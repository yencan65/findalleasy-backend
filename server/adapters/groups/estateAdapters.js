// server/adapters/groups/estateAdapters.js
// ============================================================================
// ESTATE ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.0 (ENGINE COMPATIBLE)
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub, no fake listing) ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE)
// - Discovery providers (google/osm/serp): price forced null
//
// PATCH (DRIFT+CTX):
// - canonicalProviderKey: S9 "unknown" döndürürse base'i EZMEZ
// - globalThis.__S200_ADAPTER_CTX set/restore (adapter+baseUrl) -> [S200][unknown] log drift biter
// ============================================================================

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;
const ALLOW_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "1") === "1";

// IMPORTANT: never reference an undeclared symbol in catch blocks.
// This label is used only for diagnostics.
const __GROUP_NAME = "estate";

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  nonEmptyTitleS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

const fix = (v) => String(v || "").toLowerCase().trim();
const isBadKey = (k) => !k || k === "unknown" || k === "null" || k === "undefined";

const canonicalProviderKey = (raw, fallback = "estate") => {
  const base = fix(raw || fallback);
  if (isBadKey(base)) return fix(fallback) || "estate";

  // ✅ normalizeProviderKeyS9 "unknown" döndürürse base'i EZME
  try {
    if (normalizeProviderKeyS9) {
      const nRaw = normalizeProviderKeyS9(base);
      const n = fix(nRaw);
      if (!isBadKey(n)) return n;
    }
  } catch {}

  return base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "estate");
  const fam0 = (k.split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, "estate") || "estate";
};

function resolveProviderFamily(provider) {
  const pk = canonicalProviderKey(provider, "estate");
  return providerFamilyFromKey(pk);
}

function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

// ----------------------------------------------------------------------------
// Base URLs + query-aware fallbacks (discovery)
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  // discovery
  googleplaces_estate: "https://www.google.com/maps",
  googleplacesdetails_estate: "https://www.google.com/maps",
  osm_estate: "https://www.openstreetmap.org/",
  serpapi_estate: "https://www.google.com/",

  // TR platforms
  sahibinden: "https://www.sahibinden.com/",
  sahibinden_estate: "https://www.sahibinden.com/",
  emlakjet: "https://www.emlakjet.com/",
  emlakjet_estate: "https://www.emlakjet.com/",
  hepsiemlak: "https://www.hepsiemlak.com/",
  hepsiemlak_estate: "https://www.hepsiemlak.com/",
  zingat: "https://www.zingat.com/",
  zingat_estate: "https://www.zingat.com/",

  // agencies / others
  turyap: "https://www.turyap.com.tr/",
  tapucom: "https://www.tapu.com/",
  endeksa: "https://www.endeksa.com/",
  remax: "https://www.remax.com.tr/",
  coldwell: "https://www.coldwellbanker.com.tr/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "estate");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

const mapsSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}` : "https://www.google.com/maps";
};
const osmSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(t)}` : "https://www.openstreetmap.org/";
};
const googleSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : "https://www.google.com/";
};

// ----------------------------------------------------------------------------
// Currency (TL/₺ -> TRY)
// ----------------------------------------------------------------------------
function normalizeCurrency(v) {
  if (!v) return "TRY";
  const s = String(v).trim();
  if (!s) return "TRY";
  const up = s.toUpperCase();
  if (up === "₺" || up === "TL" || up.includes("TL") || up.includes("₺") || up === "TRY") return "TRY";
  return up.replace(/\s+/g, "").slice(0, 3) || "TRY";
}

// ----------------------------------------------------------------------------
// URL normalizer (absolute-enforced + handles "relative without leading /")
// ----------------------------------------------------------------------------
function normalizeUrlEstate(candidate, baseUrl) {
  let u = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();
  if (!u) return "";

  u = normalizeUrlS200(u, b);

  // handle "relative without leading /"
  if (u && !/^https?:\/\//i.test(u)) {
    const bb = b ? b.replace(/\/+$/g, "") : "";
    const cc = String(candidate ?? "").trim().replace(/^\/+/g, "");
    if (bb && cc) u = `${bb}/${cc}`;
  }

  if (!u || !/^https?:\/\//i.test(u)) return "";
  if (isBadUrlS200(u)) return "";
  return u;
}

// ----------------------------------------------------------------------------
// Numeric helpers (estate fields)
// ----------------------------------------------------------------------------
const asNum = (v, { min = null, max = null } = {}) => {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    let n = v;
    if (min != null && n < min) return null;
    if (max !=null && n > max) return null;
    return n;
  }
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
};

