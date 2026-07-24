# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npx playwright install chromium       # one-time: Playwright needs its own Chromium
node scrape.js <url> <output-dir>     # main entry point
```

No test suite, no linter, no build step — this is a plain Node ESM CLI (`"type": "module"`).

Useful flags when iterating: `--skip-existing` (resumable runs), `--concurrency 1` (easier to read logs when debugging a single page), `--max-depth 1` (limit fallback crawl during development), `--idle-timeout <ms>` (default 5000 — max wait for network idle before capturing anyway; raise for slow sites, since sites that hold a connection open never go idle and are captured on this timer).

## Architecture

The scraper runs as a **5-stage pipeline** in `scrape.js`. The ordering is load-bearing: stages 2 and 3 must be separate because rewriting needs a fully-populated asset map from stage 2.

1. **Discovery** (`lib/sitemap.js`) — Tries `/sitemap.xml` first, falls back to JS-rendered link crawling via Playwright. Framer template sites on `*.framer.media` typically lack sitemaps, so the crawler must work.
2. **Scrape** (`lib/browser.js`) — Each page is rendered in headless Chromium, slow-scrolled to trigger lazy loads, then HTML + screenshot captured. **Assets are collected via `page.on('response')` interception, not by walking the DOM** — this is how cross-origin fonts, background images, and `framerusercontent.com` media get saved. Every captured asset goes into a single shared `assetMap: Map<originalUrl, localPath>`.
3. **Rewrite** (`lib/rewriter.js`) — Rewrites HTML (`href`/`src`/`srcset`/`poster`/inline `<style>`/`style=""`) and, separately, every `.css` file on disk (for `url(...)` references). Rewriting runs *after* all scraping completes so the `assetMap` is fully populated when any page/CSS is processed.
4. **Manifest** — `manifest.json` with page list, asset inventory, and errors.
5. **Gallery** — `index.html` thumbnail grid linking to the per-page screenshots in `_screenshots/`.

### Asset path strategy

Two origin classes, two output roots:
- **Same-origin** assets preserve their URL pathname: `/assets/img.png` → `<output>/assets/img.png`.
- **Cross-origin** assets go under `_external/<hostname>/<path>`: `https://framerusercontent.com/foo.woff2` → `<output>/_external/framerusercontent.com/foo.woff2`.

This split is implemented in both `browser.js` (on save) and `rewriter.js` (when falling back for URLs not in the asset map). Keep them in sync — a change to one must be mirrored in the other.

### Page-link vs asset-link disambiguation

`rewriter.js` receives `pageUrls` so it can build a `pagePathSet` and distinguish internal page links (rewrite to `./about.html`) from asset links (rewrite via `assetMap` lookup). Without this set, internal `<a href="/about">` links would be treated as missing assets.

### Skipped domains

`browser.js` has a hardcoded `SKIP_DOMAINS` list (GA, GTM, Facebook pixel, Hotjar, Segment, Intercom, Sentry, etc.). Responses from these are dropped before asset capture — don't attempt to "fix" missing tracking-pixel files in the output.

### Two URL-to-path functions exist

`urlToPagePath` in `scrape.js` and `urlToFilePath` in `lib/browser.js` implement the same mapping (`/` → `index-page.html`, `/about` → `about.html`, etc.). If you change the naming scheme, update both.

### Output must be served at real route paths

Framer's SPA router matches on `location.pathname`. A page opened as
`blog/slug.html` matches no route: listing pages silently fall back to the home
route, and detail pages lazily `import()` the `/404` module, which fails and
makes Framer disable the UI — the layout collapses (observed: 4392px → 1665px)
while `document.body.innerText` still matches the live site exactly. Text-only
diffing will not catch this; compare rendered heights.

`serve.js` maps `/blog/slug` → `blog/slug.html`. Relative asset paths survive
because both resolve against the same base dir (`/blog/`). Consequently
`rewriter.js` rewrites internal page links to real route paths (`/work`), not
`./work.html`, so **the output must be served from the domain root**.

The `/404` module is only fetched on an unmatched route, so a normal scrape
never captures it. It is a useful safety net to fetch once by hand.

## Caveats captured elsewhere

Output is static-visual-fidelity only — animations and interactivity won't work offline. See README.md for user-facing usage docs.
