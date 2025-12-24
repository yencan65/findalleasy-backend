// server/adapters/migrosAdapter.js
// ============================================================================
// MIGROS + MACROCENTER — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// ZERO DELETE: S5/S22 tabanı korunur, sadece S200 contract + observability eklenir
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set (kit loglarında "unknown" azalır)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

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

// ============================================================================
// HELPERS
// ============================================================================
const clean = (v) => safeStr(v, 1800).trim();

function parsePrice(v) {
  if (!v) return null;
  const n = Number(
    String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function detectProductCategory(title = "") {
  const t = String(title || "").toLowerCase();
  if (/süt|yoğurt|peynir|şarküteri/.test(t)) return "dairy";
  if (/et|kıyma|biftek/.test(t)) return "meat";
  if (/meyve|sebze|manav/.test(t)) return "produce";
  if (/atıştırmalık|cips|çikolata/.test(t)) return "snack";
  if (/temizlik|deterjan|sabun/.test(t)) return "cleaning";
  return "product";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.35;
  if (item.title?.length > 6) s += 0.25;
  if (item.image) s += 0.25;
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
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: "migros",
    _meta: { ...meta },
  };
}

function parseRegionOptions(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = Number(process.env.MIGROS_TIMEOUT_MS || 12000);

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

// ============================================================================
// SELECTORS — S5’den kalan set, asla silinmez
// ============================================================================
const SELECTORS = [
  ".product",
  ".product-card",
  ".product-box",
  ".product-list-item",
  ".product-wrapper",
  ".product-item",
  "[data-product-id]",
  "[data-product]",
];

// ============================================================================
// COMMON SCRAPER — S200
// ============================================================================
async function scrapeCommonS200({ query, baseUrl, searchUrl, providerKey, signal, region, timeoutMs }) {
  const t0 = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "migros_adapter", providerKey, url: searchUrl };

  try {
    let html = null;

    // proxy-first
    try {
      html = await withTimeout(proxyFetchHTML(searchUrl), timeoutMs, `${providerKey}.proxyFetch`);
    } catch (e) {
      const res = await withTimeout(
        axios.get(searchUrl, {
          signal,
          timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            Accept: "text/html",
          },
        }),
        timeoutMs,
        `${providerKey}.axiosFetch`
      );
      html = res?.data;
    }

    html = String(html || "");
    if (!html) {
      return { ok: false, items: [], _meta: { code: "FETCH_FAIL", url: searchUrl, ms: Date.now() - t0 } };
    }

    const $ = loadCheerioS200(html, { adapter: "migros_adapter", providerKey, url: searchUrl });
    const candidates = [];

    $(SELECTORS.join(",")).each((i, el) => {
      const title =
        clean($(el).find(".product-name").text()) ||
        clean($(el).find(".pdp-card-title").text()) ||
        clean($(el).find(".name").text()) ||
        clean($(el).find("h3").text());

      if (!title) return;

      const priceTxt =
        clean($(el).find(".sale-price").text()) ||
        clean($(el).find(".product-price").text()) ||
        clean($(el).find(".price").text());

      const priceRaw = parsePrice(priceTxt);
      const price = sanitizePrice(priceRaw);
      const optimizedPrice = optimizePrice({ price }, { provider: providerKey });

      const href = clean($(el).find("a").attr("href"));
      if (!href) return;
      const url = href?.startsWith("http") ? href : baseUrl + href;

      const imgRaw =
        clean($(el).find("img").attr("data-src")) ||
        clean($(el).find("img").attr("data-original")) ||
        clean($(el).find("img").attr("data-image")) ||
        clean($(el).find("picture img").attr("src")) ||
        clean($(el).find("img").attr("src")) ||
        null;

      const imageVariants = buildImageVariants(imgRaw);

      const categoryAI = detectProductCategory(title);
      const qScore = computeQualityScore({ title, price, image: imgRaw });

      candidates.push({
        id: stableIdS200(providerKey, url, title),
        title,
        price,
        optimizedPrice,

        provider: "market",
        providerFamily: "market",
        providerKey,
        providerType: "provider",

        currency: "TRY",
        region: region.toUpperCase(),
        vertical: "market",
        category: "product",
        categoryAI,
        qualityScore: qScore,

        url,
        originUrl: url,
        deeplink: url,

        image: imageVariants.image,
        imageOriginal: imageVariants.imageOriginal,
        imageProxy: imageVariants.imageProxy,
        hasProxy: imageVariants.hasProxy,

        raw: { title, priceTxt, href, imgRaw, providerKey, query },
      });
    });

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, providerKey, {
        providerFamily: "market",
        vertical: "market",
        category: "product",
        region,
        currency: "TRY",
        baseUrl,
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

    return {
      ok: true,
      items,
      _meta: { code: items.length ? "OK" : "OK_EMPTY", url: searchUrl, ms: Date.now() - t0, timeoutMs },
    };
  } catch (err) {
    return {
      ok: false,
      items: [],
      _meta: {
        code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
        error: _errStr(err),
        url: searchUrl,
        ms: Date.now() - t0,
        timeoutMs,
      },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ============================================================================
// PUBLIC SCRAPERS (Migros / Macro) — names preserved (ZERO DELETE)
// ============================================================================
export async function scrapeMigros(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);
  if (!q) return [];

  const qEnc = encodeURIComponent(q);
  const baseUrl = "https://www.migros.com.tr";
  const searchUrl = `https://www.migros.com.tr/arama?q=${qEnc}`;

  const res = await scrapeCommonS200({
    query: q,
    baseUrl,
    searchUrl,
    providerKey: "migros",
    signal: sig || signal,
    region,
    timeoutMs,
  });

  return res.items; // legacy array behavior preserved for direct calls
}

export async function scrapeMacro(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);
  if (!q) return [];

  const qEnc = encodeURIComponent(q);
  const baseUrl = "https://www.macrocenter.com.tr";
  const searchUrl = `https://www.macrocenter.com.tr/arama?q=${qEnc}`;

  const res = await scrapeCommonS200({
    query: q,
    baseUrl,
    searchUrl,
    providerKey: "macrocenter",
    signal: sig || signal,
    region,
    timeoutMs,
  });

  return res.items; // legacy array behavior preserved
}

// ============================================================================
// UNIFIED ADAPTER — S200 output (strict)
// ============================================================================
export async function searchMigrosAdapter(query, regionOrOptions = "TR", signal) {
  const { region, signal: sig, timeoutMs } = parseRegionOptions(regionOrOptions);
  const q = clean(query);

  if (!q) {
    return _mkRes(true, [], { code: "OK_EMPTY", region, timeoutMs });
  }

  const qEnc = encodeURIComponent(q);

  const migrosUrl = `https://www.migros.com.tr/arama?q=${qEnc}`;
  const macroUrl = `https://www.macrocenter.com.tr/arama?q=${qEnc}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "migros_adapter", providerKey: "migros", url: migrosUrl };

  try {
    const [mig, mac] = await Promise.all([
      scrapeCommonS200({
        query: q,
        baseUrl: "https://www.migros.com.tr",
        searchUrl: migrosUrl,
        providerKey: "migros",
        signal: sig || signal,
        region,
        timeoutMs,
      }),
      scrapeCommonS200({
        query: q,
        baseUrl: "https://www.macrocenter.com.tr",
        searchUrl: macroUrl,
        providerKey: "macrocenter",
        signal: sig || signal,
        region,
        timeoutMs,
      }),
    ]);

    const all = [...(mig.items || []), ...(mac.items || [])];

    // de-dupe by id
    const seen = new Set();
    const items = [];
    for (const it of all) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
    }

    const errors = [];
    if (!mig.ok) errors.push({ providerKey: "migros", ...mig._meta });
    if (!mac.ok) errors.push({ providerKey: "macrocenter", ...mac._meta });

    const ok = items.length > 0 || (mig.ok && mac.ok);

    return _mkRes(ok, items, {
      code: ok ? (items.length ? "OK" : "OK_EMPTY") : "ERROR",
      region,
      providers: ["migros", "macrocenter"],
      partial: errors.length > 0 && ok,
      errors: errors.length ? errors : undefined,
      timeoutMs,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      region,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchMigros = searchMigrosAdapter;
export const searchMigrosScrape = searchMigrosAdapter;
export const searchMigrosUnified = searchMigrosAdapter;

export default {
  searchMigrosAdapter,
  scrapeMigros,
  scrapeMacro,
};