const asStr = (v, maxLen = 120) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.slice(0, maxLen);
};

// ----------------------------------------------------------------------------
// SAFE IMPORT (kit-based) — caller-relative, optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "estate");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: NO fake price, just a navigable card
    return async (query, options = {}) => {
      const city = asStr(options?.city || "İstanbul", 40);
      const t0 = String(query || "").trim() || "satılık daire";
      const title = nonEmptyTitleS200(`${city} ${t0}`, `${providerFamily} emlak ilanı`);
      const url = normalizeUrlEstate(baseUrl, baseUrl) || "https://www.findalleasy.com/";

      return [
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          vertical: "estate",
          category: "estate",
          providerType: "estate",
          city,
          location: city,
          area: null,
          rooms: null,
          version: "S200",
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },
});

// kept signature
async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ Estate safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------------------------------------------------------
// NORMALIZER — S200 ESTATE ITEM (contract lock + estate fields)
// ----------------------------------------------------------------------------
function normalizeEstateS200(item, providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const city = asStr(item.city || options.city || "", 60);
  const district = asStr(item.district || item.town || "", 80);
  const neighborhood = asStr(item.neighborhood || item.quarter || "", 100);

  const area = asNum(item.area ?? item.netArea ?? item.grossArea ?? item.m2 ?? item.squareMeters, { min: 5, max: 20000 });
  const bathrooms = asNum(item.bathrooms ?? item.bathroomCount, { min: 0, max: 50 });
  const floor = asNum(item.floor ?? item.floorNo, { min: -5, max: 250 });
  const buildingAge = asNum(item.buildingAge ?? item.age, { min: 0, max: 500 });

  // rooms can be "2+1" -> keep string
  const rooms = asStr(item.rooms ?? item.room ?? item.roomCount ?? "", 40);

  const location = asStr(item.location || item.address || [city, district, neighborhood].filter(Boolean).join(" "), 160);

  // title with strong fallback (never empty)
  const titleFallbackParts = [];
  if (city) titleFallbackParts.push(city);
  if (district) titleFallbackParts.push(district);
  if (area) titleFallbackParts.push(`${Math.round(area)}m²`);
  if (rooms) titleFallbackParts.push(String(rooms));
  const titleFallback = titleFallbackParts.join(" ").trim() || `${providerFamily} ilanı`;

  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.heading ?? item.raw?.title ?? item.raw?.name,
    titleFallback
  );
  if (!title) return null;

  // URL candidates -> absolute
  const cAffiliate = normalizeUrlEstate(item.affiliateUrl ?? item.raw?.affiliateUrl ?? "", baseUrl);
  const cDeeplink = normalizeUrlEstate(item.deeplink ?? item.deepLink ?? item.raw?.deeplink ?? item.raw?.deepLink ?? "", baseUrl);
  const cFinal = normalizeUrlEstate(item.finalUrl ?? item.raw?.finalUrl ?? "", baseUrl);
  const cOrigin = normalizeUrlEstate(item.originUrl ?? item.raw?.originUrl ?? item.url ?? item.link ?? item.href ?? "", baseUrl);
  let cUrl = normalizeUrlEstate(item.url ?? item.link ?? item.href ?? item.website ?? item.raw?.url ?? "", baseUrl);

  // discovery fallback (search URL) if needed
  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl && isDiscoveryProvider(pk)) {
    cUrl =
      pk.includes("osm") ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi") ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);
    cUrl = normalizeUrlEstate(cUrl, baseUrl);
  }

  const clickUrl = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;
  if (!clickUrl) return null;

  const currencyIn = normalizeCurrency(item.currency ?? item.raw?.currency ?? "TRY");
  const region = String(options?.region || item.region || "TR").toUpperCase().trim();

  // Normalize via kit
  const base = normalizeItemS200(
    {
      ...item,
      title,
      currency: currencyIn,
      region,
      url: clickUrl,
      originUrl: cOrigin || clickUrl,
      finalUrl: cFinal || cDeeplink || cAffiliate || clickUrl,
      deeplink: cDeeplink || null,
      affiliateUrl: cAffiliate || null,
    },
    pk,
    {
      vertical: "estate",
      category: "estate",
      providerFamily,
      baseUrl,
      fallbackUrl: isDiscoveryProvider(pk) ? baseUrl : "",
      requireRealUrlCandidate: !isDiscoveryProvider(pk),
      titleFallback,
      priceKeys: ["optimizedPrice", "finalPrice", "price", "amount", "minPrice", "maxPrice", "rent", "salePrice"],
    }
  );

  if (!base || !base.title || !base.url || isBadUrlS200(base.url)) return null;

  // price enforcement
  let p = base.price;
  if (isDiscoveryProvider(pk)) p = null;

  if (p == null && !isDiscoveryProvider(pk)) {
    const hint = priceOrNullS200(
      item.price ??
        item.finalPrice ??
        item.optimizedPrice ??
        item.amount ??
        item.minPrice ??
        item.maxPrice ??
        item.rent ??
        item.salePrice ??
        item.raw?.price ??
        item.raw?.finalPrice ??
        item.raw?.optimizedPrice ??
        item.raw?.amount
    );
    if (hint != null) p = hint;
  }

  // images (no fabrication)
  const image =
    item.image ||
    item.thumbnail ||
    item.photo ||
    (Array.isArray(item.images) ? item.images[0] : "") ||
    item.raw?.image ||
    "";

  const imageGallery = Array.isArray(item.images) ? item.images.filter(Boolean).slice(0, 12) : [];

  // rating/reviews (don’t invent)
  const ratingRaw = item.rating ?? item.score ?? item.raw?.rating ?? null;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : null;

  const reviewCountRaw = item.reviewCount ?? item.reviews ?? item.userRatingsTotal ?? item.raw?.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw) ? Math.max(0, Math.floor(reviewCountRaw)) : 0;

  // hard guarantees
  const id = base.id || stableIdS200(pk, base.url, title);
  const currency = normalizeCurrency(base.currency || currencyIn || "TRY");

  return {
    ...base,

    id,
    currency,
    version: "S200",

    price: p,
    finalPrice: p,
    optimizedPrice: p,

    region,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    providerType: "estate",
    vertical: "estate",
    category: "estate",

    rating,
    reviewCount,

    description: asStr(item.description || item.desc || "", 400),
    location,
    city,
    district,
    neighborhood,

    area: area ?? null,
    rooms: rooms || null,
    bathrooms: bathrooms ?? null,
    floor: floor ?? null,
    buildingAge: buildingAge ?? null,

    image: image || null,
    imageGallery,

    originUrl: cOrigin || base.originUrl || base.url,
    finalUrl: cFinal || cDeeplink || cAffiliate || base.finalUrl || base.url,
    deeplink: cDeeplink || base.deeplink || base.url,
    affiliateUrl: cAffiliate || base.affiliateUrl || null,
  };
}

