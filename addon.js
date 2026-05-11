const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PORT = process.env.PORT || 7860;
const BASE_URL = process.env.AB_BASE_URL || "https://archivebate.com";
const PUBLIC_BASE_URL = process.env.SPACE_URL || process.env.PUBLIC_URL || "";

// Hardcoded lightweight catalog / bandwidth settings.
// Keep image proxying off by default so catalog posters load directly from the image host.
const PROXY_IMAGES = false;

// Even if /imgproxy is used later, do not spend outbound proxy bandwidth on poster images.
const IMAGE_PROXY_USES_OUTBOUND_PROXY = false;

// Keep catalog pages lighter.
const CATALOG_ITEM_LIMIT = 32;

const PROXY_HOST = process.env.OUTBOUND_PROXY_HOST || "";
const PROXY_PORT_ENV = process.env.OUTBOUND_PROXY_PORT || "";
const PROXY_USER = process.env.OUTBOUND_PROXY_USERNAME || "";
const PROXY_PASS = process.env.OUTBOUND_PROXY_PASSWORD || "";
const PROXY_URL = process.env.OUTBOUND_PROXY_URL || (PROXY_HOST && PROXY_PORT_ENV
  ? `http://${PROXY_USER ? encodeURIComponent(PROXY_USER) : ""}${PROXY_PASS ? ":" + encodeURIComponent(PROXY_PASS) : ""}${PROXY_USER || PROXY_PASS ? "@" : ""}${PROXY_HOST}:${PROXY_PORT_ENV}`
  : "");
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

const MAX_RESOLVE_CANDIDATES = 4;
const STREAM_CACHE_MS = 45 * 1000;
const CATALOG_CACHE_MS = 30 * 60 * 1000;
const META_CACHE_MS = 10 * 60 * 1000;

const catalogTitleCache = new Map();
const CATALOG_TITLE_CACHE_MS = 6 * 60 * 60 * 1000;
const ENRICH_CATALOG_TITLES = process.env.ENRICH_CATALOG_TITLES !== "0";
const MAX_TITLE_ENRICH_CONCURRENCY = Number(process.env.MAX_TITLE_ENRICH_CONCURRENCY || 4);

const DEBUG_STREAM = process.env.DEBUG_STREAM === "1";
const DEBUG_STREAM_SNIPPETS = process.env.DEBUG_STREAM_SNIPPETS === "1";

// If /proxy is used manually, do not send video bytes through the outbound proxy.
const SEGMENT_RE = /\.(ts|aac|m4s|woff2)(\?|$)/i;

const ID_PREFIX = "ab:"; // change per addon: "pb:", "cb:", etc.

function ownsId(id) {
  return typeof id === "string" && id.startsWith(ID_PREFIX);
}

async function doFetch(url, opts = {}, useProxy = true) {
  const options = { redirect: "follow", ...opts };
  if (useProxy && proxyAgent) options.agent = proxyAgent;
  return fetch(url, options);
}

// Archivebate category/tag slugs — update these to match the site's actual tag URLs
const GENRE_TAG_SLUGS = {
  "YouTube": "platform/eW91dHViZQ==",
  "Twitch": "platform/dHdpdGNo",
  "OnlyFans": "platform/b25seWZhbnM=",
  "Instagram": "platform/aW5zdGFncmFt",
  "TikTok": "platform/dGlrdG9r",
  "Bongacams": "platform/Ym9uZ2FjYW1z",
  "Cam4": "platform/Y2FtNA==",
  "Camsoda": "platform/Y2Ftc29kYQ==",
  "Chaturbate": "platform/Y2hhdHVyYmF0ZQ==",
  "Stripchat": "platform/c3RyaXBjaGF0",
  "Female": "gender/ZmVtYWxl",
  "Couple": "gender/Y291cGxl",
  "Male": "gender/bWFsZQ==",
  "Trans": "gender/dHJhbnM=",
};

const manifest = {
  id: "community.archivebate.vod",
  version: "1.0.0",
  name: "[18+] Archivebate",
  description: "18+ adult videos scraped from archivebate.com.",
  logo: "https://archivebate.com/favicon.ico",
  types: ["movie"],
  resources: ["catalog", { name: "meta", types: ["movie"] }, { name: "stream", types: ["movie"] }],
  idPrefixes: ["ab:"],
  catalogs: [
    {
      type: "movie",
      id: "latest",
      name: "AB Latest Videos",
      extra: [
        {
          name: "genre",
          isRequired: false,
          options: [
            "Amateur",
            "Asian",
            "BBW",
            "Big Tits",
            "Blonde",
            "Brunette",
            "Chaturbate",
            "Latina",
            "Lesbian",
            "MILF",
            "OnlyFans",
            "Redhead",
            "Teen",
          ],
        },
        { name: "skip", isRequired: false },
        { name: "search", isRequired: false },
      ],
      behaviorHints: { adult: true, configurable: false, configurationRequired: false },
    },
  ],
};

const builder = new addonBuilder(manifest);
const metaCache = new Map();
const catalogCache = new Map();

// Starts lightweight stream resolving as soon as Stremio opens the meta page.
const ENABLE_META_STREAM_PREWARM = process.env.ENABLE_META_STREAM_PREWARM !== "0";
const streamPrewarmPromises = new Map();

function hasFreshResolvedStreams(id) {
  const cached = metaCache.get(id);

  return (
    cached &&
    cached.videoUrls &&
    cached.videoUrls.length > 0 &&
    Date.now() - cached.updatedAt < STREAM_CACHE_MS
  );
}

function startStreamPrewarm(id, snapshot = null) {
  if (!ENABLE_META_STREAM_PREWARM) return null;

  if (hasFreshResolvedStreams(id)) {
    console.log(`[prewarm] stream cache already fresh for ${id}`);
    return Promise.resolve(metaCache.get(id));
  }

  const existing = streamPrewarmPromises.get(id);
  if (existing) {
    console.log(`[prewarm] already running for ${id}`);
    return existing;
  }

  console.log(`[prewarm] starting lightweight stream resolve for ${id}`);

  const runPrewarm = async () => {
    // Best path: reuse the HTML already fetched by metadata.
    if (snapshot && snapshot.html && snapshot.pageUrl) {
  const videoUrls = await resolveVideoUrlsFromHtml(
    snapshot.html,
    snapshot.pageUrl,
    snapshot.videoId,
    snapshot.cookieStr || ""
  );

  const externalPlayerUrls = extractExternalPlayerUrlsFromHtml(
    snapshot.html,
    snapshot.pageUrl
  );

  const result = {
    meta: snapshot.meta || null,
    videoUrl: videoUrls[0] || null,
    videoUrls,
    externalPlayerUrls,
    cookieStr: snapshot.cookieStr || "",
    updatedAt: Date.now(),
  };

      metaCache.set(id, result);
      return result;
    }

    // Fallback path for cached metadata that does not have HTML attached.
    return scrapeMetaById(id, { resolveStreams: true });
  };

  const promise = runPrewarm()
    .then(result => {
      console.log(
        `[prewarm] done for ${id}: ${result?.videoUrls?.length || 0} playable URL(s)`
      );
      return result;
    })
    .catch(err => {
      console.warn(`[prewarm] failed for ${id}: ${err.message}`);
      return null;
    })
    .finally(() => {
      streamPrewarmPromises.delete(id);
    });

  streamPrewarmPromises.set(id, promise);
  return promise;
}

setInterval(() => {
  const now = Date.now();

  for (const [key, val] of metaCache.entries()) {
    if (now - val.updatedAt > 60 * 60 * 1000) metaCache.delete(key);
  }

  for (const [key, val] of catalogCache.entries()) {
    if (val.expiresAt <= now) catalogCache.delete(key);
  }
}, 15 * 60 * 1000);

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Referer": BASE_URL + "/",
};

