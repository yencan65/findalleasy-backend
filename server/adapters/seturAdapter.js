// server/adapters/seturAdapter.js
// ============================================================================
// SETUR – Otel / Tur / Cruise / Paket Adapter — S200 HARDENED (DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// NO FAKE RESULTS: fail => ok:false items:[]
// Observable fail: fetch/timeout/parse => ok:false + _meta.error/timeout
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout everywhere + global ctx set
// ZERO DELETE: export isimleri korunur (searchSetur / searchSeturScrape / searchSeturAdapter)
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

// ==================================================
// ENV (ZERO DELETE)
// ==================================================
const AFF_ID = process.env.SETUR_AFFILIATE_ID || "";
const CAMP_ID = process.env.SETUR_CAMPAIGN_ID || "";
const SUBKEY = process.env.SETUR_SUBID_KEY || "subid";
const BASE = process.env.SETUR_BASE_URL || "https://www.setur.com.tr";
const REDIRECT = process.env.SETUR_AFFILIATE_REDIRECT || "";

// Adapter meta
const PROVIDER_KEY = "setur";
const ADAPTER_KEY = "setur_travel";
const PROVIDER_FAMILY = "travel";
const DEFAULT_TIMEOUT_MS = 6500;

function safe(v, max = 400) {
  return safeStr(v, max);
}

function parsePrice(t) {
  if (!t) return null;
  const n = Number(
    String(t)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: stableId function name preserved, but deterministic and S200-compliant
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, safe(url, 2000), safe(title, 260));
}

// ==================================================
// AFFILIATE URL (Titan hardened) — preserved
// ==================================================
function buildAffiliateUrl(url) {
  if (!url) return url;

  try {
    if (REDIRECT) {
      const encoded = encodeURIComponent(url);
      return `${REDIRECT}${encoded}&${SUBKEY}=${AFF_ID}`;
    }

    const u = new URL(url);
    if (AFF_ID) u.searchParams.set(SUBKEY, AFF_ID);
    if (CAMP_ID) u.searchParams.set("cid", CAMP_ID);

    return u.toString();
  } catch {
    return url;
  }
}

// Proxy destekli HTML fetch
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

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  // Back-compat: some legacy code treats response like array
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

// ==================================================
// MAIN ADAPTER — S200
// ==================================================
export async function searchSetur(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions || "TR";
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 200);

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = `${BASE}/arama?q=${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const html = await withTimeout(fetchHTML(url, options.signal, timeoutMs), timeoutMs, `${ADAPTER_KEY}.fetch`);
    if (!html) {
      return _mkRes(false, [], { code: "FETCH_FAIL", error: "FETCH_FAIL", url, region, ms: Date.now() - t0, timeoutMs });
    }

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const out = [];

    const selectors =
      ".hotel-card, .tour-card, .package-card, .cruise-card, .search-result-item";

    $(selectors).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".hotel-name").text()) ||
        safe(wrap.find(".tour-name").text()) ||
        safe(wrap.find(".package-title").text()) ||
        safe(wrap.find(".title").text());

      if (!title) return;

      const rawPrice =
        parsePrice(safe(wrap.find(".price").text(), 120)) ||
        parsePrice(safe(wrap.find(".amount").text(), 120)) ||
        null;

      let href = safe(wrap.find("a").attr("href"), 2000);
      if (!href) return;

      if (!href.startsWith("http")) href = BASE + href;

      const affiliateUrl = buildAffiliateUrl(href);

      // category detect (stable heuristic)
      const category =
        wrap.find(".hotel-name").length > 0
          ? "hotel"
          : wrap.find(".tour-name").length > 0
          ? "tour"
          : wrap.find(".cruise-card").length > 0
          ? "cruise"
          : "package";

      let item = {
        id: stableId(affiliateUrl || href, title),
        title,

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,
        vertical: "travel",

        region,
        currency: "TRY",
        category,

        // URL priority: affiliateUrl wins, but keep originUrl too
        url: href,
        originUrl: href,
        affiliateUrl,

        // Contract: price<=0 => null via sanitizePrice + normalizeItemS200
        price: sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category }),

        rating: null,

        raw: { title, rawPrice, originalUrl: href, affiliateUrl },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category });

      out.push(item);
    });

    // Normalize via kit
    const normalized = [];
    for (const it of coerceItemsS200(out)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "travel",
        category: it?.category || "travel",
        region,
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

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
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

// ==================================================
// EXPORTS (ZERO DELETE)
// ==================================================
export const searchSeturScrape = searchSetur;
export const searchSeturAdapter = searchSetur;

export default {
  searchSetur,
  searchSeturScrape,
  searchSeturAdapter,
};
