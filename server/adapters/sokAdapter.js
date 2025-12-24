// server/adapters/sokAdapter.js
// ============================================================================
// ŞOK Market — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) via normalizeItemS200
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout everywhere + global ctx set
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
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

const PROVIDER_KEY = "sok";
const ADAPTER_KEY = "sok_market";
const PROVIDER_FAMILY = "market";
const BASE = "https://www.sokmarket.com.tr";
const DEFAULT_TIMEOUT_MS = 6500;

const safe = (v, max = 400) => safeStr(v, max);

function _now() {
  return Date.now();
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

// ZERO DELETE: legacy stableId name preserved (but not used as authority)
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, url || "", title || "");
}

// ======================================================================
//  SCRAPER (Proxy destekli + Multi-selector + QueryProof) — S200
// ======================================================================
async function fetchSokHTML(url, signal, timeoutMs) {
  try {
    const { data } = await axios.get(url, {
      timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });
    return String(data || "");
  } catch (e) {
    try {
      const h = await proxyFetchHTML(url);
      return String(h || "");
    } catch {
      return "";
    }
  }
}

function _normalizeCandidates(rawItems, region) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "market",
      category: "market",
      region,
      currency: "TRY",
      baseUrl: BASE,
    });
    if (n) out.push(n);
  }
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}

async function scrapeSok(query, region, signal, timeoutMs) {
  const url = `${BASE}/search/?s=${encodeURIComponent(query)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const html = await withTimeout(fetchSokHTML(url, signal, timeoutMs), timeoutMs, `${ADAPTER_KEY}.fetch`);
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", error: "FETCH_FAIL", url, region });

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const out = [];

    const selectors = [".product-box", ".product-card", ".productItem", ".productWrapper", ".prd-card", ".prd"];

    const qLower = safe(query, 120).toLowerCase();

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".product-title").text()) ||
        safe(wrap.find(".productName").text()) ||
        safe(wrap.find("h2").text());

      if (!title) return;

      const priceRaw =
        safe(wrap.find(".product-price").text()) ||
        safe(wrap.find(".current").text()) ||
        safe(wrap.find(".price").text());

      const price = sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "market" });

      let href =
        safe(wrap.find("a").attr("href"), 2000) ||
        safe(wrap.find(".productLink").attr("href"), 2000);

      if (!href) return;
      if (!href.startsWith("http")) href = `${BASE}${href}`;

      const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: href });

      const img =
        safe(wrap.find("img").attr("data-src"), 2000) ||
        safe(wrap.find("img").attr("src"), 2000) ||
        null;

      // QueryProof
      const t = title.toLowerCase();
      const textAll = safe(wrap.text(), 1200).toLowerCase();
      if (qLower && !t.includes(qLower) && !textAll.includes(qLower)) return;

      let item = {
        id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),
        title,
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        category: "market",
        vertical: "market",
        region,
        price,
        rating: null,

        url: href,
        originUrl: href,
        affiliateUrl,

        currency: "TRY",

        ...buildImageVariants(img, "product"),

        raw: { href, title, priceRaw, img },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "market" });
      out.push(item);
    });

    const items = _normalizeCandidates(out, region).slice(0, 60);
    return _mkRes(true, items, { code: items.length ? "OK" : "OK_EMPTY", url, region });
  } catch (e) {
    return _mkRes(false, [], { code: _isTimeout(e) ? "TIMEOUT" : "ERROR", error: _errStr(e), url, region });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ======================================================================
//  UNIFIED ADAPTER — S200
// ======================================================================
export async function searchSokAdapter(query, regionOrOptions = "TR") {
  const t0 = _now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 140);

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const res = await scrapeSok(q, region, options.signal, timeoutMs);
  // attach timing
  res._meta = { ...(res._meta || {}), ms: _now() - t0, timeoutMs };
  return res;
}

// S8 alias
export const searchSok = async (q, o) => searchSokAdapter(q, o);
export const searchSokScrape = async (q, o) => searchSokAdapter(q, o);

export default {
  searchSok,
  searchSokScrape,
  searchSokAdapter,
};
