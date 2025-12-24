// server/adapters/groups/foodAdapters.js
// ============================================================================
// FOOD ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.0.3 (ENGINE COMPATIBLE)
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub)  ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE/RATING)
// - Discovery providers (googleplaces/osm/serpapi): price forced null
//
// FIX (V1.0.3):
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// - ✅ query tek noktada trimlenir (cooldown + normalize tutarlı)
// ============================================================================

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  pickUrlS200,
  fixKey,
  nonEmptyTitleS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// STUB POLICY — HARD LOCK (prod’da asla stub yok)
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// Optional affiliate engine (best-effort, no-crash)
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok
}

// ----------------------------------------------------------------------------
// Provider canonicalization (DRIFT-KILLER)
// ----------------------------------------------------------------------------
const isBadKey = (k) => {
  const s = fixKey(k);
  return !s || s === "unknown" || s === "null" || s === "undefined";
};

const canonicalProviderKey = (raw, fallback = "food") => {
  const fb = fixKey(fallback) || "food";
  const base0 = fixKey(raw || "");
  const base = isBadKey(base0) ? fb : base0;

  // ✅ normalizeProviderKeyS9 "unknown" döndürürse base’i EZME
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(base);
      const nn = fixKey(n);
      if (!isBadKey(nn)) return nn || base;
    }
  } catch {}

  return isBadKey(base) ? fb : base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "food");
  const fam0 = (String(k).split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, fam0) || "food";
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
// Base URLs (relative resolve + safe fallback)
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  // TR markets
  a101: "https://www.a101.com.tr/",
  migros: "https://www.migros.com.tr/",
  carrefour: "https://www.carrefoursa.com/",
  sok: "https://www.sokmarket.com.tr/",
  bim: "https://www.bim.com.tr/",
  metro: "https://www.metro-tr.com/",
  macrocenter: "https://www.macrocenter.com.tr/",
  happycenter: "https://www.happycenter.com.tr/",

  // ecommerce
  trendyol_market: "https://www.trendyol.com/",
  hepsiburada_market: "https://www.hepsiburada.com/",

  // discovery/search
  googleshopping_food: "https://www.google.com/shopping",
  googleplaces_food: "https://www.google.com/maps",
  osm_food: "https://www.openstreetmap.org/",
  serpapi_food: "https://www.google.com/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "food");
  const fam = providerFamilyFromKey(pk);

  // known map
  const direct = BASE_URL_MAP[pk] || BASE_URL_MAP[fam];
  if (direct) return direct;

  // ✅ unknown provider: fake domain yok; relative resolve için gerçek bir root
  if (fam === "googleplaces") return "https://www.google.com/maps/";
  if (fam === "osm") return "https://www.openstreetmap.org/";
  if (fam === "serpapi") return "https://www.google.com/";
  return "https://www.google.com/";
};

// query-aware fallbacks for discovery
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
// URL normalizer (absolute-enforced)
// ----------------------------------------------------------------------------
function normalizeUrlFood(candidate, baseUrl) {
  const c = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();
  if (!c) return "";

  // let kit resolve absolute, //, /relative
  let u = normalizeUrlS200(c, b);

  // handle "relative without leading /" (e.g. "urun/123")
  if (u && !/^https?:\/\//i.test(u)) {
    const bb = b ? b.replace(/\/+$/g, "") : "";
    const cc = c.replace(/^\/+/g, "");
    if (bb && cc) u = `${bb}/${cc}`;
  }

  // enforce absolute
  if (!u || !/^https?:\/\//i.test(u)) return "";
  return u;
}

function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

// ----------------------------------------------------------------------------
// SAFE IMPORT (kit-based) — caller-relative, optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "food");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: NO fake price/rating
    return async (query, options = {}) => {
      const q = String(query || "").trim();
      const title = nonEmptyTitleS200(q, `${providerFamily} gıda sonucu`);
      const region = String(options?.region || "TR").toUpperCase().trim();
      const url = isDiscoveryProvider(pk)
        ? pk.includes("osm")
          ? osmSearchUrl(q)
          : pk.includes("serpapi")
          ? googleSearchUrl(q)
          : mapsSearchUrl(q)
        : baseUrl;

      const abs = normalizeUrlFood(url, baseUrl) || "https://www.google.com/";

      return [
        {
          id: stableIdS200(pk, abs, title),
          title,
          url: abs,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          region,
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          vertical: "food",
          category: "food",
          providerType: "food",
          version: "S200",
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },
});

async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ Food safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------------------------------------------------------
// Affiliate URL safe wrapper (no-crash, signature tolerant)
// ----------------------------------------------------------------------------
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = String(url || "").trim();
  if (!u || isBadUrlS200(u)) return "";
  if (typeof _buildAffiliateUrl !== "function") return "";

  try {
    const r = _buildAffiliateUrl(providerKey, u, extra);
    const s = String(r || "").trim();
    if (s && !isBadUrlS200(s)) return s;
  } catch {}

  try {
    const r2 = _buildAffiliateUrl(u, extra);
    const s2 = String(r2 || "").trim();
    if (s2 && !isBadUrlS200(s2)) return s2;
  } catch {}

  try {
    const r3 = _buildAffiliateUrl(u);
    const s3 = String(r3 || "").trim();
    if (s3 && !isBadUrlS200(s3)) return s3;
  } catch {}

  return "";
}

