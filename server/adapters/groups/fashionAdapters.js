// server/adapters/groups/fashionAdapters.js
// ============================================================================
// FASHION ADAPTER GROUP — S200 KIT-BOUND FINAL PATCHED V1.0.2 (ENGINE COMPATIBLE)
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub) ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE/RATING)
// - Discovery providers (googleplaces/osm/serpapi): price forced null
//
// PATCH:
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// - ✅ DRIFT-KILLER: providerMasterS9 "unknown/null/undefined" döndürürse base providerKey EZİLMEZ
// - ✅ query tek noktada trimlenir (cooldown + normalize tutarlı)
// ============================================================================

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;
const ALLOW_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "1") === "1";

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200,
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

// ----------------------------------------------------------------------------
// Currency fix (TL/₺ -> TRY)
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
// Provider canonicalization (DRIFT-KILLER)
// ----------------------------------------------------------------------------
const fix = (v) => String(v || "").toLowerCase().trim();
const isBadKey = (k) => {
  const x = fix(k);
  return !x || x === "unknown" || x === "null" || x === "undefined";
};

const canonicalProviderKey = (raw, fallback = "fashion") => {
  const fb = fix(fallback || "fashion") || "fashion";
  const base0 = fix(raw || "");
  const start = isBadKey(base0) ? fb : base0;

  // ✅ S9 varsa dene ama "unknown/null/undefined" ile asla ezme
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const nRaw = normalizeProviderKeyS9(start);
      const n = fix(nRaw);
      if (!isBadKey(n)) return n;
    }
  } catch {}

  return isBadKey(start) ? fb : start;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "fashion");
  const fam0 = (k.split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, "fashion") || "fashion";
};

// S200 SPEC: resolveProviderFamily kept (alias)
function resolveProviderFamily(provider) {
  const pk = canonicalProviderKey(provider, "fashion");
  return providerFamilyFromKey(pk);
}

// ----------------------------------------------------------------------------
// Base URLs (relative resolve + safe fallback)
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  trendyol_fashion: "https://www.trendyol.com/",
  hepsiburada_fashion: "https://www.hepsiburada.com/",

  lcw: "https://www.lcwaikiki.com/",
  defacto: "https://www.defacto.com.tr/",
  koton: "https://www.koton.com/",
  boyner: "https://www.boyner.com.tr/",
  mavi: "https://www.mavi.com/",
  flo: "https://www.flo.com.tr/",

  googleshopping_fashion: "https://www.google.com/shopping",
  googleplaces_fashion: "https://www.google.com/maps",
  osm_fashion: "https://www.openstreetmap.org/",
  serpapi_fashion: "https://www.google.com/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "fashion");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

// query-aware fallbacks (discovery)
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

function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

