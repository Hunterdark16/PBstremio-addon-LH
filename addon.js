const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PORT = process.env.PORT || 7860;
const BASE_URL = process.env.PB_BASE_URL || "https://pimpbunny.com";
const PUBLIC_BASE_URL = process.env.SPACE_URL || process.env.PUBLIC_URL || "";

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
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const META_CACHE_MS = 10 * 60 * 1000;

// If /proxy is used manually, do not send video bytes through the outbound proxy.
const SEGMENT_RE = /\.(ts|aac|m4s|woff2)(\?|$)/i;

async function doFetch(url, opts = {}, useProxy = true) {
  const options = { redirect: "follow", ...opts };
  if (useProxy && proxyAgent) options.agent = proxyAgent;
  return fetch(url, options);
}

const GENRE_TAG_SLUGS = {
  "Teen": "teen",
  "Asian": "asian",
  "Latina": "latina",
  "Onlyfans": "onlyfans",
  "PAWG": "pawg",
  "Pornstar": "pornstar",
  "Chaturbate": "chaturbate",
  "Reverse Cowgirl": "reverse-cowgirl",
  "Stepsister": "stepsister",
};

const manifest = {
  id: "community.pimpbunny.vod",
  version: "1.0.0",
  name: "[18+] PimpBunny",
  description: "18+ adult videos scraped from pimpbunny.com.",
  logo: "https://pimpbunny.com/favicon.ico",
  types: ["movie"],
  resources: ["catalog", { name: "meta", types: ["movie"] }, { name: "stream", types: ["movie"] }],
  idPrefixes: ["pb:"],
  catalogs: [
    {
      type: "movie",
      id: "latest",
      name: "PB Latest Videos",
      extra: [
        {
          name: "genre",
          isRequired: false,
          options: [
            "Teen",
            "Asian",
            "Latina",
            "Onlyfans",
            "PAWG",
            "Pornstar",
            "Chaturbate",
            "Reverse Cowgirl",
            "Stepsister",
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

function cleanSlugPath(value) {
  return String(value || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/null$/i, "");
}

function makeIdFromPath(pathname) {
  return `pb:${cleanSlugPath(pathname)}`;
}

function decodeId(id) {
  return cleanSlugPath(String(id || "").replace(/^pb:/, ""));
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

function isRealVideoPath(pathname) {
  const path = cleanSlugPath(pathname);
  const segments = path.split("/").filter(Boolean);

  if (segments.length !== 2) return false;
  if (segments[0] !== "videos") return false;

  const slug = segments[1];

  if (!slug) return false;
  if (/^\d+$/.test(slug)) return false;
  if (!slug.includes("-")) return false;
  if (slug.length < 8) return false;
  if (BAD_CATALOG_SLUG_RE.test(slug)) return false;

  return true;
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

  $("a[href]").each((_, el) => {
    const a = $(el);
    const rawHref = a.attr("href");
    if (!rawHref) return;

    let u;
    try {
      u = new URL(rawHref, siteBase);
    } catch {
      return;
    }

    if (u.hostname !== siteHostname) return;
    if (!isRealVideoPath(u.pathname)) return;

    const pathKey = cleanSlugPath(u.pathname);
    if (seenVideoPaths.has(pathKey)) return;
    seenVideoPaths.add(pathKey);

    const slug = pathKey.split("/").pop();

    const closestCard = a.closest(
      "article, .video, .video-item, .thumb, .thumbnail, .item, .card, .post, [class*='video'], [class*='thumb']"
    );

    const container = closestCard.length ? closestCard : a;

    const imgNode =
      a.find("img").first().length
        ? a.find("img").first()
        : container.find("img").first();

    const rawTitleCandidates = [
      a.attr("title"),
      imgNode.attr("alt"),
      imgNode.attr("title"),
      a.find("[class*='title'], [class*='name']").first().text(),
      container.find("[class*='title']").first().text(),
      a.text(),
      titleFromVideoSlug(slug),
    ];

    let title = "";

    for (const candidate of rawTitleCandidates) {
      const cleaned = cleanCatalogText(candidate);
      if (!cleaned) continue;
      if (cleaned.length < 3) continue;
      if (BAD_CATALOG_TITLE_RE.test(cleaned)) continue;

      title = cleaned;
      break;
    }

    if (!title) {
      title = titleFromVideoSlug(slug);
    }

    if (!title || BAD_CATALOG_TITLE_RE.test(title)) return;

    const rawImg = absoluteUrl(
      imgNode.attr("data-src") ||
      imgNode.attr("data-lazy-src") ||
      imgNode.attr("data-original") ||
      imgNode.attr("data-thumb") ||
      (() => {
        const ss = imgNode.attr("srcset");
        if (!ss) return null;

        const first = ss
          .split(",")
          .map(x => x.trim().split(/\s+/)[0])
          .find(Boolean);

        return first || null;
      })() ||
      imgNode.attr("src"),
      siteBase
    );

    const imgOk =
      rawImg &&
      !/(placeholder|avatar|logo|icon|blank|spacer|pixel|\.gif)/i.test(rawImg);

    const img = imgOk
      ? (PUBLIC_BASE_URL
          ? `${PUBLIC_BASE_URL}/imgproxy?url=${encodeURIComponent(rawImg)}`
          : rawImg)
      : undefined;

    const description = cleanCatalogText(
      container
        .find("[class*='desc'], [class*='excerpt'], [class*='summary'], p")
        .first()
        .text()
    ).substring(0, 200);

    const date =
      container.find("time").attr("datetime") ||
      cleanCatalogText(container.find("[class*='date'], [class*='time']").first().text());

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
  });

  console.log(`[catalog] extractPostCards found ${results.length} video items`);
  return results.slice(0, 24);
}

async function fetchCatalogPage(_catalogId, skip = 0, search = "", genre = "") {
  const page = Math.floor((Number(skip) || 0) / 24) + 1;

  if (search) {
    const searchUrls = [
      `${BASE_URL}/?s=${encodeURIComponent(search)}${page > 1 ? `&paged=${page}` : ""}`,
      `${BASE_URL}/search/${encodeURIComponent(search)}${page > 1 ? `/page/${page}/` : "/"}`,
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
    const slug = GENRE_TAG_SLUGS[genre];

    const tagUrl = page <= 1
      ? `${BASE_URL}/tags/${slug}/`
      : `${BASE_URL}/tags/${slug}/${page}/`;

    try {
      console.log(`[catalog] fetching genre "${genre}" from ${tagUrl}`);

      const html = await fetchHtml(tagUrl);
      const metas = extractPostCards(html, tagUrl);

      if (metas.length > 0) {
        return metas;
      }

      console.warn(`[catalog] genre "${genre}" returned no video metas from ${tagUrl}`);
    } catch (err) {
      console.warn(`[catalog] genre "${genre}" fetch failed: ${tagUrl} -> ${err.message}`);
    }

    return [];
  }

  const catalogUrl = page <= 1
    ? `${BASE_URL}/videos/`
    : `${BASE_URL}/videos/${page}/`;

  try {
    const html = await fetchHtml(catalogUrl);
    const metas = extractPostCards(html, catalogUrl);

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
    decoded.includes(`${videoId}_pb_`) ||
    decoded.includes(`${videoId}_preview`) ||
    decoded.includes(`/${videoId}_`)
  );
}

function isPreviewOrThumbMp4(url) {
  let decoded = String(url || "");
  try { decoded = decodeURIComponent(decoded); } catch {}
  return /(preview_pb|_preview\.mp4|videos_screenshots|thumb|poster|listing|webp)/i.test(decoded);
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
    /https?:\/\/[^"'\\\s<>]+\/get_file\/[^"'\\\s<>]+\.mp4\/?(?:[?#][^"'\\\s<>]*)?/gi,
    /function\/\d+\/https?:\/\/[^"'\\\s<>]+\/get_file\/[^"'\\\s<>]+\.mp4\/?/gi,
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
    console.log(`[resolve] trying ${candidate.quality} ${candidate.hash || "nohash"}: ${resolveUrl} ref=${referer}`);

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

      console.log(`[resolve] status=${status} location=${location || "(none)"}`);

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
  const sessionCookies = getSetCookiePairs(pageRes);
  const cookieStr = mergeCookies(prefCookies, sessionCookies);

  console.log(`[meta] captured cookies: ${cookieStr || "(none)"}`);

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
    "PimpBunny video";

  const videoId = extractVideoIdFromHtml(html);
  console.log(`[meta] videoId=${videoId || "unknown"}`);

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
      cookieStr,
      updatedAt: Date.now(),
    });
    return { meta, videoUrl: null, videoUrls: [], cookieStr };
  }

  const videoUrls = await resolveVideoUrlsFromHtml(html, pageUrl, videoId, cookieStr);
  const videoUrl = videoUrls[0] || null;

  metaCache.set(id, {
    meta,
    videoUrl,
    videoUrls,
    cookieStr,
    updatedAt: Date.now(),
  });

  return { meta, videoUrl, videoUrls, cookieStr };
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
  if (type !== "movie") return { meta: null };

  try {
    const cached = metaCache.get(id);
    if (cached && cached.meta && Date.now() - cached.updatedAt < META_CACHE_MS) {
      return { meta: cached.meta };
    }

    const { meta } = await scrapeMetaById(id, { resolveStreams: false });
    return { meta };
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
      name: "PimpBunny 🎥",
      title: label,
      url: u,
      behaviorHints: { notWebReady: false },
    };
  });
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie") return { streams: [] };

  const pageUrl = absoluteUrl(`/${decodeId(id)}/`);

  try {
    const cached = metaCache.get(id);

    if (
      cached &&
      cached.videoUrls &&
      cached.videoUrls.length > 0 &&
      Date.now() - cached.updatedAt < STREAM_CACHE_MS
    ) {
      console.log(`[stream] short cache hit for ${id}`);
      return { streams: buildStreamObjects(cached.videoUrls) };
    }

    console.log(`[stream] fresh scrape for ${id}`);
    const { videoUrls } = await scrapeMetaById(id, { resolveStreams: true });

    if (!videoUrls || videoUrls.length === 0) {
      console.log(`[stream] no playable URLs found`);
      return { streams: [{ name: "PimpBunny 🔗", title: "Open Page", externalUrl: pageUrl }] };
    }

    const streams = buildStreamObjects(videoUrls);

    console.log(`[stream] returning ${streams.length} stream(s), first: ${streams[0]?.url?.substring(0, 100)}`);
    return { streams };
  } catch (err) {
    console.error(`[stream] error ${id}:`, err.message);
    return { streams: [{ name: "PimpBunny 🔗", title: "Open Page", externalUrl: pageUrl }] };
  }
});

const app = express();

app.get("/", (_req, res) => {
  const manifestUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/manifest.json` : "/manifest.json";
  res.type("html").send(
    `<html><body><h1>PimpBunny Stremio Addon</h1><p>Install: <a href="${manifestUrl}">${manifestUrl}</a></p><p>Outbound proxy: ${proxyAgent ? "enabled" : "disabled"}</p><p>Resolver: lightweight raw extraction only</p></body></html>`
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
    const upstream = await doFetch(target, { headers: { ...HEADERS, Referer: BASE_URL + "/" } }, true);
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
  console.log(`PimpBunny addon listening on ${PORT} | outbound proxy ${proxyAgent ? "enabled" : "disabled"} | resolver lightweight`);
});
