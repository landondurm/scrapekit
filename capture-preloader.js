/**
 * capture-preloader.js — grab the Framer preload/splash screen before it animates away.
 *
 * Strategy: navigate with 'commit' so we don't block on load/networkidle, then
 * sample HTML + screenshot every 100ms for the first ~3s. Save every distinct frame
 * plus any network assets fetched during the preload window.
 *
 * Usage: node capture-preloader.js <url> <output-dir>
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SKIP_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
  'facebook.com', 'connect.facebook.net', 'doubleclick.net',
  'hotjar.com', 'segment.io', 'cdn.segment.com',
  'intercom.io', 'sentry.io',
];

const [,, url, outputDir] = process.argv;
if (!url || !outputDir) {
  console.error('Usage: node capture-preloader.js <url> <output-dir>');
  process.exit(1);
}

const preDir = join(outputDir, '_preloader');
await mkdir(preDir, { recursive: true });

const baseOrigin = new URL(url).origin;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

const page = await context.newPage();

const savedUrls = new Set();
const assets = [];

page.on('response', async (response) => {
  try {
    const reqUrl = response.url();
    if (reqUrl.startsWith('data:')) return;
    const hostname = new URL(reqUrl).hostname;
    if (SKIP_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) return;

    const ct = response.headers()['content-type'] || '';
    if (ct.includes('text/html')) return;

    const status = response.status();
    if (status < 200 || status >= 400) return;

    if (savedUrls.has(reqUrl)) return;
    savedUrls.add(reqUrl);

    const parsed = new URL(reqUrl);
    let localPath;
    if (parsed.origin === baseOrigin) {
      localPath = join(outputDir, decodeURIComponent(parsed.pathname));
    } else {
      localPath = join(outputDir, '_external', parsed.hostname, decodeURIComponent(parsed.pathname));
    }

    const body = await response.body().catch(() => null);
    if (!body || body.length === 0) return;

    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, body);
    assets.push({ url: reqUrl, localPath, bytes: body.length });
  } catch {}
});

console.log(`[preloader] navigating to ${url}`);
// 'commit' returns as soon as the response starts — preloader will be in DOM shortly after
await page.goto(url, { waitUntil: 'commit', timeout: 60000 });

// Sample frames for the first 4 seconds
const samples = [0, 150, 300, 500, 800, 1200, 1800, 2500, 3500, 5000];
const frames = [];
const start = Date.now();

for (const targetMs of samples) {
  const elapsed = Date.now() - start;
  const waitMs = Math.max(0, targetMs - elapsed);
  if (waitMs > 0) await page.waitForTimeout(waitMs);

  try {
    const actualMs = Date.now() - start;
    const stamp = String(actualMs).padStart(5, '0');
    const htmlPath = join(preDir, `frame-${stamp}ms.html`);
    const pngPath = join(preDir, `frame-${stamp}ms.png`);

    const html = await page.content();
    await writeFile(htmlPath, html);
    await page.screenshot({ path: pngPath, fullPage: false });

    frames.push({ ms: actualMs, htmlPath, pngPath, bytes: html.length });
    console.log(`[preloader] frame @ ${actualMs}ms — ${html.length} bytes`);
  } catch (err) {
    console.log(`[preloader] frame @ ${targetMs}ms failed: ${err.message}`);
  }
}

// Try to capture a named preloader element's outerHTML if one exists
try {
  const preloaderInfo = await page.evaluate(() => {
    const selectors = [
      '[data-framer-name*="oader" i]',
      '[data-framer-name*="reload" i]',
      '[data-framer-name*="splash" i]',
      '[data-framer-name*="intro" i]',
      '[class*="preloader" i]',
      '[class*="loader" i]',
      '[id*="preloader" i]',
      '[id*="loader" i]',
    ];
    const hits = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        hits.push({
          selector: sel,
          tag: el.tagName,
          name: el.getAttribute('data-framer-name'),
          id: el.id,
          cls: el.className?.toString?.() ?? '',
          outerHTML: el.outerHTML.slice(0, 4000),
        });
      });
    }
    return hits;
  });
  await writeFile(join(preDir, 'preloader-elements.json'), JSON.stringify(preloaderInfo, null, 2));
  console.log(`[preloader] found ${preloaderInfo.length} candidate element(s)`);
} catch (err) {
  console.log(`[preloader] element scan failed: ${err.message}`);
}

await browser.close();

console.log(`\n[preloader] done — ${frames.length} frames, ${assets.length} assets captured`);
console.log(`[preloader] output: ${preDir}`);
