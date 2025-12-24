// server/adapters/otelzAdapter.js
// ============================================================================
// OTELZ — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: import/fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ZERO DELETE: export isimleri korunur
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

// --------------------------------------------------------
// HELPERS
// --------------------------------------------------------
const PROVIDER_KEY = "otelz";
const ADAPTER_KEY = "otelz_hotel";
const PROVIDER_FAMILY = "travel";
const BASE = "https://www.otelz.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.OTELZ_TIMEOUT_MS || 9000);

const clean = (v) => safeStr(v, 1200).trim();

function safeNumber(txt) {
  const val = sanitizePrice(txt, { provider: PROVIDER_KEY });
  return Number.isFinite(val) ? val : null;
}

function resolveRegion(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }
  return { region: String(region || "TR").toUpperCase(), signal, timeoutMs };
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
  // extra compat without changing format (still an object)
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () { yield* arr; },
    });
  } catch {}
  return res;
}

// --------------------------------------------------------
// S22 HOTEL SIGNALS (kept, hardened)
// --------------------------------------------------------
function extractHotelSignals(title, el, $) {
  const lower = String(title || "").toLowerCase();

  const stars =
    (lower.match(/(\d)\s*yıldız/) || [null])[1] ||
    (lower.match(/(\d)\*/ ) || [null])[1] ||
    null;

  const location =
    clean($(el).find(".hotel-location").text()) ||
    clean($(el).find(".location").text()) ||
    null;

  return {
    stars: stars ? Number(stars) : null,
    location,
  };
}

// ============================================================================
// MAIN ADAPTER — searchOtelz (S200)
// ============================================================================
export async function searchOtelz(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const qStr = clean(query);

  const { region, signal, timeoutMs } = resolveRegion(regionOrOptions);

  if (!qStr) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  }

  const q = encodeURIComponent(qStr);
  const url = `${BASE}/ara?q=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    // ---------------------------------------
    // Proxy Fetch → fallback Axios (withTimeout)
    // ---------------------------------------
    let html = "";
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch`);
      html = String(html || "");
    } catch (e) {
      const res = await withTimeout(
        axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0 FindAllEasy-S200" },
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
        }),
        timeoutMs,
        `${ADAPTER_KEY}.axiosFetch`
      );
      html = String(res?.data || "");
    }

    if (!html) {
      return _mkRes(false, [], {
        code: "FETCH_FAIL",
        error: "FETCH_FAIL",
        url,
        region,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const candidates = [];

    const SELECTORS = [
      ".hotel-card",
      ".result-card",
      ".search-result-card",
      ".hotelCard",
      ".list-item",
      ".hotelBox",
      ".hotel-item",
    ];

    SELECTORS.forEach((selector) => {
      $(selector).each((i, el) => {
        const wrap = $(el);

        const title =
          clean(wrap.find(".hotel-name").text()) ||
          clean(wrap.find(".name").text()) ||
          clean(wrap.find("h3").text());

        if (!title) return;

        const priceTxt =
          clean(wrap.find(".price").text()) ||
          clean(wrap.find(".hotel-price").text()) ||
          clean(wrap.find(".amount").text());

        const price = safeNumber(priceTxt);

        let link =
          clean(wrap.find("a").attr("href")) ||
          clean(wrap.find(".hotel-link").attr("href"));

        if (!link) return;
        if (!link.startsWith("http")) link = BASE + link;

        const imgRaw =
          clean(wrap.find("img").attr("data-src")) ||
          clean(wrap.find("img").attr("src")) ||
          null;

        const img = buildImageVariants(imgRaw);

        const hsig = extractHotelSignals(title, el, $);

        let item = {
          id: stableIdS200(PROVIDER_KEY, link, title),
          title,
          price,
          rating: null,

          provider: PROVIDER_FAMILY,
          providerFamily: PROVIDER_FAMILY,
          providerKey: PROVIDER_KEY,
          providerType: "provider",

          vertical: "travel",
          category: "hotel",

          currency: "TRY",
          region,

          url: link,
          originUrl: link,
          deeplink: link,

          image: img.image,
          imageOriginal: img.imageOriginal,
          imageProxy: img.imageProxy,
          hasProxy: img.hasProxy,

          hotel: {
            stars: hsig.stars,
            location: hsig.location,
          },

          raw: {
            title,
            priceTxt,
            link,
            imgRaw,
            hotelSignals: hsig,
          },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY });
        candidates.push(item);
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "travel",
        category: "hotel",
        region,
        currency: "TRY",
        baseUrl: BASE,
      });
      if (n) normalized.push(n);
    }

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
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "CanceledError") {
      return _mkRes(false, [], {
        code: "ABORTED",
        error: "ABORTED",
        url,
        region,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// ALIASES (unchanged)
// ============================================================================
export const searchOtelzScrape = searchOtelz;
export const searchOtelzAdapter = searchOtelz;

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  searchOtelz,
  searchOtelzScrape,
  searchOtelzAdapter,
};
