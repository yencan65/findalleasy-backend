// server/adapters/mediamarktAdapter.js
// ============================================================================
// MEDIAMARKT — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO FAKE RESULTS in PROD: fallback/stub only if FINDALLEASY_ALLOW_STUBS=1
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - URL priority handled by kit normalizer
// - withTimeout everywhere + global ctx set
// ZERO DELETE: S22 işlevleri korunur (API stub dahil)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

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
  parsePriceS200,
} from "../core/s200AdapterKit.js";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";
const safe = (v) => (v == null ? "" : String(v).trim());
const clean = (v) => safeStr(v, 1800).trim();

function stableId(seed, index = 0) {
  // ZERO DELETE: signature kept; now S200-stable
  return stableIdS200("mediamarkt", String(seed || ""), String(seed || "mediamarkt"));
}

function detectCategoryAI() {
  return "electronics";
}

function extractGeoSignal(title = "") {
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa"];
  const t = String(title || "").toLowerCase();
  return cities.find((c) => t.includes(c)) || null;
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 5) s += 0.3;
  if (item.image) s += 0.4;
  if (item.price) s += 0.3;
  return Number(s.toFixed(2));
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source: "mediamarkt", _meta: { ...meta } };
}

function parseRegionOptions(regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let sig = signal;
  let timeoutMs = Number(process.env.MEDIAMARKT_TIMEOUT_MS || 14000);

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    sig = regionOrOptions.signal || sig;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }

  return { region: String(region || "TR").toUpperCase(), signal: sig, timeoutMs };
}

// ----------------------------------------------------------------------------
// 1) API (dummy) – ZERO DELETE
// ----------------------------------------------------------------------------
export async function searchMediaMarktAPI(query, regionOrOptions = "TR", signal) {
  return [];
}

