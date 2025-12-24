// server/adapters/googlePlacesDetails.js
// =======================================================================
//  GOOGLE PLACES DETAILS — S33 TITAN FINAL ADAPTER (PATCHED)
// -----------------------------------------------------------------------
//  ZERO DELETE — tüm fonksiyon imzaları korunur
//  FIX: region.toLowerCase is not a function (region normalize + arg normalize)
//  FIX: query object / options object support (drift-safe)
//  + fetch timeout (zero-crash)
// =======================================================================

import "dotenv/config";
import fetch from "node-fetch";
import { buildImageVariants } from "../utils/imageFixer.js";
import { normalizeItemS200, coerceItemsS200, stableIdS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";

// =======================================================================
// S200 FAIL-ARRAY HELPERS (keeps array signature, makes failure observable)
// =======================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

function _s200FailArray(source, query, opt = {}, code = "ADAPTER_FAIL", err = "") {
  const arr = [];
  try {
    Object.defineProperty(arr, "ok", { value: false, enumerable: false });
    Object.defineProperty(arr, "_meta", {
      value: {
        source,
        query: typeof query === "string" ? query : "",
        code,
        error: String(err || ""),
        stubAllowed: FINDALLEASY_ALLOW_STUBS,
        opt,
      },
      enumerable: false,
    });
  } catch {}
  return arr;
}

function _s200MarkOkArray(arr, source, meta = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    Object.defineProperty(arr, "ok", { value: true, enumerable: false });
    Object.defineProperty(arr, "_meta", { value: { source, ...meta }, enumerable: false });
  } catch {}
  return arr;
}


// =======================================================================
// ENV
// =======================================================================
const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY || "";

// =======================================================================
// SAFE HELPERS
// =======================================================================
function safeStr(v, fb = "") {
  return v == null ? fb : String(v).trim();
}

function safeNum(v, fb = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

// region normalize (drift-safe)
function normalizeRegionInput(regionLike, fb = "TR") {
  try {
    if (regionLike && typeof regionLike === "object" && !Array.isArray(regionLike)) {
      regionLike =
        regionLike.region ||
        regionLike.country ||
        regionLike.countryCode ||
        regionLike.code ||
        regionLike.locale ||
        regionLike.lang ||
        "";
    }
    const s = safeStr(regionLike, "");
    if (!s) return fb;
    return s.toUpperCase();
  } catch {
    return fb;
  }
}

// small timeout wrapper (zero-crash)
async function fetchJsonWithTimeout(url, ms = 5200) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
  } finally {
    clearTimeout(t);
  }
}

// TITAN stableId
function stableId(provider, title, link) {
  return stableIdS200("google_places_details", title || "", provider || "");
}

// Deeplink normalize
function normalizeDeeplink(placeId) {
  if (!placeId) return "";
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

// Fallback image
function fallbackImage(name = "place") {
  const q = encodeURIComponent(name);
  return `https://source.unsplash.com/featured/?location,${q}`;
}

// S33 qualityScore
function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.40;
  if (base.rating != null) s += 0.25;
  if (base.image) s += 0.25;
  s += 0.10; // stabilite
  return Number(s.toFixed(2));
}

