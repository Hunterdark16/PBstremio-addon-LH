---
title: PimpBunny Stremio Addon
emoji: 🔞
colorFrom: red
colorTo: pink
sdk: docker
pinned: false
---

# PimpBunny Stremio Addon

Lightweight Node.js Stremio add-on for PimpBunny VOD pages, prepared for Hugging Face Spaces Docker deployment.

This version intentionally removes the Puppeteer/Chromium 1080p runtime resolver and keeps only the lightweight raw page extraction flow. It resolves the first playable `get_file` candidate from the video page HTML, which usually returns a 720p stream and sometimes returns 1080p when the raw source is already valid.

## Files

- `addon.js` — main add-on server.
- `package.json` — Node dependencies.
- `Dockerfile` — Docker deployment for Hugging Face Spaces.
- `.dockerignore` — keeps Docker builds small.

## Hugging Face Spaces setup

Create a Docker Space and upload these files.

Set these variables/secrets:

```env
SPACE_URL=https://YOUR-SPACE-NAME.hf.space
PB_BASE_URL=https://pimpbunny.com
OUTBOUND_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
```

`OUTBOUND_PROXY_URL` is optional, but if configured it is used for catalog fetching, metadata fetching, image proxying, and lightweight stream resolving checks.

Alternative split proxy variables:

```env
OUTBOUND_PROXY_HOST=HOST
OUTBOUND_PROXY_PORT=PORT
OUTBOUND_PROXY_USERNAME=USERNAME
OUTBOUND_PROXY_PASSWORD=PASSWORD
```

Do not set `PORT` on Hugging Face unless you specifically need to override it. The Dockerfile defaults to `7860`.

## What was removed

This lightweight build removes:

- `puppeteer-core`
- system Chromium install
- browser 1080p resolver
- browser prewarm logic
- stream token/cache helpers for proxied playback
- fast direct 1080p upgrade probing
- embed-page fallback resolving

## Proxy behavior

The outbound proxy is used only for lightweight server-side fetches:

- catalog pages
- metadata pages
- image proxying
- `get_file` resolve checks

Video playback URLs are returned directly to Stremio. The `/proxy` endpoint is kept for manual compatibility, but it does not use the outbound proxy for video bytes.

## Test locally

```bash
npm install
npm run check
npm start
```

Open:

```text
http://localhost:7860/health
http://localhost:7860/manifest.json
```

## Install in Stremio

After deployment, use:

```text
https://YOUR-SPACE-NAME.hf.space/manifest.json
```