// ----------------------------------------------------------------------------
// URL normalizer (absolute-enforced + handles "relative without leading /")
// ----------------------------------------------------------------------------
function normalizeUrlFashion(candidate, baseUrl) {
  const c = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();
  if (!c) return "";

  let u = normalizeUrlS200(c, b);

  if (u && !/^https?:\/\//i.test(u)) {
    const bb = b ? b.replace(/\/+$/g, "") : "";
    const cc = c.replace(/^\/+/g, "");
    if (bb && cc) u = `${bb}/${cc}`;
  }

  if (!u || !/^https?:\/\//i.test(u)) return "";
  return u;
}

// ----------------------------------------------------------------------------
// SAFE IMPORT (kit-based) — caller-relative, optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "fashion");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    return async (query) => {
      const q = String(query || "").trim();
      const title = nonEmptyTitleS200(q, `${providerFamily} moda sonucu`);
      const url = normalizeUrlFashion(baseUrl, baseUrl) || "https://www.findalleasy.com/";

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
          vertical: "fashion",
          category: "fashion",
          providerType: "fashion",
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
    console.warn(`⚠️ Fashion safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------------------------------------------------------
// NORMALIZER — S200 FASHION OBJECT (kept name)
// ----------------------------------------------------------------------------
function normalizeFashionS200(item, providerKey, vertical = "fashion", queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.label ?? item.productName ?? item.raw?.title ?? item.raw?.name,
    `${providerFamily} moda sonucu`
  );
  if (!title) return null;

  // URL candidates (priority) -> absolute
  const cAffiliate = normalizeUrlFashion(item.affiliateUrl ?? item.raw?.affiliateUrl ?? "", baseUrl);
  const cDeeplink = normalizeUrlFashion(item.deeplink ?? item.deepLink ?? item.raw?.deeplink ?? item.raw?.deepLink ?? "", baseUrl);
  const cFinal = normalizeUrlFashion(item.finalUrl ?? item.raw?.finalUrl ?? "", baseUrl);
  const cOrigin = normalizeUrlFashion(item.originUrl ?? item.raw?.originUrl ?? item.url ?? item.link ?? item.href ?? "", baseUrl);
  let cUrl = normalizeUrlFashion(item.url ?? item.link ?? item.href ?? item.website ?? item.raw?.url ?? "", baseUrl);

  // discovery fallback if needed
  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl && isDiscoveryProvider(pk)) {
    cUrl = pk.includes("osm")
      ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi")
      ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);
    cUrl = normalizeUrlFashion(cUrl, baseUrl);
  }

  const clickUrl = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;
  if (!clickUrl) return null;

  // pre-normalize currency
  const currencyIn = normalizeCurrency(item.currency ?? item.raw?.currency ?? "TRY");

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
      vertical: "fashion",
      category: "fashion",
      providerFamily,
      baseUrl,
      fallbackUrl: isDiscoveryProvider(pk) ? baseUrl : "",
      region: options?.region || item.region || "TR",
      requireRealUrlCandidate: !isDiscoveryProvider(pk),
      titleFallback: `${providerFamily} moda sonucu`,
      priceKeys: ["finalPrice", "optimizedPrice", "price", "amount", "minPrice", "maxPrice", "salePrice"],
    }
  );

  if (!base || !base.title || !base.url || isBadUrlS200(base.url)) return null;

  // rating/review clamp (no inventing)
  const ratingRaw = item.rating ?? item.score ?? item.raw?.rating ?? null;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : null;

  const reviewCountRaw = item.reviewCount ?? item.reviews ?? item.raw?.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw) ? Math.max(0, Math.floor(reviewCountRaw)) : 0;

  // discovery providers: do not carry prices
  let price = base.price;
  if (isDiscoveryProvider(pk)) price = null;

  if (price == null && !isDiscoveryProvider(pk)) {
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

  // hard guarantees
  const id = base.id || stableIdS200(pk, base.url, title);
  const currency = normalizeCurrency(base.currency || currencyIn || "TRY");

  return {
    ...base,
    id,
    currency,

    // enforce price consistency (0 => null already)
    price,
    finalPrice: price,
    optimizedPrice: price,

    // stable provider meta
    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    providerType: "fashion",
    version: "S200",
    vertical: "fashion",
    category: "fashion",

    rating,
    reviewCount,

    // keep absolute variants
    originUrl: cOrigin || base.originUrl || base.url,
    finalUrl: cFinal || cDeeplink || cAffiliate || base.finalUrl || base.url,
    deeplink: cDeeplink || base.deeplink || base.url,
    affiliateUrl: cAffiliate || base.affiliateUrl || null,
  };
}

// ----------------------------------------------------------------------------
// WRAP — S200 output object (kept name)
// ----------------------------------------------------------------------------
function wrapFashionAdapter(providerKey, fn, timeoutMs = 3000, vertical = "fashion", weight = 1.0) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const group = String(vertical || "fashion") || "fashion";

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
      providerType: "fashion",
      vertical: "fashion",
      category: "fashion",
      version: "S200",
      weight,
      baseUrl,
      regionAffinity: ["TR", "GLOBAL"],
    },

    fn: async (query, options = {}) => {
      const __HARD_CAP_MS = Number(process.env.FINDALLEASY_HARD_CAP_MS || 6200);
      try {
        return await kitWithTimeout(async () => {
        const ts = Date.now();
        const q = String(query || "").trim();

        try {
          // ✅ COOLDOWN WRAP (istenen nokta: fn(query, ctx/options) çağrısı)
          const out = await runWithCooldownS200(
            pk,
            async () => {
              // 1) (query, options)
              try {
                return await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
              } catch (e1) {
                // 2) (query, regionString)
                const region =
                  (options && typeof options === "object" ? options.region || options.country : null) || "TR";
                return await kitWithTimeout(Promise.resolve(fn(q, region)), timeoutMs, pk);
              }
            },
            { group, query: q, providerKey: pk, timeoutMs }
          );

          const rawItems = coerceItemsS200(out);

          const items = rawItems
            .filter(Boolean)
            .map((i) => normalizeFashionS200(i, pk, vertical, q, options))
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
              vertical: "fashion",
              category: "fashion",
            },
          };
        } catch (err) {
          console.warn(`❌ Fashion adapter error (${pk}):`, err?.message || err);

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
                vertical: "fashion",
                category: "fashion",
              },
            };
          }

          // DEV: minimal fallback (no fake price/rating)
          const title = `${providerFamily} moda servisi şu anda yanıt vermiyor`;
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
            vertical: "fashion",
            category: "fashion",
            providerType: "fashion",
            version: "S200",
            fallback: true,
            raw: { error: err?.message || String(err) },
          };

          return {
            ok: false,
            items: ALLOW_FALLBACK_NAV ? [one] : [],
            count: ALLOW_FALLBACK_NAV ? 1 : 0,
            error: err?.message || String(err),
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "fashion",
              category: "fashion",
            },
          };
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
            group,
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
// SAFE WRAP HELPER (kept name) — returns normalized ITEMS array (not used by engine)
// ----------------------------------------------------------------------------
async function safeWrap(providerKey, fn, q, opt = {}, vertical = "fashion") {
  try {
    const out = await fn(q, opt);
    const items = coerceItemsS200(out);
    return items.map((x) => normalizeFashionS200(x, providerKey, vertical, q, opt)).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ----------------------------------------------------------------------------
// DYNAMIC IMPORTS
// ----------------------------------------------------------------------------
const searchTrendyolAdapter = await safeImport("../trendyolAdapter.js", "searchTrendyolAdapter");
const searchHepsiburadaAdapter = await safeImport("../hepsiburadaAdapter.js", "searchHepsiburadaAdapter");

// Brand stores
const searchLCW = await safeImport("../lcwAdapter.js");
const searchDefacto = await safeImport("../defactoAdapter.js");
const searchKoton = await safeImport("../kotonAdapter.js");
const searchBoyner = await safeImport("../boynerAdapter.js");
const searchMavi = await safeImport("../maviAdapter.js");
const searchFlo = await safeImport("../floAdapter.js");

// Search services
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");
const searchGoogleShopping = await safeImport("../googleShopping.js", "searchGoogleShopping");
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");

// ----------------------------------------------------------------------------
// FASHION ADAPTERS PACK — FINAL
// ----------------------------------------------------------------------------
export const fashionAdapters = [
  // E-commerce
  wrapFashionAdapter(
    "trendyol_fashion",
    async (q, o) => searchTrendyolAdapter(`${String(q || "").trim()} giyim ayakkabı moda`, o),
    3500,
    "fashion",
    1.25
  ),

  wrapFashionAdapter(
    "hepsiburada_fashion",
    async (q, o) => searchHepsiburadaAdapter(`${String(q || "").trim()} giyim ayakkabı moda`, o),
    3500,
    "fashion",
    1.20
  ),

  // Brand stores
  wrapFashionAdapter("lcw", searchLCW, 3200, "fashion", 1.0),
  wrapFashionAdapter("defacto", searchDefacto, 3200, "fashion", 0.95),
  wrapFashionAdapter("koton", searchKoton, 3300, "fashion", 0.95),
  wrapFashionAdapter("boyner", searchBoyner, 3400, "fashion", 1.15),
  wrapFashionAdapter("mavi", searchMavi, 3400, "fashion", 1.05),
  wrapFashionAdapter("flo", searchFlo, 3300, "fashion", 0.9),

  // Search services
  wrapFashionAdapter(
    "serpapi_fashion",
    async (q, o) => searchWithSerpApi(`${String(q || "").trim()} fashion clothes wear`, o || {}),
    2200,
    "fashion",
    0.8
  ),

  wrapFashionAdapter(
    "googleshopping_fashion",
    async (q, o) => searchGoogleShopping(`${String(q || "").trim()} fashion`, o || {}),
    2500,
    "fashion",
    0.85
  ),

  wrapFashionAdapter(
    "googleplaces_fashion",
    async (q, o) =>
      searchGooglePlaces(`${String(q || "").trim()} fashion store clothing boutique`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2600,
    "fashion",
    0.75
  ),

  wrapFashionAdapter(
    "osm_fashion",
    async (q, o) => searchWithOpenStreetMap(`${String(q || "").trim()} fashion clothing boutique giyim mağazası`, o || {}),
    2500,
    "fashion",
    0.7
  ),
];

// ----------------------------------------------------------------------------
// Ana motor için direkt fonksiyon array'i
// - Legacy path için items array döndüren wrapperlar
// ----------------------------------------------------------------------------
export const fashionAdapterFns = fashionAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ----------------------------------------------------------------------------
// DIREKT ADAPTER FONKSİYONLARI (Eski sistem uyumluluğu için)
// ----------------------------------------------------------------------------
export async function searchTrendyolFashionAdapter(query, options = {}) {
  const adapter = fashionAdapters.find((a) => a.name === "trendyol_fashion");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "trendyol_fashion" };
}

export async function searchLCWAdapter(query, options = {}) {
  const adapter = fashionAdapters.find((a) => a.name === "lcw");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "lcw" };
}

export async function searchDefactoAdapter(query, options = {}) {
  const adapter = fashionAdapters.find((a) => a.name === "defacto");
  return adapter ? await adapter.fn(query, options) : { ok: false, items: [], count: 0, source: "defacto" };
}

// ----------------------------------------------------------------------------
// TEST
// ----------------------------------------------------------------------------
export async function testFashionAdapters() {
  console.log("🧪 Fashion Adapters Test (S200 kit-bound)\n");
  console.log(`Total adapters: ${fashionAdapters.length}`);

  const testQueries = ["tişört", "pantolon", "ayakkabı", "ceket", "elbise"];

  for (const q of testQueries) {
    console.log(`\n🔍 Query: "${q}"`);
    for (const adapter of fashionAdapters.slice(0, 4)) {
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

  console.log("\n✅ Fashion test done");
}

// ----------------------------------------------------------------------------
// STATS
// ----------------------------------------------------------------------------
export const fashionAdapterStats = {
  totalAdapters: fashionAdapters.length,
  providers: fashionAdapters.map((a) => a.name),
  totalWeight: fashionAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    fashionAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, fashionAdapters.length)
  ),
  vertical: "fashion",
  version: "S200",
};

// ----------------------------------------------------------------------------
// LEGACY EXPORT
// ----------------------------------------------------------------------------
export default fashionAdapters;

// ============================================================================
// Locked:
// - PROD stub yok (ALLOW_STUBS hard-lock)
// - id/currency/version garanti
// - fn(...) çağrısı runWithCooldownS200 ile sarıldı ✅
// - canonicalProviderKey drift-killer ✅
// ============================================================================
