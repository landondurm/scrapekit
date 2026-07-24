# scrapekit

Mirror a website into a folder of static files — fully rendered HTML, CSS, images, fonts, and scripts — for pixel-accurate local viewing. Runs entirely on your machine: no API keys, no accounts, no cloud.

This is a **site mirroring tool, not a data scraper**. It does not extract structured data, text, or content from pages — it captures the pages themselves, as a browser rendered them, so you can serve an offline copy that looks like the original.

## Supported sites

Verified against real sites:

- **Framer** — the primary target this tool was built and tested for. Full visual fidelity including client-rendered layouts (verified: identical rendered heights vs. live).
- **Webflow** — verified working, including sitemap-less sites discovered via link crawling.
- **Plain static sites** — verified working.
- **Squarespace** — verified working, with caveats: embedded third-party widgets (see "What it can't do") and some runtime-injected page elements are not captured.

Anything else that renders its content into the DOM is likely to work but has not been verified — treat other platforms as untested.

## Quickstart

```bash
npm install
npx playwright install chromium
```

Note the second step: `npm install` does **not** fetch a browser. Playwright needs its own Chromium binary, and `npx playwright install chromium` is a separate, large download (hundreds of megabytes). You only do it once.

Then:

```bash
node scrape.js https://example.com ./output/mysite
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--viewport <WxH>` | `1920x1080` | Browser viewport size |
| `--concurrency <n>` | `3` | Number of parallel page scrapes |
| `--delay <ms>` | `500` | Delay between requests |
| `--max-depth <n>` | `2` | Fallback crawl depth when no sitemap exists |
| `--idle-timeout <ms>` | `5000` | Max wait for the network to go idle before capturing anyway |
| `--skip-existing` | `false` | Skip pages already downloaded (resumable runs) |

**About `--idle-timeout`:** after a page loads, the scraper waits up to this long for network activity to stop before taking its snapshot. Sites that hold a connection open forever (consent managers, chat widgets, analytics streams) will never go idle — the scraper logs that it fell back and captures the page as-is. If a site is slow and your capture is missing late-loading images or fonts, raise this (e.g. `--idle-timeout 15000`) to give the page more time to settle.

## How it works

1. **Page discovery** — fetches `/sitemap.xml`; if there isn't one, falls back to crawling internal links from the homepage up to `--max-depth`.
2. **Rendering** — loads each page in headless Chromium so JS-driven layouts fully render.
3. **Lazy-load triggering** — slowly scrolls each page top to bottom to trigger lazy images and scroll-revealed content.
4. **Asset capture** — intercepts every network response: same-origin assets keep their original paths, cross-origin assets go into `_external/<hostname>/`.
5. **URL rewriting** — rewrites URLs in the HTML and CSS to point at the local copies.
6. **Output** — a browsable gallery (`index.html`), a machine-readable `manifest.json`, and a full-page screenshot of every page.

## What it can't do

Read this before pointing it at a real site.

- **Iframes and embedded third-party widgets are not captured.** Booking/reservation widgets, embedded forms, maps, video embeds (YouTube/Vimeo), and anything else that lives in an iframe will be missing or broken in the mirror. This will affect most real commercial sites.
- **The mirror still executes the original site's JavaScript — and can still phone home.** Captured pages include the site's scripts, and when you serve the mirror those scripts run and can make outbound requests to the original platform, analytics services, and other third parties. A mirrored copy is not automatically a private or self-contained copy. If that matters to you, strip or block the scripts yourself after capture.
- **No authentication.** There is no login flow, cookie import, or session support. Pages behind an auth wall are captured as their logged-out state, or not at all.
- **No bot-protection handling.** Sites behind Cloudflare challenges, CAPTCHAs, or similar will fail or capture the challenge page. The scraper presents a standard desktop Chrome user agent; it makes no attempt to defeat protections, and you shouldn't point it at sites that don't want automated access.
- **Discovery only follows `<a href>` links.** Pages reachable only through image maps, buttons, or JavaScript navigation are missed. URLs that differ only by query string are treated as one page.
- **Sites that never go network-idle are captured on a timer.** Long-polling connections (consent managers, chat widgets) mean the scraper snapshots after `--idle-timeout` instead of waiting for quiet — late-loading assets may be missed (it logs when this happens).
- **Runtime-generated asset URLs can't be rewritten.** Assets whose URLs are injected by JavaScript at runtime (badges, dynamically loaded media) still point at the live site. Likewise, assets referenced in the HTML but never actually loaded during capture keep their original live URLs by design, rather than pointing at local files that don't exist.
- **Streamed media isn't stitched into playable files.** HLS/DASH video is captured only as whatever segments happened to load; don't expect working video offline.
- **Animations and interactivity are best-effort.** The goal is static visual fidelity. Much of a site's runtime behavior still works when served locally because its JS is preserved, but functional parity is not guaranteed.

## Viewing the output

Serve the output — do **not** open the `.html` files directly:

```bash
node serve.js ./output/mysite 8899   # then visit http://localhost:8899
```

Many modern sites (Framer included) are SPAs whose router matches on `location.pathname`. Opening `blog/slug.html` from disk matches no route, so the router falls back to the home route or a 404 module — which can break hydration and collapse the layout. `serve.js` maps each original route (`/blog/slug`) to its captured file (`blog/slug.html`), so the router sees exactly the paths the live site serves. Any clean-URL static host (Netlify, Vercel, nginx `try_files`) works the same way; internal links are rewritten to real route paths, so the output must be served from the domain root.

## Output structure

```
<output-dir>/
├── index.html                 ← thumbnail gallery of all pages
├── manifest.json              ← scrape metadata, asset inventory, errors
├── index-page.html            ← captured homepage
├── about.html
├── assets/                    ← same-origin assets (original paths preserved)
├── _external/                 ← cross-origin assets, grouped by hostname
└── _screenshots/              ← full-page PNGs of every page
```

## Responsible use

Respect `robots.txt` and each site's terms of service — this tool does not check either for you. It also identifies itself as a regular browser, not a bot. Mirror sites you own, sites you have permission to copy, or content whose terms allow it. Keep the default request delay (or raise it) so you're not hammering someone's server. You are accountable for what you point this at and for what you do with the copies.

## License

MIT — see [LICENSE](LICENSE).