// ----------------------------------------------------------------------------
// WRAP — S200 ESTATE FORMAT (ANA MOTOR UYUMLU)
// ----------------------------------------------------------------------------
function wrapEstateAdapter(providerKey, fn, timeoutMs = 3000, weight = 1.0, tags = []) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);

  return {
    name: pk,
    provider: providerFamily,
    providerKey: pk,
    providerFamily,
    timeoutMs,

    meta: {
      provider: providerFamily,
      providerKey: pk,
      providerFamily,
      providerType: "estate",
      vertical: "estate",
      category: "estate",
      version: "S200",
      regionAffinity: ["TR"],
      commissionPreferred: false,
      weight,
      priority: weight,
      baseUrl: baseUrlFor(pk),
    },

    tags: ["estate", "real_estate", ...tags],

    fn: async (query, options = {}) => {
      const __HARD_CAP_MS = Number(process.env.FINDALLEASY_HARD_CAP_MS || 6200);
      try {
        return await kitWithTimeout(async () => {
        const ts = Date.now();
        const q = String(query || "").trim();

        // ✅ Global ctx set/restore (log drift killer)
        const ctxUrl = baseUrlFor(pk) || "https://www.findalleasy.com/";
        const prev = globalThis.__S200_ADAPTER_CTX;
        globalThis.__S200_ADAPTER_CTX = { adapter: pk, url: ctxUrl };

        try {
          let out;

          // 1) (query, options)
          try {
            out = await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
          } catch (e1) {
            // 2) fallback signature (query, regionString) or (query, cityString)
            const region = (options && typeof options === "object" ? options.region || options.country : null) || "TR";
            const city = (options && typeof options === "object" ? options.city : null) || "";
            out = await kitWithTimeout(Promise.resolve(fn(q, city || region)), timeoutMs, pk);
          }

          const rawItems = coerceItemsS200(out);

          const items = rawItems
            .filter(Boolean)
            .map((x) => normalizeEstateS200(x, pk, q, options))
            .filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

          return {
            ok: true,
            items,
            count: items.length,
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "estate",
              category: "estate",
            },
          };
        } catch (err) {
          console.warn(`❌ Estate adapter error (${pk}):`, err?.message || err);

          // PROD: no fake listings (HARD-LOCK)
          if (!ALLOW_STUBS) {
            return {
              ok: false,
              items: [],
              count: 0,
              error: err?.message || String(err),
              timeout: String(err?.name || "").toLowerCase().includes("timeout"),
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "estate",
                category: "estate",
              },
            };
          }

          // DEV: minimal fallback (no fake price)
          const title = `${providerFamily} emlak servisi şu anda yanıt vermiyor`;
          const url = isDiscoveryProvider(pk)
            ? pk.includes("osm")
              ? osmSearchUrl(q)
              : pk.includes("serpapi")
              ? googleSearchUrl(q)
              : mapsSearchUrl(q)
            : baseUrlFor(pk);

          const one = {
            id: stableIdS200(pk, url, title),
            title,
            url,
            price: null,
            finalPrice: null,
            optimizedPrice: null,
            currency: "TRY",
            provider: providerFamily,
            providerKey: pk,
            providerFamily,
            rating: null,
            reviewCount: 0,
            category: "estate",
            vertical: "estate",
            providerType: "estate",
            location: asStr(options?.city || "", 80),
            city: asStr(options?.city || "", 60),
            district: "",
            neighborhood: "",
            area: null,
            rooms: null,
            bathrooms: null,
            floor: null,
            buildingAge: null,
            version: "S200",
            fallback: true,
            raw: { error: err?.message || String(err) },
          };

          return {
            ok: false,
            items: ALLOW_FALLBACK_NAV ? [one] : [],
            count: ALLOW_FALLBACK_NAV ? 1 : 0,
            error: err?.message || String(err),
            timeout: String(err?.name || "").toLowerCase().includes("timeout"),
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "estate",
              category: "estate",
            },
          };
        } finally {
          globalThis.__S200_ADAPTER_CTX = prev;
        }
    
        }, __HARD_CAP_MS, providerKey);
      } catch (err) {
        const emsg = String(err?.message || err);
        const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(emsg);
        return {
          ok: false,
          items: [],
          count: 0,
          source: providerKey,
          _meta: {
            group: __GROUP_NAME,
            providerKey,
            error: isTimeout ? "TIMEOUT" : "ERROR",
            message: emsg,
          },
        };
      }
},
  };
}