const VIDEO_HEADERS = {
  "User-Agent": HEADERS["User-Agent"],
  "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": BASE_URL + "/",
  "Origin": BASE_URL,
};

function absoluteUrl(url, base = BASE_URL) {
  if (!url) return null;
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url, extraHeaders = {}) {
  console.log(`[fetchHtml] GET ${url} (proxy=${!!proxyAgent})`);
  const res = await doFetch(url, { headers: { ...HEADERS, ...extraHeaders } }, true);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchHtmlWithCookies(url, extraHeaders = {}) {
  console.log(`[fetchHtml] GET ${url} (proxy=${!!proxyAgent})`);

  const res = await doFetch(
    url,
    {
      headers: { ...HEADERS, ...extraHeaders },
    },
    true
  );

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const html = await res.text();
  const cookieStr = getSetCookiePairs(res);

  return { html, cookieStr };
}

function decodeHtmlAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractCsrfToken(html) {
  const $ = cheerio.load(html);

  return (
    $("meta[name='csrf-token']").attr("content") ||
    $("input[name='_token']").attr("value") ||
    (() => {
      const m =
        html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)/i) ||
        html.match(/csrf-token["']?\s*content=["']([^"']+)/i) ||
        html.match(/window\.livewire_token\s*=\s*["']([^"']+)/i);
      return m?.[1] || "";
    })()
  );
}

function extractLivewireInitialData(html) {
  const $ = cheerio.load(html);

  const node = $("[wire\\:initial-data][wire\\:init]").first();
  if (!node.length) {
    console.log("[livewire] no wire:initial-data node found");
    return null;
  }

  const initMethod = node.attr("wire:init") || "loadVideos";
  const rawInitialData = decodeHtmlAttr(node.attr("wire:initial-data"));

  try {
    const initialData = JSON.parse(rawInitialData);

    console.log(
      `[livewire] found component name=${initialData?.fingerprint?.name || "(unknown)"} ` +
      `id=${initialData?.fingerprint?.id || "(unknown)"} init=${initMethod}`
    );

    return { initialData, initMethod };
  } catch (err) {
    console.warn(`[livewire] failed to parse wire:initial-data: ${err.message}`);
    console.warn(`[livewire] raw initial data sample: ${rawInitialData.substring(0, 500)}`);
    return null;
  }
}

async function fetchLivewireInitializedHtml(pageHtml, pageUrl, cookieStr = "") {
  const extracted = extractLivewireInitialData(pageHtml);
  if (!extracted) return "";

  const { initialData, initMethod } = extracted;
  const componentName = initialData?.fingerprint?.name;
  const componentId = initialData?.fingerprint?.id;

  if (!componentName || !componentId) {
    console.warn("[livewire] missing component name/id");
    return "";
  }

  const csrfToken = extractCsrfToken(pageHtml);

  console.log(`[livewire] csrf=${csrfToken ? "found" : "missing"}`);

  const endpoint = `${BASE_URL}/livewire/message/${componentName}`;

  const payload = {
    fingerprint: initialData.fingerprint,
    serverMemo: initialData.serverMemo,
    updates: [
      {
        type: "callMethod",
        payload: {
          id: componentId,
          method: initMethod,
          params: [],
        },
      },
    ],
  };

  console.log(`[livewire] POST ${endpoint} method=${initMethod}`);

  const res = await doFetch(
    endpoint,
    {
      method: "POST",
      headers: {
        ...HEADERS,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-Livewire": "true",
        "Referer": pageUrl,
        "Origin": BASE_URL,
        ...(csrfToken ? { "X-CSRF-TOKEN": csrfToken } : {}),
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
      body: JSON.stringify(payload),
    },
    true
  );

  const text = await res.text();

  console.log(`[livewire] status=${res.status} bodyLen=${text.length}`);

  if (!res.ok) {
    console.warn(`[livewire] failed body sample: ${text.substring(0, 1000)}`);
    return "";
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.warn(`[livewire] JSON parse failed: ${err.message}`);
    console.warn(`[livewire] body sample: ${text.substring(0, 1000)}`);
    return "";
  }

  const hydratedHtml = json?.effects?.html || "";
  console.log(`[livewire] hydrated html length=${hydratedHtml.length}`);

  return hydratedHtml;
}

function isFallbackArchivebateTitle(title) {
  return /^Archivebate Video \d+$/i.test(cleanCatalogText(title));
}

function cleanArchivebatePageTitle(value, fallback = "") {
  let title = cleanCatalogText(value);

  title = title
    .replace(/\s*[-|–]\s*Archivebate.*$/i, "")
    .replace(/^Archivebate\s*[-|–]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title || isBadCatalogTitle(title) || /^Archivebate$/i.test(title)) {
    return fallback;
  }

  return title.substring(0, 180);
}

async function fetchTitleFromWatchPage(meta) {
  if (!meta || !meta.website) return meta;
  if (!isFallbackArchivebateTitle(meta.name)) return meta;

  const cacheKey = meta.id || meta.website;
  const cached = catalogTitleCache.get(cacheKey);

  if (cached && Date.now() - cached.updatedAt < CATALOG_TITLE_CACHE_MS) {
    return {
      ...meta,
      name: cached.title || meta.name,
      description: cached.description || meta.description,
    };
  }

  try {
    console.log(`[title] fetching ${meta.website}`);

    const res = await doFetch(
      meta.website,
      {
        headers: {
          ...HEADERS,
          Referer: BASE_URL + "/",
        },
      },
      true
    );

    if (!res.ok) {
      console.warn(`[title] HTTP ${res.status} for ${meta.website}`);
      return meta;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const fallback = meta.name;

    const title = cleanArchivebatePageTitle(
      $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("meta[name='title']").attr("content") ||
      $("h1").first().text() ||
      $("title").first().text(),
      fallback
    );

    const description = cleanCatalogText(
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      meta.description ||
      ""
    ).substring(0, 240);

    catalogTitleCache.set(cacheKey, {
      title,
      description,
      updatedAt: Date.now(),
    });

    if (process.env.DEBUG_CATALOG_ITEMS === "1") {
      console.log(`[title-debug] ${meta.id}: "${fallback}" -> "${title}"`);
    }

    return {
      ...meta,
      name: title || meta.name,
      description: description || meta.description,
    };
  } catch (err) {
    console.warn(`[title] failed for ${meta.website}: ${err.message}`);
    return meta;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await mapper(items[idx], idx);
      }
    }
  );

  await Promise.all(workers);
  return out;
}

async function enrichCatalogTitles(metas) {
  if (!ENRICH_CATALOG_TITLES) return metas;

  const needsEnrich = metas.some(meta => isFallbackArchivebateTitle(meta.name));
  if (!needsEnrich) return metas;

  console.log(`[title] enriching fallback titles for ${metas.length} catalog items`);

  return await mapWithConcurrency(
    metas,
    MAX_TITLE_ENRICH_CONCURRENCY,
    fetchTitleFromWatchPage
  );
}

async function fetchCatalogMetasFromLivewirePage(url) {
  const { html, cookieStr } = await fetchHtmlWithCookies(url);

  debugCatalogHtml(html, url);

  let metas = extractPostCards(html, url);
  if (metas.length > 0) return await enrichCatalogTitles(metas);

  console.log("[catalog] no static watch links; trying Livewire hydration");

  const hydratedHtml = await fetchLivewireInitializedHtml(html, url, cookieStr);

  if (hydratedHtml) {
    metas = extractPostCards(hydratedHtml, url);

    console.log(`[catalog] Livewire extractPostCards found ${metas.length} video items`);

    if (metas.length > 0) return await enrichCatalogTitles(metas);
  }

  return [];
}

