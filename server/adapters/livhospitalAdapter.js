// ============================================================================
//  LIV HOSPITAL — S22 ULTRA TITAN ADAPTER (FINAL VERSION)
// ----------------------------------------------------------------------------
//  ZERO DELETE — eski scraper korunur, üzerine Titan-grade tüm modüller eklenir
// ----------------------------------------------------------------------------
//  • proxyFetchHTML anti-bot bypass
//  • stableId (Merge Engine + Vitrin)
//  • sanitizePrice + optimizePrice
//  • ImageVariants S22
//  • categoryAI (doctor / checkup / health)
//  • geoSignal extraction
//  • qualityScore
//  • fallback güvenli
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

function stableId(seed, i = 0) {
  return "liv_" + Buffer.from(seed + "_" + i).toString("base64").slice(0, 14);
}

function detectCategoryAI(title = "") {
  const t = title.toLowerCase();

  if (t.includes("doktor") || t.includes("dr") || t.includes("prof")) return "doctor";
  if (t.includes("check-up") || t.includes("checkup") || t.includes("check up")) return "checkup";
  if (t.includes("tedavi") || t.includes("treatment") || t.includes("paket")) return "health";

  return "health";
}

function extractGeoSignal(title = "", subtitle = "") {
  const text = (title + " " + subtitle).toLowerCase();
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa"];
  return cities.find((c) => text.includes(c)) || null;
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 3) s += 0.25;
  if (item.subtitle) s += 0.25;
  if (item.image) s += 0.3;
  s += 0.2; // provider reliability boost
  return Number(s.toFixed(2));
}

// Görsel fallback
function extractImage($, el) {
  return (
    $(el).find("img").attr("data-src") ||
    $(el).find("img").attr("src") ||
    $(el).find("picture img").attr("src") ||
    null
  );
}

function parsePriceRaw(txt) {
  if (!txt) return null;
  const raw = Number(txt.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(raw) ? raw : null;
}

// ============================================================================
//  S22 SCRAPER — proxy + multi-selector + Titan normalize
// ============================================================================
async function scrapeLiv(region, query, signal) {
  const q = encodeURIComponent(query);
  const url = `https://www.livhospital.com/arama?search=${q}`;

  let html = null;

  // Anti-bot: önce proxy dene
  try {
    html = await proxyFetchHTML(url);
  } catch {
    try {
      const { data } = await axios.get(url, {
        timeout: 16000,
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S22)" }
      });
      html = data;
    } catch {
      return [
        {
          provider: "livhospital",
          title: "Liv Hospital erişilemedi",
          price: null,
          region,
          category: "health",
          fallback: true,
        },
      ];
    }
  }

  const $ = loadCheerioS200(html);
  const results = [];

  // ------------------------
  // 1) Doctors
  // ------------------------
  const doctorSelectors = [
    ".doctor-card",
    ".doctor",
    ".list-item",
    ".doctorProfile",
    ".doctor-card-container",
    ".doctorBox",
    "[data-doctor-id]",
  ];

  $(doctorSelectors.join(", ")).each((i, el) => {
    const name =
      safe($(el).find(".doctor-name").text()) ||
      safe($(el).find("h3").text()) ||
      safe($(el).find(".name").text());
    if (!name) return;

    const branch =
      safe($(el).find(".doctor-branch").text()) ||
      safe($(el).find(".department").text());

    let href = safe($(el).find("a").attr("href"));
    if (href && !href.startsWith("http"))
      href = `https://www.livhospital.com${href}`;

    const imgRaw = extractImage($, el);
    const image = buildImageVariants(imgRaw);

    const id = stableId(href || name, i);
    const categoryAI = "doctor";
    const geoSignal = extractGeoSignal(name, branch);
    const qualityScore = computeQualityScore({ title: name, subtitle: branch, image: imgRaw });

    const price = sanitizePrice(null);
    const optimizedPrice = optimizePrice({ price }, { provider: "livhospital" });

    results.push({
      id,
      provider: "livhospital",
      source: "livhospital",

      title: name,
      subtitle: branch,
      price,
      optimizedPrice,
      rating: null,

      category: "doctor",
      categoryAI,
      geoSignal,
      qualityScore,

      currency: "TRY",
      region: region.toUpperCase(),

      url: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      fallback: false,

      raw: { name, branch, href, imgRaw },
    });
  });

  // ------------------------
  // 2) Packages / Treatments / Checkup
  // ------------------------
  const packageSelectors = [
    ".package-card",
    ".treatment",
    ".paket-card",
    ".checkup-card",
    ".health-package",
    ".treatment-card",
    "[data-package-id]",
  ];

  $(packageSelectors.join(", ")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".package-title").text()) ||
      safe(wrap.find("h3").text()) ||
      safe(wrap.find(".title").text());
    if (!title) return;

    const priceRaw = parsePriceRaw(
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".package-price").text()) ||
      safe(wrap.find(".amount").text())
    );

    const price = sanitizePrice(priceRaw);
    const optimizedPrice = optimizePrice({ price }, { provider: "livhospital" });

    let href = safe(wrap.find("a").attr("href"));
    if (href && !href.startsWith("http"))
      href = `https://www.livhospital.com${href}`;

    const imgRaw = extractImage($, el);
    const image = buildImageVariants(imgRaw);

    const id = stableId(href || title, i + 100);
    const categoryAI = detectCategoryAI(title);
    const geoSignal = extractGeoSignal(title);
    const qualityScore = computeQualityScore({ title, image: imgRaw });

    results.push({
      id,
      provider: "livhospital",
      source: "livhospital",

      title,
      price,
      optimizedPrice,
      rating: null,

      category: categoryAI,
      categoryAI,
      geoSignal,
      qualityScore,

      currency: "TRY",
      region: region.toUpperCase(),

      url: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      fallback: false,

      raw: { title, priceRaw, href, imgRaw },
    });
  });

  if (results.length === 0) {
    return [
      {
        provider: "livhospital",
        title: `Liv Hospital sonuç bulunamadı (${query})`,
        price: null,
        optimizedPrice: null,
        region,
        category: "health",
        fallback: true,
      },
    ];
  }

  return results;
}

