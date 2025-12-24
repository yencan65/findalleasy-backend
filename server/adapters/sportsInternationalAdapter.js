// server/adapters/sportsInternationalAdapter.js
// ============================================================================
// SPORTS INTERNATIONAL (KULÜPLER) — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH)
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
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
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
const BASE = "https://www.sportsinternational.com.tr";
const PROVIDER_KEY = "sportsinternational";
const ADAPTER_KEY = "sportsinternational_fitness";
const PROVIDER_FAMILY = "health";
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
function scrapeClubItemsFromHtml(html, query) {
  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: BASE + "/kulupler" });
  const items = [];
  const qLower = safe(query).toLowerCase();

  const selectors = [
    ".branch-card",
    ".club-card",
    ".branchBox",
    ".club-item",
    ".kolon"
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".title").text()) ||
      safe(wrap.find(".branch-title").text()) ||
      safe(wrap.find("h3").text()) ||
      safe(wrap.find("h2").text());

    if (!title) return;

    // Query-proof
    if (qLower) {
      const blob = (title + " " + safe(wrap.text(), 900)).toLowerCase();
      if (!blob.includes(qLower)) return;
    }

    let href =
      safe(wrap.find("a").attr("href")) ||
      safe(wrap.find(".branch-link").attr("href"));

    if (!href) return;

    const originUrl = abs(BASE, href);

    const affiliateUrl = buildAffiliateUrlS10({
      provider: PROVIDER_KEY,
      url: originUrl,
      category: "fitness",
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
      location: null,
      price: null,
      finalPrice: null,
      optimizedPrice: null,
      rating: null,
      ...buildImageVariants(imgRaw, "fitness"),
      raw: { title, originUrl, imgRaw },
    };

    // keep pipeline hooks (no-op here but avoids drift)
    candidate.price = sanitizePrice(candidate.price);
    candidate = optimizePrice(candidate, { provider: PROVIDER_KEY, category: "fitness" });

    const normalized = normalizeItemS200(candidate, {
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      category: "fitness",
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
export async function searchSportsInternational(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  const region = typeof regionOrOptions === "string" ? regionOrOptions : (regionOrOptions?.region || "TR");
  const options = typeof regionOrOptions === "object" && regionOrOptions ? regionOrOptions : {};
  const q = safe(query);

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = BASE + "/kulupler";
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

      const items = coerceItemsS200(scrapeClubItemsFromHtml(html, q));
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

export const searchSportsInternationalScrape = searchSportsInternational;
export const searchSportsInternationalAdapter = searchSportsInternational;