// ----------------------------------------------------------------------------
// Food item normalizer (S200 contract + food rules)
// ----------------------------------------------------------------------------
function normalizeFoodItemS200(item, providerKey, queryForFallback = "", options = {}, foodType = "grocery") {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  // title
  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.label ?? item.productName ?? item.raw?.title ?? item.raw?.name,
    `${providerFamily} gıda sonucu`
  );
  if (!title) return null;

  // URL candidates (priority) -> normalize all -> pick best (absolute only)
  // ✅ drift fallback: pickUrlS200 (kit) + raw
  const picked = (() => {
    try {
      return (
        pickUrlS200(item) ||
        pickUrlS200(item?.raw) ||
        item?.url ||
        item?.link ||
        item?.href ||
        item?.website ||
        ""
      );
    } catch {
      return item?.url || item?.link || item?.href || item?.website || "";
    }
  })();

  const cAffiliate = normalizeUrlFood(item.affiliateUrl ?? item.raw?.affiliateUrl ?? "", baseUrl);
  const cDeeplink = normalizeUrlFood(item.deeplink ?? item.deepLink ?? item.raw?.deeplink ?? item.raw?.deepLink ?? "", baseUrl);
  const cFinal = normalizeUrlFood(item.finalUrl ?? item.raw?.finalUrl ?? "", baseUrl);
  const cOrigin = normalizeUrlFood(item.originUrl ?? item.raw?.originUrl ?? item.url ?? item.link ?? item.href ?? "", baseUrl);
  let cUrl = normalizeUrlFood(item.url ?? item.link ?? item.href ?? item.website ?? item.raw?.url ?? picked ?? "", baseUrl);

  // Discovery fallback search urls if nothing valid
  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl && isDiscoveryProvider(pk)) {
    cUrl = pk.includes("osm")
      ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi")
      ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);
    cUrl = normalizeUrlFood(cUrl, baseUrl);
  }

  const clickUrl = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;

  // strict: require real candidate for non-discovery providers
  if (!clickUrl) return null;

  // Currency normalize
  const currencyIn = normalizeCurrency(item.currency ?? item.raw?.currency ?? "TRY");

  // Let kit normalize core contract (title+url, price parsing)
  const base = normalizeItemS200(
    {
      ...item,
      title,
      currency: currencyIn,
      url: clickUrl,
      originUrl: cOrigin || clickUrl,
      finalUrl: cFinal || cDeeplink || cAffiliate || clickUrl,
      deeplink: cDeeplink || null,
      affiliateUrl: cAffiliate || null,
    },
    pk,
    {
      vertical: "food",
      category: "food",
      providerFamily,
      baseUrl,
      fallbackUrl: isDiscoveryProvider(pk) ? baseUrl : "",
      region: options?.region || item.region || "TR",
      requireRealUrlCandidate: !isDiscoveryProvider(pk),
      titleFallback: `${providerFamily} gıda sonucu`,
      priceKeys: ["finalPrice", "optimizedPrice", "price", "amount", "minPrice", "maxPrice", "totalPrice"],
    }
  );

  if (!base || !base.title || !base.url || isBadUrlS200(base.url)) return null;

  // price enforcement: discovery providers must not carry prices
  let price = base.price;

  if (isDiscoveryProvider(pk)) {
    price = null;
  } else {
    if (price == null) {
      const hint = priceOrNullS200(
        item.price ??
          item.finalPrice ??
          item.optimizedPrice ??
          item.amount ??
          item.raw?.price ??
          item.raw?.finalPrice ??
          item.raw?.optimizedPrice
      );
      if (hint != null) price = hint;
    }
  }

  // affiliate inject (best-effort, discovery OFF)
  let affiliateUrl = cAffiliate || base.affiliateUrl || null;
  if (!isDiscoveryProvider(pk) && !affiliateUrl && base.url && !isBadUrlS200(base.url)) {
    const built = buildAffiliateUrlSafe(pk, base.url, { query: String(queryForFallback || "").trim() });
    const aff = built ? normalizeUrlFood(built, baseUrl) : "";
    if (aff && !isBadUrlS200(aff)) affiliateUrl = aff;
  }

  const reviewCountRaw = item.reviewCount ?? item.reviews ?? item.raw?.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw) ? Math.max(0, Math.floor(reviewCountRaw)) : 0;

  const ratingRaw = item.rating ?? item.score ?? item.raw?.rating ?? null;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : null;

  // hard guarantees
  const id = base.id || stableIdS200(pk, base.url, title);
  const currency = normalizeCurrency(base.currency || currencyIn || "TRY");

  return {
    ...base,
    id,
    currency,

    // overwrite prices consistently
    price,
    finalPrice: price,
    optimizedPrice: price,

    // stable provider meta (S200 canon)
    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    // food typing
    foodType: String(foodType || "grocery"),
    providerType: "food",
    version: "S200",
    vertical: "food",
    category: "food",

    rating,
    reviewCount,

    // keep normalized variants (already absolute)
    originUrl: cOrigin || base.originUrl || base.url,
    finalUrl: cFinal || cDeeplink || affiliateUrl || base.finalUrl || base.url,
    deeplink: cDeeplink || base.deeplink || base.url,
    affiliateUrl,
  };
}

