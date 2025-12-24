// server/adapters/rossmannAdapter.js
// ============================================================================
// ROSSMANN — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - ZERO DELETE: mevcut export isimleri korunur.
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - Observable fail: fetch/timeout/parse => ok:false + items:[]
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// - withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

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

const PROVIDER_KEY = "rossmann";
const ADAPTER_KEY = "rossmann_market";
const PROVIDER_FAMILY = "market";
const BASE = "https://www.rossmann.com.tr";
const MAX_PAGES = Number(process.env.ROSSMANN_MAX_PAGES || 3);
const DEFAULT_TIMEOUT_MS = Number(process.env.ROSSMANN_TIMEOUT_MS || 6500);

// ========================= HELPERS =========================
function safe(v, max = 900) {
  return safeStr(v, max);
}
function pick(...vals) {
  for (const v of vals) {
    const s = safe(v, 1400).trim();
    if (s.length > 1) return s;
  }
  return "";
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
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

// ------------------------------
// PRICE PARSER (kept)
// ------------------------------
function parsePriceS22(text) {
  const n = sanitizePrice(text, { provider: PROVIDER_KEY });
  return Number.isFinite(n) ? n : null;
}

// ------------------------------
// CATEGORY AI (kept)
// ------------------------------
function detectCategoryAI(title) {
  const t = (title || "").toLowerCase();
  if (/şampuan|krem|cilt|saç|parfüm|kozmetik|makyaj/.test(t)) return "cosmetics";
  if (/temizlik|deterjan/.test(t)) return "cleaning";
  if (/vitamin|takviye/.test(t)) return "supplement";
  return "product";
}

// ------------------------------
// IMAGE VARIANTS (kept)
// ------------------------------
function extractImageS22($, el) {
  const raw =
    safe($(el).find("img").attr("data-src-mobile"), 2000) ||
    safe($(el).find("img").attr("data-src"), 2000) ||
    safe($(el).find("img").attr("src"), 2000) ||
    safe($(el).find("source").attr("srcset"), 2000) ||
    "";
  return buildImageVariants(raw || null);
}

// ------------------------------
// STABLE ID — S200 (NO RANDOM)
// ------------------------------
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, safe(url, 2000), safe(title, 260));
}

// ============================================================================
// SCRAPER CORE — Proxy + Normalize + Variants
// ============================================================================
async function scrapeRossmannPage(query, page = 1, options = {}) {
  const q = encodeURIComponent(String(query || ""));
  const url = `${BASE}/arama?q=${q}&sayfa=${page}`;

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  let html = "";

  // 1) PROXY FETCH
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch.p${page}`);
    html = String(html || "");
  } catch (e) {
    // 2) Fallback AXIOS
    try {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
        timeoutMs,
        `${ADAPTER_KEY}.axiosFetch.p${page}`
      );
      html = String(res?.data || "");
    } catch (e2) {
      const err = e2 || e;
      const ex = new Error(_isTimeout(err) ? "TIMEOUT" : "FETCH_FAIL");
      ex.code = _isTimeout(err) ? "TIMEOUT" : "FETCH_FAIL";
      ex.cause = _errStr(err);
      ex.url = url;
      throw ex;
    }
  }

  if (!html) {
    const ex = new Error("FETCH_FAIL");
    ex.code = "FETCH_FAIL";
    ex.url = url;
    throw ex;
  }

  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
  const list = [];

  const selectors = [".product-card", ".product", ".product-item", ".product-box"];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title = pick(
      wrap.find(".product-card-name").text(),
      wrap.find(".product-name").text(),
      wrap.find("h3").text()
    );
    if (!title) return;

    const priceTxt = pick(
      wrap.find(".product-card-price-new").text(),
      wrap.find(".product-card-price").text(),
      wrap.find(".product-price").text(),
      wrap.find(".price-new").text(),
      wrap.find(".price").text()
    );
    const price = parsePriceS22(priceTxt);

    let href = safe(wrap.find("a").attr("href"), 2000) || safe(wrap.find(".product-card-link").attr("href"), 2000);
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + href;

    const imgVariants = extractImageS22($, el);
    const category = detectCategoryAI(title);

    let item = {
      id: stableId(href, title),

      title,
      price,
      url: href,
      originUrl: href,
      deeplink: href,

      providerKey: PROVIDER_KEY,
      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerType: "provider",

      currency: "TRY",
      region: "TR",
      vertical: PROVIDER_FAMILY,
      category,

      rating: null,

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
    list.push(item);
  });

  // Normalize
  const items = [];
  for (const it of coerceItemsS200(list)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: PROVIDER_FAMILY,
      category: it?.category || "product",
      region: "TR",
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

  return deduped;
}

// ============================================================================
// MAIN ADAPTER — S200
// ============================================================================
export async function searchRossmann(query, regionOrOptions = "TR") {
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
  if (!q) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const ctxUrl = `${BASE}/arama?q=${encodeURIComponent(q)}&sayfa=1`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: ctxUrl };

  const errors = [];
  let all = [];

  try {
    const maxPages = Math.max(1, Math.min(10, Number.isFinite(MAX_PAGES) ? MAX_PAGES : 3));
    for (let page = 1; page <= maxPages; page++) {
      try {
        const part = await scrapeRossmannPage(q, page, { ...options, timeoutMs });

        if (!part.length) break;
        all = all.concat(part);

        // early exit heuristics
        if (part.length < 10) break;
      } catch (e) {
        errors.push({
          page,
          code: e?.code || (_isTimeout(e) ? "TIMEOUT" : "ERROR"),
          error: _errStr(e?.cause || e),
          url: e?.url || "",
        });
        break; // stop paging on error
      }
    }

    // Dedupe across pages
    const seen = new Set();
    const deduped = [];
    for (const it of all) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(it);
    }

    const ok = deduped.length > 0 || errors.length === 0;

    return _mkRes(ok, deduped, {
      code: ok ? (deduped.length ? "OK" : "OK_EMPTY") : (errors[0]?.code || "ERROR"),
      region,
      partial: errors.length > 0 && deduped.length > 0,
      errors: errors.length ? errors.slice(0, 3) : undefined,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchRossmannScrape = searchRossmann;
export const searchRossmannAdapter = searchRossmann;

export default { searchRossmann };
