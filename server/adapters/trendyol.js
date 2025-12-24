// server/adapters/trendyol.js
// ======================================================================
// Trendyol – S21 → S200 ULTRA-STABLE ADAPTER (HARDENED)
// ZERO DELETE — S21 mantığı korunur, S200 wrapper + kit-lock eklenir
// Mutlak S200:
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title+url required; price<=0 => null
// - NO FAKE in PROD: placeholder/mock/fallback yasak (FINDALLEASY_ALLOW_STUBS=1 ile DEV)
// - Observable fail: fetch/proxy/timeout => ok:false + items:[] + _meta.error/code
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere; S200 ctx set
// ======================================================================

import axios from "axios"; // ZERO DELETE
import * as cheerio from "cheerio"; // ZERO DELETE
import crypto from "crypto"; // ZERO DELETE

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
  fixKey,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = fixKey("trendyol");
const PROVIDER_FAMILY = "trendyol";
const BASE = "https://www.trendyol.com";

const MAX_PAGES = 2; // ZERO DELETE
const MAX_ITEMS = 80;
const HARD_TIMEOUT_MS = 16000;

const DEFAULT_TIMEOUT_MS = 8500;

const ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// =========================================================
// HELPERS
// =========================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

// Daha sağlam fiyat parse (1.299,90 / 1,299.90 / 1299,90 / 1299.90)
function parsePrice(txt) {
  if (!txt) return null;
  try {
    const s = String(txt).replace(/\s+/g, " ").replace(/[^\d.,]/g, "").trim();
    if (!s) return null;

    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    let normalized = s;

    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) normalized = s.replace(/\./g, "").replace(",", ".");
      else normalized = s.replace(/,/g, "");
    } else if (lastComma > -1) {
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      const parts = s.split(".");
      if (parts.length > 2) {
        const dec = parts.pop();
        normalized = parts.join("") + "." + dec;
      } else normalized = s;
    }

    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// URL-safe base64 + hash fallback (ID’de / + = belası biter)
function buildStableId(href, title) {
  const base = safe(href) || safe(title) || "item";
  try {
    const h = crypto.createHash("sha1").update(base).digest("hex").slice(0, 18);
    const b64 = Buffer.from(base)
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `trendyol_${h}_${b64.slice(0, 24)}`;
  } catch {
    return "trendyol_" + base.replace(/\W+/g, "_").slice(0, 60);
  }
}

function normalizeTrendyolUrl(rawHref) {
  let href = safe(rawHref);
  if (!href) return null;

  try {
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? "" : "/") + href;
    const u = new URL(href);

    [
      "boutiqueId",
      "merchantId",
      "campaignId",
      "pId",
      "adjust_t",
      "adjust_deeplink",
      "adjust_campaign",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "ref",
    ].forEach((k) => u.searchParams.delete(k));

    href = u.origin + u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : "");
  } catch {
    if (!href.startsWith("http")) href = BASE + href;
  }

  return href;
}

// Affiliate Engine imza farklılıklarına karşı dayanıklı çağrı
function safeBuildAffiliateUrl(url, region, title) {
  const u = safe(url);
  if (!u) return null;

  try {
    const a1 = buildAffiliateUrlS10("trendyol", u, { region, rawTitle: title });
    if (a1) return a1;
  } catch {}

  try {
    const a2 = buildAffiliateUrlS10({ provider: "trendyol", url: u, region, rawTitle: title });
    if (a2) return a2;
  } catch {}

  return u;
}

async function fetchHTML(url, config) {
  try {
    const { data } = await axios.get(url, config);
    return data;
  } catch (err) {
    try {
      return await proxyFetchHTML(url, { timeout: HARD_TIMEOUT_MS, headers: config?.headers });
    } catch {
      try {
        return await proxyFetchHTML(url);
      } catch {
        return null;
      }
    }
  }
}

function computeQualityScore(item) {
  try {
    let s = 0;
    if (item.title) s += 0.30;
    if (item.price != null) s += 0.28;
    if (item.image) s += 0.20;
    if (item.rating != null) s += 0.05;
    if (item.url) s += 0.12;
    if (item.affiliateUrl) s += 0.03;
    s += 0.02;
    return Number(s.toFixed(2));
  } catch {
    return 0;
  }
}

