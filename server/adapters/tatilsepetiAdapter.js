// server/adapters/tatilsepetiAdapter.js
// ======================================================================
// TatilSepeti — S200 FINAL (KIT-LOCKED, DRIFT-SAFE, OBSERVABLE)
// - Output: { ok, items, count, source, _meta }  ✅
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200) ✅
// - NO RANDOM ID: stableIdS200(providerKey,url,title) ✅
// - Observable fail: fetch/timeout/parse => ok:false + items:[] (+ _meta.error/code) ✅
// - withTimeout: provider call wrapped ✅
// - URL priority: affiliateUrl > originUrl > url (normalizeItemS200) ✅
// - NO FAKE RESULTS: PROD’da stub yok ✅
// ZERO DELETE: Mevcut fonksiyonlar korunur, sadece güçlendirilir.
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
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "tatilsepeti";
const PROVIDER_FAMILY = "tatilsepeti";
const BASE = "https://www.tatilsepeti.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.TATILSEPETI_TIMEOUT_MS || 9000);

// ------------------------------------------------------------
// SAFE HELPERS (legacy kept)
// ------------------------------------------------------------
function safe(v) { return v == null ? "" : String(v).trim(); }

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt).replace(/[^\d.,]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function abs(base, href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return base + href;
  return base + "/" + href;
}

// ZERO DELETE: legacy stable id helper (not used as canonical id)
function buildStableId(url, title) {
  try {
    return "tatilsepeti_" + Buffer.from(url || title).toString("base64");
  } catch {
    return url || title;
  }
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    _meta: { ...meta },
  };

  // Back-compat: iterable + length (non-enumerable) — kırılgan eski çağrılar için
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () { yield* arr; },
    });
  } catch {}
  return res;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

// ------------------------------------------------------------
// SAFE HTML FETCH (native → proxy fallback) + timeout
// ------------------------------------------------------------
async function fetchHTML(url, cfg) {
  try {
    const { data } = await axios.get(url, cfg);
    return String(data || "");
  } catch (err) {
    try {
      return String(await proxyFetchHTML(url) || "");
    } catch {
      return "";
    }
  }
}

// ------------------------------------------------------------
// MAIN SCRAPER (S200)
// ------------------------------------------------------------
export async function searchTatilSepeti(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const q = safe(query);
  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = `${BASE}/arama?q=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const result = await withTimeout((async () => {
      const html = await fetchHTML(url, {
        timeout: Math.max(1500, Math.min(20000, timeoutMs + 3000)),
        signal: options.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
      });

      if (!html) {
        return _mkRes(false, [], {
          code: "FETCH_FAIL",
          error: "FETCH_FAIL",
          ms: Date.now() - t0,
          region,
          query: q,
          url,
        });
      }

      const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
      const rawItems = [];

      const selectors = [
        ".hotelItem",
        ".hotel-item",
        ".result-item",
        ".product-item",
        ".tourItem",
        ".package-item",
        ".ts-hotel-card",
        ".ts-tour-card",
        ".ts-package-card",
      ];

      $(selectors.join(",")).each((i, el) => {
        const w = $(el);

        const title =
          safe(w.find(".hotelName").text()) ||
          safe(w.find(".name").text()) ||
          safe(w.find(".product-title").text()) ||
          safe(w.find("h3").text());

        if (!title) return;

        const categoryGuess =
          w.hasClass("tourItem") || w.hasClass("ts-tour-card")
            ? "tour"
            : w.hasClass("package-item") || w.hasClass("ts-package-card")
              ? "package"
              : "hotel";

        const priceTxt =
          safe(w.find(".price").text()) ||
          safe(w.find(".amount").text()) ||
          safe(w.find(".value").text());

        const priceRaw = parsePrice(priceTxt);

        let href =
          safe(w.find("a").attr("href")) ||
          safe(w.find(".product-link").attr("href"));

        if (!href) return;

        const originUrl = abs(BASE, href);

        // Affiliate Injection (S10)
        const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: originUrl });

        const imgRaw =
          safe(w.find("img").attr("data-src")) ||
          safe(w.find("img").attr("src")) ||
          null;

        const stableId = stableIdS200(PROVIDER_KEY, affiliateUrl || originUrl, title);

        let item = {
          id: stableId, // deterministic
          title,
          provider: PROVIDER_FAMILY,
          providerKey: PROVIDER_KEY,
          providerFamily: PROVIDER_FAMILY,
          region: String(region || "TR").toUpperCase(),
          currency: "TRY",
          vertical: "travel",
          category: categoryGuess,
          rating: null,

          // URL candidates (priority handled in normalizeItemS200)
          url: originUrl,
          originUrl,
          affiliateUrl,
          deeplink: affiliateUrl,
          finalUrl: affiliateUrl,

          price: sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: categoryGuess }),
          priceText: priceTxt || null,

          ...buildImageVariants(imgRaw, PROVIDER_KEY),

          raw: {
            title,
            priceRaw,
            priceTxt,
            href: originUrl,
            imgRaw,
            categoryGuess,
          },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY, category: categoryGuess, region });

        rawItems.push(item);
      });

      const normalized = [];
      for (const it of coerceItemsS200(rawItems)) {
        const n = normalizeItemS200(it, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          baseUrl: BASE,
          region: String(region || "TR").toUpperCase(),
          currency: "TRY",
          category: it?.category || "hotel",
          vertical: "travel",
          requireRealUrlCandidate: true,
        });
        if (n) normalized.push(n);
      }

      // Dedupe by id
      const seen = new Set();
      const deduped = [];
      for (const it of normalized) {
        const k = String(it?.id || "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        deduped.push(it);
      }

      return _mkRes(deduped.length > 0, deduped.slice(0, 60), {
        ms: Date.now() - t0,
        region,
        query: q,
        url,
        parsed: rawItems.length,
        returned: deduped.length,
      });
    })(), timeoutMs, PROVIDER_KEY);

    return result;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return _mkRes(false, [], {
      code: isTimeout ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      timeout: !!isTimeout,
      ms: Date.now() - t0,
      region,
      query: q,
      url,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ------------------------------------------------------------
// EXPORT ALIASES (ZERO DELETE)
// ------------------------------------------------------------
export const searchTatilSepetiScrape = searchTatilSepeti;
export const searchTatilSepetiAdapter = searchTatilSepeti;

export default {
  searchTatilSepeti,
  searchTatilSepetiScrape,
  searchTatilSepetiAdapter,
};