// ----------------------------------------------------------------------------
// SAFE WRAP HELPER (kept) — returns normalized ITEMS array
// ----------------------------------------------------------------------------
async function safeWrap(providerKey, fn, query, opt = {}) {
  try {
    const out = await fn(query, opt);
    const items = coerceItemsS200(out);
    return items.map((x) => normalizeEstateS200(x, providerKey, query, opt)).filter(Boolean);
  } catch (err) {
    console.warn(`[S200::estate::${providerKey}] hata →`, err?.message || err);
    return [];
  }
}

// ============================================================================
// DİNAMİK IMPORTLAR (named exports preferred)
// ============================================================================

// Arama servisleri
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// Sahibinden
const searchSahibinden = await safeImport("../sahibindenAdapter.js", "searchSahibinden");
const searchSahibindenScrape = await safeImport("../sahibindenAdapter.js", "searchSahibindenScrape");
const searchSahibindenAdapter = await safeImport("../sahibindenAdapter.js", "searchSahibindenAdapter");

// Emlakjet
const searchEmlakjet = await safeImport("../emlakjetAdapter.js", "searchEmlakjet");
const searchEmlakjetScrape = await safeImport("../emlakjetAdapter.js", "searchEmlakjetScrape");
const searchEmlakjetAdapter = await safeImport("../emlakjetAdapter.js", "searchEmlakjetAdapter");

