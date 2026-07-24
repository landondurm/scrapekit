/**
 * browser.js — Launch headless Chromium, scrape pages, intercept assets.
 *
 * Handles:
 * - Network response interception to capture all assets
 * - Lazy-load triggering via slow scroll
 * - Full-page screenshots
 * - HTML capture via page.content()
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Tracking pixel / analytics domains to skip
const SKIP_DOMAINS = [
  'google-analytics.com', 'www.google-analytics.com',
  'googletagmanager.com', 'www.googletagmanager.com',
  'analytics.google.com',
  'facebook.com', 'www.facebook.com',
  'connect.facebook.net',
  'pixel.facebook.com',
  'doubleclick.net',
  'hotjar.com',
  'segment.io', 'cdn.segment.com',
  'intercom.io',
  'sentry.io',
];

/**
 * Launch a browser instance with the given viewport.
 * Returns { browser, context } — caller is responsible for closing.
 */
export async function launchBrowser(viewport) {
  const [width, height] = viewport.split('x').map(Number);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  return { browser, context };
}

/**
 * Scrape a single page: navigate, scroll to trigger lazy loads,
 * capture HTML and screenshot, collect all network assets.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} url - The page URL to scrape
 * @param {string} outputDir - Root output directory
 * @param {string} baseOrigin - The site's origin for same-origin checks
 * @param {{ idleTimeout?: number }} [options] - idleTimeout: max ms to wait for network idle
 * @returns {{ html, htmlPath, screenshotPath, assets, errors }}
 */
export async function scrapePage(context, url, outputDir, baseOrigin, options = {}) {
  const idleTimeout = options.idleTimeout ?? 5000;
  const assets = [];  // { url, localPath, size, hostname }
  const errors = [];
  const savedUrls = new Set();

  const page = await context.newPage();

  // --- Intercept all network responses to save assets ---
  page.on('response', async (response) => {
    try {
      const reqUrl = response.url();

      // Skip data URIs
      if (reqUrl.startsWith('data:')) return;

      // Skip tracking pixels / analytics
      const hostname = new URL(reqUrl).hostname;
      if (SKIP_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return;

      // Skip non-asset content types
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('text/html')) return; // we capture HTML separately

      // Only save successful responses
      const status = response.status();
      if (status < 200 || status >= 400) return;

      // Deduplicate
      const finalUrl = response.url();
      if (savedUrls.has(finalUrl)) return;
      savedUrls.add(finalUrl);

      const parsed = new URL(finalUrl);
      let localPath;

      if (parsed.origin === baseOrigin) {
        // Same-origin asset: preserve original path
        localPath = join(outputDir, decodeURIComponent(parsed.pathname));
      } else {
        // Cross-origin asset: save under _external/<hostname>/<path>
        localPath = join(
          outputDir,
          '_external',
          parsed.hostname,
          decodeURIComponent(parsed.pathname)
        );
      }

      // Ensure the file has an extension — some Framer URLs omit it
      if (!localPath.match(/\.[a-zA-Z0-9]+$/)) {
        const ext = guessExtension(contentType);
        if (ext) localPath += ext;
      }

      const body = await response.body().catch(() => null);
      if (!body || body.length === 0) return;

      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, body);

      assets.push({
        url: finalUrl,
        localPath,
        size: body.length,
        hostname: parsed.hostname,
      });
    } catch (err) {
      // Non-critical: log and continue
      if (!err.message.includes('Response body is unavailable')) {
        errors.push({ type: 'asset', url: response.url(), error: err.message });
      }
    }
  });

  try {
    // Navigate on a fast condition, then settle to network idle best-effort.
    // A hard networkidle wait hangs forever on sites that hold a connection
    // open (consent managers, chat widgets, analytics streams).
    console.log(`  [page] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: idleTimeout });
    } catch {
      console.log(
        `  [page] Network still active after ${idleTimeout}ms — capturing current state ` +
        `(late-loading assets may be missed)`
      );
    }

    // Slow scroll to trigger lazy-loaded content
    await slowScroll(page);

    // Scroll back to top and wait for any final renders
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Wait a moment for any final network requests from scrolling
    await page.waitForTimeout(1000);

    // Capture rendered HTML
    const html = await page.content();

    // Determine output file path for this page
    const pagePath = urlToFilePath(url, baseOrigin);
    const htmlPath = join(outputDir, pagePath);

    // Take full-page screenshot
    const screenshotName = pagePath.replace(/\.html$/, '.png');
    const screenshotPath = join(outputDir, '_screenshots', screenshotName);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`  [page] Captured ${pagePath} (${assets.length} assets)`);

    return { html, htmlPath, pagePath, screenshotPath, assets: [...assets], errors };
  } catch (err) {
    console.error(`  [page] FAILED ${url}: ${err.message}`);
    errors.push({ type: 'page', url, error: err.message });
    return { html: null, htmlPath: null, pagePath: null, screenshotPath: null, assets: [...assets], errors };
  } finally {
    await page.close();
  }
}

/**
 * Scroll slowly from top to bottom in ~200px increments
 * to trigger lazy-loaded images and scroll-reveal animations.
 */
async function slowScroll(page) {
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  let currentPos = 0;

  while (currentPos < scrollHeight) {
    currentPos += 200;
    await page.evaluate((y) => window.scrollTo(0, y), currentPos);
    await page.waitForTimeout(300);
  }

  // One final scroll to absolute bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
}

/**
 * Convert a page URL to a local file path.
 *   https://example.com/           → index-page.html
 *   https://example.com/about      → about.html
 *   https://example.com/blog/post  → blog/post.html
 */
function urlToFilePath(url, baseOrigin) {
  const parsed = new URL(url);
  let pathname = parsed.pathname;

  // Strip trailing slash
  if (pathname.endsWith('/') && pathname !== '/') {
    pathname = pathname.slice(0, -1);
  }

  if (pathname === '/' || pathname === '') {
    return 'index-page.html';
  }

  // Remove leading slash, add .html
  const clean = pathname.slice(1);
  return clean + '.html';
}

/** Guess a file extension from a Content-Type header. */
function guessExtension(contentType) {
  if (!contentType) return null;
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'application/font-woff2': '.woff2',
    'application/font-woff': '.woff',
    'text/css': '.css',
    'application/javascript': '.js',
    'text/javascript': '.js',
    'application/json': '.json',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (contentType.includes(mime)) return ext;
  }
  return null;
}
