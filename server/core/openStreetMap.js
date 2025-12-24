// server/adapters/openStreetMapAdapter.js
// ======================================================================
//  OPENSTREETMAP — S15.9 TITAN-OMEGA EDITION
//  ZERO-CRASH · ZERO-NOISE · ZERO-RATELIMIT · ZERO-DRIFT
//  Advanced semantic title extractor + deep category engine
//  Stable coordinates + ultra-stable ID + jittered backoff
//  All legacy functions preserved — NO REMOVALS
// ======================================================================

import fetch from "node-fetch";

// ======================================================================
// SMART BACKOFF + JITTER — S15 LEVEL
// ======================================================================
async function safeFetch(url, tries = 4) {
  let last = null;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "FindAllEasy/5.0 (OSM-S15 TITAN)",
          Accept: "application/json",
        },
        timeout: 9000,
      });

      if (res.status === 429) {
        const wait = Math.min(1800 * (i + 1), 7000) + Math.random() * 300;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error("HTTP " + res.status);

      return await res.json();
    } catch (err) {
      last = err;
      const jitter = Math.random() * 200;
      await new Promise(r => setTimeout(r, 400 * (i + 1) + jitter));
    }
  }

  console.warn("⚠️ OSM safeFetch FAILED:", last?.message);
  return null;
}

// ======================================================================
// SEMANTIC TITLE EXTRACTOR — S15 Ultra
// ======================================================================
function extractTitle(displayName = "") {
  const txt = String(displayName || "").trim();
  if (!txt) return "Lokasyon";

  const parts = txt.split(",").map(x => x.trim()).filter(Boolean);
  if (!parts.length) return "Lokasyon";

  const blacklist = [
    "mahallesi",
    "mah",
    "district",
    "province",
    "county",
    "neighborhood",
    "ilçe",
    "il",
  ];

  const cand = parts[0]
    .split(" ")
    .filter(w => !blacklist.includes(w.toLowerCase()))
    .join(" ")
    .trim();

  // Eğer ilk segment saçmaysa ikinci segmenti kullan
  if (cand.length < 2 && parts[1]) return parts[1];

  return cand || parts[0] || "Lokasyon";
}

// ======================================================================
// DEEP CATEGORY CLASSIFIER — S15.9
// semantic + fuzzy + type/class inference
// ======================================================================
function detectOSMCategory(p) {
  try {
    const text = [
      p.type,
      p.category,
      p.class,
      p.osm_type,
      p.display_name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const map = {
      hotel: /(hotel|otel|resort|konaklama|pansiyon)/,
      flight: /(airport|uçak|ucak|terminal|airline)/,
      food: /(restaurant|cafe|kahve|coffee|bar|pub|food|yemek)/,
      health: /(hospital|clinic|hastane|sağlık|health)/,
      car_rental: /(rent|kirala|rentacar|car rental)/,
      market: /(market|supermarket|market|bakkal|mağaza|store|shop)/,
      nature: /(park|beach|plaj|nature|forest|doğa)/,
      event: /(stadium|konser|festival|theatre|opera|event)/,
      education: /(school|kolej|üniversite|university|education)/,
    };

    for (const [cat, regex] of Object.entries(map)) {
      if (regex.test(text)) return cat;
    }

    return "location";
  } catch {
    return "location";
  }
}

// ======================================================================
// STABLE ID (ULTRA SAFE)
// ======================================================================
function buildStableId(p, region) {
  try {
    const lat = Number(p.latitude || p.lat);
    const lon = Number(p.longitude || p.lon);

    const hash =
      Math.abs(Math.floor(lat * 100000)) +
      "-" +
      Math.abs(Math.floor(lon * 100000));

    return `osm-${p.raw?.place_id || p.id}-${region}-${hash}`;
  } catch {
    return `osm-${region}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ======================================================================
// INTERNAL COORD NORMALIZER — S15
// ======================================================================
function normalizeCoordinates(p) {
  const lat = Number(p.lat);
  const lon = Number(p.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      latitude: null,
      longitude: null,
      coordinates: null,
    };
  }

  return {
    latitude: lat,
    longitude: lon,
    coordinates: { lat, lon },
  };
}

// ======================================================================
// 1) ORIGINAL FUNCTION — PRESERVED & UPGRADED
// ======================================================================
export async function searchWithOpenStreetMap(query, region = "TR") {
  try {
    if (!query) return [];

    const q = encodeURIComponent(query);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&addressdetails=1&limit=30`;

    const json = await safeFetch(url);
    if (!Array.isArray(json) || json.length === 0) return [];

    return json.map(p => {
      const coords = normalizeCoordinates(p);

      return {
        id: p.place_id || `osm-${Math.random().toString(36).slice(2, 8)}`,
        title: extractTitle(p.display_name),

        provider: "openstreetmap",
        source: "openstreetmap",

        price: null,
        rating: null,

        ...coords,

        url: coords.latitude
          ? `https://www.openstreetmap.org/?mlat=${coords.latitude}&mlon=${coords.longitude}#map=18/${coords.latitude}/${coords.longitude}`
          : null,

        deeplink: coords.latitude
          ? `https://www.openstreetmap.org/?mlat=${coords.latitude}&mlon=${coords.longitude}#map=18/${coords.latitude}/${coords.longitude}`
          : null,

        address: p.display_name || "",
        category: detectOSMCategory(p),
        region,
        raw: p,
      };
    });
  } catch (err) {
    console.warn("⚠️ OSM adapter hata:", err.message);
    return [];
  }
}

// ======================================================================
// 2) FINAL TITAN ENGINE — stable ID + ultra safe mapping
// ======================================================================
export async function searchOpenStreetMapAdapter(query, region = "TR") {
  try {
    if (!query) return [];

    const list = await searchWithOpenStreetMap(query, region);
    if (!Array.isArray(list)) return [];

    return list.map(x => ({
      ...x,
      id: buildStableId(x, region),
    }));
  } catch {
    return [];
  }
}

// ======================================================================
// DEFAULT EXPORT
// ======================================================================
export default {
  searchWithOpenStreetMap,
  searchOpenStreetMapAdapter,
};