// Hepsiemlak
const searchHepsiemlak = await safeImport("../hepsiemlakAdapter.js", "searchHepsiemlak");
const searchHepsiemlakScrape = await safeImport("../hepsiemlakAdapter.js", "searchHepsiemlakScrape");
const searchHepsiemlakAdapter = await safeImport("../hepsiemlakAdapter.js", "searchHepsiemlakAdapter");

// Zingat
const searchZingat = await safeImport("../zingatAdapter.js", "searchZingat");
const searchZingatScrape = await safeImport("../zingatAdapter.js", "searchZingatScrape");
const searchZingatAdapter = await safeImport("../zingatAdapter.js", "searchZingatAdapter");

// Diğer emlak platformları
const searchTuryap = await safeImport("../turyapAdapter.js");
const searchTapuCom = await safeImport("../tapucomAdapter.js");
const searchEndeksa = await safeImport("../endeksaAdapter.js");
const searchRemaxAdapter = await safeImport("../remaxAdapter.js");
const searchColdwellAdapter = await safeImport("../coldwellAdapter.js");

// ============================================================================
// ESTATE ADAPTERS PACK — FINAL (ANA MOTOR FORMATINDA)
// ============================================================================
export const estateAdapters = [
  // discovery/search
  wrapEstateAdapter(
    "googleplaces_estate",
    async (q, o) =>
      searchGooglePlaces(`${String(q || "").trim()} emlak ofis gayrimenkul`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2600,
    0.85,
    ["googleplaces", "office"]
  ),

  wrapEstateAdapter(
    "googleplacesdetails_estate",
    async (q, o) =>
      searchGooglePlacesDetails(String(q || "").trim(), {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2900,
    0.8
  ),

  wrapEstateAdapter(
    "osm_estate",
    async (q, o) => searchWithOpenStreetMap(`${String(q || "").trim()} building office estate satılık kiralık`, o || {}),
    2300,
    0.75
  ),

  wrapEstateAdapter(
    "serpapi_estate",
    async (q, o) => searchWithSerpApi(`${String(q || "").trim()} satılık kiralık konut emlak`, o || {}),
    2000,
    0.9
  ),

  // Sahibinden - 3 model
  wrapEstateAdapter("sahibinden_estate", searchSahibinden, 3500, 1.25, ["sahibinden", "premium"]),
  wrapEstateAdapter("sahibinden_scrape_estate", searchSahibindenScrape, 4000, 1.0, ["sahibinden", "scrape"]),
  wrapEstateAdapter("sahibinden_adapter_estate", searchSahibindenAdapter, 3500, 1.1, ["sahibinden", "api"]),

  // Emlakjet - 3 model
  wrapEstateAdapter("emlakjet_estate", searchEmlakjet, 3200, 1.15, ["emlakjet"]),
  wrapEstateAdapter("emlakjet_scrape_estate", searchEmlakjetScrape, 3800, 1.0, ["emlakjet", "scrape"]),
  wrapEstateAdapter("emlakjet_adapter_estate", searchEmlakjetAdapter, 3500, 1.1, ["emlakjet", "api"]),

  // Hepsiemlak - 3 model
  wrapEstateAdapter("hepsiemlak_estate", searchHepsiemlak, 3300, 1.15, ["hepsiemlak"]),
  wrapEstateAdapter("hepsiemlak_scrape_estate", searchHepsiemlakScrape, 3900, 1.0, ["hepsiemlak", "scrape"]),
  wrapEstateAdapter("hepsiemlak_adapter_estate", searchHepsiemlakAdapter, 3500, 1.15, ["hepsiemlak", "api"]),

  // Zingat - 3 model
  wrapEstateAdapter("zingat_estate", searchZingat, 3100, 1.05, ["zingat"]),
  wrapEstateAdapter("zingat_scrape_estate", searchZingatScrape, 3600, 1.0, ["zingat", "scrape"]),
  wrapEstateAdapter("zingat_adapter_estate", searchZingatAdapter, 3300, 1.1, ["zingat", "api"]),

  // Diğer platformlar
  wrapEstateAdapter("turyap_estate", searchTuryap, 3300, 0.9, ["turyap"]),
  wrapEstateAdapter("tapucom_estate", searchTapuCom, 3400, 1.0, ["tapucom", "official"]),
  wrapEstateAdapter("endeksa_estate", searchEndeksa, 3500, 0.85, ["endeksa", "data"]),
  wrapEstateAdapter("remax_estate", searchRemaxAdapter, 3000, 1.1, ["remax", "international"]),
  wrapEstateAdapter("coldwell_estate", searchColdwellAdapter, 3000, 1.0, ["coldwell", "international"]),
];

// Ana motor için direkt fonksiyon array'i (legacy): items[] döndürür
export const estateAdapterFns = estateAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ============================================================================
// DIREKT ADAPTER FONKSİYONLARI (Eski sistem uyumluluğu için)
// ============================================================================
export async function searchSahibindenEstateAdapter(query, options = {}) {
  const adapter = estateAdapters.find((a) => a.name === "sahibinden_estate");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "sahibinden_estate" };
}

export async function searchEmlakjetEstateAdapter(query, options = {}) {
  const adapter = estateAdapters.find((a) => a.name === "emlakjet_estate");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "emlakjet_estate" };
}

export async function searchHepsiemlakEstateAdapter(query, options = {}) {
  const adapter = estateAdapters.find((a) => a.name === "hepsiemlak_estate");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "hepsiemlak_estate" };
}

