// ============================================================================
//  ODAMAX — S22 ULTRA TITAN ADAPTER
//  ZERO DELETE — S7 Ultra tabanı duruyor, üstüne S22 zekâ katmanı eklendi
//  • proxyFetchHTML fallback
//  • stableId
//  • ImageVariants S22
//  • sanitizePrice + optimizePrice
//  • categoryAI(hotel)
//  • qualityScore
//  • geoSignal extraction
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
} from "../core/s200AdapterKit.js";

// ----------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------
const clean = (v) => String(v || "").trim();

function parsePrice(v) {
  if (!v) return null;
  const n = Number(
    String(v).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function resolveRegion(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  return { region: region.toUpperCase(), signal };
}

// ----------------------------------------------------------------------
// IMAGE EXTRACTOR (S7) — korunur
// ----------------------------------------------------------------------
function extractImageRaw($, el) {
  return (
    clean($(el).find("img").attr("data-src")) ||
    clean($(el).find("img").attr("data-original")) ||
    clean($(el).find("img").attr("src")) ||
    clean($(el).find("picture img").attr("src")) ||
    null
  );
}

// ----------------------------------------------------------------------
// S22: stableId
// ----------------------------------------------------------------------
const PROVIDER_KEY = "odamax";

function stableId(url, title = "") {
  return stableIdS200(PROVIDER_KEY, url, title);
}
// ----------------------------------------------------------------------
// S22: Category AI (Hotel)
// ----------------------------------------------------------------------
function detectHotelCategory(title) {
  const t = title.toLowerCase();
  if (/resort|spa|deluxe/.test(t)) return "luxury_hotel";
  if (/boutique|butik/.test(t)) return "boutique_hotel";
  if (/apart|residence/.test(t)) return "apart_hotel";
  return "hotel";
}

// ----------------------------------------------------------------------
// S22: qualityScore
// ----------------------------------------------------------------------
function computeQualityScore(item) {
  let s = 0;
  if (item.price) s += 0.4;
  if (item.title.length > 8) s += 0.2;
  if (item.image) s += 0.3;
  return Number(s.toFixed(2));
}

// ----------------------------------------------------------------------
// MULTI-SELECTOR — S7’den kalan set (dokunulmaz)
// ----------------------------------------------------------------------
const HOTEL_SELECTORS = [
  ".hotel-card",
  ".card-hotel",
  ".hotel-item",
  ".search-hotel-card",
  ".col-12.hotel",
  "[data-hotel-id]",
];

// ============================================================================
// MAIN — S22 Ultra Titan Adapted Version
// ============================================================================
export async function searchOdamax(query, regionOrOptions = "TR", signal) {
  const qClean = clean(query);
  if (!qClean) return [];

  const { region, signal: finalSignal } = resolveRegion(regionOrOptions);
  const q = encodeURIComponent(qClean);

  const url = `https://www.odamax.com/search?text=${q}`;

  let html = null;

  // ----------------------------------------------------------------------
  // S22: proxy first
  // ----------------------------------------------------------------------
  try {
    html = await proxyFetchHTML(url);
  } catch {
    try {
      const { data } = await axios.get(url, {
        timeout: 18000,
        signal: finalSignal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S22)",
          Accept: "text/html",
        },
      });
      html = data;
    } catch (err) {
      console.warn("Odamax FETCH ERROR:", err.message);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  $(HOTEL_SELECTORS.join(",")).each((i, el) => {
    const title =
      clean($(el).find(".hotel-name").text()) ||
      clean($(el).find(".title").text()) ||
      clean($(el).find("h3").text());

    if (!title) return;

    const priceTxt =
      clean($(el).find(".price").text()) ||
      clean($(el).find(".hotel-price").text()) ||
      clean($(el).find(".amount").text());

    const priceRaw = parsePrice(priceTxt);
    const price = sanitizePrice(priceRaw);
    const optimized = optimizePrice({ price }, { provider: "odamax" });

    let href =
      clean($(el).find("a").attr("href")) ||
      clean($(el).find(".hotel-link").attr("href"));

    if (!href) return;
    if (!href.startsWith("http")) href = "https://www.odamax.com" + href;

    const imageRaw = extractImageRaw($, el);
    const imageVariants = buildImageVariants(imageRaw);

    // S22 ID
    const id = stableId(href, title);

    // city signal
    const locText =
      clean($(el).find(".location").text()) ||
      clean($(el).find(".hotel-location").text());

    const categoryAI = detectHotelCategory(title);
    const qualityScore = computeQualityScore({ title, price, image: imageRaw });

    const rawItem = {
      id,
      title,
      price,
      optimizedPrice: optimized,
      rating: null,

      provider: "odamax",
      source: "odamax",
      currency: "TRY",
      region,
      category: "hotel",
      categoryAI,
      qualityScore,

      url: href,
      originUrl: href,
      finalUrl: href,
      deeplink: href,

      geoSignal,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      raw: {
        title,
        priceTxt,
        href,
        imgRaw,
        geoSignal,
      },
    };

    const norm = normalizeItemS200(rawItem, PROVIDER_KEY, { vertical: "travel", category: "hotel" });
    if (norm) items.push(norm);
  });

  return items;
}

export const searchOdamaxScrape = searchOdamax;
export const searchOdamaxAdapter = searchOdamax;

export default { searchOdamax };
