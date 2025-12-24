// ============================================================================
//  N11 — S22 ULTRA TITAN ADAPTER
//  ZERO DELETE → S10 tabanı duruyor, üzerine S22 zekâ katmanı eklendi
//  • proxyFetchHTML first
//  • sanitizePrice + optimizePrice
//  • ImageVariants S22
//  • stableId
//  • categoryAI(product)
//  • qualityScore
//  • affiliateUrl (korundu)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
} from "../core/s200AdapterKit.js";

// ============================================================================
// AFFILIATE CONFIG
// ============================================================================
const N11_AFF_ID = String(process.env.N11_AFF_ID || "").trim();
const N11_SUBID = process.env.N11_SUBID || "subid";
const N11_REDIRECT = process.env.N11_REDIRECT || "";

// AFFILIATE BUILDER (S10’dan korundu)
function buildAffiliateUrl(url) {
  if (!url) return url;

  // ✅ PROD: affiliate id yoksa URL'e parametre şişirme
  if (!N11_AFF_ID) return url;

  if (N11_REDIRECT) {
    return `${N11_REDIRECT}${encodeURIComponent(url)}&${N11_SUBID}=${N11_AFF_ID}`;
  }
  try {
    const u = new URL(url);
    u.searchParams.set(N11_SUBID, N11_AFF_ID);
    return u.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
const clean = (v) => String(v || "").trim();

function isBadImageUrl(u) {
  const s = String(u || "").trim();
  if (!s) return true;
  const l = s.toLowerCase();
  if (l.startsWith("data:image/gif")) return true;
  if (l.includes("blank.gif")) return true;
  if (l.includes("/static/css/jquery/img/blank.gif")) return true;
  if (l === "about:blank") return true;
  return false;
}

function normalizeImg(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = "https:" + s;
  return s;
}

function firstFromSrcset(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const first = s.split(",")[0]?.trim()?.split(/\s+/)[0];
  return first || "";
}

function extractUrlFromStyle(style) {
  const s = String(style || "").trim();
  if (!s) return "";
  const m = s.match(/url\((['"]?)(.*?)\1\)/i);
  return m?.[2] ? String(m[2]).trim() : "";
}

function extractImageUrlsFromHtml(html) {
  const h = String(html || "");
  if (!h) return [];
  // Pull likely image URLs from any attribute/value in the card HTML
  const out = [];
  const push = (u) => {
    const n = normalizeImg(u);
    if (n && !isBadImageUrl(n)) out.push(n);
  };
  const m1 = h.match(/https?:\/\/[^\s"')>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"')>]+)?/gi) || [];
  const m2 = h.match(/\/\/[^\s"')>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"')>]+)?/gi) || [];
  for (const u of m1) push(u);
  for (const u of m2) push(u);
  // de-dupe
  return Array.from(new Set(out)).slice(0, 12);
}

function parsePrice(v) {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// N11 = 3 sayfa optimal
const MAX_PAGES = 3;

// ============================================================================
// S22 → stableId
// ============================================================================
const PROVIDER_KEY = "n11";

function stableId(url, title = "") {
  // ✅ deterministic, no random
  return stableIdS200(PROVIDER_KEY, url, title);
}
// ============================================================================
// S22 → kategori zekâsı
// ============================================================================
function detectProductCategory(title) {
  const t = title.toLowerCase();

  if (/iphone|samsung|xiaomi|asus|lenovo|tablet|kulak|tv|televizyon/.test(t))
    return "electronics";

  if (/elbise|ayakkabı|tshirt|çanta|kazak/.test(t))
    return "fashion";

  if (/supurge|buzdolabı|fırın|kombi|klima/.test(t))
    return "home_appliance";

  if (/oyuncak|lego|barbie/.test(t))
    return "toy";

  return "product";
}

// ============================================================================
// S22 → qualityScore
// ============================================================================
function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.35;
  if (item.title.length > 10) s += 0.25;
  if (item.image) s += 0.35;
  return Number(s.toFixed(2));
}

// ============================================================================
// ANTI-BAN HEADERS (S22 hardened)
// - AdapterEngine ctx.headers içindeki UA/Accept-Language'ı kullan (varsa)
// - Default UA "FindAllEasy-*" gibi bot kokan string olmasın
// ============================================================================
const N11_UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function pickHeader(headers, key) {
  if (!headers) return "";
  return String(headers[key] ?? headers[key.toLowerCase()] ?? "");
}

function pickUA(headers) {
  const ua = pickHeader(headers, "User-Agent");
  if (ua && ua.length > 10) return ua;
  return N11_UA_POOL[Math.floor(Math.random() * N11_UA_POOL.length)];
}

function buildAxiosConfig(signal, extraHeaders = {}) {
  const ua = pickUA(extraHeaders);
  return {
    timeout: 14000,
    signal,
    headers: {
      "User-Agent": ua,
      "Accept-Language": pickHeader(extraHeaders, "Accept-Language") || "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
      Referer: "https://www.n11.com/",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      ...extraHeaders,
    },
    // ✅ anti-bot durumlarında status'ü biz yakalayalım
    validateStatus: (s) => s >= 200 && s < 500,
  };
}

function looksBlockedN11(html = "") {
  const t = String(html || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("captcha") ||
    t.includes("robot") ||
    t.includes("access denied") ||
    t.includes("forbidden") ||
    t.includes("cloudflare") ||
    t.includes("service unavailable")
  );
}

// ============================================================================
// S22 SCRAPER — PROXY (header-aware) + direct fallback
// ============================================================================
async function fetchN11HTML(url, options = {}) {
  const signal = options?.signal;
  const headers = options?.headers && typeof options.headers === "object" ? options.headers : {};

  // 1) ProxyEngine (UA rotation + block heuristics). Header'ları da geçir.
  try {
    const html = await proxyFetchHTML(url, { headers, timeoutMs: 14000, signal, mode: "direct-first" });
    if (looksBlockedN11(html)) throw Object.assign(new Error("N11_BLOCKED"), { code: "N11_BLOCKED" });
    return html;
  } catch (e) {
    // 2) Direct axios fallback (bazı ortamlarda proxy yokken burada şans var)
    const cfg = buildAxiosConfig(signal, headers);
    const res = await axios.get(url, cfg);

    const status = res?.status;
    const html = res?.data;

    if (!html || typeof html !== "string") {
      throw Object.assign(new Error("N11_EMPTY_HTML"), { code: "N11_EMPTY_HTML", status });
    }
    if (status && status >= 400) {
      throw Object.assign(new Error(`N11_HTTP_${status}`), { code: "N11_HTTP", status });
    }
    if (looksBlockedN11(html)) {
      throw Object.assign(new Error("N11_BLOCKED"), { code: "N11_BLOCKED", status: status || 403 });
    }
    return html;
  }
}

// ============================================================================
// SINGLE PAGE SCRAPER — S22
// ============================================================================
async function scrapeN11Page(query, page = 1, regionOrOptions = "TR", maybeOptions = {}) {
  // Back-compat: older callers might pass (q, page, region, options)
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
    options = maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {};
  } else {
    options = regionOrOptions && typeof regionOrOptions === "object" ? regionOrOptions : {};
    region = String(options.region || "TR");
  }

  const { signal, headers } = options;
  const q = encodeURIComponent(query);
  const url = `https://www.n11.com/arama?q=${q}&pg=${page}`;

let html = null;
try {
  html = await fetchN11HTML(url, { signal, headers });
  if (!html || typeof html !== "string" || html.length < 800) {
    throw Object.assign(new Error("N11_EMPTY_HTML"), { code: "N11_EMPTY_HTML" });
  }
} catch (err) {
  console.warn("N11 html fetch error:", err?.message || String(err));
  return [];
}

  const $ = loadCheerioS200(html);
  const items = [];

  const NODES = $(
    "li.column, div.productItem, li[id*='p-'], li"
  );

  NODES.each((i, el) => {
    const n = $(el);

    const title =
      clean(n.find(".productName").text()) ||
      clean(n.find(".pro").text()) ||
      clean(n.find("h3").text());

    if (!title) return;

    // price
    const priceTxt =
      clean(n.find(".newPrice ins").text()) ||
      clean(n.find(".price").text()) ||
      clean(n.find("ins").text()) ||
      clean(n.find("[data-price]").attr("data-price"));

    const priceParsed = parsePrice(priceTxt);
    const price = sanitizePrice(priceParsed);
    const optimizedPrice = (() => {
      try {
        const out = optimizePrice({ price }, { provider: "n11" });
        if (typeof out === "number") return out;
        if (out && typeof out === "object") return out.optimizedPrice ?? null;
        return null;
      } catch {
        return null;
      }
    })();
// url
    let href =
      clean(n.find("a").attr("href")) ||
      clean(n.find("a.product").attr("href"));

    if (!href) return;
    if (!href.startsWith("http")) href = "https://www.n11.com" + href;

    const affiliateUrl = buildAffiliateUrl(href);

    // image (N11 uses lazy-load + can include multiple <img>; src can be blank.gif)
    const cand = [];

    const imgs = n.find("img").toArray().slice(0, 8);
    for (const elImg of imgs) {
      const img = $(elImg);
      cand.push(
        clean(img.attr("data-src")),
        clean(img.attr("data-original")),
        clean(img.attr("data-lazy")),
        clean(img.attr("data-lazy-src")),
        clean(img.attr("data-img")),
        clean(img.attr("data-image")),
        firstFromSrcset(clean(img.attr("data-srcset"))),
        firstFromSrcset(clean(img.attr("data-src-set"))),
        firstFromSrcset(clean(img.attr("srcset"))),
        extractUrlFromStyle(clean(img.attr("style"))),
        clean(img.attr("src"))
      );
    }

    // sometimes background-image is on wrappers
    cand.push(
      extractUrlFromStyle(clean(n.find(".productImage").attr("style"))),
      extractUrlFromStyle(clean(n.find(".img").attr("style"))),
      extractUrlFromStyle(clean(n.attr("style")))
    );

    // last-resort: regex scan the card HTML
    cand.push(...extractImageUrlsFromHtml(n.html()));

    const candClean = cand
      .map(normalizeImg)
      .filter((x) => x && !isBadImageUrl(x));

    const imgRaw = candClean[0] || "";
    const image = buildImageVariants(imgRaw, "n11");

    // rating
    const ratingTxt =
      clean(n.find(".ratingScore").text()) ||
      clean(n.find("[data-rating]").attr("data-rating"));

    let rating = null;
    if (ratingTxt) {
      const r = Number(ratingTxt.replace(/[^\d.,]/g, "").replace(",", "."));
      if (Number.isFinite(r) && r > 0 && r <= 5) rating = r;
    }

    // id (S22)
    const id = stableId(href, title);

    // categoryAI
    const categoryAI = detectProductCategory(title);

    // qualityScore
    const qualityScore = computeQualityScore({
      title,
      price,
      image: imgRaw,
    });

    const rawItem = {
      id,
      title,
      price,
      optimizedPrice,
      rating,

      provider: "n11",
      source: "n11",
      currency: "TRY",
      region: "TR",
      category: "product",
      categoryAI,
      qualityScore,

      // URL priority is enforced by normalizeItemS200
      url: href,
      originUrl: href,
      finalUrl: href,
      deeplink: affiliateUrl,
      affiliateUrl,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      // allow FE / vitrin patches to recover image if needed
      images: candClean.slice(0, 10),

      raw: {
        title,
        priceTxt,
        ratingTxt,
        href,
        affiliateUrl,
        imgRaw,
        imageCandidates: cand.slice(0, 10),
      },
    };

    const norm = normalizeItemS200(rawItem, PROVIDER_KEY, { vertical: "market", category: "product" });
    if (norm) items.push(norm);
  });

  return items;
}

// ============================================================================
// MULTI PAGE SCRAPER
// ============================================================================

// ============================================================================
// S200 WRAPPER OUTPUT
// ============================================================================
function _wrapS200(ok, items, meta = {}) {
  const arr = coerceItemsS200(items);
  return {
    ok: Boolean(ok),
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    _meta: meta || {},
  };
}

// ============================================================================
// MULTI PAGE SCRAPER — S200 WRAPPED
// ============================================================================
export async function searchN11Scrape(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const qSafe = clean(query);
  if (!qSafe) {
    return _wrapS200(false, [], { error: "empty_query", region });
  }

  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    adapter: "searchN11Scrape",
    group: "product",
    metaUrl: import.meta?.url,
  };

  const startedAt = Date.now();
  const errors = [];
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const pageItems = await withTimeout(
        scrapeN11Page(qSafe, page, region, options),
        Number(options.timeoutMs || 6500),
        `n11 page ${page}`
      );
      if (Array.isArray(pageItems) && pageItems.length) items.push(...pageItems);
    } catch (err) {
      const isTimeout = err instanceof TimeoutError || /timed out/i.test(err?.message || "");
      errors.push({
        page,
        timeout: isTimeout,
        message: err?.message || String(err),
      });
      // partial success policy: stop early only if first page failed and nothing collected
      if (!items.length) break;
    }
  }

  const ok = items.length > 0 && errors.length === 0 ? true : items.length > 0 ? true : false;

  return _wrapS200(ok, items, {
    region,
    pagesTried: MAX_PAGES,
    errors: errors.length ? errors : undefined,
    tookMs: Date.now() - startedAt,
  });
}

// Legacy array output (ZERO DELETE safety)
export async function searchN11Array(query, regionOrOptions = "TR") {
  const res = await searchN11Scrape(query, regionOrOptions);
  return res?.items || [];
}

export async function searchN11Adapter(query, regionOrOptions = "TR") {
  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    adapter: "searchN11Adapter",
    group: "product",
    metaUrl: import.meta?.url,
  };

  return searchN11Scrape(query, regionOrOptions);
}

export const searchN11 = searchN11Adapter;

export default {
  searchN11,
  searchN11Scrape,
  searchN11Adapter,
  searchN11Array,
};
