// server/adapters/teknosaAdapter.js
// ======================================================================
// T E K N O S A — S200 FINAL (KIT-LOCKED, DRIFT-SAFE, OBSERVABLE)
// - Output: { ok, items, count, source, _meta } ✅
// - Contract lock: title + url required; price<=0 => null ✅
// - Observable fail: fetch/timeout/parse => ok:false + items:[] ✅
// - NO RANDOM ID: stableIdS200(providerKey,url,title) ✅
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url ✅
// - withTimeout wrapped ✅
// ZERO DELETE: Var olan fonksiyon isimleri korunur.
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

const PROVIDER_KEY = "teknosa";
const PROVIDER_FAMILY = "teknosa";
const BASE = "https://www.teknosa.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.TEKNOSA_TIMEOUT_MS || 9000);

// ------------------------------------------------------------
function safe(v) { return v == null ? "" : String(v).trim(); }

function parsePrice(txt) {
  if (!txt) return null;
  const c = String(txt).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: legacy stable id helper (not canonical)
function buildStableId(url, title) {
  try {
    if (url) return "teknosa_" + Buffer.from(url).toString("base64");
    return "teknosa_" + Buffer.from(title).toString("base64");
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
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

async function getHTML(url, cfg) {
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
// SCRAPE (S200)
// ------------------------------------------------------------
export async function searchTeknosaScrape(query, regionOrOptions = "TR") {
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

  const url = `${BASE}/arama/?s=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const res = await withTimeout((async () => {
      const html = await getHTML(url, {
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
      const out = [];

      const selectors = [
        ".product-list__product-item",
        ".product-card",
        ".product-item",
        ".prd",
        ".prd-item",
        "[data-testid='product-card']",
      ];

      $(selectors.join(",")).each((i, el) => {
        const w = $(el);

        const brand =
          safe(w.find(".product-list__product-brand").text()) ||
          safe(w.find(".prd-brand").text());

        const title =
          safe(w.find(".product-list__product-name").text()) ||
          safe(w.find(".prd-name").text()) ||
          safe(w.find("h3").text());

        const fullTitle = [brand, title].filter(Boolean).join(" ").trim();
        if (!fullTitle) return;

        const priceTxt =
          safe(w.find(".product-list__product-price").text()) ||
          safe(w.find(".prd-final-price").text()) ||
          safe(w.find(".price").text());

        const priceRaw = parsePrice(priceTxt);
        const price = sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "electronics" });

        let href =
          safe(w.find("a").attr("href")) ||
          safe(w.find(".product-list__product-name").parent().attr("href"));

        if (!href) return;

        const originUrl = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;

        const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: originUrl });

        const imgRaw =
          safe(w.find("img").attr("data-src")) ||
          safe(w.find("img").attr("src"));

        const stableId = stableIdS200(PROVIDER_KEY, affiliateUrl || originUrl, fullTitle);

        let item = {
          id: stableId,
          title: fullTitle,

          provider: PROVIDER_FAMILY,
          providerKey: PROVIDER_KEY,
          providerFamily: PROVIDER_FAMILY,

          vertical: "product",
          category: "electronics",
          region: String(region || "TR").toUpperCase(),
          currency: "TRY",
          rating: null,

          url: originUrl,
          originUrl,
          affiliateUrl,
          deeplink: affiliateUrl,
          finalUrl: affiliateUrl,

          price,
          priceText: priceTxt || null,

          ...buildImageVariants(imgRaw || null, PROVIDER_KEY),

          raw: { brand, title, fullTitle, priceTxt, originUrl, imgRaw },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY, region, category: "electronics" });

        out.push(item);
      });

      const normalized = [];
      for (const it of coerceItemsS200(out)) {
        const n = normalizeItemS200(it, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          baseUrl: BASE,
          region: String(region || "TR").toUpperCase(),
          currency: "TRY",
          category: "electronics",
          vertical: "product",
          requireRealUrlCandidate: true,
        });
        if (n) normalized.push(n);
      }

      const seen = new Set();
      const deduped = [];
      for (const it of normalized) {
        const k = String(it?.id || "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        deduped.push(it);
      }

      const sliced = deduped.slice(0, 60);
      return _mkRes(sliced.length > 0, sliced, {
        ms: Date.now() - t0,
        region,
        query: q,
        url,
        parsed: out.length,
        returned: sliced.length,
      });
    })(), timeoutMs, PROVIDER_KEY);

    return res;
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
// API (not implemented) — OBSERVABLE
// ------------------------------------------------------------
export async function searchTeknosaAPI(query, regionOrOptions = "TR") {
  const region = typeof regionOrOptions === "string" ? regionOrOptions : (regionOrOptions?.region || "TR");
  return _mkRes(false, [], {
    code: "NOT_IMPLEMENTED",
    notImplemented: true,
    region,
    query: safe(query),
  });
}

// ------------------------------------------------------------
// Unified Adapter — API first then scrape (ZERO DELETE)
// ------------------------------------------------------------
export async function searchTeknosaAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  try {
    const api = await searchTeknosaAPI(query, regionOrOptions);
    if (api?.ok && Array.isArray(api?.items) && api.items.length) return api;

    return await searchTeknosaScrape(query, regionOrOptions);
  } catch (err) {
    return _mkRes(false, [], { code: "ERROR", error: _errStr(err), ms: Date.now() - t0 });
  }
}

export default {
  searchTeknosaAdapter,
  searchTeknosaScrape,
  searchTeknosaAPI,
};