// ----------------------------------------------------------------------------
// 2) SCRAPE — returns { ok, items, _meta }
// ----------------------------------------------------------------------------
export async function searchMediaMarktScrape(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions, signal);
  const q = clean(query);

  if (!q) return { ok: true, items: [], _meta: { code: "OK_EMPTY", region, timeoutMs } };

  const url = `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "mediamarkt_adapter", providerKey: "mediamarkt", url };

  try {
    let html = null;

    // PROXY first
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, "mediamarkt.proxyFetch");
    } catch {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal: sig,
          headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
        }),
        timeoutMs,
        "mediamarkt.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return { ok: false, items: [], _meta: { code: "FETCH_FAIL", url, region, timeoutMs } };

    const $ = loadCheerioS200(html, { adapter: "mediamarkt_adapter", providerKey: "mediamarkt", url });
    const raw = [];

    const selectors = [
      ".product-wrapper",
      ".products-list .product",
      ".product",
      ".product-card",
      "[data-product-id]",
      ".product--list-item",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        clean(wrap.find(".product-name, .name, h3, h2, .title").first().text()) || null;
      if (!title) return;

      let href =
        clean(wrap.find("a").attr("href")) ||
        clean(wrap.find(".product-link").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.mediamarkt.com.tr" + href;

      const priceTxt =
        clean(wrap.find(".price, .price-wrapper, .product-price").first().text()) || null;

      const parsed = parsePriceS200(priceTxt);
      const price = sanitizePrice(parsed);
      const optimizedPrice = optimizePrice({ price }, { provider: "mediamarkt" });

      const imageRaw =
        clean(wrap.find("img").attr("data-src")) ||
        clean(wrap.find("img").attr("data-original")) ||
        clean(wrap.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imageRaw);

      const categoryAI = detectCategoryAI();
      const geoSignal = extractGeoSignal(title);
      const qualityScore = computeQualityScore({ title, image: imageRaw, price });

      raw.push({
        id: stableIdS200("mediamarkt", href, title),
        title,
        price,
        priceText: priceTxt,
        optimizedPrice,

        provider: "electronics",
        providerFamily: "electronics",
        providerKey: "mediamarkt",
        providerType: "retailer",

        category: "product",
        categoryAI,
        geoSignal,
        qualityScore,

        currency: "TRY",
        region: region.toUpperCase(),

        url: href,
        deeplink: href,
        originUrl: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,
        raw: { title, priceTxt, href, imageRaw },
      });
    });

    return {
      ok: true,
      items: raw.slice(0, 60),
      _meta: { code: raw.length ? "OK" : "OK_EMPTY", url, region, timeoutMs },
    };
  } catch (err) {
    return {
      ok: false,
      items: [],
      _meta: { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), url, region, timeoutMs },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ----------------------------------------------------------------------------
// 3) ADAPTER — API → SCRAPE fallback (ZERO DELETE)
// ----------------------------------------------------------------------------
export async function searchMediaMarktAdapter(query, regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  try {
    // API (currently empty) — treat as optional
    const apiRes = await searchMediaMarktAPI(q, { region, signal });
    if (Array.isArray(apiRes) && apiRes.length) {
      const normalized = [];
      for (const it of coerceItemsS200(apiRes)) {
        const n = normalizeItemS200(it, "mediamarkt", {
          providerFamily: "electronics",
          vertical: "electronics",
          category: "product",
          region,
          currency: "TRY",
          baseUrl: "https://www.mediamarkt.com.tr",
          requireRealUrlCandidate: true,
        });
        if (n) normalized.push(n);
      }
      return _mkRes(true, normalized, { code: "OK_API", region, timeoutMs });
    }

    const scraped = await searchMediaMarktScrape(q, { region, signal, timeoutMs }, signal);

    if (!scraped.ok) {
      // NO FAKE RESULTS in PROD
      if (FINDALLEASY_ALLOW_STUBS) {
        const stub = normalizeItemS200({
          title: `MediaMarkt erişilemedi (${q})`,
          url: `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(q)}`,
          price: null,
          provider: "electronics",
          providerFamily: "electronics",
          providerKey: "mediamarkt",
          region,
          fallback: true,
        }, "mediamarkt", {
          providerFamily: "electronics",
          vertical: "electronics",
          category: "product",
          region,
          currency: "TRY",
          baseUrl: "https://www.mediamarkt.com.tr",
        });
        return _mkRes(true, [stub].filter(Boolean), {
          ...scraped._meta,
          code: "ERROR_STUB",
          region,
          timeoutMs,
        });
      }
      return _mkRes(false, [], { ...scraped._meta, region, timeoutMs });
    }

    const normalized = [];
    for (const it of coerceItemsS200(scraped.items)) {
      const n = normalizeItemS200(it, "mediamarkt", {
        providerFamily: "electronics",
        vertical: "electronics",
        category: "product",
        region,
        currency: "TRY",
        baseUrl: "https://www.mediamarkt.com.tr",
        requireRealUrlCandidate: true,
      });
      if (n) normalized.push(n);
    }

    // dedupe
    const seen = new Set();
    const items = [];
    for (const it of normalized) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
    }

    return _mkRes(true, items, {
      ...scraped._meta,
      code: items.length ? "OK" : "OK_EMPTY",
      region,
      timeoutMs,
    });
  } catch (err) {
    // NO FAKE RESULTS in PROD
    if (FINDALLEASY_ALLOW_STUBS) {
      const url = `https://www.mediamarkt.com.tr/tr/search.html?query=${encodeURIComponent(q)}`;
      const stub = normalizeItemS200({
        title: `MediaMarkt erişilemedi (${q})`,
        url,
        price: null,
        provider: "electronics",
        providerFamily: "electronics",
        providerKey: "mediamarkt",
        region,
        fallback: true,
      }, "mediamarkt", {
        providerFamily: "electronics",
        vertical: "electronics",
        category: "product",
        region,
        currency: "TRY",
        baseUrl: "https://www.mediamarkt.com.tr",
      });
      return _mkRes(true, [stub].filter(Boolean), {
        code: _isTimeout(err) ? "TIMEOUT_STUB" : "ERROR_STUB",
        error: _errStr(err),
        region,
        timeoutMs,
        url,
      });
    }

    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
    });
  }
}

export default {
  searchMediaMarktAPI,
  searchMediaMarktScrape,
  searchMediaMarktAdapter,
};
