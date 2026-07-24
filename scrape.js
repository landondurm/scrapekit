#!/usr/bin/env node

/**
 * scrape.js — CLI entry point for the Framer site scraper.
 *
 * Usage:
 *   node scrape.js <url> <output-dir> [options]
 *
 * Captures a static snapshot of a Framer-built website:
 * fully rendered HTML, all CSS, images, SVGs, and fonts.
 */

import { Command } from 'commander';
import pLimit from 'p-limit';
import { mkdir, writeFile, stat, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

import { fetchSitemap, crawlLinks } from './lib/sitemap.js';
import { launchBrowser, scrapePage } from './lib/browser.js';
import { rewriteHtml, rewriteAllCssFiles } from './lib/rewriter.js';

// ── CLI Setup ──────────────────────────────────────────────

const program = new Command();
program
  .name('scrapekit')
  .description('Mirror a website into a folder of static files for local viewing')
  .argument('<url>', 'URL of the site to scrape')
  .argument('<output-dir>', 'Directory to save the scraped site')
  .option('--viewport <WxH>', 'Browser viewport size', '1920x1080')
  // Coercion fns are called as fn(value, previousValue); passing bare `parseInt`
  // makes the default the radix (parseInt('3', 3) → NaN), so wrap it.
  .option('--concurrency <n>', 'Parallel page scrapes', v => parseInt(v, 10), 3)
  .option('--delay <ms>', 'Delay between requests (ms)', v => parseInt(v, 10), 500)
  .option('--max-depth <n>', 'Fallback crawl depth if no sitemap', v => parseInt(v, 10), 2)
  .option('--idle-timeout <ms>', 'Max wait for network idle before capturing anyway', v => parseInt(v, 10), 5000)
  .option('--skip-existing', 'Skip pages already downloaded')
  .parse();

const [siteUrl, outputDirArg] = program.args;
const opts = program.opts();
const outputDir = resolve(outputDirArg);

// ── Main ───────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`\n🔍 Framer Scraper`);
  console.log(`   Target: ${siteUrl}`);
  console.log(`   Output: ${outputDir}`);
  console.log(`   Viewport: ${opts.viewport}`);
  console.log(`   Concurrency: ${opts.concurrency}`);
  console.log(`   Delay: ${opts.delay}ms\n`);

  const baseOrigin = new URL(siteUrl).origin;

  // Create output directories
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, '_screenshots'), { recursive: true });
  await mkdir(join(outputDir, '_external'), { recursive: true });

  // ── Step 1: Discover pages ─────────────────────────────

  console.log('━━━ Step 1: Discovering pages ━━━');
  let pageUrls = await fetchSitemap(siteUrl);

  const { browser, context } = await launchBrowser(opts.viewport);

  if (!pageUrls) {
    console.log('[discover] No sitemap — falling back to link crawling');
    const crawlPage = await context.newPage();
    pageUrls = await crawlLinks(crawlPage, siteUrl, opts.maxDepth);
    await crawlPage.close();
  }

  // Ensure the homepage is always included
  const normalizedHome = normalizeUrl(siteUrl);
  if (!pageUrls.some(u => normalizeUrl(u) === normalizedHome)) {
    pageUrls.unshift(siteUrl);
  }

  console.log(`\n📄 Found ${pageUrls.length} pages to scrape\n`);

  // ── Step 2: Scrape all pages ───────────────────────────

  console.log('━━━ Step 2: Scraping pages ━━━');
  const limit = pLimit(opts.concurrency);
  const allResults = [];
  const allErrors = [];
  // Global asset map: original URL → local file path
  const assetMap = new Map();

  const tasks = pageUrls.map((url, i) =>
    limit(async () => {
      // Respect delay between requests
      if (i > 0) {
        await sleep(opts.delay);
      }

      // Skip existing if flag is set
      if (opts.skipExisting) {
        const pagePath = urlToPagePath(url, baseOrigin);
        const existingPath = join(outputDir, pagePath);
        try {
          await access(existingPath);
          console.log(`  [skip] ${pagePath} already exists`);
          return null;
        } catch { /* doesn't exist, proceed */ }
      }

      console.log(`\n[${i + 1}/${pageUrls.length}] Scraping: ${url}`);
      const result = await scrapePage(context, url, outputDir, baseOrigin, {
        idleTimeout: opts.idleTimeout,
      });

      // Populate asset map
      for (const asset of result.assets) {
        assetMap.set(asset.url, asset.localPath);
      }

      if (result.errors.length > 0) {
        allErrors.push(...result.errors);
      }

      return result;
    })
  );

  const results = await Promise.all(tasks);
  const validResults = results.filter(Boolean).filter(r => r.html);

  // ── Step 3: Rewrite URLs ───────────────────────────────

  console.log('\n━━━ Step 3: Rewriting URLs ━━━');
  for (const result of validResults) {
    console.log(`  [rewrite] ${result.pagePath}`);
    const rewrittenHtml = rewriteHtml(
      result.html,
      result.htmlPath,
      outputDir,
      baseOrigin,
      assetMap,
      pageUrls
    );

    // Save the rewritten HTML
    await mkdir(join(outputDir, ...result.pagePath.split('/').slice(0, -1)), { recursive: true });
    await writeFile(result.htmlPath, rewrittenHtml, 'utf-8');
    result.fileSize = Buffer.byteLength(rewrittenHtml);
    allResults.push(result);
  }

  // Rewrite url() references in all downloaded CSS files
  console.log('  [rewrite] Processing CSS files...');
  await rewriteAllCssFiles(outputDir, baseOrigin, assetMap);

  // ── Step 4: Generate manifest.json ─────────────────────

  console.log('\n━━━ Step 4: Generating manifest ━━━');
  const manifest = {
    timestamp: new Date().toISOString(),
    sourceUrl: siteUrl,
    pageCount: allResults.length,
    pages: allResults.map(r => ({
      url: r.pagePath,
      fileSize: r.fileSize,
      assetCount: r.assets.length,
    })),
    assets: [...assetMap.entries()].map(([url, localPath]) => {
      const parsed = new URL(url);
      return {
        originalUrl: url,
        hostname: parsed.hostname,
        localPath: relative(outputDir, localPath),
      };
    }),
    errors: allErrors,
    duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
  };

  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`  [manifest] Saved with ${manifest.pageCount} pages, ${manifest.assets.length} assets`);

  // ── Step 5: Generate index.html gallery ────────────────

  console.log('\n━━━ Step 5: Generating gallery index ━━━');
  const galleryHtml = generateGallery(allResults, siteUrl, outputDir);
  await writeFile(join(outputDir, 'index.html'), galleryHtml);
  console.log('  [gallery] index.html created');

  // ── Done ───────────────────────────────────────────────

  await browser.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Scrape complete in ${elapsed}s`);
  console.log(`   ${allResults.length} pages captured`);
  console.log(`   ${assetMap.size} assets saved`);
  if (allErrors.length > 0) {
    console.log(`   ⚠️  ${allErrors.length} errors (see manifest.json)`);
  }
  console.log(`   Output: ${outputDir}\n`);
}

// ── Helpers ────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch { return url; }
}

function urlToPagePath(url, baseOrigin) {
  const parsed = new URL(url);
  let pathname = parsed.pathname;
  if (pathname.endsWith('/') && pathname !== '/') pathname = pathname.slice(0, -1);
  if (pathname === '/' || pathname === '') return 'index-page.html';
  return pathname.slice(1) + '.html';
}

/**
 * Generate a visual gallery page with thumbnails of all scraped pages.
 */
function generateGallery(results, siteUrl, outputDir) {
  const cards = results.map(r => {
    const screenshotRel = './_screenshots/' + r.pagePath.replace(/\.html$/, '.png');
    const pageLink = './' + r.pagePath;
    return `
      <a href="${pageLink}" class="card">
        <img src="${screenshotRel}" alt="${r.pagePath}" loading="lazy" />
        <div class="label">${r.pagePath}</div>
      </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scrape Gallery — ${siteUrl}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a; color: #e0e0e0;
      padding: 2rem;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .meta { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1.5rem;
    }
    .card {
      display: block;
      background: #1a1a1a;
      border-radius: 8px;
      overflow: hidden;
      text-decoration: none;
      color: inherit;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .card img {
      width: 100%;
      height: 220px;
      object-fit: cover;
      object-position: top;
      border-bottom: 1px solid #333;
    }
    .label {
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      color: #aaa;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <h1>Scraped Site: ${siteUrl}</h1>
  <p class="meta">${results.length} pages captured — ${new Date().toISOString()}</p>
  <div class="grid">
    ${cards}
  </div>
</body>
</html>`;
}

// ── Run ────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