// =========================================================
// S200 WRAPPER HELPERS
// =========================================================
function mkS200(ok, items, meta = {}, extra = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    _meta: { ...meta },
    ...extra,
  };

  // Migration safety: allow `for..of res` to iterate items
  try {
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () {
        yield* res.items;
      },
    });
    Object.defineProperty(res, "length", {
      enumerable: false,
      get: () => res.items.length,
    });
  } catch {}

  return res;
}

function mkFail(code, err, meta = {}, extra = {}) {
  const msg = safeStr(err?.message || err || code);
  return mkS200(false, [], { ...meta, code, error: msg }, { ...extra, error: code });
}

// =========================================================
// ÇÖP FİLTRESİ
// =========================================================
function isGarbage(title, brand) {
  const t = safe(title).toLowerCase();
  const b = safe(brand).toLowerCase();

  if (
    t.includes("tamir") ||
    t.includes("onarım") ||
    t.includes("servis") ||
    t.includes("ekran değişimi") ||
    t.includes("batarya") ||
    t.includes("kamera") ||
    t.includes("parça") ||
    t.includes("montaj") ||
    b.includes("cep iletişim") ||
    b.includes("gsm") ||
    b.includes("telefoncu")
  ) {
    return true;
  }
  return false;
}

// =========================================================
// ORIGINAL S21 ITEM BUILDER — ZERO DELETE (hardened)
// =========================================================
function buildItem({ id, title, brand, href, priceRaw, priceText, imgRaw, rating, region }) {
  let url = normalizeTrendyolUrl(href);
  if (!url) return null;

  const stableLegacy = buildStableId(url, title); // ZERO DELETE

  let img = safe(imgRaw);
  if (img && img.startsWith("//")) img = "https:" + img;

  const imageVariants = buildImageVariants(img || null, PROVIDER_KEY);

  // sanitizePrice null-safe
  let priceSan = null;
  if (priceRaw != null && Number.isFinite(priceRaw)) {
    try {
      priceSan = sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "product" });
    } catch {
      priceSan = null;
    }
  }

  const affiliateUrl = url ? safeBuildAffiliateUrl(url, String(region || "TR").toUpperCase(), title) : null;

  let item = {
    id: stableIdS200(PROVIDER_KEY, affiliateUrl || url, title),
    title,
    price: priceSan,
    priceText,
    rating: rating ?? null,
    reviewCount: null,

    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerType: "retailer",
    providerFamily: PROVIDER_FAMILY,
    vertical: "product",

    currency: "TRY",
    region: String(region || "TR").toUpperCase(),
    category: "product",
    categoryAI: "product",

    url,
    originUrl: url,
    affiliateUrl,

    image: imageVariants.image,
    imageOriginal: imageVariants.imageOriginal,
    imageProxy: imageVariants.imageProxy,
    hasProxy: imageVariants.hasProxy,

    commissionRate: 0,
    isAffiliate: Boolean(affiliateUrl),
    source: PROVIDER_KEY,

    qualityScore: computeQualityScore({
      title,
      price: priceSan,
      image: imageVariants.image,
      rating,
      url,
      affiliateUrl,
    }),

    raw: {
      id,
      legacyId: stableLegacy,
      title,
      brand,
      href,
      urlNormalized: url,
      priceRaw,
      priceText,
      imgRaw,
      rating,
      variants: imageVariants,
      extractedAt: new Date().toISOString(),
    },
  };

  try {
    item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "product" });
  } catch {}

  // Contract lock (kit) — drop if invalid
  return normalizeItemS200(item, PROVIDER_KEY, {
    providerFamily: PROVIDER_FAMILY,
    baseUrl: BASE,
    currency: "TRY",
    region: String(region || "TR").toUpperCase(),
    category: "product",
    vertical: "product",
  });
}

