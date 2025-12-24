// server/adapters/trendyolScraper.js
// ======================================================================
// Trendyol – S21 HYBRID → S200 FINAL ADAPTER (HARDENED)
// ZERO DELETE — scrape/api/fallback korunur (ama PROD’da FAKE kapalı)
// Mutlak S200:
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title+url required; price<=0 => null
// - NO FAKE in PROD: mock/fallback/placeholder yasak (FINDALLEASY_ALLOW_STUBS=1 ile DEV)
// - Observable fail: fetch/proxy/timeout => ok:false + items:[] + _meta.error/code
// - NO RANDOM ID: stableIdS200(providerKey,url,title) (Date.now yasak)
// - withTimeout everywhere; S200 ctx set
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

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

const DEFAULT_TIMEOUT_MS = 8500;

const ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// ==========================================================
// HELPER
// ==========================================================
const safe = (v) => (v == null ? "" : String(v).trim());

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper (artık stableIdS200 kullanılıyor)
function buildStableId(href, title) {
  try {
    if (href) return "trendyol_" + Buffer.from(href).toString("base64");
    return "trendyol_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

// S200 wrapper helpers
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

// ==========================================================
// SAFE HTML FETCH (direct -> proxy)
// ==========================================================
async function fetchHTMLWithProxy(url, cfg = {}) {
  try {
    const direct = await axios.get(url, cfg);
    return direct?.data || null;
  } catch (e) {
    try {
      return await proxyFetchHTML(url, { timeout: cfg?.timeout, headers: cfg?.headers });
    } catch {
      try {
        return await proxyFetchHTML(url);
      } catch {
        return null;
      }
    }
  }
}

// ==========================================================
// BUILD ITEM (ZERO DELETE) — hardened + kit-normalize
// ==========================================================
function buildTrendyolItem({ id, title, href, priceRaw, priceText, imgRaw, region = "TR", extra = {} }) {
  const priceSanitized = sanitizePrice(priceRaw, {
    provider: PROVIDER_KEY,
    category: "product",
  });

  let url = safe(href);
  if (url && !url.startsWith("http")) url = BASE + url;

  let img = safe(imgRaw);
  if (img && img.startsWith("//")) img = "https:" + img;
  const imageVariants = buildImageVariants(img || null, PROVIDER_KEY);

  let affiliateUrl = null;
  try {
    affiliateUrl = url ? buildAffiliateUrlS10({ url, provider: PROVIDER_KEY }) : null;
  } catch {
    affiliateUrl = url || null;
  }

  let item = {
    id: stableIdS200(PROVIDER_KEY, affiliateUrl || url || id, title),
    title: title || "",
    price: priceSanitized,
    priceText: priceText || null,
    rating: extra.rating ?? null,

    provider: PROVIDER_FAMILY,
    providerKey: PROVIDER_KEY,
    providerFamily: PROVIDER_FAMILY,
    category: "product",
    vertical: "product",
    currency: "TRY",
    region: String(region).toUpperCase(),

    url: url || null,
    originUrl: url || null,
    affiliateUrl,
    deeplink: affiliateUrl,

    image: imageVariants.image,
    imageOriginal: imageVariants.imageOriginal,
    imageProxy: imageVariants.imageProxy,
    hasProxy: imageVariants.hasProxy,

    commissionRate: extra.commissionRate ?? 0,
    isAffiliate: Boolean(affiliateUrl),
    source: PROVIDER_KEY,

    raw: {
      id,
      title,
      href,
      priceRaw,
      priceText,
      imgRaw,
      ...extra,
    },
  };

  try {
    item = optimizePrice(item, { provider: PROVIDER_KEY, region: item.region, category: "product" });
  } catch {}

  return normalizeItemS200(item, PROVIDER_KEY, {
    providerFamily: PROVIDER_FAMILY,
    baseUrl: BASE,
    currency: "TRY",
    region: item.region,
    category: "product",
    vertical: "product",
  });
}

// ==========================================================
// SCRAPE — ZERO DELETE (now returns raw array; wrapper uses it)
// ==========================================================
async function searchTrendyolScrapeRaw(query = "", region = "TR") {
  const url = `${BASE}/sr?q=${encodeURIComponent(query)}`;

  const html = await fetchHTMLWithProxy(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (FindAllEasy-S200) Chrome/122 Safari/537.36",
      "Accept-Language": "tr-TR,en;q=0.9",
    },
  });

  if (!html) return { ok: false, items: [], url, error: "fetch_failed" };

  const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
  const items = [];

  const selectors = [".p-card-wrppr", ".prdct-cntnr-wrppr", ".product-card", "[data-id][data-content-key]"];

  $(selectors.join(",")).each((_, el) => {
    const root = $(el);

    const title =
      safe(root.find(".prdct-desc-cntnr-ttl").text()) ||
      safe(root.find(".prdct-desc-cntnr-name").text());

    if (!title) return;

    const priceText =
      safe(root.find(".prc-box-dscntd").text()) ||
      safe(root.find(".prc-box-sllng").text());

    const priceRaw = parsePrice(priceText);

    const href = safe(root.find("a").attr("href")) || null;

    const imgRaw =
      safe(root.find("img").attr("data-src")) ||
      safe(root.find("img").attr("src"));

    const item = buildTrendyolItem({
      id: root.attr("data-id") || href || title,
      title,
      href,
      priceRaw,
      priceText,
      imgRaw,
      region,
      extra: { scraped: true },
    });

    if (item) items.push(item);
  });

  return { ok: true, items };
}