// =======================================================================
// NORMALIZE — S33 LEVEL
// =======================================================================
function normalizePlaceDetails(place, details, region) {
  const title = safeStr(details.name || place.name, "Unknown Place");

  // Görsel → S33 ImageVariants
  let imgRaw = null;
  if (Array.isArray(details.photos) && details.photos.length > 0) {
    imgRaw = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=900&photo_reference=${details.photos[0].photo_reference}&key=${GOOGLE_KEY}`;
  } else {
    imgRaw = fallbackImage(title);
  }

  const imageData = buildImageVariants(imgRaw, "google_places");

  const deeplink =
    safeStr(details.url) || normalizeDeeplink(place.place_id) || "";

  const base = {
    id: stableId("google_places_details", title, deeplink),
    title,
    provider: "google_places_details",
    providerType: "travel_info",
    providerFamily: "google",
    vertical: "travel",

    category: "place_details",
    categoryAI: "travel_place_details",

    price: null,
    finalPrice: null,
    currency: "TRY",

    rating: safeNum(details.rating, null),
    reviewCount: safeNum(details.user_ratings_total, null),

    phone: details.formatted_phone_number || null,
    address: safeStr(details.formatted_address || place.formatted_address, ""),
    region,

    website: safeStr(details.website, null),

    openNow: details?.opening_hours?.open_now ?? null,
    hours:
      Array.isArray(details?.opening_hours?.weekday_text) &&
      details.opening_hours.weekday_text.length > 0
        ? details.opening_hours.weekday_text
        : [],

    // TITAN Image Pack
    image: imageData.image,
    imageOriginal: imageData.imageOriginal,
    imageProxy: imageData.imageProxy,
    hasProxy: imageData.hasProxy,

    images:
      Array.isArray(details.photos) && details.photos.length > 0
        ? details.photos
            .map(
              (ph) =>
                `https://maps.googleapis.com/maps/api/place/photo?maxwidth=900&photo_reference=${ph.photo_reference}&key=${GOOGLE_KEY}`
            )
            .filter(Boolean)
        : [imageData.image],

    deeplink,
    source: "google_places_details",
    raw: details,
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// =======================================================================
// MAIN SEARCH — S33 LEVEL
// =======================================================================
export async function searchGooglePlacesDetails(query, region = "TR") {
  if (!GOOGLE_KEY) {
    console.log("⚠️ googlePlacesDetails: API KEY yok → observable fail");
    return _s200FailArray("google_places_details", "MISSING_GOOGLE_PLACES_KEY", "GOOGLE_PLACES_KEY missing", { query, region });
  }

  // --- ARG NORMALIZATION (DRIFT-SAFE) ---
  // allow calls like: searchGooglePlacesDetails({ query, region })
  // allow calls like: searchGooglePlacesDetails("x", { region:"TR" })
  let qLike = query;
  let rLike = region;

  if (qLike && typeof qLike === "object" && !Array.isArray(qLike)) {
    const o = qLike;
    qLike = o.query ?? o.q ?? o.term ?? o.text ?? "";
    rLike = o.region ?? o.country ?? o.countryCode ?? o.code ?? rLike;
  }
  if (rLike && typeof rLike === "object" && !Array.isArray(rLike)) {
    const o = rLike;
    rLike = o.region ?? o.country ?? o.countryCode ?? o.code ?? "TR";
  }

  const q = safeStr(qLike, "");
  const regionNorm = normalizeRegionInput(rLike, "TR");
  const regionParam = regionNorm.toLowerCase();
  const lang = regionNorm === "TR" ? "tr" : "en";

  if (!q) return [];

  try {
    // 1) TEXT SEARCH
    const textUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      q
    )}&region=${regionParam}&language=${lang}&key=${GOOGLE_KEY}`;

    const t1 = await fetchJsonWithTimeout(textUrl, 5200);
    if (!t1.ok) {
      console.warn("⚠️ GooglePlacesDetails textSearch HTTP:", t1.status);
      return [];
    }

    const baseResults = Array.isArray(t1.json?.results) ? t1.json.results : [];
    if (!baseResults.length) return [];

    const first10 = baseResults.slice(0, 10);
    const output = [];

    // 2) DETAILS SEARCH (sequential, drift-safe)
    for (const place of first10) {
      const pid = safeStr(place?.place_id, "");
      if (!pid) continue;

      const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
        pid
      )}&language=${lang}&key=${GOOGLE_KEY}`;

      const t2 = await fetchJsonWithTimeout(detUrl, 5200);
      if (!t2.ok) continue;

      const details = t2.json?.result;
      if (!details) continue;

      const normalized = normalizePlaceDetails(place, details, regionNorm);
      output.push(normalized);
    }

    console.log(`📌 GooglePlacesDetails S33 → ${output.length} detay`);
    return output;
  } catch (e) {
    console.warn("⚠️ googlePlacesDetails hata:", safeStr(e?.message, String(e || "unknown")));
    return _s200FailArray("google_places_details", "EXCEPTION", safeStr(e?.message, String(e || "unknown")), { region });
  }
}

// =======================================================================
// DEFAULT EXPORT
// =======================================================================
export default {
  searchGooglePlacesDetails,
};

// =======================================================================
// S200 WRAPPED EXPORT — standard output { ok, items, count, source, _meta }
// =======================================================================
function _s200StripIds(x) {
  if (!x || typeof x !== "object") return x;
  const y = { ...x };
  delete y.id;
  delete y.listingId;
  return y;
}

function _s200NormalizeItems(arr, providerKey) {
  const out = [];
  const items = coerceItemsS200(arr);
  for (const it of items) {
    const clean = _s200StripIds(it);
    if (!clean) continue;
    if (true) {
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;
    }
    const norm = normalizeItemS200(clean, providerKey, { vertical: "discovery", providerFamily: "discovery" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function searchGooglePlacesDetailsS200(query, options = {}) {
  const startedAt = Date.now();
  const providerKey = "google_places_details";
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { providerKey, adapter: "google_places_details", query: typeof query === "string" ? query : "" };
  try {
    const raw = await withTimeout((searchGooglePlacesDetails(query, options)), 6500, providerKey);
    const items = _s200NormalizeItems(raw, providerKey);
    return {
      ok: true,
      items,
      count: items.length,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, stub: false },
    };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e || "unknown");
    const isTimeout = (e && e.name === "TimeoutError") || /timed out|timeout/i.test(msg);
    if (FINDALLEASY_ALLOW_STUBS) {
      return {
        ok: true,
        items: [],
        count: 0,
        source: providerKey,
        _meta: { tookMs: Date.now() - startedAt, stub: true, error: msg, timeout: isTimeout },
      };
    }
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, error: msg, timeout: isTimeout },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}