// ============================================================================
//  S22 MAIN ADAPTER — ZERO DELETE
// ============================================================================
async function searchLivHospitalLegacy(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  } else {
    region = regionOrOptions;
  }

  return await scrapeLiv(region, query, signal);
}

// ============================================================================
//  S22 WRAPPER — unified Herkül output
// ============================================================================
async function searchLivHospitalAdapterLegacy(query, regionOrOptions = "TR") {
  try {
    const items = await searchLivHospital(query, regionOrOptions);

    return {
      ok: true,
      adapterName: "livhospital",
      items,
      count: items.length,
    };
  } catch (err) {
    return {
      ok: false,
      adapterName: "livhospital",
      items: [],
      count: 0,
      error: err?.message || "unknown error",
    };
  }
}

// ============================================================================
// S200 WRAPPER — FINAL (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================

function _s200ResolveRegionSignal(regionOrOptions, fallbackRegion = "TR") {
  let region = fallbackRegion;
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || fallbackRegion;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || regionOrOptions.locale || fallbackRegion;
    signal = regionOrOptions.signal || null;
  }

  return { region: String(region || fallbackRegion).toUpperCase(), signal };
}

function _s200IsTimeout(e) {
  const n = String(e?.name || "").toLowerCase();
  const m = String(e?.message || "").toLowerCase();
  return n.includes("timeout") || m.includes("timed out");
}

function _s200IsFake(it) {
  if (!it || typeof it !== "object") return false;
  if (it.fallback === true || it.mock === true) return true;

  const u = String(it.affiliateUrl || it.deeplink || it.finalUrl || it.originUrl || it.url || "");
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

// ============================================================================
// LIVHOSPITAL — S200 WRAPPER (NO FAKE / NO CRASH / NO DRIFT)
// - Keeps legacy scraper logic untouched
// - Normalizes output to S200 contract: { ok, items, count, source, _meta }
// ============================================================================

export async function searchLivHospitalAdapter(query, regionOrOptions = {}) {
  const t0 = Date.now();

  // Back-compat: some callers may pass region string as 2nd arg
  const opts =
    typeof regionOrOptions === "string"
      ? { region: regionOrOptions }
      : (regionOrOptions || {});

  const region = String(opts?.region || "TR");
  const locale = String(opts?.locale || opts?.lang || "tr");

  try {
    if (typeof globalThis !== "undefined") {
      globalThis.__S200_ADAPTER_CTX = {
        providerKey: "livhospital",
        providerFamily: "health",
        vertical: "health",
        category: "hospital",
        locale,
        region,
      };
    }

    const legacyOut = await withTimeout(
      searchLivHospitalAdapterLegacy(query, opts),
      Number(opts?.timeoutMs || 8500),
      "livhospital_legacy"
    );

    const items = coerceItemsS200(legacyOut);
    const norm = items
      .map((it) => {
        const title = String(it?.title || it?.name || "").trim();
        const url =
          it?.affiliateUrl ||
          it?.deeplink ||
          it?.finalUrl ||
          it?.originUrl ||
          it?.url ||
          "";

        const price = priceOrNullS200(it?.finalPrice ?? it?.price);

        return normalizeItemS200({
          providerKey: "livhospital",
          providerFamily: "health",
          title,
          url,
          price,
          category: "hospital",
          locale,
          region,
          raw: it,
        });
      })
      .filter(Boolean);

    return {
      ok: true,
      items: norm,
      count: norm.length,
      source: "livhospital",
      _meta: {
        ms: Date.now() - t0,
        region,
        locale,
        input: String(query || "").slice(0, 120),
      },
    };
  } catch (err) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: "livhospital",
      _meta: {
        ms: Date.now() - t0,
        region,
        locale,
        error: String(err?.message || err),
      },
    };
  }
}

export const searchLivHospital =
 searchLivHospitalAdapter;
export const searchLivHospitalScrape = searchLivHospitalAdapter;

export default {
  searchLivHospital,
  searchLivHospitalScrape,
  searchLivHospitalAdapter,
  searchLivHospitalLegacy,
  searchLivHospitalAdapterLegacy
};
