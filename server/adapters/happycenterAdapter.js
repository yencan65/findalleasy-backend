// server/adapters/happycenterAdapter.js
// ============================================================================
// HAPPYCENTER – S33 TITAN FINAL ADAPTER
// ZERO DELETE — tüm fonksiyon imzaları ve export'lar korunur
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// S200 HARDENING HELPERS (KIT-LOCKED)
// ============================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _errStr(e) {
  return safeStr(e?.message || e || "error", 500);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(source, ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source, _meta: { ...meta } };
}
function _normalizeMany(rawItems, providerKey, normOpts = {}) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const x = it && typeof it === "object" ? { ...it } : it;
    if (x && typeof x === "object") {
      // NO RANDOM/DRIFT ID: force kit stableId
      delete x.id;
      delete x.listingId;
    }
    const n = normalizeItemS200(x, providerKey, normOpts);
    if (n) out.push(n);
  }
  // dedupe by id
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


// ------------------------------------------------------------
// SAFE HELPERS
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

// Strong price parser
function parsePriceStrong(t) {
  if (!t) return null;
  let cleaned = String(t)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Stable ID → Titan merge motoru için zorunlu
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "hc_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

// Quality score → BEST sıralaması için
function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.45;
  if (base.price != null) s += 0.35;
  if (base.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// URL FIXER
// ------------------------------------------------------------
function fullUrl(h) {
  if (!h) return null;
  if (h.startsWith("http")) return h.split("?")[0];
  return "https://www.happycenter.com.tr" + h.split("?")[0];
}

// ============================================================================
// S33 SCRAPER
// ============================================================================
export async function searchHappyCenterScrape(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.happycenter.com.tr/arama?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/125",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    const selectors = [
      ".product-item",
      ".product",
      ".product-list-item",
      ".product-card",
      ".col-6",
      ".col-4",
      ".col-3",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".product-name").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find("h3").text()) ||
        safe(wrap.find("h2").text());

      if (!title) return;

      // Fiyat
      const ptxt =
        safe(wrap.find(".price").text()) ||
        safe(wrap.find(".new-price").text()) ||
        safe(wrap.find(".product-price").text()) ||
        safe(wrap.find(".value").text());

      const strong = parsePriceStrong(ptxt);
      const price = sanitizePrice(strong);

      // URL
      let href =
        safe(wrap.find("a").attr("href")) ||
        safe(wrap.attr("data-url"));
      if (!href) return;

      const urlFinal = fullUrl(href);

      // Görsel
      const imgRaw =
        safe(wrap.find("img").attr("data-src")) ||
        safe(wrap.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw, "happycenter");

      // ID
      const id = stableId("happycenter", title, urlFinal);

      const base = {
        id,
        title,
        price,
        priceText: ptxt,
        url: urlFinal,
        deepLink: urlFinal,
        rating: null,

        provider: "happycenter",
        providerType: "market",
        providerFamily: "happycenter",
        vertical: "market",
        category: "market",
        categoryAI: "market_product",

        currency: "TRY",
        region,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        raw: { ptxt, href, imgRaw },
      };

      items.push({
        ...base,
        finalPrice: base.price,
        optimizedPrice:
          base.price != null
            ? optimizePrice({ price: base.price }, { provider: "happycenter" })
            : null,
        qualityScore: computeQualityScore(base),
        stock: "var",
      });
    });

    return items.slice(0, 50); // Titan optimum
  } catch (err) {
    console.warn("⚠️ HappyCenter S33 hata:", err.message);
    return [];
  }
}

// ============================================================================
// UNIFIED ADAPTER
// ============================================================================
export async function searchHappyCenterAdapter(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "happycenterAdapter", providerKey: "happycenter", url: "" };

  try {
    const raw = await withTimeout(searchHappyCenterScrape(query, regionOrOptions), timeoutMs, "happycenter.scrape");
    const items = _normalizeMany(raw, "happycenter", { providerFamily: "happycenter", vertical: "health", category: "health", currency: "TRY", region });
    return _mkRes("happycenter", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("happycenter", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}


// ============================================================================
// S8 ALIAS — DEĞİŞTİRİLMEDİ
// ============================================================================
export const searchHappyCenter = async (q, opts = {}) => {
  return await searchHappyCenterAdapter(q, opts);
};

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  searchHappyCenterScrape,
  searchHappyCenterAdapter,
  searchHappyCenter,
};


// S200: legacy raw array access (ZERO DELETE)
export async function searchHappyCenterLegacy(query, regionOrOptions = "TR") {
  return await searchHappyCenterScrape(query, regionOrOptions);
}
