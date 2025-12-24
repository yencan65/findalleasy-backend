// server/adapters/googlePlacesTravel.js
// ============================================================================
// GOOGLE PLACES TRAVEL — S200 HARDENED (API-BASED)
// - Focus: travel-ish entities (lodging / attractions) via Places API.
// - If location provided => Nearby Search; else Text Search.
// - Price fields null.
// ============================================================================
import "dotenv/config";

import crypto from "node:crypto";

import { buildImageVariants } from "../utils/imageFixer.js";

import {
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  normalizeUrlS200,
  safeStr,
} from "../core/s200AdapterKit.js";

const SOURCE = "google_places_travel";

function getPlacesKey() {
  return (
    process.env.GOOGLE_PLACES_KEY ||
    process.env.PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  );
}

function now() {
  return Date.now();
}

async function fetchJson(url, timeoutMs = 6500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(250, timeoutMs));
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "accept": "application/json" } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function mapsUrlForPlaceId(placeId) {
  const pid = safeStr(placeId);
  if (!pid) return null;
  return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(pid)}`;
}

function photoUrl(photoRef, opts = {}) {
  const key = getPlacesKey();
  const ref = safeStr(photoRef);
  if (!key || !ref) return null;
  const maxwidth = Math.max(200, Math.min(1600, Number(opts.maxwidth || 1100)));
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photoreference=${encodeURIComponent(ref)}&key=${encodeURIComponent(key)}`;
}

function normalizeResult(r, providerKey = SOURCE, opts = {}) {
  const placeId = safeStr(r?.place_id);
  const title = safeStr(r?.name);
  const url = normalizeUrlS200(mapsUrlForPlaceId(placeId) || "");
  if (!title || !url) return null;

  const imgRef = r?.photos?.[0]?.photo_reference || "";
  const img = photoUrl(imgRef, opts);
  const images = img ? buildImageVariants(img) : null;

  const idBase = `${providerKey}|${placeId || ""}|${title}|${url}`;
  const id = stableIdS200 ? stableIdS200(providerKey, idBase) : crypto.createHash("sha1").update(idBase).digest("hex");

  const lat = r?.geometry?.location?.lat;
  const lng = r?.geometry?.location?.lng;

  return {
    id,
    title,
    url,
    originUrl: url,
    finalUrl: url,

    price: null,
    finalPrice: null,
    optimizedPrice: null,
    currency: null,

    image: img || null,
    images: images || null,

    rating: typeof r?.rating === "number" ? r.rating : null,
    reviewCount: Number.isFinite(r?.user_ratings_total) ? Number(r.user_ratings_total) : null,

    address: safeStr(r?.formatted_address || r?.vicinity || ""),
    location: (typeof lat === "number" && typeof lng === "number") ? { lat, lng } : null,

    provider: providerKey,
    providerKey,

    raw: {
      providerKey,
      place_id: placeId || null,
      types: Array.isArray(r?.types) ? r.types : null,
      google: r,
    },
  };
}

async function placesTextSearch(query, opts = {}) {
  const key = getPlacesKey();
  const hl = safeStr(opts.language || opts.hl || "tr") || "tr";
  const region = safeStr(opts.region || "tr") || "tr";

  const u = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  u.searchParams.set("query", query);
  u.searchParams.set("language", hl);
  u.searchParams.set("region", region);
  u.searchParams.set("key", key);

  const { ok, status, json, text } = await fetchJson(u.toString(), Math.max(1500, Number(opts.httpTimeoutMs || 6500)));
  if (!ok) {
    const err = new Error(`GooglePlacesTravel(Text) HTTP: ${status}`);
    err.code = "HTTP_NON_2XX";
    err.status = status;
    err._meta = { status, snippet: String(text || "").slice(0, 400) };
    throw err;
  }
  return Array.isArray(json?.results) ? json.results : [];
}

async function placesNearbySearch(keyword, opts = {}) {
  const key = getPlacesKey();
  const hl = safeStr(opts.language || opts.hl || "tr") || "tr";
  const loc = opts.location;

  const u = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
  u.searchParams.set("keyword", keyword);
  u.searchParams.set("language", hl);
  u.searchParams.set("key", key);

  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  u.searchParams.set("location", `${lat},${lng}`);
  const radius = Math.max(100, Math.min(50_000, Number(opts.radius || 15_000)));
  u.searchParams.set("radius", String(radius));

  // travel-ish default
  u.searchParams.set("type", safeStr(opts.type || "lodging"));

  const { ok, status, json, text } = await fetchJson(u.toString(), Math.max(1500, Number(opts.httpTimeoutMs || 6500)));
  if (!ok) {
    const err = new Error(`GooglePlacesTravel(Nearby) HTTP: ${status}`);
    err.code = "HTTP_NON_2XX";
    err.status = status;
    err._meta = { status, snippet: String(text || "").slice(0, 400) };
    throw err;
  }
  return Array.isArray(json?.results) ? json.results : [];
}

export async function searchGooglePlacesTravel(q, opts = {}) {
  const key = getPlacesKey();
  if (!key) {
    const err = new Error("GOOGLE_PLACES_KEY / PLACES_API_KEY missing");
    err.code = "MISSING_GOOGLE_PLACES_KEY";
    throw err;
  }

  const queryRaw = safeStr(q);
  if (!queryRaw) return [];

  const keyword = safeStr(opts.keyword || queryRaw);
  const locationOk = opts.location && Number.isFinite(Number(opts.location.lat)) && Number.isFinite(Number(opts.location.lng));

  // nudge queries towards travel
  const travelQuery = (/\b(otel|hotel|konaklama|pansiyon|resort|bungalov|apart)\b/i.test(queryRaw))
    ? queryRaw
    : `${queryRaw} otel`;

  const results = locationOk
    ? await placesNearbySearch(keyword, opts)
    : await placesTextSearch(travelQuery, opts);

  return results.map((r) => normalizeResult(r, SOURCE, opts)).filter(Boolean);
}

export async function searchGooglePlacesTravelAdapter(q, opts = {}) {
  const started = now();
  const providerKey = SOURCE;

  try {
    const rawItems = await withTimeout(searchGooglePlacesTravel(q, opts), Number(opts.timeoutMs || 6500));
    const items = coerceItemsS200(rawItems, providerKey).map((it) =>
      normalizeItemS200(it, providerKey, { strict: true })
    );

    return { ok: true, items, count: items.length, source: providerKey, _meta: { ms: now() - started } };
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    const meta = {
      ms: now() - started,
      timeout: !!isTimeout,
      code: e?.code,
      status: e?.status,
      error: { name: e?.name, message: e?.message },
    };
    if (e?._meta) meta.upstream = e._meta;

    return { ok: false, items: [], count: 0, source: providerKey, _meta: meta };
  }
}

export default {
  searchGooglePlacesTravelAdapter,
  searchGooglePlacesTravel,
};
