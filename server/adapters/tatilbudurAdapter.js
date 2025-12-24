// server/adapters/tatilbudurAdapter.js
// ============================================================================
// TATILBUDUR — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta } (iterable/length compat added)
// Contract lock: title+url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) via normalizeItemS200
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout wrapped + global ctx set
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // legacy
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  safeStr,
  normalizeItemS200,
  coerceItemsS200,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const BASE = "https://www.tatilbudur.com";
const PROVIDER_KEY = "tatilbudur";
const ADAPTER_KEY = "tatilbudur_travel";
const PROVIDER_FAMILY = "travel";
const DEFAULT_TIMEOUT_MS = 6500;

// ---------------------------------------------------------------------------
// UTILS
// ---------------------------------------------------------------------------
function safe(v, max = 300) {
  return safeStr(v, max);
}
function abs(base, href) {
  const h = safe(href, 2000);
  if (!h) return "";
  if (h.startsWith("http://") || h.startsWith("https://")) return h;
  if (h.startsWith("//")) return "https:" + h;
  if (h.startsWith("/")) return base + h;
  return base + "/" + h;
}
function parsePrice(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function _errStr(e) {
  return safeStr(e?.message || e || "error", 400);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || String(e?.code || "").toUpperCase().includes("TIME");
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

// ---------------------------------------------------------------------------
// FETCH (direct -> proxy fallback)
// ---------------------------------------------------------------------------
async function fetchHTML(url, cfg) {
  const directCfg = cfg || {};
  try {
    const { data } = await axios.get(url, directCfg);
    return { html: String(data || ""), via: "direct" };
  } catch (e) {
    const directErr = _errStr(e);
    try {
      const h = String((await proxyFetchHTML(url)) || "");
      return { html: h, via: "proxy", directErr };
    } catch (e2) {
      return { html: "", via: "fail", directErr, error: _errStr(e2) };
    }
  }
}

// ---------------------------------------------------------------------------
// SCRAPE
// ---------------------------------------------------------------------------
function scrapeTatilbudurItemsFromHtml(html) {
  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: BASE });
  const items = [];

  // Page may contain different cards (hotel/tour/package)
  const selectors = [
    ".hotel-list-item",
    ".hotel-item",
    ".product-item",
    ".result-item",
    ".search-item",
    ".tour-item",
    ".card"
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".hotel-name").text()) ||
      safe(wrap.find(".title").text()) ||
      safe(wrap.find("h3").text()) ||
      safe(wrap.find("h2").text());

    if (!title) return;

    let href =
      safe(wrap.find("a").attr("href")) ||
      safe(wrap.find(".detail-link").attr("href")) ||
      safe(wrap.find(".hotel-link").attr("href"));

    if (!href) return;

    const originUrl = abs(BASE, href);

    // Category heuristics (stable, purely content-based)
    const hrefL = originUrl.toLowerCase();
    let category = "hotel";
    if (hrefL.includes("/tur/") || hrefL.includes("/turlar") || hrefL.includes("tour")) category = "tour";
    if (hrefL.includes("/paket/") || hrefL.includes("/paket-tur") || hrefL.includes("package")) category = "package";

    const priceTxt =
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".hotel-price").text()) ||
      safe(wrap.find(".amount").text()) ||
      safe(wrap.find(".price-text").text());

    const price = parsePrice(priceTxt);

    const location =
      safe(wrap.find(".location").text()) ||
      safe(wrap.find(".hotel-location").text()) ||
      safe(wrap.find(".place").text()) ||
      "";

    const imgRaw =
      safe(wrap.find("img").attr("data-src")) ||
      safe(wrap.find("img").attr("src")) ||
      "";

    const affiliateUrl = buildAffiliateUrlS10({
      provider: PROVIDER_KEY,
      url: originUrl,
      category,
    });

    let candidate = {
      title,
      originUrl,
      url: originUrl,
      affiliateUrl,
      location,
      currency: "TRY",
      price,
      ...buildImageVariants(imgRaw, category),
      raw: { title, location, originUrl, priceTxt, imgRaw, category },
    };

    candidate.price = sanitizePrice(candidate.price);
    candidate = optimizePrice(candidate, { provider: PROVIDER_KEY, category });

    const normalized = normalizeItemS200(candidate, {
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      category,
      vertical: PROVIDER_FAMILY,
    });

    if (normalized) items.push(normalized);
  });

  const dedup = new Map();
  for (const it of items) if (it?.id && !dedup.has(it.id)) dedup.set(it.id, it);
  return Array.from(dedup.values());
}

// ============================================================================
// EXPORTS (S200)
// ============================================================================
export async function searchTatilBudur(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  const region = typeof regionOrOptions === "string" ? regionOrOptions : (regionOrOptions?.region || "TR");
  const options = typeof regionOrOptions === "object" && regionOrOptions ? regionOrOptions : {};
  const q = safe(query);

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = `${BASE}/arama?q=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const out = await withTimeout((async () => {
      const { html, via, directErr, error } = await fetchHTML(url, {
        timeout: Math.max(1500, Math.min(25000, timeoutMs + 2500)),
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          "Accept-Language": "tr-TR,tr;q=0.9",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: options.signal,
      });

      if (!html) {
        return _mkRes(false, [], {
          code: "FETCH_FAIL",
          error: error || directErr || "FETCH_FAIL",
          url,
          via,
          region,
          ms: Date.now() - t0,
        });
      }

      const items = coerceItemsS200(scrapeTatilbudurItemsFromHtml(html));
      return _mkRes(true, items, {
        code: "OK",
        url,
        via,
        region,
        q: safe(q, 120),
        ms: Date.now() - t0,
        timeoutMs,
      });
    })(), timeoutMs, `${ADAPTER_KEY}.run`);

    return out;
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchTatilBudurScrape = searchTatilBudur;
export const searchTatilBudurAdapter = searchTatilBudur;
