// server/adapters/tapucomAdapter.js
// ============================================================================
// TAPU.COM — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
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
const BASE = "https://www.tapu.com";
const PROVIDER_KEY = "tapucom";
const ADAPTER_KEY = "tapucom_estate";
const PROVIDER_FAMILY = "estate";
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
function scrapeTapuItemsFromHtml(html) {
  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: BASE });
  const items = [];

  const selectors = [
    ".property-card",
    ".listing-item",
    ".search-card",
    ".auction-card",
    ".propertyBox"
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".property-title").text()) ||
      safe(wrap.find(".title").text()) ||
      safe(wrap.find("h3").text());

    if (!title) return;

    const priceTxt =
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".property-price").text()) ||
      safe(wrap.find(".listing-price").text());

    const price = parsePrice(priceTxt);

    const location =
      safe(wrap.find(".location").text()) ||
      safe(wrap.find(".property-location").text()) ||
      safe(wrap.find(".listing-location").text()) ||
      "";

    let href =
      safe(wrap.find("a").attr("href")) ||
      safe(wrap.find(".property-link").attr("href"));

    if (!href) return;

    const originUrl = abs(BASE, href);

    const affiliateUrl = buildAffiliateUrlS10({
      provider: PROVIDER_KEY,
      url: originUrl,
    });

    const imgRaw =
      safe(wrap.find("img").attr("data-src")) ||
      safe(wrap.find("img").attr("src")) ||
      "";

    let candidate = {
      title,
      originUrl,
      url: originUrl,
      affiliateUrl,
      location,
      currency: "TRY",
      price,
      ...buildImageVariants(imgRaw, "estate"),
      raw: { title, location, originUrl, priceTxt, imgRaw },
    };

    candidate.price = sanitizePrice(candidate.price);
    candidate = optimizePrice(candidate, { provider: PROVIDER_KEY, category: "real_estate" });

    const normalized = normalizeItemS200(candidate, {
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      category: "real_estate",
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
export async function searchTapuCom(query, regionOrOptions = "TR") {
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

      const items = coerceItemsS200(scrapeTapuItemsFromHtml(html));
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

export const searchTapuComScrape = searchTapuCom;
export const searchTapuComAdapter = searchTapuCom;