// =========================================================
// S21 SCRAPE PAGE — ZERO DELETE (hardened)
// =========================================================
async function scrapePage(query, page = 1, region = "TR") {
  const q = encodeURIComponent(query);
  const url = `${BASE}/sr?q=${q}&pi=${page}`;

  const html = await fetchHTML(url, {
    timeout: HARD_TIMEOUT_MS,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: BASE + "/",
    },
  });

  if (!html) return { ok: false, items: [], url, error: "fetch_failed" };

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
  const items = [];

  const nodes = $(
    "div.p-card-wrppr, \
     div.product-card, \
     article[data-testid='product-card'], \
     div[data-prd-id], \
     div[data-id]"
  );

  nodes.each((i, el) => {
    const node = $(el);

    const name =
      safe(node.find(".prdct-desc-cntnr-name").text()) ||
      safe(node.find(".product-name").text()) ||
      safe(node.find("[data-testid='product-name']").text());

    const brand =
      safe(node.find(".prdct-desc-cntnr-ttl").text()) ||
      safe(node.find(".product-brand").text()) ||
      safe(node.find("[data-testid='product-brand']").text());

    const title = [brand, name].filter(Boolean).join(" ").trim();
    if (!title) return;

    if (isGarbage(title, brand)) return;

    const priceText =
      safe(node.find(".prc-box-dscntd").text()) ||
      safe(node.find(".prc-box-sllng").text()) ||
      safe(node.find(".price").text()) ||
      safe(node.find("[data-testid='price-current-price']").text()) ||
      safe(node.find("[data-test-id='price-current-price']").text());

    const priceRaw = parsePrice(priceText);

    let href = safe(node.find("a").attr("href"));
    if (!href) return;

    const imgRaw =
      safe(node.find("img").attr("data-src")) ||
      safe(node.find("img").attr("data-original")) ||
      safe(node.find("img").attr("src"));

    const ratingTxt =
      safe(node.find("[data-testid='rating-score']").text()) ||
      safe(node.find(".rating").text()) ||
      safe(node.find("[data-test-id='rating-score']").text());

    let rating = null;
    if (ratingTxt) {
      const r = Number(ratingTxt.replace(/[^\d.,]/g, "").replace(",", "."));
      if (Number.isFinite(r) && r > 0 && r <= 5) rating = r;
    }

    const idAttr = safe(node.attr("data-prd-id")) || safe(node.attr("data-id")) || href;

    const item = buildItem({
      id: idAttr,
      title,
      brand,
      href,
      priceRaw,
      priceText,
      imgRaw,
      rating,
      region,
    });

    if (item) {
      item.raw.sourceUrl = url;
      item.raw.page = page;
      items.push(item);
    }
  });

  return { ok: true, items };
}

// =========================================================
// MULTI PAGE SCRAPER — S200 WRAPPER
// =========================================================
export async function searchTrendyol(query, region = "TR") {
  const t0 = Date.now();
  const q = safe(query);
  const reg = String(region || "TR").toUpperCase();

  if (!q) return mkFail("EMPTY_QUERY", "empty_query", { region: reg, ms: 0 });

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, query: q, region: reg };

  try {
    const out = await withTimeout(
      (async () => {
        // Rate limit — Trendyol ban manyağı, burada fren şart
        try {
          const key = `s200:adapter:trendyol:${reg}`;
          const allowed = await rateLimiter.check(key, {
            limit: 14,
            windowMs: 60_000,
            burst: true,
            adaptive: true,
          });
          if (!allowed) {
            return mkFail("RATE_LIMITED", "rate_limited", { region: reg, ms: Date.now() - t0 });
          }
        } catch {
          // rateLimiter yoksa bile sistem çalışsın
        }

        let all = [];
        const seen = new Set();

        for (let p = 1; p <= MAX_PAGES; p++) {
          const part = await scrapePage(q, p, reg);
          if (!part.ok) {
            if (p === 1) return mkFail("FETCH_FAIL", part.error || "fetch_failed", { region: reg, page: p, ms: Date.now() - t0 });
            break;
          }
          if (!part.items.length) break;

          for (const it of part.items) {
            const k = it?.url || it?.id;
            if (!k) continue;
            if (seen.has(k)) continue;
            seen.add(k);
            all.push(it);
            if (all.length >= MAX_ITEMS) break;
          }
          if (all.length >= MAX_ITEMS) break;
        }

        all = all.filter((x) => x && x.title && x.url);
        return mkS200(true, all, { region: reg, ms: Date.now() - t0 });
      })(),
      DEFAULT_TIMEOUT_MS,
      PROVIDER_KEY
    );

    return out;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, { region: reg, timeout: isTimeout, ms: Date.now() - t0 });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// =========================================================
// S200 UYUMLU ANA EXPORT (wrapper)
// =========================================================
export async function searchTrendyolAdapter(query, region = "TR") {
  const res = await searchTrendyol(query, region);
  // already S200 wrapper
  return res;
}

export default {
  searchTrendyol,
  searchTrendyolAdapter,
};
