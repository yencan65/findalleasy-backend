// server/adapters/googlePlaces.js
// =======================================================================
//  GOOGLE PLACES — S33 TITAN FINAL ADAPTER (PATCHED)
// -----------------------------------------------------------------------
//  ZERO DELETE — S10 fonksiyon imzaları korunur, sadece güçlendirme
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


const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || "";

// =======================================================================
// SAFE HELPERS — TITAN LEVEL
// =======================================================================
function safeStr(v, fb = "") {
  return v == null ? fb : String(v).trim();
}
function safeNum(v, fb = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function fallbackImage(name = "location") {
  return `https://source.unsplash.com/featured/?location,${encodeURIComponent(
    name
  )}`;
}
function makePhotoUrl(ref) {
  if (!ref || !GOOGLE_PLACES_KEY) return null;
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=900&photo_reference=${ref}&key=${GOOGLE_PLACES_KEY}`;
}
function deeplink(placeId) {
  if (!placeId) return "";
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

// region normalize (drift-safe)
function normalizeRegionInput(regionLike, fb = "TR") {
  try {
    // allow passing options object mistakenly
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
    // keep it as country-ish code; upper for logic, lower for API param later
    return s.toUpperCase();
  } catch {
    return fb;
  }
}

// small timeout wrapper (zero-crash)
async function fetchJsonWithTimeout(url, ms = 4500) {
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
  return stableIdS200(provider || "unknown", link || "", title || "");
}

// TITAN quality score
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.40;
  if (item.rating != null) s += 0.25;
  if (item.image) s += 0.25;
  s += 0.10;
  return Number(s.toFixed(2));
}

// =======================================================================
// NORMALIZE — S33 TITAN EDITION
// =======================================================================
function normalizeGooglePlace(p = {}, region = "TR", index = 0) {
  const title = safeStr(p.name, "Unknown Place");

  // Görsel seçimi
  const rawImg =
    p.photos?.length > 0
      ? makePhotoUrl(p.photos[0].photo_reference)
      : fallbackImage(title);

  const imageData = buildImageVariants(rawImg, "google_places");

  const url = deeplink(p.place_id);

  const base = {
    id: stableId("google_places", title, url),

    title,
    provider: "google_places",
    providerType: "travel_info",
    providerFamily: "google",
    vertical: "travel",

    category: "place",
    categoryAI: "travel_place",

    price: p.price_level ? p.price_level * 100 : null,
    currency: "TRY",

    rating: safeNum(p.rating, null),
    reviewCount: safeNum(p.user_ratings_total, null),

    address: safeStr(p.formatted_address, ""),
    region,

    image: imageData.image,
    imageOriginal: imageData.imageOriginal,
    imageProxy: imageData.imageProxy,
    hasProxy: imageData.hasProxy,

    images:
      (p.photos || [])
        .map((ph) => makePhotoUrl(ph.photo_reference))
        .filter(Boolean) || [imageData.image],

    url,
    deeplink: url,

    source: "google_places",
    raw: p,
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// =======================================================================
// MAIN SEARCH — S33 LEVEL
// =======================================================================

function _attachMetaArray(arr, ok, meta) {
  try {
    Object.defineProperty(arr, "ok", { value: !!ok, enumerable: false });
    Object.defineProperty(arr, "_meta", { value: meta || {}, enumerable: false });
  } catch {}
  return arr;
}

function _failArray(code, message, extra = {}) {
  const arr = [];
  return _attachMetaArray(arr, false, { code, message, ...extra });
}

function _okArray(arr, extra = {}) {
  const items = Array.isArray(arr) ? arr : [];
  return _attachMetaArray(items, true, { ...extra });
}

export async function searchGooglePlaces(query, region = "TR") {
  // --- ARG NORMALIZATION (DRIFT-SAFE) ---
  // allow calls like: searchGooglePlaces({ query, region })
  // allow calls like: searchGooglePlaces("x", { region:"TR" })
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
  const regionNorm = normalizeRegionInput(rLike, "TR"); // e.g. "TR"
  const regionParam = regionNorm.toLowerCase(); // API wants lower ccTLD-ish
  const lang = regionNorm === "TR" ? "tr" : "en";

  if (!GOOGLE_PLACES_KEY) {
    console.log("⚠️ googlePlaces: API KEY yok → observable fail");
    return _failArray("MISSING_GOOGLE_PLACES_KEY", "GOOGLE_PLACES_KEY missing", { query: q, region: regionNorm });
  }
  if (!q) return [];

  try {
    const enc = encodeURIComponent(q);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${enc}&region=${regionParam}&language=${lang}&key=${GOOGLE_PLACES_KEY}`;

    const { ok, status, json } = await fetchJsonWithTimeout(url, 5200);
    if (!ok) {
      console.warn("⚠️ GooglePlaces HTTP:", status);
      return _failArray("HTTP_NON_2XX", "GooglePlaces HTTP non-2xx", { status });
    }

    const arr = Array.isArray(json?.results) ? json.results : [];
    if (!arr.length) return [];

    const normalized = arr
      .slice(0, 20)
      .map((p, i) => normalizeGooglePlace(p, regionNorm, i));

    console.log(`📍 GooglePlaces S33 → ${normalized.length} sonuç`);
    return normalized;
  } catch (err) {
    const msg = safeStr(err?.message, String(err || "unknown"));
    console.warn("⚠️ googlePlaces hata:", msg);
    return _failArray("EXCEPTION", msg, { region: regionNorm });
  }
}

// =======================================================================
// DEFAULT EXPORT — ZERO DELETE
// =======================================================================
export default {
  searchGooglePlaces,
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

export async function searchGooglePlacesS200(query, options = {}) {
  const startedAt = Date.now();
  const providerKey = "google_places";
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { providerKey, adapter: "google_places", query: typeof query === "string" ? query : "" };
  try {
    const raw = await withTimeout((searchGooglePlaces(query, options)), 6500, providerKey);
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