function cleanSlugPath(value) {
  return String(value || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/null$/i, "");
}

function makeIdFromPath(pathname) {
  return `ab:${cleanSlugPath(pathname)}`;
}

function decodeId(id) {
  return cleanSlugPath(String(id || "").replace(/^ab:/, ""));
}

function getSetCookiePairs(res) {
  return (res.headers.raw?.()?.["set-cookie"] || [])
    .map(c => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(...cookieStrings) {
  const jar = new Map();

  for (const cookieString of cookieStrings) {
    String(cookieString || "")
      .split(";")
      .map(c => c.trim())
      .filter(Boolean)
      .forEach(pair => {
        const eq = pair.indexOf("=");
        if (eq <= 0) return;
        jar.set(pair.slice(0, eq), pair);
      });
  }

  return [...jar.values()].join("; ");
}

function qualityPreferenceCookies(slug) {
  const slugOnly = slug.replace(/^videos\//, "");
  const ktQParams = `dir%3D${encodeURIComponent(slugOnly)}`;

  return [
    "kt_browser_res=1920x1080",
    "kt_is_visited=1",
    "kt_tcookie=1",
    `kt_qparams=${ktQParams}`,
  ].join("; ");
}

const BAD_CATALOG_TITLE_RE = /^(home|about|contact|blog|videos?|models?|categories?|tags?|search|login|register|privacy|terms|dmca|sitemap|upload and earn|verified|male|female|become a model|affiliate program|advertise|members?|join|sign up|signup)$/i;
const BAD_CATALOG_SLUG_RE = /^(home|about|contact|blog|videos?|models?|categories?|tags?|search|login|register|privacy|terms|dmca|sitemap|upload-and-earn|verified|male|female|become-a-model|affiliate-program|advertise|members?|join|sign-up|signup)$/i;

function cleanCatalogText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
    .trim();
}

function titleFromVideoSlug(slug) {
  return cleanCatalogText(
    String(slug || "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
  );
}

// Archivebate video URLs look like:
//   https://archivebate.com/videos/some-video-slug/
//   https://archivebate.com/video/some-video-slug/
// Accept both /videos/ and /video/ prefixes (one segment or two).
function isRealVideoPath(pathname) {
  const path = cleanSlugPath(pathname);
  const segments = path.split("/").filter(Boolean);

  if (segments.length !== 2) return false;

  const prefix = segments[0].toLowerCase();
  const value = segments[1];

  if (prefix === "watch") {
    return /^\d{4,}$/.test(value);
  }

  if (["videos", "video"].includes(prefix)) {
    if (!value) return false;
    if (/^\d+$/.test(value)) return false;
    if (!value.includes("-")) return false;
    if (value.length < 5) return false;
    if (BAD_CATALOG_SLUG_RE.test(value)) return false;
    return true;
  }

  return false;
}

function firstSrcsetUrl(srcset) {
  if (!srcset) return null;

  return String(srcset)
    .split(",")
    .map(x => x.trim().split(/\s+/)[0])
    .find(Boolean) || null;
}

function extractCssUrl(style) {
  if (!style) return null;

  const m = String(style).match(/url\((['"]?)(.*?)\1\)/i);
  return m?.[2] || null;
}

function isUsablePosterUrl(url) {
  if (!url) return false;

  const s = String(url);

  if (/^data:/i.test(s)) return false;
  if (/\.(mp4|webm|m3u8)(?:[?#]|$)/i.test(s)) return false;
  if (/(placeholder|avatar|logo|icon|blank|spacer|pixel)/i.test(s)) return false;

  return true;
}

function collectImageCandidatesFromNode($, node, baseUrl) {
  const out = [];
  const add = value => {
    const abs = absoluteUrl(value, baseUrl);
    if (abs && isUsablePosterUrl(abs)) out.push(abs);
  };

  const attrs = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-thumb",
    "data-thumbnail",
    "data-image",
    "data-bg",
    "data-background",
    "poster",
    "src",
  ];

  for (const attr of attrs) {
    add(node.attr(attr));
  }

  add(firstSrcsetUrl(node.attr("data-srcset")));
  add(firstSrcsetUrl(node.attr("srcset")));
  add(extractCssUrl(node.attr("style")));

  return out;
}

function findPosterImage($, scope, baseUrl) {
  const candidates = [];

  const addMany = arr => {
    for (const item of arr) {
      if (item && !candidates.includes(item)) candidates.push(item);
    }
  };

  // Check the scope itself first.
  scope.each((_, el) => {
    addMany(collectImageCandidatesFromNode($, $(el), baseUrl));
  });

  // Then check common image/lazy/background nodes inside it.
  scope
    .find(
      [
        "img",
        "picture source",
        "video",
        "[style]",
        "[data-src]",
        "[data-lazy-src]",
        "[data-original]",
        "[data-thumb]",
        "[data-thumbnail]",
        "[data-image]",
        "[data-bg]",
        "[data-background]",
        "[poster]",
      ].join(", ")
    )
    .each((_, el) => {
      addMany(collectImageCandidatesFromNode($, $(el), baseUrl));
    });

  return candidates[0] || null;
}

function isBadCatalogTitle(title) {
  const t = cleanCatalogText(title);

  if (!t) return true;
  if (t.length < 3) return true;
  if (/^\d+$/.test(t)) return true;
  if (BAD_CATALOG_TITLE_RE.test(t)) return true;
  if (/^(watch|view|play|loading|recent videos|recently uploaded)$/i.test(t)) return true;
  if (/^#/.test(t)) return true;

  return false;
}

function pickCatalogTitle(candidates, fallbackTitle) {
  const cleaned = [];

  for (const candidate of candidates) {
    const t = cleanCatalogText(candidate)
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (isBadCatalogTitle(t)) continue;
    if (!cleaned.includes(t)) cleaned.push(t);
  }

  if (cleaned.length === 0) return fallbackTitle;

  cleaned.sort((a, b) => {
    const aScore =
      Math.min(a.length, 120) +
      (a.includes(" ") ? 20 : 0) -
      (/^archivebate video \d+$/i.test(a) ? 100 : 0);

    const bScore =
      Math.min(b.length, 120) +
      (b.includes(" ") ? 20 : 0) -
      (/^archivebate video \d+$/i.test(b) ? 100 : 0);

    return bScore - aScore;
  });

  return cleaned[0].substring(0, 180);
}

function extractPostCards(html, baseUrl) {
  const $ = cheerio.load(html);
  const siteBase = baseUrl || BASE_URL;

  const siteHostname = (() => {
    try {
      return new URL(siteBase).hostname;
    } catch {
      return "";
    }
  })();

  const results = [];
  const seenVideoPaths = new Set();

  function parseUrlFromHref(rawHref) {
    if (!rawHref) return null;

    try {
      const u = new URL(rawHref, siteBase);
      if (u.hostname !== siteHostname) return null;
      if (!isRealVideoPath(u.pathname)) return null;
      return u;
    } catch {
      return null;
    }
  }

  function addCard(container, primaryLink) {
    const href = primaryLink.attr("href");
    const u = parseUrlFromHref(href);
    if (!u) return;

    const pathKey = cleanSlugPath(u.pathname);
    if (seenVideoPaths.has(pathKey)) return;

    const slug = pathKey.split("/").pop();
    const isWatchId = /^watch\/\d+$/i.test(pathKey);
    const fallbackTitle = isWatchId
      ? `Archivebate Video ${slug}`
      : titleFromVideoSlug(slug);

    // Important: collect all links in the same card pointing to the same watch URL.
    // Archivebate often has one link around the thumbnail and another around the title.
    const samePathLinks = container.find("a[href]").filter((_, el) => {
      const candidateUrl = parseUrlFromHref($(el).attr("href"));
      return candidateUrl && cleanSlugPath(candidateUrl.pathname) === pathKey;
    });

    const imgNode =
      samePathLinks.find("img").first().length
        ? samePathLinks.find("img").first()
        : container.find("img").first();

    const titleCandidates = [
      container.attr("data-title"),
      container.attr("aria-label"),
      primaryLink.attr("title"),
      primaryLink.attr("aria-label"),
      imgNode.attr("alt"),
      imgNode.attr("title"),

      ...samePathLinks
        .map((_, el) => $(el).attr("title"))
        .get(),

      ...samePathLinks
        .map((_, el) => $(el).attr("aria-label"))
        .get(),

      ...samePathLinks
        .map((_, el) => $(el).text())
        .get(),

      ...container
        .find(
          [
            ".title",
            ".video-title",
            ".name",
            ".video-name",
            ".username",
            "[class*='title']",
            "[class*='name']",
            "[itemprop='name']",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
          ].join(", ")
        )
        .map((_, el) => $(el).text())
        .get(),

      fallbackTitle,
    ];

    const title = pickCatalogTitle(titleCandidates, fallbackTitle);

    const rawImg =
      findPosterImage($, samePathLinks, siteBase) ||
      findPosterImage($, primaryLink, siteBase) ||
      findPosterImage($, container, siteBase);

    const img =
      rawImg && PROXY_IMAGES && PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL}/imgproxy?url=${encodeURIComponent(rawImg)}`
        : rawImg || undefined;

    const description = cleanCatalogText(
      container
        .find("[class*='desc'], [class*='excerpt'], [class*='summary'], p")
        .first()
        .text()
    ).substring(0, 200);

    const date =
      container.find("time").attr("datetime") ||
      cleanCatalogText(container.find("[class*='date'], [class*='time']").first().text());

    seenVideoPaths.add(pathKey);

    results.push({
      id: makeIdFromPath(pathKey),
      type: "movie",
      name: title,
      poster: img,
      posterShape: "landscape",
      background: img,
      description: [date, description].filter(Boolean).join(" • "),
      website: u.toString(),
    });

    if (process.env.DEBUG_CATALOG_ITEMS === "1" && results.length <= 5) {
      console.log(
        `[catalog-debug] item ${results.length}: id=${makeIdFromPath(pathKey)} title="${title}" img=${img || "(none)"}`
      );
    }
  }

  // First pass: parse actual card containers.
  $(
    [
      ".video_item",
      ".video-item",
      ".video-card",
      ".video",
      ".item",
      ".card",
      ".thumb",
      ".thumbnail",
      "article",
      "[class*='video_item']",
      "[class*='video-item']",
      "[class*='video']",
      "[class*='thumb']",
    ].join(", ")
  ).each((_, el) => {
    const container = $(el);

    const primaryLink = container.find("a[href]").filter((_, linkEl) => {
      return !!parseUrlFromHref($(linkEl).attr("href"));
    }).first();

    if (primaryLink.length) {
      addCard(container, primaryLink);
    }
  });

  // Fallback pass: parse loose anchors that were not inside a matched card.
  $("a[href]").each((_, el) => {
    const a = $(el);
    const u = parseUrlFromHref(a.attr("href"));
    if (!u) return;

    const pathKey = cleanSlugPath(u.pathname);
    if (seenVideoPaths.has(pathKey)) return;

    const container = a.closest(
      [
        ".video_item",
        ".video-item",
        ".video-card",
        ".video",
        ".item",
        ".card",
        ".thumb",
        ".thumbnail",
        "article",
        "[class*='video_item']",
        "[class*='video-item']",
        "[class*='video']",
        "[class*='thumb']",
      ].join(", ")
    );

    addCard(container.length ? container : a, a);
  });

  console.log(`[catalog] extractPostCards found ${results.length} video items`);
  return results.slice(0, CATALOG_ITEM_LIMIT);
}

function debugCatalogHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  const hrefs = $("a[href]")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(Boolean);

  const watchHrefs = hrefs.filter(h => /\/watch\/\d+/i.test(h));

  const scripts = $("script[src]")
    .map((_, el) => absoluteUrl($(el).attr("src"), baseUrl))
    .get()
    .filter(Boolean);

  console.log(`[debug] html length=${html.length}`);
  console.log(`[debug] total hrefs=${hrefs.length}`);
  console.log(`[debug] hrefs=${hrefs.slice(0, 80).join(" | ") || "(none)"}`);
  console.log(`[debug] watch hrefs=${watchHrefs.length}: ${watchHrefs.slice(0, 20).join(", ") || "(none)"}`);
  console.log(`[debug] script srcs=${scripts.length}: ${scripts.slice(0, 20).join(", ") || "(none)"}`);

  const markers = [
    "wire:id",
    "wire:initial-data",
    "livewire",
    "Livewire",
    "Recent Videos",
    "Loading...",
    "/watch/",
    "platform/",
    "archivebate.min.js",
  ];

  for (const marker of markers) {
    const idx = html.indexOf(marker);
    console.log(`[debug] marker "${marker}" idx=${idx}`);
    if (idx >= 0) {
      const start = Math.max(0, idx - 600);
      const end = Math.min(html.length, idx + 1200);
      console.log(`[debug] snippet around "${marker}": ${html.slice(start, end).replace(/\s+/g, " ").substring(0, 1800)}`);
    }
  }

  const livewireNodes = $("[wire\\:id], [wire\\:initial-data], [wire\\:snapshot], [wire\\:effects]");
  console.log(`[debug] livewire nodes=${livewireNodes.length}`);

  livewireNodes.each((i, el) => {
    if (i >= 5) return;

    const node = $(el);
    console.log(`[debug] livewire node ${i} tag=${el.tagName || el.name || "unknown"}`);
    console.log(`[debug] livewire node ${i} attrs=${JSON.stringify(el.attribs || {}).substring(0, 2000)}`);
    console.log(`[debug] livewire node ${i} text=${cleanCatalogText(node.text()).substring(0, 500)}`);
  });
}

async function fetchCatalogPage(_catalogId, skip = 0, search = "", genre = "") {
  const page = Math.floor((Number(skip) || 0) / CATALOG_ITEM_LIMIT) + 1;

  if (search) {
    // Archivebate search URL patterns — try both common patterns
    const searchUrls = [
      `${BASE_URL}/?s=${encodeURIComponent(search)}${page > 1 ? `&page=${page}` : ""}`,
      `${BASE_URL}/search/${encodeURIComponent(search)}${page > 1 ? `/?page=${page}` : "/"}`,
    ];

    for (const url of searchUrls) {
      try {
        const html = await fetchHtml(url);
        const metas = extractPostCards(html, url);
        if (metas.length > 0) return metas;
      } catch (err) {
        console.warn(`Search fetch failed: ${url} -> ${err.message}`);
      }
    }

    throw new Error("No search results could be fetched");
  }

  if (genre && GENRE_TAG_SLUGS[genre]) {
  const route = GENRE_TAG_SLUGS[genre];

  const genreUrl = page <= 1
    ? `${BASE_URL}/${route}`
    : `${BASE_URL}/${route}?page=${page}`;

  try {
    console.log(`[catalog] fetching genre "${genre}" from ${genreUrl}`);

    const metas = await fetchCatalogMetasFromLivewirePage(genreUrl);

    if (metas.length > 0) {
      return metas;
    }

    console.warn(`[catalog] genre "${genre}" returned no video metas from ${genreUrl}`);
    return [];
  } catch (err) {
    console.warn(`[catalog] genre "${genre}" fetch failed: ${genreUrl} -> ${err.message}`);
    return [];
  }
}

  // Archivebate main catalog pagination: /?page=2, /?page=3, etc.
  const catalogUrl = page <= 1
  ? `${BASE_URL}/`
  : `${BASE_URL}/?page=${page}`;

try {
  const metas = await fetchCatalogMetasFromLivewirePage(catalogUrl);

  if (metas.length > 0) {
    return metas;
  }

  throw new Error(`No metas found on ${catalogUrl}`);
} catch (err) {
  console.warn(`Catalog fetch failed: ${catalogUrl} -> ${err.message}`);
  throw err;
}
}

function extractVideoIdFromHtml(html) {
  const patterns = [
    /\/embed\/(\d+)/i,
    /video_id["']?\s*[:=]\s*["']?(\d+)/i,
    /videoId["']?\s*[:=]\s*["']?(\d+)/i,
    /video-id=["']?(\d+)/i,
    /\/videos_screenshots\/\d+\/(\d+)\//i,
    /\/get_file\/\d+\/[^/]+\/\d+\/(\d+)\//i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }

  return null;
}

function urlBelongsToVideo(url, videoId) {
  if (!videoId) return true;

  let decoded = String(url || "");
  try { decoded = decodeURIComponent(decoded); } catch {}

  return (
    decoded.includes(`/${videoId}/`) ||
    decoded.includes(`_${videoId}_`) ||
    decoded.includes(`/embed/${videoId}`) ||
    decoded.includes(`${videoId}_ab_`) ||
    decoded.includes(`${videoId}_preview`) ||
    decoded.includes(`/${videoId}_`)
  );
}

function isPreviewOrThumbMp4(url) {
  let decoded = String(url || "");
  try { decoded = decodeURIComponent(decoded); } catch {}
  return /(preview_ab|_preview\.mp4|videos_screenshots|thumb|poster|listing|webp)/i.test(decoded);
}

function decodeEscapedMediaString(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/")
    .trim();
}

function unwrapKvsFunctionUrl(value) {
  let v = decodeEscapedMediaString(value);

  const m = v.match(/^function\/\d+\/(https?:\/\/.+)$/i);
  if (m) v = m[1];

  v = v.replace(/^[`'"]+|[`'"]+$/g, "");
  v = v.replace(/[),;]+$/g, "");
  return v;
}

function getQualityFromUrlOrText(url, text = "") {
  const s = `${decodeEscapedMediaString(url)} ${decodeEscapedMediaString(text)}`;
  if (/_1080p\.mp4/i.test(s) || /\b1080p\b/i.test(s)) return "1080p";
  if (/_720p\.mp4/i.test(s) || /\b720p\b/i.test(s)) return "720p";
  if (/_480p\.mp4/i.test(s) || /\b480p\b/i.test(s)) return "480p";
  if (/_360p\.mp4/i.test(s) || /\b360p\b/i.test(s)) return "360p";
  if (/\.mp4\/?(?:[?#]|$)/i.test(s)) return "480p";
  return "HD";
}

function qualityRank(q) {
  return {
    "1080p": 0,
    "720p": 1,
    "480p": 2,
    "360p": 3,
    "HD": 4,
  }[q] ?? 99;
}

function getQualSuffix(u) {
  let decoded = decodeEscapedMediaString(u);
  try { decoded = decodeURIComponent(decoded); } catch {}
  const m = decoded.match(/_(1080p|720p|480p|360p)\.mp4\/?(?:[?#]|$)/i);
  return m ? `_${m[1].toLowerCase()}.mp4` : ".mp4";
}

function getGetFileHash(url) {
  const m = String(url || "").match(/\/get_file\/\d+\/([^/]+)\//i);
  return m ? m[1] : "";
}

function extractKvsPlayerSources(html, videoId = null) {
  const text = decodeEscapedMediaString(html);
  const out = [];
  const seen = new Set();

  const urlRe = /\b(video_url|video_alt_url\d*)\s*:\s*(['"`])((?:\\.|(?!\2).)*?)\2/gi;

  for (const m of text.matchAll(urlRe)) {
    const key = m[1];
    const rawValue = m[3];
    const unwrapped = unwrapKvsFunctionUrl(rawValue);

    if (!/^https?:\/\//i.test(unwrapped)) continue;
    if (!/\/get_file\//i.test(unwrapped)) continue;
    if (!/\.mp4\/?(?:[?#]|$)/i.test(unwrapped)) continue;
    if (isPreviewOrThumbMp4(unwrapped)) continue;
    if (!urlBelongsToVideo(unwrapped, videoId)) continue;

    const textKey = `${key}_text`;
    const textRe = new RegExp(
      "\\b" + textKey + "\\s*:\\s*([\"'`])((?:\\\\.|(?!\\1).)*?)\\1",
      "i"
    );
    const textMatch = text.match(textRe);
    const qualityText = textMatch ? textMatch[2] : "";

    const quality = getQualityFromUrlOrText(unwrapped, qualityText);
    const hash = getGetFileHash(unwrapped);
    const dedupeKey = `${quality}:${hash}:${unwrapped}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ key, quality, hash, source: `kvs:${key}`, url: unwrapped });
  }

  out.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
  return out;
}

function collectRawGetFileCandidates(text, videoId = null, sourceLabel = "raw-html") {
  const normalized = decodeEscapedMediaString(text);
  const out = [];
  const seen = new Set();

  const add = (raw, source) => {
    let u = unwrapKvsFunctionUrl(raw);
    u = decodeEscapedMediaString(u).replace(/[),;'"<>]+$/g, "");

    if (!/^https?:\/\//i.test(u)) return;
    if (!/\/get_file\//i.test(u)) return;
    if (!/\.mp4\/?(?:[?#]|$)/i.test(u)) return;
    if (isPreviewOrThumbMp4(u)) return;
    if (!urlBelongsToVideo(u, videoId)) return;

    const quality = getQualityFromUrlOrText(u);
    const hash = getGetFileHash(u);
    const key = `${quality}:${hash}:${u}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ quality, hash, source, url: u });
  };

  const patterns = [
    /https?:\/\/[^"'\\s<>]+\/get_file\/[^"'\\s<>]+\.mp4\/?(?:[?#][^"'\\s<>]*)?/gi,
    /function\/\d+\/https?:\/\/[^"'\\s<>]+\/get_file\/[^"'\\s<>]+\.mp4\/?/gi,
  ];

  for (const re of patterns) {
    for (const m of normalized.matchAll(re)) {
      add(m[0], sourceLabel);
    }
  }

  for (const src of extractKvsPlayerSources(normalized, videoId)) {
    add(src.url, src.source);
  }

  out.sort((a, b) => {
    const q = qualityRank(a.quality) - qualityRank(b.quality);
    if (q !== 0) return q;
    return a.hash.localeCompare(b.hash);
  });

  return out;
}

function addRndParam(url) {
  const base = decodeEscapedMediaString(url);

  try {
    const u = new URL(base);
    u.searchParams.set("rnd", String(Date.now()));
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}rnd=${Date.now()}`;
  }
}

async function resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId) {
  const referers = videoId
    ? [`${BASE_URL}/embed/${videoId}`, pageUrl]
    : [pageUrl];

  for (const referer of referers) {
    const resolveUrl = addRndParam(candidate.url);
    console.log(
  `[resolve] trying ${candidate.quality} ${candidate.hash || "nohash"}: ` +
  `${redactSensitive(resolveUrl)} ref=${redactSensitive(referer)}`
);

    let res = null;
    try {
      res = await doFetch(resolveUrl, {
        headers: {
          "User-Agent": HEADERS["User-Agent"],
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity;q=1, *;q=0",
          "Range": "bytes=0-0",
          "Referer": referer,
          "Origin": BASE_URL,
          ...(cookieStr ? { Cookie: cookieStr } : {}),
          "Sec-Fetch-Dest": "video",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-origin",
        },
        redirect: "manual",
      }, true);

      const location = res.headers.get("location");
      const contentType = res.headers.get("content-type") || "";
      const contentRange = res.headers.get("content-range") || "";
      const acceptRanges = res.headers.get("accept-ranges") || "";
      const status = res.status;

      res.body?.destroy?.();

      console.log(`[resolve] status=${status} location=${location ? redactSensitive(location) : "(none)"}`);

      if (location) {
        const resolved = new URL(location, resolveUrl).toString();
        let decoded = resolved;
        try { decoded = decodeURIComponent(resolved); } catch {}

        if (/\/remote_control\.php\?/i.test(resolved) && /\.mp4/i.test(decoded)) {
          console.log(`[resolve] ✅ ${candidate.quality} remote_control: ${decoded}`);
          return resolved;
        }

        if (/\.mp4(?:[?#]|$)/i.test(decoded)) {
          console.log(`[resolve] ✅ ${candidate.quality} direct mp4 redirect: ${decoded}`);
          return resolved;
        }
      }

      const looksLikeMedia =
        /video|octet-stream/i.test(contentType) ||
        /bytes/i.test(contentRange) ||
        /bytes/i.test(acceptRanges);

      if ((status === 200 || status === 206) && looksLikeMedia) {
        console.log(`[resolve] ✅ ${candidate.quality} get_file itself appears playable`);
        return resolveUrl;
      }
    } catch (e) {
      res?.body?.destroy?.();
      console.log(`[resolve] error for ${candidate.quality}: ${e.message}`);
    }
  }

  console.log(`[resolve] ❌ unusable ${candidate.quality}: ${candidate.url}`);
  return null;
}

function getFilePathForDedupe(u) {
  try {
    const match = String(u || "").match(/[?&]file=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : String(u || "");
  } catch {
    return String(u || "");
  }
}

function dedupeUrls(urls) {
  const seenPaths = new Set();

  return urls.filter(u => {
    const path = getFilePathForDedupe(u);
    if (seenPaths.has(path)) return false;
    seenPaths.add(path);
    return true;
  });
}

async function resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr) {
	debugCandidateScan(html, videoId);
  const candidates = collectRawGetFileCandidates(html, videoId, "raw-html");

  console.log(`[meta] get_file candidates: ${candidates.map(c => `${c.quality}:${c.hash || "nohash"}:${c.source}`).join(", ") || "(none)"}`);

  const resolveList = candidates.slice(0, MAX_RESOLVE_CANDIDATES);

  console.log(
    `[meta] raw resolve list: ${
      resolveList.map(c => `${c.quality}:${getQualSuffix(c.url)}`).join(", ") || "(none)"
    } (kept ${resolveList.length}/${candidates.length})`
  );

  const videoUrls = [];

  for (const candidate of resolveList) {
    const resolved = await resolveGetFileCandidate(candidate, pageUrl, cookieStr, videoId);
    if (resolved) {
      videoUrls.push(resolved);
      break;
    }
  }

  const finalDeduped = dedupeUrls(videoUrls);
  console.log(`[meta] resolved ${finalDeduped.length} playable URL(s) (lightweight only)`);

  return finalDeduped;
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/([?&](?:token|hash|sig|signature|expires|time|cv|cv2|cv3|cv4|rnd|key|auth|session|file)=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/(XSRF-TOKEN=)[^;\s]+/gi, "$1[redacted]")
    .replace(/(archivebate_session=)[^;\s]+/gi, "$1[redacted]");
}

function cookieNames(cookieStr) {
  return String(cookieStr || "")
    .split(";")
    .map(x => x.trim().split("=")[0])
    .filter(Boolean)
    .join(", ") || "(none)";
}

function shortText(value, max = 500) {
  return redactSensitive(
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, max)
  );
}

function logMarkerSnippet(label, html, marker) {
  const idx = html.indexOf(marker);
  console.log(`[stream-debug] marker "${marker}" idx=${idx}`);

  if (DEBUG_STREAM_SNIPPETS && idx >= 0) {
    const start = Math.max(0, idx - 500);
    const end = Math.min(html.length, idx + 1200);
    console.log(`[stream-debug] snippet around "${marker}": ${shortText(html.slice(start, end), 1800)}`);
  }
}

function debugStreamPageHtml(html, pageUrl) {
  if (!DEBUG_STREAM) return;

  const $ = cheerio.load(html);

  console.log(`[stream-debug] pageUrl=${pageUrl}`);
  console.log(`[stream-debug] html length=${html.length}`);

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text() ||
    $("h1").first().text();

  const ogImage =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    "";

  console.log(`[stream-debug] title="${shortText(title, 240)}"`);
  console.log(`[stream-debug] ogImage=${shortText(ogImage, 300)}`);

  const scripts = $("script[src]")
    .map((_, el) => absoluteUrl($(el).attr("src"), pageUrl))
    .get()
    .filter(Boolean);

  console.log(`[stream-debug] script srcs=${scripts.length}: ${scripts.map(redactSensitive).slice(0, 30).join(" | ") || "(none)"}`);

  const iframes = $("iframe[src]")
    .map((_, el) => absoluteUrl($(el).attr("src"), pageUrl))
    .get()
    .filter(Boolean);

  console.log(`[stream-debug] iframe srcs=${iframes.length}: ${iframes.map(redactSensitive).slice(0, 20).join(" | ") || "(none)"}`);

  const videos = $("video")
    .map((_, el) => {
      const node = $(el);
      return {
        src: absoluteUrl(node.attr("src"), pageUrl),
        poster: absoluteUrl(node.attr("poster"), pageUrl),
        controls: node.attr("controls") != null,
        class: node.attr("class") || "",
        id: node.attr("id") || "",
      };
    })
    .get();

  console.log(`[stream-debug] video tags=${videos.length}: ${shortText(JSON.stringify(videos), 1500)}`);

  const sources = $("source[src]")
    .map((_, el) => ({
      src: absoluteUrl($(el).attr("src"), pageUrl),
      type: $(el).attr("type") || "",
    }))
    .get();

  console.log(`[stream-debug] source tags=${sources.length}: ${shortText(JSON.stringify(sources), 1500)}`);

  const interestingLinks = $("a[href]")
    .map((_, el) => absoluteUrl($(el).attr("href"), pageUrl))
    .get()
    .filter(Boolean)
    .filter(u => /(watch|embed|video|stream|download|file|media|mp4|m3u8)/i.test(u));

  console.log(`[stream-debug] interesting hrefs=${interestingLinks.length}: ${interestingLinks.map(redactSensitive).slice(0, 30).join(" | ") || "(none)"}`);

  const livewireNodes = $("[wire\\:id], [wire\\:initial-data], [wire\\:snapshot], [wire\\:effects]");
  console.log(`[stream-debug] livewire nodes=${livewireNodes.length}`);

  livewireNodes.each((i, el) => {
    if (i >= 5) return;

    const attrs = el.attribs || {};
    console.log(`[stream-debug] livewire node ${i} tag=${el.tagName || el.name || "unknown"}`);
    console.log(`[stream-debug] livewire node ${i} attrs=${shortText(JSON.stringify(attrs), 2000)}`);
    console.log(`[stream-debug] livewire node ${i} text="${shortText($(el).text(), 500)}"`);
  });

  const markers = [
    "/get_file/",
    "remote_control.php",
    ".mp4",
    ".m3u8",
    "video_url",
    "video_alt_url",
    "file:",
    "sources",
    "source",
    "player",
    "embed",
    "download",
    "cdn.freefile.io",
    "Livewire",
    "wire:init",
    "wire:initial-data",
  ];

  for (const marker of markers) {
    logMarkerSnippet("stream", html, marker);
  }

  const mediaLikeStrings =
    html.match(/https?:\/\/[^"'`\s<>]+(?:mp4|m3u8|get_file|remote_control|embed|stream|download|cdn\.freefile\.io)[^"'`\s<>]*/gi) || [];

  console.log(
    `[stream-debug] media-like urls=${mediaLikeStrings.length}: ` +
    `${mediaLikeStrings.map(redactSensitive).slice(0, 20).join(" | ") || "(none)"}`
  );
}

function debugCandidateScan(html, videoId) {
  if (!DEBUG_STREAM) return;

  const normalized = decodeEscapedMediaString(html);

  const counts = {
    getFile: (normalized.match(/\/get_file\//gi) || []).length,
    remoteControl: (normalized.match(/remote_control\.php/gi) || []).length,
    mp4: (normalized.match(/\.mp4/gi) || []).length,
    m3u8: (normalized.match(/\.m3u8/gi) || []).length,
    videoUrl: (normalized.match(/video_url/gi) || []).length,
    videoAltUrl: (normalized.match(/video_alt_url/gi) || []).length,
    iframe: (normalized.match(/<iframe/gi) || []).length,
    videoTag: (normalized.match(/<video/gi) || []).length,
  };

  console.log(`[stream-debug] candidate marker counts=${JSON.stringify(counts)} videoId=${videoId || "unknown"}`);

  const rawMedia = normalized.match(/https?:\/\/[^"'`\s<>]+(?:\.mp4|\.m3u8|get_file|remote_control|embed|stream|download)[^"'`\s<>]*/gi) || [];

  console.log(
    `[stream-debug] raw media-ish matches=${rawMedia.length}: ` +
    `${rawMedia.map(redactSensitive).slice(0, 20).join(" | ") || "(none)"}`
  );
}

function extractExternalPlayerUrlsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const urls = [];
  const seen = new Set();

  const add = (raw, label = "external") => {
    const abs = absoluteUrl(raw, pageUrl);
    if (!abs) return;

    // External embedded players found on Archivebate watch pages.
    if (!/(mixdrop|streamtape|dood|voe|filemoon|vidhide|streamwish|player|embed)/i.test(abs)) {
      return;
    }

    if (seen.has(abs)) return;
    seen.add(abs);

    urls.push({
      url: abs,
      label,
    });
  };

  $("iframe[src]").each((_, el) => {
    add($(el).attr("src"), "Embedded Player");
  });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (/(mixdrop|streamtape|dood|voe|filemoon|vidhide|streamwish)/i.test(href || "")) {
      add(href, "External Player");
    }
  });

  console.log(
    `[external] found ${urls.length} external player URL(s): ` +
    `${urls.map(x => redactSensitive(x.url)).join(" | ") || "(none)"}`
  );

  return urls;
}

async function scrapeMetaById(id, options = {}) {
  const resolveStreams = options.resolveStreams === true;
  const slug = decodeId(id);
  const pageUrl = absoluteUrl(`/${slug}/`);
  const prefCookies = qualityPreferenceCookies(slug);

  console.log(`[meta] fetching page: ${pageUrl}`);
  const pageRes = await doFetch(pageUrl, {
    headers: {
      ...HEADERS,
      Cookie: prefCookies,
    },
  }, true);

  if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} for ${pageUrl}`);

  const html = await pageRes.text();
  debugStreamPageHtml(html, pageUrl);
  const sessionCookies = getSetCookiePairs(pageRes);
  const cookieStr = mergeCookies(prefCookies, sessionCookies);

  console.log(`[meta] captured cookie names: ${cookieNames(cookieStr)}`);

  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("h1.entry-title, h1").first().text().trim() ||
    slug.split("/").pop();

  const poster = absoluteUrl(
    $("meta[property='og:image']").attr("content") ||
    $("video").attr("poster") ||
    $("img").first().attr("src")
  );

  const description =
    $("meta[property='og:description']").attr("content") ||
    $(".entry-content p").first().text().trim() ||
    "Archivebate video";

  const videoId = extractVideoIdFromHtml(html);
  console.log(`[meta] videoId=${videoId || "unknown"}`);
  const externalPlayerUrls = extractExternalPlayerUrlsFromHtml(html, pageUrl);

  const meta = {
    id,
    type: "movie",
    name: title,
    poster: poster || undefined,
    posterShape: "landscape",
    background: poster || undefined,
    description,
    website: pageUrl,
    videos: [{ id, title }],
  };

  if (!resolveStreams) {
    console.log(`[meta] metadata-only request; stream resolving skipped`);

    metaCache.set(id, {
  meta,
  videoUrl: null,
  videoUrls: [],
  externalPlayerUrls,
  cookieStr,
  updatedAt: Date.now(),
});

    // Return the fetched HTML too, so prewarm can reuse it instead of fetching
    // the same page again through the outbound proxy.
    return {
  meta,
  videoUrl: null,
  videoUrls: [],
  externalPlayerUrls,
  cookieStr,
  html,
  pageUrl,
  videoId,
};
  }

  const videoUrls = await resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr);
  const videoUrl = videoUrls[0] || null;

  const result = {
  meta,
  videoUrl,
  videoUrls,
  externalPlayerUrls,
  cookieStr,
  updatedAt: Date.now(),
};

  metaCache.set(id, result);

  return {
  ...result,
  html,
  pageUrl,
  videoId,
};
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie") return { metas: [] };

  const cacheKey = JSON.stringify({
    id,
    skip: extra?.skip || 0,
    search: extra?.search || "",
    genre: extra?.genre || "",
  });

  try {
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[catalog] cache hit ${cacheKey}`);
      return { metas: cached.metas };
    }

    const metas = await fetchCatalogPage(id, extra?.skip || 0, extra?.search || "", extra?.genre || "");

    catalogCache.set(cacheKey, {
      metas,
      expiresAt: Date.now() + CATALOG_CACHE_MS,
    });

    return { metas };
  } catch (err) {
    console.error("Catalog error:", err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie" || !ownsId(id)) return { meta: null };

  try {
    const cached = metaCache.get(id);

    if (cached && cached.meta && Date.now() - cached.updatedAt < META_CACHE_MS) {
      // If streams are not fresh yet, start/continue prewarm.
      startStreamPrewarm(id);

      return { meta: cached.meta };
    }

    const result = await scrapeMetaById(id, { resolveStreams: false });

    // Reuse the HTML already fetched by scrapeMetaById instead of fetching
    // the same page again.
    startStreamPrewarm(id, result);

    return { meta: result.meta };
  } catch (err) {
    console.error("Meta error:", err.message);

    return {
      meta: {
        id,
        type: "movie",
        name: decodeId(id).split("/").pop() || "Video",
        website: absoluteUrl(`/${decodeId(id)}/`),
      },
    };
  }
});

function buildExternalStreamObjects(externalPlayerUrls, pageUrl) {
  const streams = [];

  for (const item of externalPlayerUrls || []) {
    const host = (() => {
      try {
        return new URL(item.url).hostname.replace(/^www\./, "");
      } catch {
        return "External";
      }
    })();

    streams.push({
      name: "Archivebate 🔗",
      title: "Open Mixdrop Player"
externalUrl: item.url
    });
  }

  // Keep the source page as fallback.
  if (pageUrl) {
    streams.push({
      name: "Archivebate 🔗",
      title: "Open Page",
      externalUrl: pageUrl,
    });
  }

  return streams;
}

function buildStreamObjects(videoUrls) {
  const qualityLabels = {
    "_1080p": "1080p",
    "_720p": "720p",
    "_480p": "480p",
    "_360p": "360p",
  };

  return videoUrls.map(u => {
    let decoded = u;
    try { decoded = decodeURIComponent(u); } catch {}

    const label = Object.entries(qualityLabels).find(([k]) => decoded.includes(k))?.[1] ?? "HD";

    return {
      name: "Archivebate 🎥",
      title: label,
      url: u,
      behaviorHints: { notWebReady: false },
    };
  });
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie" || !ownsId(id)) return { streams: [] };

  const pageUrl = absoluteUrl(`/${decodeId(id)}/`);

  try {
    const cached = metaCache.get(id);

    if (cached && Date.now() - cached.updatedAt < STREAM_CACHE_MS) {
  if (cached.videoUrls && cached.videoUrls.length > 0) {
    console.log(`[stream] short cache hit for direct URLs ${id}`);

    const streams = buildStreamObjects(
      cached.videoUrls,
      pageUrl,
      cached.cookieStr || ""
    );

    return { streams };
  }

  if (cached.externalPlayerUrls && cached.externalPlayerUrls.length > 0) {
    console.log(`[stream] short cache hit for external players ${id}`);

    return {
      streams: buildExternalStreamObjects(cached.externalPlayerUrls, pageUrl),
    };
  }
}

    const prewarmPromise = streamPrewarmPromises.get(id);

    if (prewarmPromise) {
      console.log(`[stream] awaiting in-flight prewarm for ${id}`);

      const prewarmed = await prewarmPromise;

      if (prewarmed && prewarmed.videoUrls && prewarmed.videoUrls.length > 0) {
  console.log(`[stream] using prewarmed direct streams for ${id}`);

  const streams = buildStreamObjects(
    prewarmed.videoUrls,
    pageUrl,
    prewarmed.cookieStr || ""
  );

  return { streams };
}

if (prewarmed && prewarmed.externalPlayerUrls && prewarmed.externalPlayerUrls.length > 0) {
  console.log(`[stream] using prewarmed external players for ${id}`);

  return {
    streams: buildExternalStreamObjects(prewarmed.externalPlayerUrls, pageUrl),
  };
}

console.log(`[stream] prewarm finished without usable streams for ${id}`);
    }

    console.log(`[stream] fresh scrape for ${id}`);

    const { videoUrls, externalPlayerUrls, cookieStr } = await scrapeMetaById(id, {
  resolveStreams: true,
});

    if ((!videoUrls || videoUrls.length === 0) && externalPlayerUrls && externalPlayerUrls.length > 0) {
  console.log(`[stream] no direct URLs found; returning ${externalPlayerUrls.length} external player(s)`);

  return {
    streams: buildExternalStreamObjects(externalPlayerUrls, pageUrl),
  };
}

if (!videoUrls || videoUrls.length === 0) {
  console.log(`[stream] no playable URLs or external players found`);

  return {
    streams: [
      {
        name: "Archivebate 🔗",
        title: "Open Page",
        externalUrl: pageUrl,
      },
    ],
  };
}

    const streams = buildStreamObjects(videoUrls, pageUrl, cookieStr || "");

    console.log(
      `[stream] returning ${streams.length} stream(s), first: ${streams[0]?.url?.substring(0, 80)}`
    );

    return { streams };
  } catch (err) {
    console.error(`[stream] error ${id}:`, err.message);

    return {
      streams: [
        {
          name: "Archivebate 🔗",
          title: "Open Page",
          externalUrl: pageUrl,
        },
      ],
    };
  }
});

const app = express();

app.get("/", (_req, res) => {
  const manifestUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/manifest.json` : "/manifest.json";
  res.type("html").send(
    `<html><body><h1>Archivebate Stremio Addon</h1><p>Install: <a href="${manifestUrl}">${manifestUrl}</a></p><p>Outbound proxy: ${proxyAgent ? "enabled" : "disabled"}</p><p>Resolver: lightweight raw extraction only</p></body></html>`
  );
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    proxy: !!proxyAgent,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    streamResolver: "lightweight-raw-html-only",
  });
});

app.get("/imgproxy", async (req, res) => {
  const target = req.query.url ? String(req.query.url).replace(/\+/g, "%2B") : null;
  if (!target) return res.status(400).send("missing url");

  try {
    const upstream = await doFetch(
  target,
  {
    headers: {
      ...HEADERS,
      Referer: BASE_URL + "/",
    },
  },
  IMAGE_PROXY_USES_OUTBOUND_PROXY
);
    if (!upstream.ok) return res.status(upstream.status).send(`upstream ${upstream.status}`);

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    upstream.body.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/proxy", async (req, res) => {
  const rawQuery = req._parsedUrl?.query || require("url").parse(req.url).query || "";
  const urlMatch = rawQuery.match(/(?:^|&)url=([^&]*)/);
  const target = urlMatch ? urlMatch[1] : null;
  if (!target) return res.status(400).send("missing url");

  const refMatch = rawQuery.match(/(?:^|&)ref=([^&]*)/);
  const referer = refMatch ? decodeURIComponent(refMatch[1]) : BASE_URL + "/";

  let decodedTarget;
  try {
    decodedTarget = decodeURIComponent(target);
  } catch (e) {
    console.warn(`[proxy] decode error: ${e.message}`);
    decodedTarget = target;
  }

  const isSegment = SEGMENT_RE.test(decodedTarget.split("?")[0]);
  const isRemoteControl = /\/remote_control\.php\?/i.test(decodedTarget);

  // Video playback bytes should not use the outbound proxy.
  const useProxy = false;

  console.log(`[proxy] target=${decodedTarget} isSegment=${isSegment} isRemoteControl=${isRemoteControl} useProxy=${useProxy}`);

  try {
    const fetchHeaders = {
      "User-Agent": HEADERS["User-Agent"],
      "Referer": referer,
      "Origin": BASE_URL,
      "Accept": VIDEO_HEADERS.Accept,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity;q=1, *;q=0",
      "Connection": "keep-alive",
    };

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
      console.log(`[proxy] range: ${req.headers.range}`);
    }

    const upstream = await doFetch(decodedTarget, {
      headers: fetchHeaders,
      redirect: "follow",
    }, useProxy);

    console.log(
      `[proxy] upstream status=${upstream.status} ` +
      `type=${upstream.headers.get("content-type") || "(none)"} ` +
      `len=${upstream.headers.get("content-length") || "(none)"} ` +
      `range=${upstream.headers.get("content-range") || "(none)"}`
    );

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[proxy] upstream ${upstream.status} for ${decodedTarget} body: ${errBody.substring(0, 300)}`);
      return res.status(upstream.status).type("text/plain").send(`upstream error ${upstream.status}`);
    }

    res.status(upstream.status);

    for (const h of [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
      "last-modified",
      "etag",
    ]) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    upstream.body.pipe(res);

    upstream.body.on("error", err => {
      console.error("[proxy] upstream body error:", err.message);
      if (!res.headersSent) {
        res.status(500).send("stream error");
      } else {
        res.destroy(err);
      }
    });
  } catch (e) {
    console.error(`[proxy] error: ${e.message}`);
    if (!res.headersSent) {
      res.status(500).send(e.message);
    } else {
      res.destroy(e);
    }
  }
});

app.use(getRouter(builder.getInterface()));
app.listen(PORT, () => {
  console.log(`Archivebate addon listening on ${PORT} | outbound proxy ${proxyAgent ? "enabled" : "disabled"} | resolver lightweight`);
});