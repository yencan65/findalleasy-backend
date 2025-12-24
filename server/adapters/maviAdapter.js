// server/adapters/maviAdapter.js
// ============================================================================
// MAVI — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO FAKE RESULTS in PROD: fallback/stub only if FINDALLEASY_ALLOW_STUBS=1
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - withTimeout everywhere + global ctx set
// ZERO DELETE: mevcut işlevler korunur, sadece S200 standardına yükseltilir
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
  return stableIdS200("mavi", String(seed || ""), String(seed || "mavi"));
}

function detectCategoryAI() {
  return "fashion";
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
  return { ok: !!ok, items: arr, count: arr.length, source: "mavi", _meta: { ...meta } };
}

const MAX_PAGES = 3;

function parseRegionOptions(regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let sig = signal;
  let timeoutMs = Number(process.env.MAVI_TIMEOUT_MS || 14000);

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

// ============================================================================
// PAGE SCRAPER — returns { ok, items, _meta }
// ============================================================================
async function scrapeMaviPage(query, page = 1, signal = null, timeoutMs = 14000) {
  const q = encodeURIComponent(query);
  const url = `https://www.mavi.com/search?q=${q}&page=${page}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "mavi_adapter", providerKey: "mavi", url };

  try {
    let html = null;

    // PROXY FETCH
    try {
      html = await withTimeout(proxyFetchHTML(url), timeoutMs, "mavi.proxyFetch");
    } catch {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            Accept: "text/html,application/xhtml+xml",
          },
        }),
        timeoutMs,
        "mavi.axiosFetch"
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) return { ok: false, items: [], _meta: { code: "FETCH_FAIL", url, page } };

    const $ = loadCheerioS200(html, { adapter: "mavi_adapter", providerKey: "mavi", url });
    const results = [];

    const selectors = [
      ".product-item",
      ".col-6",
      ".col-md-4",
      ".plp-product-card",
      ".product-list-item",
      ".product",
      ".product-card",
      "[data-product-id]",
      ".grid-item",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        clean(wrap.find(".product-name, .product-title, .name, h3, h2").first().text()) || null;
      if (!title) return;

      let href =
        clean(wrap.find("a").attr("href")) ||
        clean(wrap.find(".product-link").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.mavi.com" + href;

      const priceRaw =
        clean(
          wrap.find(".product-price, .new-price, .current-price, .price").first().text()
        ) || null;

      const parsed = parsePriceS200(priceRaw);
      const price = sanitizePrice(parsed);
      const optimizedPrice = optimizePrice({ price }, { provider: "mavi" });

      const imgRaw =
        clean(wrap.find("img").attr("data-src")) ||
        clean(wrap.find("img").attr("src")) ||
        clean(wrap.find("picture img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);

      const categoryAI = detectCategoryAI();
      const geoSignal = extractGeoSignal(title);
      const qualityScore = computeQualityScore({ title, image: imgRaw, price });

      results.push({
        id: stableIdS200("mavi", href, title),
        title,
        price,
        optimizedPrice,

        provider: "fashion",
        providerFamily: "fashion",
        providerKey: "mavi",
        providerType: "retailer",

        category: "product",
        categoryAI,
        geoSignal,
        qualityScore,

        currency: "TRY",
        region: "TR",

        url: href,
        deeplink: href,
        originUrl: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,
        raw: { title, priceRaw, href, imgRaw, page },
      });
    });

    return { ok: true, items: results, _meta: { code: results.length ? "OK" : "OK_EMPTY", url, page } };
  } catch (err) {
    return {
      ok: false,
      items: [],
      _meta: { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), url, page },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// LEGACY MAIN SEARCH (returns array) — ZERO DELETE
// ============================================================================
export async function searchMavi(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions, signal);
  const q = safe(query);
  if (!q) return [];

  const res = await searchMaviAdapter(q, { region, signal: sig, timeoutMs });
  if (Array.isArray(res?.items) && res.items.length) return res.items;

  // NO FAKE RESULTS in PROD
  if (FINDALLEASY_ALLOW_STUBS) {
    return [
      {
        provider: "fashion",
        providerKey: "mavi",
        title: `Mavi sonuç bulunamadı (${query})`,
        price: null,
        optimizedPrice: null,
        category: "fashion",
        region,
        fallback: true,
      },
    ];
  }

  return [];
}

export const searchMaviScrape = searchMavi;

// ============================================================================
// S200 WRAPPER — unified output (strict)
// ============================================================================
export async function searchMaviAdapter(query, regionOrOptions = "TR") {
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });

  let all = [];
  const errors = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const part = await scrapeMaviPage(q, page, signal, timeoutMs);

    if (!part.ok) {
      if (page === 1) {
        return _mkRes(false, [], { ...part._meta, region, timeoutMs });
      }
      errors.push(part._meta);
      break;
    }

    if (!part.items.length) break;
    all = all.concat(part.items);

    if (all.length >= 120) break;
  }

  const normalized = [];
  for (const it of coerceItemsS200(all)) {
    const n = normalizeItemS200(it, "mavi", {
      providerFamily: "fashion",
      vertical: "fashion",
      category: "product",
      region,
      currency: "TRY",
      baseUrl: "https://www.mavi.com",
      requireRealUrlCandidate: true,
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
    region,
    timeoutMs,
    partial: errors.length ? true : undefined,
    errors: errors.length ? errors : undefined,
  });
}

export default { searchMavi, searchMaviScrape, searchMaviAdapter };
