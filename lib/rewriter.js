/**
 * rewriter.js — Rewrite URLs in captured HTML and CSS files
 * so the offline snapshot links to local asset copies.
 *
 * Rewrites:
 * - Internal page links  (/about → ./about.html)
 * - Same-origin assets   (/assets/img.png → ./assets/img.png)
 * - Cross-origin assets  (https://cdn.com/foo.woff2 → ./_external/cdn.com/foo.woff2)
 * - url(...) inside CSS  (both inline <style> and external .css files)
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

/**
 * Rewrite all URLs in a captured HTML string.
 *
 * @param {string} html - The raw HTML from page.content()
 * @param {string} htmlFilePath - Where this HTML will be saved (for relative path calc)
 * @param {string} outputDir - Root output directory
 * @param {string} baseOrigin - The original site origin
 * @param {Map<string,string>} assetMap - Maps original URL → local file path
 * @param {string[]} pageUrls - All scraped page URLs (for link rewriting)
 * @returns {string} Rewritten HTML
 */
export function rewriteHtml(html, htmlFilePath, outputDir, baseOrigin, assetMap, pageUrls) {
  const htmlDir = dirname(htmlFilePath);

  // Build a set of page paths for internal link detection
  const pagePathSet = new Set();
  for (const url of pageUrls) {
    const parsed = new URL(url);
    pagePathSet.add(parsed.pathname);
    // Also add without trailing slash
    if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
      pagePathSet.add(parsed.pathname.slice(0, -1));
    }
  }

  // Rewrite href and src attributes
  html = html.replace(
    /(href|src|srcset|poster)=(["'])(.*?)\2/gi,
    (match, attr, quote, value) => {
      const rewritten = rewriteUrl(value, htmlDir, outputDir, baseOrigin, assetMap, pagePathSet);
      return `${attr}=${quote}${rewritten}${quote}`;
    }
  );

  // Rewrite url(...) in inline <style> blocks
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => {
      const rewrittenCss = rewriteCssUrls(css, htmlDir, outputDir, baseOrigin, assetMap);
      return open + rewrittenCss + close;
    }
  );

  // Rewrite url(...) in inline style="" attributes
  html = html.replace(
    /style=(["'])(.*?)\1/gi,
    (match, quote, value) => {
      const rewritten = rewriteCssUrls(value, htmlDir, outputDir, baseOrigin, assetMap);
      return `style=${quote}${rewritten}${quote}`;
    }
  );

  return html;
}

/**
 * Rewrite all url(...) references in a CSS file on disk.
 */
export async function rewriteCssFile(cssPath, outputDir, baseOrigin, assetMap) {
  try {
    let css = await readFile(cssPath, 'utf-8');
    const cssDir = dirname(cssPath);
    css = rewriteCssUrls(css, cssDir, outputDir, baseOrigin, assetMap);
    await writeFile(cssPath, css);
  } catch (err) {
    console.warn(`[rewrite] Could not rewrite CSS file ${cssPath}: ${err.message}`);
  }
}

/**
 * Walk the output directory and rewrite all .css files.
 */
export async function rewriteAllCssFiles(outputDir, baseOrigin, assetMap) {
  const cssFiles = await findFiles(outputDir, /\.css$/);
  for (const cssFile of cssFiles) {
    await rewriteCssFile(cssFile, outputDir, baseOrigin, assetMap);
  }
}

/**
 * Matches url(...) with an optional delimiter that may be a literal quote or an
 * HTML-encoded one. Framer serializes inline style="" attributes containing
 * url("...") as url(&quot;...&quot;); treating &quot; as part of the URL yields a
 * mangled relative path and the asset silently stops rendering.
 */
const CSS_URL_RE = /url\(\s*(["']|&quot;|&#34;|&apos;|&#39;|)([\s\S]*?)\1\s*\)/gi;

/**
 * Rewrite url(...) references within a CSS string.
 */
function rewriteCssUrls(css, contextDir, outputDir, baseOrigin, assetMap) {
  return css.replace(
    CSS_URL_RE,
    (match, quote, value) => {
      // Skip data: URIs and empty values
      if (!value || value.startsWith('data:') || value.startsWith('#')) {
        return match;
      }
      const rewritten = rewriteAssetUrl(value, contextDir, outputDir, baseOrigin, assetMap);
      return `url(${quote}${rewritten}${quote})`;
    }
  );
}

/**
 * Rewrite a single URL (from href/src/srcset) to a local relative path.
 */
function rewriteUrl(value, contextDir, outputDir, baseOrigin, assetMap, pagePathSet) {
  if (!value || value.startsWith('data:') || value.startsWith('#') || value.startsWith('javascript:')) {
    return value;
  }

  // Non-web schemes (mailto:, tel:, sms:, …) are not assets — leave untouched
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) {
    return value;
  }

  // Handle srcset (comma-separated list of "url size" pairs)
  if (value.includes(',') && value.match(/\s\d+[wx]/)) {
    return value.split(',').map(part => {
      const trimmed = part.trim();
      const [url, ...rest] = trimmed.split(/\s+/);
      const rewritten = rewriteAssetUrl(url, contextDir, outputDir, baseOrigin, assetMap);
      return [rewritten, ...rest].join(' ');
    }).join(', ');
  }

  // Check if this is an internal page link
  try {
    const resolved = resolveUrl(value, baseOrigin);
    if (resolved) {
      const parsed = new URL(resolved);
      if (parsed.origin === baseOrigin) {
        let pathname = parsed.pathname;
        // Normalize: remove trailing slash
        if (pathname.endsWith('/') && pathname !== '/') {
          pathname = pathname.slice(0, -1);
        }

        // Is this a page link? Keep the site's real route path rather than
        // pointing at "<page>.html". The Framer SPA router matches on
        // location.pathname, so a ".html" URL matches no route and falls back
        // to the home route or the /404 module — which breaks hydration and
        // collapses the layout. Serve the output with serve.js (or any
        // clean-URL static host) and these resolve to the captured files.
        if (pagePathSet && (pagePathSet.has(pathname) || pagePathSet.has(pathname + '/'))) {
          return (pathname === '' ? '/' : pathname) + parsed.search + parsed.hash;
        }
      }
    }
  } catch {
    // Not a valid URL — return as-is
  }

  // Otherwise treat as asset — but if nothing was captured locally for it
  // (external page links, uncaptured media), keep the original URL instead
  // of pointing at a file that doesn't exist.
  const rewritten = rewriteAssetUrl(value, contextDir, outputDir, baseOrigin, assetMap);
  if (rewritten !== value && !existsSync(join(contextDir, rewritten))) {
    return value;
  }
  return rewritten;
}

/**
 * Rewrite an asset URL to its local relative path using the asset map.
 */
function rewriteAssetUrl(value, contextDir, outputDir, baseOrigin, assetMap) {
  if (!value || value.startsWith('data:') || value.startsWith('#')) {
    return value;
  }

  // Try to resolve the URL
  const resolved = resolveUrl(value, baseOrigin);
  if (!resolved) return value;

  // Look up in asset map
  const localPath = assetMap.get(resolved);
  if (localPath) {
    return './' + relative(contextDir, localPath);
  }

  // For same-origin URLs not in the map, try path-based resolution
  try {
    const parsed = new URL(resolved);
    if (parsed.origin === baseOrigin) {
      const localFile = join(outputDir, decodeURIComponent(parsed.pathname));
      return './' + relative(contextDir, localFile);
    } else {
      // Cross-origin not captured — build expected path anyway
      const localFile = join(outputDir, '_external', parsed.hostname, decodeURIComponent(parsed.pathname));
      return './' + relative(contextDir, localFile);
    }
  } catch {
    return value;
  }
}

/** Resolve a possibly-relative URL against the base origin. */
function resolveUrl(value, baseOrigin) {
  try {
    if (value.startsWith('//')) {
      return 'https:' + value;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    // Relative URL — resolve against origin
    return new URL(value, baseOrigin).href;
  } catch {
    return null;
  }
}

/** Recursively find files matching a pattern. */
async function findFiles(dir, pattern) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('_screenshots')) {
        results.push(...await findFiles(fullPath, pattern));
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore permission errors */ }
  return results;
}
