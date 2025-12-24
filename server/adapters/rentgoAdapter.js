// server/adapters/rentgoAdapter.js
// ============================================================================
// RENTGO — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - ZERO DELETE: mevcut export isimleri korunur.
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - Observable fail: fetch/timeout/parse => ok:false + items:[]
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// - withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE (parser)

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
  safeStr,
} from "../core/s200AdapterKit.js";

// ----------------------------------
const PROVIDER_KEY = "rentgo";
const ADAPTER_KEY = "rentgo_car_rental";
const PROVIDER_FAMILY = "car_rental";
const BASE = "https://www.rentgo.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.RENTGO_TIMEOUT_MS || 6500);

function safe(v, max = 800) {
  return safeStr(v, max);
}

function pick(...vals) {
  for (const v of vals) {
    const s = safe(v, 1200).trim();
    if (s.length > 1) return s;
  }
  return "";
}

// ----------------------------------
// PRICE PARSER (kept, hardened)
// ----------------------------------
function parsePriceS22(text) {
  const n = sanitizePrice(text, { provider: PROVIDER_KEY });
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------
// CATEGORY AI (kept)
// ----------------------------------
function detectCategoryAI(title) {
  const t = (title || "").toLowerCase();
  if (/araç|car|rent|kirala|kiralık|araba|otomobil/.test(t)) return "car_rental";
  return "car_rental";
}

// ----------------------------------
// IMAGE VARIANTS (kept)
// ----------------------------------
function extractImageS22($, el) {
  const raw =
    safe($(el).find("img").attr("data-src"), 2000) ||
    safe($(el).find("img").attr("src"), 2000) ||
    safe($(el).find("source").attr("srcset"), 2000) ||
    "";
  return buildImageVariants(raw || null);
}

// ----------------------------------
// STABLE ID — S200 (NO RANDOM)
// ----------------------------------
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, safe(url, 2000), safe(title, 260));
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  // Back-compat: allow legacy loops treating response like iterable
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

// ============================================================================
// SCRAPER CORE — Proxy + Normalize + Variants
// ============================================================================
async function scrapeRentGo(query, options = {}) {
  const q = encodeURIComponent(String(query || ""));
  const url = `${BASE}/search?keyword=${q}`;

  const t0 = Date.now();
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  let html = "";

  // Proxy-first
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch`);
    html = String(html || "");
  } catch (e) {
    // Fallback direct
    try {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            "Accept-Language": "tr-TR,tr;q=0.9",
          },
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
        timeoutMs,
        `${ADAPTER_KEY}.axiosFetch`
      );
      html = String(res?.data || "");
    } catch (e2) {
      const err = e2 || e;
      const msg = _errStr(err);
      const code = _isTimeout(err) ? "TIMEOUT" : "FETCH_FAIL";
      const ex = new Error(code);
      ex.code = code;
      ex.cause = msg;
      throw ex;
    }
  }

  if (!html) {
    const ex = new Error("FETCH_FAIL");
    ex.code = "FETCH_FAIL";
    throw ex;
  }

  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
  const out = [];

  const selectors = [
    ".car-list-card",
    ".car-card",
    ".vehicle-card",
    ".search-card",
    ".result-card",
    ".listing-card",
    ".car-item",
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title = pick(
      wrap.find(".title").text(),
      wrap.find("h3").text(),
      wrap.find(".car-name").text()
    );
    if (!title) return;

    const priceTxt = pick(
      wrap.find(".price").text(),
      wrap.find(".daily-price").text(),
      wrap.find(".amount").text()
    );
    const price = parsePriceS22(priceTxt);

    let href = safe(wrap.find("a").attr("href"), 2000);
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + href;

    const imgVariants = extractImageS22($, el);
    const category = detectCategoryAI(title);

    let item = {
      // ID: deterministic (NO RANDOM)
      id: stableId(href, title),

      title,
      price,
      rating: null,

      providerKey: PROVIDER_KEY,
      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerType: "provider",

      url: href,
      originUrl: href,
      deeplink: href,

      currency: "TRY",
      region: "TR",

      vertical: PROVIDER_FAMILY,
      category,

      image: imgVariants.image,
      imageOriginal: imgVariants.imageOriginal,
      imageProxy: imgVariants.imageProxy,
      hasProxy: imgVariants.hasProxy,

      raw: {
        title,
        priceTxt,
        url: href,
        image: imgVariants,
      },
    };

    item = optimizePrice(item, { provider: PROVIDER_KEY, category });
    out.push(item);
  });

  // Normalize (contract lock + url priority + badUrl filter + price<=0 => null)
  const normalized = [];
  for (const it of coerceItemsS200(out)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: PROVIDER_FAMILY,
      category: it?.category || "car_rental",
      region: "TR",
      currency: "TRY",
      baseUrl: BASE,
    });
    if (n) normalized.push(n);
  }

  // Dedupe by id
  const seen = new Set();
  const items = [];
  for (const it of normalized) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(it);
  }

  // Attach meta to be used by caller if needed
  items._meta = { url, ms: Date.now() - t0, timeoutMs };
  return items;
}

// ============================================================================
// API — ZERO DELETE (placeholder korunur)
// ============================================================================
async function apiRentGo(query) {
  try {
    return [];
  } catch {
    return [];
  }
}

// ============================================================================
// MAIN EXPORT — S200 REGION + fallback
// ============================================================================
export async function searchRentGo(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 220);

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const ctxUrl = `${BASE}/search?keyword=${encodeURIComponent(q)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: ctxUrl };

  try {
    // API → Scrape fallback
    let api = [];
    try {
      api = await withTimeout(apiRentGo(q), Math.min(2500, timeoutMs), `${ADAPTER_KEY}.api`);
    } catch {
      api = [];
    }

    let rawItems;
    let mode = "scrape";

    if (Array.isArray(api) && api.length) {
      rawItems = api;
      mode = "api";
    } else {
      rawItems = await scrapeRentGo(q, { ...options, timeoutMs });
    }

    // Normalize again (api may differ)
    const items = [];
    for (const it of coerceItemsS200(rawItems)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: PROVIDER_FAMILY,
        category: it?.category || "car_rental",
        region,
        currency: "TRY",
        baseUrl: BASE,
      });
      if (n) items.push(n);
    }

    // Dedupe
    const seen = new Set();
    const deduped = [];
    for (const it of items) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(it);
    }

    return _mkRes(true, deduped, {
      code: deduped.length ? "OK" : "OK_EMPTY",
      mode,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    const code = e?.code || (_isTimeout(e) ? "TIMEOUT" : "ERROR");
    return _mkRes(false, [], {
      code,
      error: _errStr(e?.cause || e),
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchRentGoScrape = searchRentGo;
export const searchRentGoAdapter = searchRentGo;

export default { searchRentGo };
