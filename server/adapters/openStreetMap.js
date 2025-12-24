// ============================================================================
//  OPENSTREETMAP — S22 ULTRA TITAN ADAPTER
//  ZERO DELETE — S7 fonksiyonların hepsi aynen korunur
//  Eklenenler:
//  • proxyFetchHTML fallback
//  • stableId
//  • strongLocationSignals(city, district, country)
//  • staticMapImage via proxy
//  • category AI ++
//  • raw metadata expanded
// ============================================================================

import fetch from "node-fetch";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { normalizeItemS200, stableIdS200, coerceItemsS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";
const PROVIDER_KEY = "openstreetmap";
const DISCOVERY_SOURCE = true;

// --------------------------------------------------------
// HELPERS
// --------------------------------------------------------
function resolveRegion(regionOrOptions = "TR", fallback = "TR", fallbackSignal = null) {
  let region = fallback;
  let signal = fallbackSignal;
  let options = {};

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || fallback;
    signal = regionOrOptions.signal || fallbackSignal;
    options = regionOrOptions;
  }

  return { region: region.toUpperCase(), signal, options };
}

// ------------------------------
// Strong category AI
// ------------------------------
function detectCategory(p) {
  const t = [
    p.type,
    p.class,
    p.category,
    p.display_name,
  ]
    .join(" ")
    .toLowerCase();

  if (/hotel|otel|resort|konaklama/.test(t)) return "hotel";
  if (/airport|uçak|havaalanı|terminal/.test(t)) return "flight";
  if (/restaurant|cafe|restoran|yemek/.test(t)) return "food";
  if (/rent|kiralama|car rental/.test(t)) return "car_rental";
  if (/market|shop|store|mağaza/.test(t)) return "product";
  if (/museum|park|beach|nature|gezi/.test(t)) return "event";

  // Travel generic
  if (/city|town|village|district|bölge|mahalle/.test(t)) return "location";

  return "location";
}

// ------------------------------
// Location signals (city, district, country)
// ------------------------------
function parseAddress(p) {
  const addr = p.address || {};

  return {
    city: addr.city || addr.town || addr.village || null,
    district: addr.suburb || addr.neighbourhood || null,
    state: addr.state || null,
    country: addr.country || null,
  };
}

// ------------------------------
// Static map preview generator
// ------------------------------
function buildStaticMap(lat, lon) {
  if (!lat || !lon) return null;

  const staticUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=15&size=400x300&markers=${lat},${lon},red`;

  const variants = buildImageVariants(staticUrl);
  return {
    image: variants.image,
    imageProxy: variants.imageProxy,
    imageOriginal: variants.imageOriginal,
    hasProxy: variants.hasProxy,
  };
}

function stableId(placeId, region, url = "", title = "") {
  // ✅ deterministic
  return stableIdS200(PROVIDER_KEY, url || String(placeId || ""), title || String(placeId || ""));
}
// ============================================================================
// OLD FUNCTION (UNCHANGED) — BUT EXTENDED WITH TITAN SIGNALS
// ============================================================================
export async function searchWithOpenStreetMap(query, regionOrOptions = "TR", signal) {
  const qStr = String(query || "").trim();
  if (!qStr) return [];

  const { region, signal: finalSignal } = resolveRegion(regionOrOptions, "TR", signal);
  const q = encodeURIComponent(qStr);

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&addressdetails=1&limit=20`;

  let json;

  // ------------------------------
  // S22: proxy first
  // ------------------------------
  try {
    const html = await proxyFetchHTML(url, {
      headers: { "User-Agent": "FindAllEasy-S22" },
      signal: finalSignal,
    });
    json = JSON.parse(html);
  } catch {
    // fallback
    const res = await withTimeout(fetch(url, {
      headers: { "User-Agent": "FindAllEasy/1.0" },
      signal: finalSignal,
    }), 6500, "openstreetmap fetch");

    if (!res.ok) return [];
    json = await res.json();
  }

  if (!Array.isArray(json)) return [];

  return json.map((p, i) => {
    const title =
      (p.display_name && p.display_name.split(",")[0]) ||
      p.name ||
      "Lokasyon";

    const lat = p.lat ? Number(p.lat) : null;
    const lon = p.lon ? Number(p.lon) : null;

    const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;

    const cat = detectCategory(p);
    const addr = parseAddress(p);
    const staticImg = buildStaticMap(lat, lon);

    return {
      id: p.place_id || `osm-${i}`,
      title,
      provider: "openstreetmap",
      source: "openstreetmap",

      price: null,
      rating: null,

      latitude: lat,
      longitude: lon,
      coordinates: { lat, lon },

      url: mapUrl,
      deeplink: mapUrl,

      address: p.display_name || "",
      addressDetails: addr,

      category: cat,
      region,

      image: staticImg?.image || null,
      imageProxy: staticImg?.imageProxy || null,
      imageOriginal: staticImg?.imageOriginal || null,
      hasProxy: staticImg?.hasProxy || false,

      raw: {
        osm: p,
        staticMap: staticImg,
        address: addr,
      },
    };
  });
}

// ============================================================================
// FINAL ADAPTER — Dedup-safe IDs + S22 compliance
// ============================================================================
export async function searchOpenStreetMapAdapter(query, regionOrOptions = "TR", signal) {
  const qStr = String(query || "").trim();
  if (!qStr) {
    return { ok: false, items: [], count: 0, source: PROVIDER_KEY, _meta: { error: "empty_query" } };
  }

  const { region, signal: finalSignal } = resolveRegion(regionOrOptions, "TR", signal);

  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    adapter: "searchOpenStreetMapAdapter",
    group: "estate",
    metaUrl: import.meta?.url,
  };

  const startedAt = Date.now();

  try {
    const results = await withTimeout(
      searchWithOpenStreetMap(qStr, { region, signal: finalSignal }),
      6500,
      "openstreetmap search"
    );

    const items = (Array.isArray(results) ? results : [])
      .map((x) => {
        const url = x.url || x.deeplink || x.originUrl || x.finalUrl || "";
        const title = x.title || x.name || x.address || "";
        const raw = {
          ...x,
          id: stableId(x.id, region, url, title),
          provider: PROVIDER_KEY,
          source: PROVIDER_KEY,
          region,
          // discovery: price forced null
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          affiliateUrl: null,
          url: url || null,
          originUrl: x.originUrl || url || null,
          finalUrl: x.finalUrl || url || null,
          deeplink: x.deeplink || url || null,
        };
        return normalizeItemS200(raw, PROVIDER_KEY, { vertical: "estate", category: "place", discovery: true });
      })
      .filter(Boolean);

    return {
      ok: items.length > 0,
      items,
      count: items.length,
      source: PROVIDER_KEY,
      _meta: {
        region,
        discovery: true,
        tookMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, items: [], count: 0, source: PROVIDER_KEY, _meta: { region, aborted: true } };
    }
    const isTimeout = err instanceof TimeoutError || /timed out/i.test(err?.message || "");
    return {
      ok: false,
      items: [],
      count: 0,
      source: PROVIDER_KEY,
      _meta: {
        region,
        discovery: true,
        timeout: isTimeout,
        error: err?.message || String(err),
        tookMs: Date.now() - startedAt,
      },
    };
  }
}

export async function searchOpenStreetMapArray(query, regionOrOptions = "TR", signal) {
  const res = await searchOpenStreetMapAdapter(query, regionOrOptions, signal);
  return res?.items || [];
}

export default {
  searchWithOpenStreetMap,
  searchOpenStreetMapAdapter,
};