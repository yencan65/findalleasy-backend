// server/adapters/groups/educationAdapters.js
// ============================================================================
// EDUCATION ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.0 (ENGINE COMPATIBLE)
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub, no fake course) ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE)
// - Discovery providers (google/osm/serp): price forced null
// ============================================================================

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200, // ✅ ADDED
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  nonEmptyTitleS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") {
    normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
  }
} catch {
  // ok
}

const fix = (v) => String(v || "").toLowerCase().trim();

const canonicalProviderKey = (raw, fallback = "education") => {
  const base = fix(raw || fallback);
  if (!base || base === "unknown" || base === "unknown_adapter" || base === "na" || base === "n/a") {
    return fix(fallback) || "education";
  }

  // Preserve suffix to avoid collisions (googleplaces_education vs googleplaces_craft, etc.)
  const parts = base.split("_").filter(Boolean);
  const fam = parts[0] || base;
  const suffix = parts.slice(1).join("_");

  let famNorm = fam;

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = fix(normalizeProviderKeyS9(fam));
      if (n && n !== "unknown" && n !== "unknown_adapter" && n !== "na" && n !== "n/a") famNorm = n;
    }
  } catch {}

  const key = suffix ? `${famNorm}_${suffix}` : famNorm;
  return key && key !== "unknown" ? key : (fix(fallback) || "education");
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "education");
  const fam0 = (k.split("_")[0] || k).trim();
  // keep canonical like other groups
  return canonicalProviderKey(fam0, fam0) || "education";
};

// ----------------------------------------------------------------------------
// Provider family resolver (S200) — keep legacy mapping but canonical
// ----------------------------------------------------------------------------
function resolveProviderFamily(provider) {
  const p = canonicalProviderKey(provider, "education");
  if (p.includes("googleplaces")) return "googleplaces";
  if (p.includes("serpapi")) return "serpapi";
  if (p.includes("udemy")) return "udemy";
  if (p.includes("osm")) return "osm";
  return providerFamilyFromKey(p);
}

function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

// ----------------------------------------------------------------------------
// Base URLs + query-aware fallbacks (discovery)
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  googleplaces_education: "https://www.google.com/maps",
  googleplacesdetails_education: "https://www.google.com/maps",
  osm_education: "https://www.openstreetmap.org/",
  serpapi_education: "https://www.google.com/",
  udemy_courses: "https://www.udemy.com/",
  udemy: "https://www.udemy.com/",
  education: "https://www.findalleasy.com/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "education");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

const mapsSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}`
    : "https://www.google.com/maps";
};
const osmSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t
    ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(t)}`
    : "https://www.openstreetmap.org/";
};
const googleSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : "https://www.google.com/";
};