// ----------------------------------------------------------------------------
// WRAP — engine format + S200 wrapper output object
// ----------------------------------------------------------------------------
function wrapFoodAdapter(providerKey, fn, timeoutMs = 3000, foodType = "grocery", weight = 1.0) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk) || "https://www.google.com/";
  const group = "food";

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
      providerType: "food",
      vertical: "food",
      category: "food",
      version: "S200",
      weight,
      baseUrl,
      foodType,
      regionAffinity: ["TR"],
    },

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = String(query || "").trim();

      // ✅ GLOBAL CTX set/restore — coerce/kit loglarında [S200][unknown] düşmesin
      const prev = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = { adapter: pk, url: baseUrl };

      try {
        try {
          // ✅ COOLDOWN WRAP (istenen nokta: fn(query, ctx/options) çağrısı)
          const out = await runWithCooldownS200(
            pk,
            async () => {
              // 1) (query, options)
              try {
                return await kitWithTimeout(() => fn(q, options), timeoutMs, pk);
              } catch (e1) {
                // 2) (query, regionString)
                const region = (options && typeof options === "object" ? options.region || options.country : null) || "TR";
                return await kitWithTimeout(() => fn(q, region), timeoutMs, pk);
              }
            },
            { group, query: q, providerKey: pk, timeoutMs }
          );

          const rawItems = coerceItemsS200(out);

          const items = rawItems
            .filter(Boolean)
            .map((i) => normalizeFoodItemS200(i, pk, q, options, foodType))
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
              vertical: "food",
              category: "food",
              foodType,
            },
          };
        } catch (err) {
          console.warn(`❌ ${pk} food adapter error:`, err?.message || err);

          // PROD: no fake cards
          if (!ALLOW_STUBS) {
            return {
              ok: false,
              items: [],
              count: 0,
              error: err?.message || String(err),
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "food",
                category: "food",
                foodType,
              },
            };
          }

          // DEV: minimal single fallback (S200, no fake price/rating)
          const title = `${providerFamily} gıda servisi şu anda yanıt vermiyor`;
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
            url: normalizeUrlFood(url, baseUrl) || "https://www.google.com/",
            price: null,
            finalPrice: null,
            optimizedPrice: null,
            currency: "TRY",
            provider: providerFamily,
            providerKey: pk,
            providerFamily,
            rating: null,
            reviewCount: 0,
            vertical: "food",
            category: "food",
            providerType: "food",
            version: "S200",
            foodType,
            fallback: true,
            raw: { error: err?.message || String(err) },
          };

          return {
            ok: false,
            items: [one],
            count: 1,
            error: err?.message || String(err),
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "food",
              category: "food",
              foodType,
            },
          };
        }
      } finally {
        globalThis.__S200_ADAPTER_CTX = prev;
      }
    },
  };
}

// ----------------------------------------------------------------------------
// DYNAMIC IMPORTS (named exports preferred where applicable)
// ----------------------------------------------------------------------------
// Markets
const searchA101 = await safeImport("../a101Adapter.js");
const searchMigros = await safeImport("../migrosAdapter.js");
const searchCarrefour = await safeImport("../carrefourAdapter.js");
const searchSok = await safeImport("../sokAdapter.js");
const searchBim = await safeImport("../bimAdapter.js");
const searchMetro = await safeImport("../metroAdapter.js");
const searchMacroCenter = await safeImport("../macrocenterAdapter.js");
const searchHappyCenter = await safeImport("../happycenterAdapter.js");

// E-commerce
const searchTrendyolAdapter = await safeImport("../trendyolAdapter.js", "searchTrendyolAdapter");
const searchHepsiburadaAdapter = await safeImport("../hepsiburadaAdapter.js", "searchHepsiburadaAdapter");

