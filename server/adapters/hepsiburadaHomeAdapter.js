// server/adapters/hepsiburadaHomeAdapter.js
// ============================================================================
//  Hepsiburada Home — S33 TITAN → S200 FINAL
//  ZERO DELETE — eski tüm davranış korunur, sadece normalizeS200 blenderı eklenir.
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


// ============================================================================
// ⭐️ S200 NORMALIZER — tüm adapter sonuçlarını tek forma sokan blender
// ============================================================================
function normalizeS200(item) {
  if (!item) return null;

  const link = item.deeplink || item.url || null;

  return {
    id: item.id,

    provider: "hb_home",
    source: "hepsiburada_home",

    title: item.title || "",
    price: item.price ?? null,
    priceText: item.priceText ?? null,

    finalPrice: item.optimizedPrice ?? item.price ?? null,
    optimizedPrice: item.optimizedPrice ?? item.price ?? null,

    rating: item.rating ?? null,
    reviewCount: item.reviewCount ?? null,

    url: link,
    deeplink: link,
    affiliateUrl: link,

    image: item.image || null,
    imageOriginal: item.imageOriginal || null,
    imageProxy: item.imageProxy || null,
    hasProxy: item.hasProxy ?? false,

    currency: item.currency || "TRY",
    region: String(item.region || "TR").toUpperCase(),

    category: "home",
    categoryAI: "home",

    stockStatus: "in_stock",
    availability: "in_stock",

    providerType: "retailer",
    providerFamily: "hepsiburada",
    vertical: "home",

    qualityScore: item.qualityScore ?? 0,

    raw: item.raw || { legacy: item },
  };
}

// ============================================================================
// HELPERS — S33 LEVEL
// ============================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function parsePriceStrong(text) {
  if (!text) return null;
  try {
    let cleaned = text
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function stableId(provider, title, url) {
  const seed = `${provider}::${title}::${url}`;
  return (
    "hbhome_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.40;
  if (item.price != null) s += 0.40;
  if (item.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const BASE = "https://www.hepsiburada.com";

// ============================================================================
// MAIN — S33 SCRAPER, output S200 normalize
// ============================================================================
export async function searchHBHomeAdapterLegacy(
  query,
  regionOrOptions = "TR",
  signal = null
) {
  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
    signal = regionOrOptions.signal || signal;
  }

  const q = encodeURIComponent(query);
  const url = `${BASE}/ara?q=${q}&filtreler=ev-yasam`;

  try {
    await wait(120);

    const headers = {
      "User-Agent": options.userAgent || "Mozilla/5.0 (FindAllEasyBot S33)",
      "Accept-Language": "tr-TR,tr;q=0.9",
    };

    const axiosOptions = { headers, timeout: 15000 };
    if (signal) axiosOptions.signal = signal;

    const { data: html } = await axios.get(url, axiosOptions);
    const $ = loadCheerioS200(html);

    const results = [];

    const selectors = [
      ".search-item",
      ".productBox",
      ".box",
      ".search-item-wrapper",
      ".product-list-item",
      "[data-testid='product-card']",
      ".product-card",
    ];

    $(selectors.join(", ")).each((i, el) => {
      const root = $(el);

      const title =
        clean(
          root
            .find(
              "h3.title, h3.product-title, a.title, a.product-title, .product-title"
            )
            .first()
            .text()
        ) || null;

      const priceTxt =
        clean(
          root
            .find(
              ".price, .price-value, .product-price, span.price, .price-new, [data-testid='price-current']"
            )
            .first()
            .text()
        ) || null;

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href =
        root.find("a").attr("href") ||
        root.find("a.product-link").attr("href") ||
        null;

      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      const imgRaw =
        root.find("img").attr("data-src") ||
        root.find("img").attr("src") ||
        null;

      const image = buildImageVariants(imgRaw);

      if (!title) return;

      const id = stableId("hb_home", title, href);

      const base = {
        id,
        title,
        price,
        optimizedPrice:
          price != null ? optimizePrice({ price }, { provider: "hepsiburada" }) : null,

        provider: "hb_home",
        providerType: "retailer",
        providerFamily: "hepsiburada",
        vertical: "home",

        region,
        currency: "TRY",

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "home",
        categoryAI: "home",

        raw: { priceTxt, href, imgRaw },
      };

      results.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    // Fallback
    if (results.length === 0) {
      return [
        normalizeS200({
          provider: "hb_home",
          title: `Hepsiburada Ev: sonuç yok (${query})`,
          price: null,
          url,
          region,
          currency: "TRY",
          image: null,
          hasProxy: false,
          fallback: true,
        }),
      ];
    }

    // ⭐️ S200 CAST — BÜTÜN SONUÇLAR normalize edilir
    return results.slice(0, 20).map((x) => normalizeS200(x));
  } catch (err) {
    if (signal?.aborted) {
      return [
        normalizeS200({
          provider: "hb_home",
          title: "HB Home arama iptal edildi",
          price: null,
          url: null,
          region,
          aborted: true,
          fallback: true,
        }),
      ];
    }

    return [
      normalizeS200({
        provider: "hb_home",
        title: `HB Home erişilemedi (${query})`,
        price: null,
        url,
        region,
        fallback: true,
      }),
    ];
  }
}


export async function searchHBHomeAdapter(query, regionOrOptions = "TR", signal = null) {
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
  globalThis.__S200_ADAPTER_CTX = { adapter: "searchHBHomeAdapter", providerKey: "hepsiburada", url: "" };

  try {
    const raw = await withTimeout(searchHBHomeAdapterLegacy(query, regionOrOptions, signal), timeoutMs, "hepsiburada.legacy");
    // If legacy returned fallback placeholders, block in PROD
    const hasFallback = Array.isArray(raw) && raw.some((x) => x && typeof x === "object" && (x.fallback === true || x.isFallback === true));
    if (hasFallback && !FINDALLEASY_ALLOW_STUBS) {
      return _mkRes("hb_home", false, [], { code: "STUB_BLOCKED", region, timeoutMs });
    }
    const items = _normalizeMany(raw, "hepsiburada", { providerFamily: "hepsiburada", vertical: "home", category: "product", currency: "TRY", region, baseUrl: "https://www.hepsiburada.com" });
    return _mkRes("hb_home", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("hb_home", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export async function searchHBHomeAdapterArray(query, regionOrOptions = "TR", signal = null) {
  // legacy raw array (ZERO DELETE)
  return await searchHBHomeAdapterLegacy(query, regionOrOptions, signal);
}

export default { searchHBHomeAdapter };