// ----------------------------------------------------------------------------
// Currency normalize (TL/₺ -> TRY)
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
function normalizeUrlEdu(candidate, baseUrl) {
  const c = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();
  if (!c) return "";

  let u = normalizeUrlS200(c, b);

  // handle "relative without leading /"
  if (u && !/^https?:\/\//i.test(u)) {
    const bb = b ? b.replace(/\/+$/g, "") : "";
    const cc = c.replace(/^\/+/g, "");
    if (bb && cc) u = `${bb}/${cc}`;
  }

  if (!u || !/^https?:\/\//i.test(u)) return "";
  if (isBadUrlS200(u)) return "";
  return u;
}

// ----------------------------------------------------------------------------
// Safe import (kit-based) — caller-relative + optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS), // ✅ HARD-LOCK: prod'da asla stub
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "education");
    const providerFamily = resolveProviderFamily(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: NO fake price, only navigable card
    return async (query, options = {}) => {
      const region = String(options?.region || (providerFamily === "udemy" ? "GLOBAL" : "TR"))
        .toUpperCase()
        .trim();

      const title = nonEmptyTitleS200(
        `${String(query || "").trim() || "kurs"} - ${providerFamily}`,
        `${providerFamily} eğitim kartı`
      );

      const url = normalizeUrlEdu(baseUrl, baseUrl) || "https://www.findalleasy.com/";

      return [
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: region === "GLOBAL" ? "USD" : "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          category: "education",
          vertical: "education",
          providerType: "education",
          region,
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
    console.warn(`⚠️ Education safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ============================================================================
// NORMALIZER — S200 EDUCATION ITEM (contract lock + edu fields)
// ============================================================================
function normalizeEducationS200(item, providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = resolveProviderFamily(pk);
  const baseUrl = baseUrlFor(pk);

  const title = nonEmptyTitleS200(
    item.title || item.name || item.courseName || item.programName || item.label || item.raw?.title || item.raw?.name || "",
    `${String(queryForFallback || "").trim() || "kurs"} - ${providerFamily}`
  );
  if (!title) return null;

  const pickedUrl =
    item.affiliateUrl ||
    item.deeplink ||
    item.deepLink ||
    item.finalUrl ||
    item.originUrl ||
    item.url ||
    item.link ||
    item.href ||
    item.website ||
    item.raw?.url ||
    "";

  const cAffiliate = normalizeUrlEdu(item.affiliateUrl || item.raw?.affiliateUrl || "", baseUrl);
  const cDeeplink = normalizeUrlEdu(item.deeplink || item.deepLink || item.raw?.deeplink || item.raw?.deepLink || "", baseUrl);
  const cFinal = normalizeUrlEdu(item.finalUrl || item.raw?.finalUrl || "", baseUrl);
  const cOrigin = normalizeUrlEdu(item.originUrl || item.raw?.originUrl || "", baseUrl);
  let cUrl = normalizeUrlEdu(pickedUrl, baseUrl);

  // discovery fallback (search url)
  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl && isDiscoveryProvider(pk)) {
    cUrl =
      pk.includes("osm") ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi") ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);

    cUrl = normalizeUrlEdu(cUrl, baseUrl);
  }

  const url = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;
  if (!url) return null;

  // region: udemy => GLOBAL by default
  const region =
    String(options?.region || item.region || (providerFamily === "udemy" ? "GLOBAL" : "TR"))
      .toUpperCase()
      .trim();

  const currency = normalizeCurrency(item.currency || item.raw?.currency || (region === "GLOBAL" ? "USD" : "TRY"));

  // price: discovery providers must not have price
  let price = null;
  if (!isDiscoveryProvider(pk)) {
    price = priceOrNullS200(
      item.price ??
        item.finalPrice ??
        item.optimizedPrice ??
        item.amount ??
        item.raw?.price ??
        item.raw?.finalPrice ??
        item.raw?.optimizedPrice
    );
  }

  const base = normalizeItemS200(
    {
      ...item,
      title,
      url,
      originUrl: cOrigin || url,
      finalUrl: cFinal || cDeeplink || cAffiliate || url,
      deeplink: cDeeplink || null,
      affiliateUrl: cAffiliate || null,
      currency,
      region,
      price,
      finalPrice: price,
      optimizedPrice: price,
    },
    pk,
    {
      vertical: "education",
      category: "education",
      providerFamily,
      baseUrl,
      fallbackUrl: isDiscoveryProvider(pk) ? baseUrl : "",
      requireRealUrlCandidate: !isDiscoveryProvider(pk),
      titleFallback: `${String(queryForFallback || "").trim() || "kurs"} - ${providerFamily}`,
      priceKeys: ["optimizedPrice", "finalPrice", "price", "amount"],
    }
  );

  if (!base || !base.title || !base.url || isBadUrlS200(base.url)) return null;

  // rating/reviews (do not invent)
  const ratingRaw = item.rating ?? item.score ?? item.raw?.rating ?? null;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
      ? Math.max(0, Math.min(5, ratingRaw))
      : null;

  const reviewCountRaw =
    item.reviewCount ?? item.reviews ?? item.userRatingsTotal ?? item.raw?.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw)
      ? Math.max(0, Math.floor(reviewCountRaw))
      : 0;

  const features = Array.isArray(item.features)
    ? item.features
    : Array.isArray(item.tags)
    ? item.tags
    : item.features
    ? [String(item.features)]
    : item.tags
    ? [String(item.tags)]
    : [];

  const image =
    item.image ||
    item.thumbnail ||
    item.cover ||
    (Array.isArray(item.images) ? item.images[0] : null) ||
    item.raw?.image ||
    null;

  const imageGallery = Array.isArray(item.images)
    ? item.images.filter(Boolean).slice(0, 12)
    : [];

  // hard guarantees
  const id = base.id || stableIdS200(pk, base.url, title);

  const safePrice = isDiscoveryProvider(pk) ? null : (base.price ?? null);
  const p = isDiscoveryProvider(pk) ? null : priceOrNullS200(safePrice);

  return {
    ...base,

    id,
    currency: normalizeCurrency(base.currency || currency || "TRY"),
    version: "S200",

    price: p,
    finalPrice: p,
    optimizedPrice: p,

    region,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    providerType: "education",
    vertical: "education",
    category: "education",
    categoryAI: "education",

    rating,
    reviewCount,

    description: String(item.description || item.raw?.description || "").trim(),
    instructor: String(item.instructor || item.raw?.instructor || "").trim(),
    school: String(item.school || item.organization || item.raw?.school || item.raw?.organization || "").trim(),
    duration: String(item.duration || item.raw?.duration || "").trim(),
    level: String(item.level || item.raw?.level || "").trim(),
    features: Array.isArray(features) ? features.slice(0, 20) : [],

    image,
    imageGallery,

    originUrl: cOrigin || base.originUrl || base.url,
    finalUrl: cFinal || cDeeplink || cAffiliate || base.finalUrl || base.url,
    deeplink: cDeeplink || base.deeplink || base.url,
    affiliateUrl: cAffiliate || base.affiliateUrl || null,

    adapterSource: item.adapterSource || pk,
  };
}

// ============================================================================
// WRAP — S200 ANA MOTOR UYUMLU
// ============================================================================
function wrapEducationAdapter(providerKey, fn, timeoutMs = 3000, weight = 1.0, tags = []) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = resolveProviderFamily(pk);

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
      providerType: "education",
      vertical: "education",
      category: "education",
      version: "S200",
      commissionPreferred: false,
      regionAffinity: ["TR", "GLOBAL"],
      weight,
      priority: weight,
      baseUrl: baseUrlFor(pk),
    },

    tags: ["education", "course", ...tags],

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = String(query || "").trim();

      try {
        // ✅ COOLDOWN WRAP (mevcut akış içeride aynen duruyor)
        const out = await runWithCooldownS200(
          pk,
          async () => {
            // 1) (query, options)
            try {
              return await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
            } catch (e1) {
              // 2) fallback signature (query, regionString)
              const region =
                (options && typeof options === "object" ? options.region || options.country : null) ||
                (providerFamily === "udemy" ? "GLOBAL" : "TR");
              return await kitWithTimeout(Promise.resolve(fn(q, region)), timeoutMs, pk);
            }
          },
          { group: "education", query: q, providerKey: pk, timeoutMs }
        );

        const rawItems = coerceItemsS200(out);

        const items = rawItems
          .filter(Boolean)
          .map((x) => normalizeEducationS200(x, pk, q, options))
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
            vertical: "education",
            category: "education",
          },
        };
      } catch (err) {
        console.warn(`❌ Education adapter error (${pk}):`, err?.message || err);

        // PROD: no fake courses (HARD-LOCK)
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
              vertical: "education",
              category: "education",
            },
          };
        }

        // DEV: minimal fallback card (NO fake price)
        const title = `${providerFamily} eğitim servisi şu anda yanıt vermiyor`;
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
          currency: providerFamily === "udemy" ? "USD" : "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          category: "education",
          vertical: "education",
          providerType: "education",
          region: providerFamily === "udemy" ? "GLOBAL" : "TR",
          version: "S200",
          fallback: true,
          raw: { error: err?.message || String(err) },
        };

        return {
          ok: false,
          items: [one],
          count: 1,
          error: err?.message || String(err),
          timeout: String(err?.name || "").toLowerCase().includes("timeout"),
          source: pk,
          _meta: {
            adapter: pk,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "education",
            category: "education",
          },
        };
      }
    },
  };
}

// ============================================================================
// DİNAMİK IMPORTLAR (named exports preferred)
// ============================================================================
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

const searchUdemy = await safeImport("../udemyAdapter.js", "searchUdemy");

// ============================================================================
// EDUCATION ADAPTERS PACK — FINAL (ANA MOTOR FORMATINDA)
// ============================================================================
export const educationAdapters = [
  wrapEducationAdapter(
    "googleplaces_education",
    async (q, o) =>
      searchGooglePlaces(`${String(q || "").trim()} kurs eğitim ders okul`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2600,
    1.12,
    ["lokasyon", "fiziksel"]
  ),

  wrapEducationAdapter(
    "googleplacesdetails_education",
    async (q, o) =>
      searchGooglePlacesDetails(String(q || "").trim(), {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2800,
    0.97,
    ["details"]
  ),

  wrapEducationAdapter(
    "osm_education",
    async (q, o) =>
      searchWithOpenStreetMap(`${String(q || "").trim()} kurs eğitim driving school`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    3500,
    0.86,
    ["osm", "school"]
  ),

  wrapEducationAdapter(
    "serpapi_education",
    async (q, o) =>
      searchWithSerpApi(`${String(q || "").trim()} course bootcamp eğitim`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2000,
    1.08,
    ["online", "serpapi"]
  ),

  wrapEducationAdapter(
    "udemy_courses",
    async (q, o) => {
      const region = String(o?.region || "GLOBAL").toUpperCase();
      return searchUdemy(q, region);
    },
    3000,
    1.25,
    ["online_course", "bootcamp", "global"]
  ),
];

export const educationAdapterFns = educationAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ============================================================================
// TEST
// ============================================================================
export async function testEducationAdapters() {
  console.log("🎓 Education Adapters Test (S200 kit-bound)\n");
  console.log(`Total adapters: ${educationAdapters.length}`);

  const testQueries = ["ingilizce kursu", "yazılım bootcamp", "sürücü kursu", "gitar dersi", "dijital pazarlama"];

  for (const query of testQueries) {
    console.log(`\n🔍 Test query: "${query}"`);

    for (const adapter of educationAdapters.slice(0, 3)) {
      try {
        const result = await adapter.fn(query, { region: "TR" });
        const items = Array.isArray(result) ? result : result?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${adapter.name}: ok=${result?.ok !== false} count=${items.length} bad=${bad}`);
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ HATA: ${err?.message || err}`);
      }
    }
  }

  console.log("\n✅ Education test done");
}

// ============================================================================
// STATS
// ============================================================================
export const educationAdapterStats = {
  totalAdapters: educationAdapters.length,
  categories: {
    search: educationAdapters.filter((a) => a.name.includes("google") || a.name.includes("osm") || a.name.includes("serp")).length,
    platforms: educationAdapters.filter((a) => a.name.includes("udemy")).length,
  },
  timeouts: educationAdapters.map((a) => a.timeoutMs),
  providers: educationAdapters.map((a) => a.name),
  totalWeight: educationAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    educationAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, educationAdapters.length)
  ),
  vertical: "education",
  version: "S200",
};

// ============================================================================
// LEGACY EXPORT
// ============================================================================
export default educationAdapters;