// ==========================================================
// MOCK API — ZERO DELETE (DEV ONLY)
// ==========================================================
async function searchTrendyolMockRaw(query = "", region = "TR") {
  const baseUrl = `${BASE}/sr?q=${encodeURIComponent(query)}`;

  const mock = [
    {
      id: "mock1",
      title: `${query} - Trendyol Mock Ürün`,
      priceRaw: 199,
      priceText: "199",
      href: baseUrl,
    },
  ];

  const items = mock
    .map((m) =>
      buildTrendyolItem({
        id: m.id,
        title: m.title,
        href: m.href,
        priceRaw: m.priceRaw,
        priceText: m.priceText,
        imgRaw: null,
        region,
        extra: { mock: true },
      })
    )
    .filter(Boolean);

  return { ok: true, items };
}

// ==========================================================
// FALLBACK (DEV ONLY) — ZERO DELETE (NO Date.now)
// ==========================================================
function buildFallbackRaw(query, region = "TR") {
  const fallbackUrl = `${BASE}/sr?q=${encodeURIComponent(query)}`;

  const it = buildTrendyolItem({
    id: "fallback",
    title: `${query} Trendyol'da Ara`,
    href: fallbackUrl,
    priceRaw: null,
    priceText: null,
    imgRaw: null,
    region,
    extra: { fallback: true },
  });

  return it ? { ok: true, items: [it] } : { ok: true, items: [] };
}

// ==========================================================
// FINAL HYBRID ADAPTER — S200 WRAPPER
// ==========================================================
export async function searchTrendyolAdapter(query, region = "TR") {
  const t0 = Date.now();
  const q = safe(query);
  const reg = String(region || "TR").toUpperCase();

  if (!q) return mkFail("EMPTY_QUERY", "empty_query", { region: reg, ms: 0 });

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, query: q, region: reg };

  try {
    const res = await withTimeout(
      (async () => {
        // 1) SCRAPE
        const scraped = await searchTrendyolScrapeRaw(q, reg);
        if (scraped.ok && scraped.items.length) {
          const items = coerceItemsS200(scraped.items).filter(Boolean);
          return mkS200(true, items, { region: reg, mode: "scrape", ms: Date.now() - t0 });
        }
        if (!scraped.ok) {
          // scrape fail → only DEV can fallback to mock
          if (!ALLOW_STUBS) {
            return mkFail("FETCH_FAIL", scraped.error || "fetch_failed", { region: reg, mode: "scrape", ms: Date.now() - t0 });
          }
        }

        // 2) MOCK API (DEV ONLY)
        if (ALLOW_STUBS) {
          const api = await searchTrendyolMockRaw(q, reg);
          if (api.ok && api.items.length) {
            return mkS200(true, api.items, { region: reg, mode: "mock", stub: true, ms: Date.now() - t0 });
          }

          // 3) FALLBACK (DEV ONLY)
          const fb = buildFallbackRaw(q, reg);
          return mkS200(true, fb.items, { region: reg, mode: "fallback", stub: true, ms: Date.now() - t0 });
        }

        // PROD: no fake
        return mkS200(true, [], { region: reg, mode: "scrape", empty: true, ms: Date.now() - t0 });
      })(),
      DEFAULT_TIMEOUT_MS,
      PROVIDER_KEY
    );

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, { region: reg, timeout: isTimeout, ms: Date.now() - t0 });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// Preserve legacy exports (ZERO DELETE)
export async function searchTrendyolScrape(query = "", region = "TR") {
  // wrapper form now
  const t0 = Date.now();
  const q = safe(query);
  const reg = String(region || "TR").toUpperCase();
  if (!q) return mkFail("EMPTY_QUERY", "empty_query", { region: reg, ms: 0 });

  try {
    const r = await withTimeout(searchTrendyolScrapeRaw(q, reg), DEFAULT_TIMEOUT_MS, PROVIDER_KEY);
    if (!r.ok) return mkFail("FETCH_FAIL", r.error || "fetch_failed", { region: reg, ms: Date.now() - t0 });
    return mkS200(true, r.items || [], { region: reg, mode: "scrape", ms: Date.now() - t0 });
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return mkFail(isTimeout ? "TIMEOUT" : "ERROR", e, { region: reg, timeout: isTimeout, ms: Date.now() - t0 });
  }
}

export async function searchTrendyol(query = "", region = "TR") {
  // DEV-only mock wrapper (kept)
  if (!ALLOW_STUBS) return mkFail("NOT_IMPLEMENTED", "mock_disabled_in_prod", { region: String(region || "TR").toUpperCase() });
  const r = await searchTrendyolMockRaw(query, region);
  return mkS200(true, r.items || [], { region: String(region || "TR").toUpperCase(), mode: "mock", stub: true });
}

export default {
  searchTrendyol,
  searchTrendyolScrape,
  searchTrendyolAdapter,
};