// Search services
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");
const searchGoogleShopping = await safeImport("../googleShopping.js", "searchGoogleShopping");
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");

// ----------------------------------------------------------------------------
// FOOD ADAPTERS PACK — FINAL
// ----------------------------------------------------------------------------
export const foodAdapters = [
  // Markets
  wrapFoodAdapter("a101", searchA101, 3000, "grocery", 1.2),
  wrapFoodAdapter("migros", searchMigros, 3000, "grocery", 1.3),
  wrapFoodAdapter("carrefour", searchCarrefour, 3000, "grocery", 1.25),
  wrapFoodAdapter("sok", searchSok, 3000, "grocery", 1.05),
  wrapFoodAdapter("bim", searchBim, 3000, "grocery", 1.0),
  wrapFoodAdapter("metro", searchMetro, 3000, "grocery", 0.95),
  wrapFoodAdapter("macrocenter", searchMacroCenter, 3000, "grocery", 0.95),
  wrapFoodAdapter("happycenter", searchHappyCenter, 3000, "grocery", 0.9),

  // E-commerce markets (query boost)
  wrapFoodAdapter(
    "trendyol_market",
    async (q, o) => searchTrendyolAdapter(`${String(q || "").trim()} market gıda`, o),
    3000,
    "grocery",
    1.15
  ),

  wrapFoodAdapter(
    "hepsiburada_market",
    async (q, o) => searchHepsiburadaAdapter(`${String(q || "").trim()} market gıda`, o),
    3000,
    "grocery",
    1.15
  ),

  // Discovery/search providers (price rules: googleplaces/osm/serpapi => null)
  wrapFoodAdapter(
    "serpapi_food",
    async (q, o) => searchWithSerpApi(`${String(q || "").trim()} grocery supermarket food`, o),
    2000,
    "discovery",
    0.7
  ),

  // GoogleShopping = “shopping” (price taşıyabilir)
  wrapFoodAdapter(
    "googleshopping_food",
    async (q, o) => searchGoogleShopping(`${String(q || "").trim()} food grocery`, o),
    2500,
    "shopping",
    0.8
  ),

  wrapFoodAdapter(
    "googleplaces_food",
    async (q, o) =>
      searchGooglePlaces(`${String(q || "").trim()} supermarket grocery`, { ...(o || {}), region: o?.region || "TR" }),
    2600,
    "discovery",
    0.7
  ),

  wrapFoodAdapter(
    "osm_food",
    async (q, o) => searchWithOpenStreetMap(`${String(q || "").trim()} supermarket grocery market`, o || {}),
    2600,
    "discovery",
    0.6
  ),
];

// ----------------------------------------------------------------------------
// Legacy compatibility: return ITEMS array (old engine paths)
// ----------------------------------------------------------------------------
export const foodAdapterFns = foodAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ----------------------------------------------------------------------------
// Direct legacy exports (keep names)
// ----------------------------------------------------------------------------
export async function searchA101Adapter(query, options = {}) {
  const a = foodAdapters.find((x) => x.name === "a101");
  return a ? await a.fn(query, options) : { ok: false, items: [], count: 0, source: "a101" };
}

export async function searchMigrosAdapter(query, options = {}) {
  const a = foodAdapters.find((x) => x.name === "migros");
  return a ? await a.fn(query, options) : { ok: false, items: [], count: 0, source: "migros" };
}

export async function searchTrendyolMarketAdapter(query, options = {}) {
  const a = foodAdapters.find((x) => x.name === "trendyol_market");
  return a ? await a.fn(query, options) : { ok: false, items: [], count: 0, source: "trendyol_market" };
}

// ----------------------------------------------------------------------------
// Stats
// ----------------------------------------------------------------------------
export const foodAdapterStats = {
  totalAdapters: foodAdapters.length,
  providers: foodAdapters.map((a) => a.name),
  totalWeight: foodAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    foodAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, foodAdapters.length)
  ),
  vertical: "food",
  version: "S200",
};

// ----------------------------------------------------------------------------
// Test (fn returns object)
// ----------------------------------------------------------------------------
export async function testFoodAdapters() {
  console.log("🧪 Food Adapters Test (S200 kit-bound)\n");
  console.log(`Total adapters: ${foodAdapters.length}`);

  const testQueries = ["süt", "ekmek", "yumurta", "meyve", "su"];

  for (const q of testQueries) {
    console.log(`\n🔍 Query: "${q}"`);
    for (const adapter of foodAdapters.slice(0, 4)) {
      try {
        const out = await adapter.fn(q, { region: "TR" });
        const items = Array.isArray(out) ? out : out?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${adapter.name}: ok=${out?.ok !== false} count=${items.length} bad=${bad}`);
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ ${err?.message || err}`);
      }
    }
  }

  console.log("\n✅ Food test done");
}

export default foodAdapters;
