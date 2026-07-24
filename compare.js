/**
 * compare.js — render the live site and the local replica side by side
 * and save full-page + above-the-fold screenshots for visual diffing.
 *
 * Usage: node compare.js <liveUrl> <localUrl> <outDir> [pageLabel]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [,, liveUrl, localUrl, outDir, label = 'home'] = process.argv;
if (!liveUrl || !localUrl || !outDir) {
  console.error('Usage: node compare.js <liveUrl> <localUrl> <outDir> [label]');
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

async function shoot(browser, url, tag) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log(`[${tag}] goto warn: ${e.message}`);
  }
  // let the Framer preloader/animation settle
  await page.waitForTimeout(4500);
  // scroll through to trigger lazy content, then back to top
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);

  const fold = join(outDir, `${label}-${tag}-fold.png`);
  const full = join(outDir, `${label}-${tag}-full.png`);
  await page.screenshot({ path: fold, fullPage: false });
  await page.screenshot({ path: full, fullPage: true });

  const metrics = await page.evaluate(() => ({
    title: document.title,
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().length,
    imgs: document.images.length,
    imgsBroken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
    docHeight: document.body.scrollHeight,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  console.log(`[${tag}] ${url}`);
  console.log(`       title="${metrics.title}" textLen=${metrics.bodyText} imgs=${metrics.imgs} broken=${metrics.imgsBroken} height=${metrics.docHeight} bg=${metrics.bg}`);
  if (errors.length) console.log(`       errors(${errors.length}): ${errors.slice(0, 5).join(' | ')}`);
  await ctx.close();
  return metrics;
}

const browser = await chromium.launch({ headless: true });
const live = await shoot(browser, liveUrl, 'live');
const local = await shoot(browser, localUrl, 'local');
await browser.close();

console.log('\n=== SUMMARY ===');
console.log(`height live=${live.docHeight} local=${local.docHeight} diff=${live.docHeight - local.docHeight}px`);
console.log(`text   live=${live.bodyText} local=${local.bodyText}`);
console.log(`broken imgs local=${local.imgsBroken}/${local.imgs}`);
