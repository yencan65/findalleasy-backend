// server/adapters/sixtAdapter.js
// ============================================================================
// SIXT – Araç Kiralama Adapteri — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// NO FAKE RESULTS: fail => ok:false items:[]
// Observable fail: fetch/timeout/parse => ok:false + _meta.error/timeout
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout everywhere + global ctx set
// ZERO DELETE: export isimleri korunur (searchSixt / searchSixtScrape / searchSixtAdapter)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "sixt";
const ADAPTER_KEY = "sixt_car_rental";
const PROVIDER_FAMILY = "car_rental";
const DEFAULT_TIMEOUT_MS = 6500;

function safe(v, max = 400) {
  return safeStr(v, max);
}

// ZERO DELETE: stableId name preserved, but now deterministic (no Math.random)
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, safe(url, 2000), safe(title, 260));
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function fetchHTML(url, signal, timeoutMs) {
  try {
    const r = await axios.get(url, {
      signal,
      timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
      headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
    });
    return String(r?.data || "");
  } catch {
    try {
      return String((await proxyFetchHTML(url)) || "");
    } catch {
      return "";
    }
  }
}

// ====================== AFFILIATE ENGINE (Dummy) ======================
// NOTE: This is a provider adapter, not a discovery source — affiliate is allowed.
const SIXT_AFF_ID = process.env.SIXT_AFF_ID || "fae_sixt";
function buildAffiliate(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("affid", SIXT_AFF_ID);
    return u.toString();
  } catch {
    return url;
  }
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  // Back-compat: some legacy code treats response like an array
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}
function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}

// ====================== SCRAPER — S200 ======================
async function scrapeSixt(query, region, options = {}) {
  const q = safe(query, 200);
  const url = `https://www.sixt.com.tr/arama?query=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const html = await withTimeout(fetchHTML(url, options.signal, timeoutMs), timeoutMs, `${ADAPTER_KEY}.fetch`);
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", error: "FETCH_FAIL", url, region });

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const items = [];

    const selectors = [
      ".car-card",
      ".vehicle-card",
      ".product-card",
      ".search-result",
      ".car-item",
      ".result-item",
      ".car-list-item",
      ".result-card",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".car-name").text()) ||
        safe(wrap.find(".name").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find("h3").text());

      if (!title) return;

      const priceTxt =
        safe(wrap.find(".price").text(), 120) ||
        safe(wrap.find(".daily-price").text(), 120) ||
        safe(wrap.find(".amount").text(), 120);

      const rawPrice = parsePrice(priceTxt);

      let href = safe(wrap.find("a").attr("href"), 2000);
      if (!href) return;

      if (!href.startsWith("http")) href = "https://www.sixt.com.tr" + href;

      const affiliateUrl = buildAffiliate(href);

      let item = {
        id: stableId(affiliateUrl || href, title),
        title,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,
        providerType: "provider",
        vertical: "travel",

        category: "car_rental",
        region,
        currency: "TRY",

        url: href,
        originUrl: href,
        affiliateUrl,

        price: sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "car_rental" }),
        rating: null,

        raw: { title, priceTxt, href },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "car_rental" });
      items.push(item);
    });

    // Normalize via kit
    const normalized = [];
    for (const it of coerceItemsS200(items)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "travel",
        category: "car_rental",
        region,
        currency: "TRY",
        baseUrl: "https://www.sixt.com.tr",
      });
      if (n) normalized.push(n);
    }

    // Dedupe by id
    const seen = new Set();
    const out = [];
    for (const it of normalized) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }

    return _mkRes(true, out, { code: out.length ? "OK" : "OK_EMPTY", url, region, timeoutMs });
  } catch (e) {
    return _mkRes(false, [], { code: _isTimeout(e) ? "TIMEOUT" : "ERROR", error: _errStr(e), url, region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ====================== API (Boş ama korunuyor) ======================
async function apiSixt(query, options = {}) {
  // S200 observable: API not implemented
  return _mkRes(false, [], { code: "NOT_IMPLEMENTED", notImplemented: true, error: "NOT_IMPLEMENTED" });
}

// ====================== UNIFIED — S200 ======================
export async function searchSixt(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") region = regionOrOptions || "TR";
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const api = await apiSixt(query, options);
  if (api?.ok && api.items?.length) {
    api._meta = { ...(api._meta || {}), region, ms: Date.now() - t0, timeoutMs };
    return api;
  }

  const scraped = await scrapeSixt(query, region, { ...options, timeoutMs });
  scraped._meta = { ...(scraped._meta || {}), region, ms: Date.now() - t0, timeoutMs };
  return scraped;
}

export const searchSixtScrape = searchSixt;
export const searchSixtAdapter = searchSixt;

export default { searchSixt };
