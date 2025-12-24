// server/adapters/metroAdapter.js
// ============================================================================
// METRO MARKET — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S22 tabanı korunur; sadece S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// withTimeout everywhere + global ctx set
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
} from "../core/s200AdapterKit.js";

// ----------------------------------------------------------------------
// HELPERS (kept)
// ----------------------------------------------------------------------
const clean = (v) => safeStr(v, 1800).trim();

function parsePrice(v) {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// ZERO DELETE: stableId adı korunur; random temizlendi
function stableId(url, i, title = "") {
  return stableIdS200("metro", String(url || ""), String(title || `metro_${i ?? 0}`));
}

function detectProductCategory(title = "") {
  const t = String(title || "").toLowerCase();
  if (/et|tavuk|dana|balık|kıyma/.test(t)) return "meat";
  if (/süt|yoğurt|peynir/.test(t)) return "dairy";
  if (/sebze|meyve|domates|salatalık/.test(t)) return "fresh_food";
  if (/ekmek|un|makarna|pirinç/.test(t)) return "bakery_grain";
  if (/içecek|kola|su|meyve suyu/.test(t)) return "beverage";
  return "product";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.45;
  if ((item.title || "").length > 6) s += 0.25;
  if (item.image) s += 0.25;
  return Number(s.toFixed(2));
}

function extractGeo(title = "") {
  const t = String(title || "").toLowerCase();
  const cities = ["istanbul", "ankara", "izmir", "bursa", "antalya"];
  return cities.find((c) => t.includes(c)) || null;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: "metro",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.METRO_TIMEOUT_MS || 12000);

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

async function fetchHTML(url, signal, timeoutMs) {
  try {
    return await withTimeout(proxyFetchHTML(url), timeoutMs, "metro.proxyFetch");
  } catch {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
      }),
      timeoutMs,
      "metro.axiosFetch"
    );
    return data;
  }
}

async function runMetroS200(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  const qClean = clean(query);
  if (!qClean) return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs, ms: Date.now() - t0 });

  const q = encodeURIComponent(qClean);
  const url = `https://www.metro-tr.com/arama?q=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "metro_adapter", providerKey: "metro", url };

  try {
    const html = String(await fetchHTML(url, signal, timeoutMs) || "");
    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", url, region, timeoutMs, ms: Date.now() - t0 });

    const $ = loadCheerioS200(html, { adapter: "metro_adapter", providerKey: "metro", url });
    const candidates = [];

    $(".product, .product-item, .product-card, .product-wrapper").each((i, el) => {
      const wrap = $(el);

      const title = clean(wrap.find(".product-title, .product-name, .title").first().text()) || "";
      if (!title) return;

      const priceTxt = clean(
        wrap
          .find(".product-price, .price, .current-price, .discounted-price")
          .first()
          .text()
      );

      const priceRaw = parsePrice(priceTxt);
      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: "metro" });

      let href = clean(wrap.find("a").attr("href") || wrap.find("a.product-link").attr("href") || "");
      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.metro-tr.com" + href;

      const imgRaw =
        clean(wrap.find("img").attr("src")) ||
        clean(wrap.find("img").attr("data-src")) ||
        null;

      const imageVariants = buildImageVariants(imgRaw);

      const categoryAI = detectProductCategory(title);
      const geoSignal = extractGeo(title);
      const id = stableId(href, i, title);
      const qualityScore = computeQualityScore({ title, price, image: imgRaw });

      candidates.push({
        id,
        title,
        price,
        optimizedPrice,
        rating: null,

        provider: "market",
        providerFamily: "market",
        providerKey: "metro",
        providerType: "provider",

        currency: "TRY",
        region,
        vertical: "market",
        category: "product",
        categoryAI,
        qualityScore,
        geoSignal,

        url: href,
        originUrl: href,
        deeplink: href,

        image: imageVariants.image,
        imageOriginal: imageVariants.imageOriginal,
        imageProxy: imageVariants.imageProxy,
        hasProxy: imageVariants.hasProxy,

        raw: { title, priceTxt, href, imgRaw },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, "metro", {
        providerFamily: "market",
        vertical: "market",
        region,
        currency: "TRY",
        baseUrl: "https://www.metro-tr.com",
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
      url,
      region,
      timeoutMs,
      ms: Date.now() - t0,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      region,
      timeoutMs,
      ms: Date.now() - t0,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// PUBLIC EXPORTS (ZERO DELETE)
// ============================================================================
export async function searchMetroAdapter(query, regionOrOptions = "TR") {
  return runMetroS200(query, regionOrOptions);
}

// legacy aliases: array-only
export async function searchMetro(query, regionOrOptions = "TR") {
  const r = await runMetroS200(query, regionOrOptions);
  return r.items || [];
}

export default {
  searchMetroAdapter,
  searchMetro,
};
