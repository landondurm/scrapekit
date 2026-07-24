/**
 * serve.js — static server for a scraped Framer replica.
 *
 * Framer sites are SPAs whose router matches on `location.pathname`. A page
 * served at `/blog/slug.html` matches no route, so the router falls back to the
 * home route (listing pages) or the /404 module (detail pages), which breaks
 * hydration and collapses the layout. Serving each page at its exact original
 * route path (`/blog/slug`) makes the router behave identically to the live site.
 *
 * Relative asset paths stay valid because `blog/slug.html` and the URL
 * `/blog/slug` resolve against the same base directory (`/blog/`).
 *
 * Usage: node serve.js <dir> [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const root = process.argv[2] || '.';
const port = Number(process.argv[3] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function tryFile(p) {
  try {
    const s = await stat(p);
    if (s.isFile()) return p;
  } catch { /* not there */ }
  return null;
}

/** Map a request path to a file, mirroring the live site's clean URLs. */
async function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');

  // "/" → the captured homepage
  if (clean === '/' || clean === '') {
    return (await tryFile(join(root, 'index-page.html'))) || (await tryFile(join(root, 'index.html')));
  }

  const rel = clean.replace(/^\//, '');

  // Exact file (assets, and any explicit .html request)
  const direct = await tryFile(join(root, rel));
  if (direct) return direct;

  // Clean URL → "<path>.html"  (/blog/slug → blog/slug.html)
  const asHtml = await tryFile(join(root, rel.replace(/\/$/, '') + '.html'));
  if (asHtml) return asHtml;

  // Directory-style fallback
  return await tryFile(join(root, rel, 'index.html'));
}

const server = createServer(async (req, res) => {
  try {
    const file = await resolveFile(req.url);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('500 ' + err.message);
  }
});

server.listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
