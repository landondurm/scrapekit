/**
 * sitemap.js — Discover pages via sitemap.xml or fallback link crawling.
 *
 * Framer template sites on *.framer.media often lack a sitemap,
 * so the fallback crawler must reliably find pages through <a> tags.
 */

import { XMLParser } from 'fast-xml-parser';

/**
 * Try to fetch and parse sitemap.xml for the given origin.
 * Returns an array of absolute URL strings, or null if no sitemap exists.
 */
export async function fetchSitemap(baseUrl) {
  const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
  console.log(`[sitemap] Fetching ${sitemapUrl}`);

  try {
    const res = await fetch(sitemapUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FramerScraper/1.0)' },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.log(`[sitemap] No sitemap found (HTTP ${res.status})`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    // Some servers return HTML for missing pages instead of 404
    if (contentType.includes('text/html') && !text.trim().startsWith('<?xml')) {
      console.log('[sitemap] Response was HTML, not XML — skipping');
      return null;
    }

    const parser = new XMLParser({ ignoreAttributes: false });
    const doc = parser.parse(text);

    // Handle both <urlset> and <sitemapindex>
    let urls = [];
    if (doc.urlset?.url) {
      const entries = Array.isArray(doc.urlset.url) ? doc.urlset.url : [doc.urlset.url];
      urls = entries.map(e => e.loc).filter(Boolean);
    } else if (doc.sitemapindex?.sitemap) {
      // Recursive: fetch each child sitemap
      const sitemaps = Array.isArray(doc.sitemapindex.sitemap)
        ? doc.sitemapindex.sitemap
        : [doc.sitemapindex.sitemap];
      for (const sm of sitemaps) {
        if (sm.loc) {
          const childUrls = await fetchSitemap(sm.loc);
          if (childUrls) urls.push(...childUrls);
        }
      }
    }

    // Filter to same domain only
    const origin = new URL(baseUrl).origin;
    urls = urls.filter(u => {
      try { return new URL(u).origin === origin; }
      catch { return false; }
    });

    console.log(`[sitemap] Found ${urls.length} URLs`);
    return urls.length > 0 ? urls : null;
  } catch (err) {
    console.log(`[sitemap] Error fetching sitemap: ${err.message}`);
    return null;
  }
}

/**
 * Crawl internal links starting from baseUrl up to maxDepth.
 * Uses Playwright page instances to render JS-heavy Framer pages
 * and extract links from the fully rendered DOM.
 */
export async function crawlLinks(page, baseUrl, maxDepth = 2) {
  const origin = new URL(baseUrl).origin;
  const visited = new Set();
  const found = new Set();
  const queue = [{ url: normalizeUrl(baseUrl), depth: 0 }];

  console.log(`[crawl] Starting link crawl from ${baseUrl} (max depth: ${maxDepth})`);

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    const normalized = normalizeUrl(url);

    if (visited.has(normalized) || depth > maxDepth) continue;
    visited.add(normalized);
    found.add(normalized);

    console.log(`[crawl] Visiting ${normalized} (depth: ${depth})`);

    try {
      await page.goto(normalized, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1000);

      // Extract all internal links from rendered DOM
      const links = await page.evaluate((orig) => {
        return [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(href => href.startsWith(orig));
      }, origin);

      for (const link of links) {
        const norm = normalizeUrl(link);
        if (!visited.has(norm) && depth + 1 <= maxDepth) {
          queue.push({ url: norm, depth: depth + 1 });
        }
      }
    } catch (err) {
      console.warn(`[crawl] Error visiting ${normalized}: ${err.message}`);
    }
  }

  const urls = [...found];
  console.log(`[crawl] Discovered ${urls.length} pages`);
  return urls;
}

/** Strip trailing slashes, hashes, and query params for dedup. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    // Remove trailing slash except for root
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return url;
  }
}