// ============================================================================
// TEST
// ============================================================================
export async function testEstateAdapters() {
  console.log("🏠 Estate Adapters Test (S200 kit-bound)\n");
  console.log(`Total adapters: ${estateAdapters.length}`);

  const testQueries = ["satılık daire", "kiralık ofis", "arsa", "villa", "rezidans"];

  for (const query of testQueries) {
    console.log(`\n🔍 Test query: "${query}"`);

    const testAdapters = [
      ...estateAdapters.filter((a) => a.name.includes("sahibinden")).slice(0, 1),
      ...estateAdapters.filter((a) => a.name.includes("emlakjet")).slice(0, 1),
      ...estateAdapters.filter((a) => a.name.includes("google")).slice(0, 1),
    ];

    for (const adapter of testAdapters) {
      try {
        const result = await adapter.fn(query, { region: "TR", city: "İstanbul" });
        const items = Array.isArray(result) ? result : result?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${adapter.name}: ok=${result?.ok !== false} count=${items.length} bad=${bad}`);
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ HATA: ${err?.message || err}`);
      }
    }
  }

  console.log("\n✅ Estate test done");
}

// ============================================================================
// STATS
// ============================================================================
export const estateAdapterStats = {
  totalAdapters: estateAdapters.length,
  categories: {
    search: estateAdapters.filter((a) => a.name.includes("google") || a.name.includes("osm") || a.name.includes("serp")).length,
    platforms: estateAdapters.filter(
      (a) => a.name.includes("sahibinden") || a.name.includes("emlakjet") || a.name.includes("hepsiemlak") || a.name.includes("zingat")
    ).length,
    others: estateAdapters.filter((a) => ["turyap", "tapucom", "endeksa", "remax", "coldwell"].some((p) => a.name.includes(p))).length,
  },
  timeouts: estateAdapters.map((a) => a.timeoutMs),
  providers: estateAdapters.map((a) => a.name),
  totalWeight: estateAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    estateAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, estateAdapters.length)
  ),
  vertical: "estate",
  version: "S200",
};

// ============================================================================
// LEGACY EXPORT
// ============================================================================
export default estateAdapters;
