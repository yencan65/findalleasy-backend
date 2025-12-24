// server/adapters/groups/healthAdapters.js
// ============================================================================
// HEALTH ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.0.3
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub)
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE/RATING)
// - HealthBrain: scoring/sorting without fabricating fields
//
// FIX (V1.0.1):
// - canonicalProviderKey: normalizeProviderKeyS9 "unknown" döndürürse base'i EZMEZ
// - providerFamilyFromKey: deterministic family (sgk_hospitals -> sgk) + GOVERNMENT set uyumu
//
// FIX (V1.0.2):
// - GLOBAL CTX set/restore: kit/coerce loglarında [S200][unknown] düşmesin
//
// FIX (V1.0.3):
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// - ✅ IMPORT DRIFT FIX: pickUrlPriorityS200 kaldırıldı → pickUrlS200 fallback (kit uyumsuzluğunda çökme yok)
// - ✅ query tek noktada trimlenir (cooldown + normalize + meta tutarlı)
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
// STUB POLICY — HARD LOCK
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;
const ALLOW_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "1") === "1";

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ----------------------------------------------------------------------------
// Provider canonicalization
// ----------------------------------------------------------------------------
const fix = (v) => String(v || "").toLowerCase().trim();
const isBadKey = (k) => !k || k === "unknown" || k === "null" || k === "undefined";

const canonicalProviderKey = (raw, fallback = "health") => {
  const base = fix(raw || fallback);
  if (isBadKey(base)) return fix(fallback) || "health";

  try {
    if (normalizeProviderKeyS9) {
      const n = fix(normalizeProviderKeyS9(base));
      // ✅ KRİTİK: S9 "unknown" döndürürse base'i EZME
      if (!isBadKey(n)) return n;
    }
  } catch {}

  return base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "health");
  const fam0 = fix((k.split("_")[0] || k).trim());
  return isBadKey(fam0) ? "health" : fam0;
};

// ----------------------------------------------------------------------------
// Health brain (NO fabrication)
// ----------------------------------------------------------------------------
const PREMIUM = new Set(["acibadem", "memorial", "medicalpark", "liv", "florence", "medipol"]);
// NOTE: providerFamilyFromKey("sgk_hospitals") => "sgk" olduğu için "sgk" ekli.
const GOVERNMENT = new Set(["mhrs", "sgk", "sgk_hospitals", "enabiz"]);

function detectHealthCategory(text = "") {
  const t = String(text || "").toLowerCase();
  if (t.includes("diş") || t.includes("dental") || t.includes("implant")) return "dental";
  if (t.includes("test") || t.includes("kan") || t.includes("tahlil") || t.includes("laboratuvar")) return "lab";
  if (t.includes("check") || t.includes("check-up") || t.includes("checkup")) return "checkup";
  if (t.includes("muayene") || t.includes("doktor") || t.includes("hekim")) return "doctor";
  if (t.includes("hastane") || t.includes("klinik") || t.includes("tıp merkezi")) return "hospital";
  return "health";
}

function providerWeight(pkOrFam = "") {
  const p = providerFamilyFromKey(pkOrFam);
  if (PREMIUM.has(p)) return 1.35;
  if (GOVERNMENT.has(p)) return 1.25;
  if (String(pkOrFam).includes("googleplaces") || p.includes("googleplaces") || p.includes("google")) return 0.6;
  if (String(pkOrFam).includes("osm") || p.includes("osm")) return 0.5;
  if (String(pkOrFam).includes("serpapi") || p.includes("serp")) return 0.4;
  return 1.0;
}

// Discovery sources must NOT carry prices (avoid nonsense “place search price”)
function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

function clamp(n, lo, hi) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

function healthBrainScore(item) {
  const w = providerWeight(item?.providerKey || item?.providerFamily || item?.provider || "");
  const r = clamp(item?.rating, 0, 5);
  const rc =
    typeof item?.reviewCount === "number" && Number.isFinite(item.reviewCount) ? Math.max(0, Math.floor(item.reviewCount)) : 0;

  // Score uses defaults only internally; we do NOT write them back to item fields.
  const ratingScore = r != null ? r : 3.2;
  const reviewsBoost = 1 + Math.min(0.25, Math.log10(rc + 1) / 10);
  const completeness = (item?.price != null ? 1.05 : 1.0) * (r != null ? 1.05 : 1.0);

  return w * ratingScore * reviewsBoost * completeness;
}

function processHealth(query, items) {
  const q = String(query || "").trim();
  const withMeta = (Array.isArray(items) ? items : []).map((it, idx) => {
    const title = String(it?.title || "").trim();
    const category = detectHealthCategory(title || q);
    const score = healthBrainScore(it);

    return {
      ...it,
      healthCategory: category,
      healthScore: score,
      searchable: `${title} ${it?.providerFamily || it?.providerKey || it?.provider || ""}`.toLowerCase(),
      _idx: idx,
    };
  });

  const filtered = withMeta.filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

  filtered.sort((a, b) => {
    const d = (b.healthScore || 0) - (a.healthScore || 0);
    if (d !== 0) return d;
    return (a._idx || 0) - (b._idx || 0);
  });

  return filtered.map(({ _idx, ...rest }) => rest);
}

// ----------------------------------------------------------------------------
// Base URLs (relative resolve + safe fallback)
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  acibadem: "https://www.acibadem.com.tr/",
  memorial: "https://www.memorial.com.tr/",
  medicalpark: "https://www.medicalpark.com.tr/",
  liv: "https://www.livhospital.com/",
  florence: "https://www.florence.com.tr/",
  medipol: "https://www.medipol.com.tr/",

  mhrs: "https://www.mhrs.gov.tr/",
  sgk_hospitals: "https://www.sgk.gov.tr/",
  enabiz: "https://enabiz.gov.tr/",

  dental_clinics: "https://www.google.com/maps",
  lab_test_prices: "https://www.google.com/search?q=lab+test+prices",
  doktorset: "https://www.doktorsitesi.com/",
  health_tourism: "https://healthturism.gov.tr/",
  insurance_health: "https://www.findalleasy.com/",

  googleplaces_health: "https://www.google.com/maps",
  osm_health: "https://www.openstreetmap.org/",
  serpapi_health: "https://www.google.com/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "health");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

// Query-aware fallbacks (for discovery adapters)
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

function fallbackSearchUrl(pk, query) {
  const q = String(query || "").trim() || "sağlık";
  if (String(pk).includes("googleplaces")) return mapsSearchUrl(q);
  if (String(pk).includes("osm")) return osmSearchUrl(q);
  if (String(pk).includes("serpapi")) return googleSearchUrl(q);
  return baseUrlFor(pk);
}

// ----------------------------------------------------------------------------
// SAFE IMPORT (kit-based) — caller-relative, optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "health");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: NO fake price/rating, just a navigational card (still S200)
    return async (query) => {
      const q = String(query || "").trim();
      const title = nonEmptyTitleS200(q, `${providerFamily} sağlık hizmeti`);
      const url = normalizeUrlS200(baseUrl, baseUrl) || "https://www.findalleasy.com/";

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
          vertical: "health",
          category: "health",
          providerType: "health",
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
    console.warn(`⚠️ Health safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------------------------------------------------------
// Health item normalizer (S200 contract + health rules)
// ----------------------------------------------------------------------------
function normalizeHealthItemS200(item, providerKey, queryForFallback = "", options = {}, healthType = "health") {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  // Title
  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.label ?? item.serviceName ?? item.raw?.title ?? item.raw?.name,
    `${providerFamily} sağlık sonucu`
  );
  if (!title) return null;

  // URL candidate (priority) + discovery fallback
  // ✅ drift-safe: pickUrlS200 + raw + fallback fields
  let urlCandidate = (() => {
    try {
      return (
        pickUrlS200(item) ||
        pickUrlS200(item?.raw) ||
        item?.affiliateUrl ||
        item?.deeplink ||
        item?.finalUrl ||
        item?.originUrl ||
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

  const hasCandidate = !!urlCandidate && !isBadUrlS200(urlCandidate);

  if (!hasCandidate && isDiscoveryProvider(pk)) {
    urlCandidate = pk.includes("osm")
      ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi")
      ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);
  }

  const allowFallbackUrl = isDiscoveryProvider(pk) || GOVERNMENT.has(providerFamily) || pk === "insurance_health";

  const base = normalizeItemS200(
    {
      ...item,
      title,
      url: urlCandidate || item.url,
    },
    pk,
    {
      vertical: "health",
      category: "health",
      providerFamily,
      baseUrl,
      fallbackUrl: allowFallbackUrl ? baseUrl : "",
      region: options?.region || item.region || "TR",
      requireRealUrlCandidate: !allowFallbackUrl,
      titleFallback: `${providerFamily} sağlık sonucu`,
      priceKeys: ["fee", "amount", "price", "finalPrice", "optimizedPrice", "minPrice", "maxPrice", "totalPrice"],
    }
  );

  if (!base) return null;

  // Enforce: discovery/government providers must not carry prices
  let price = base.price;
  if (isDiscoveryProvider(pk) || GOVERNMENT.has(providerFamily)) price = null;

  // Recover valid price only for non-discovery & non-government
  if (price == null && !(isDiscoveryProvider(pk) || GOVERNMENT.has(providerFamily))) {
    const hint = priceOrNullS200(item.price ?? item.finalPrice ?? item.optimizedPrice ?? item.amount ?? item.fee);
    if (hint != null) price = hint;
  }

  const city = String(options?.city || item.city || item.locationCity || item.raw?.city || "").trim() || null;
  const specialty = String(item.specialty || item.department || item.branch || item.raw?.specialty || "").trim() || null;
  const address = String(item.address || item.location || item.raw?.address || "").trim() || null;
  const phone = String(item.phone || item.phoneNumber || item.tel || item.raw?.phone || "").trim() || null;

  // hard guarantees
  const id = base.id || stableIdS200(pk, base.url, title);
  const currency = base.currency || "TRY";

  return {
    ...base,
    id,

    // overwrite prices consistently (S200 rule)
    price,
    finalPrice: price,
    optimizedPrice: price,
    currency,

    // keep health typing without abusing "vertical"
    providerType: "health",
    version: "S200",

    healthType: String(healthType || "health"),
    healthCategory: detectHealthCategory(title),

    city,
    specialty,
    address,
    phone,
  };
}

// ----------------------------------------------------------------------------
// WRAP — engine format + S200 wrapper output object
// ----------------------------------------------------------------------------
function wrapHealthAdapter(providerKey, fn, timeoutMs = 3000, healthType = "health", weight = 1.0) {
  // ✅ DRIFT-KILLER canonicalProviderKey (S9 unknown döndürürse base’i ezme)
  const baseKey = fix(providerKey || "health") || "health";
  let s9Key = baseKey;

  try {
    if (normalizeProviderKeyS9) {
      const n = fix(normalizeProviderKeyS9(baseKey));
      if (!isBadKey(n)) s9Key = n;
    }
  } catch {}

  const pk = !isBadKey(s9Key) ? s9Key : baseKey || "health";

  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const group = "health";

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
      providerType: "health",
      vertical: "health",
      category: "health",
      version: "S200",
      weight,
      baseUrl,
      healthType,
    },

    fn: async (query, options = {}) => {
      const __HARD_CAP_MS = Number(process.env.FINDALLEASY_HARD_CAP_MS || 6200);
      try {
        return await kitWithTimeout(async () => {
        const ts = Date.now();
        const q = String(query || "").trim();

        // ✅ GLOBAL CTX set/restore — kit/coerce loglarında [S200][unknown] düşmesin
        const normalizedProviderKey = pk;
        const prev = globalThis.__S200_ADAPTER_CTX;
        globalThis.__S200_ADAPTER_CTX = { adapter: normalizedProviderKey, url: baseUrl };

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

            // coerceItemsS200 burada log basabilir — ctx artık doğru
            const rawItems = coerceItemsS200(out);

            const items = rawItems
              .filter(Boolean)
              .map((i) => normalizeHealthItemS200(i, pk, q, options, healthType))
              .filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

            const processed = processHealth(q, items);

            return {
              ok: true,
              items: processed,
              count: processed.length,
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "health",
                category: "health",
                healthType,
              },
            };
          } catch (err) {
            console.warn(`❌ ${pk} health adapter error:`, err?.message || err);

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
                  vertical: "health",
                  category: "health",
                  healthType,
                },
              };
            }

            // DEV: minimal single fallback item (still S200, no fake price/rating)
            const title = `${providerFamily} sağlık servisi şu anda yanıt vermiyor`;
            const url = fallbackSearchUrl(pk, q);

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
              vertical: "health",
              category: "health",
              providerType: "health",
              version: "S200",
              healthType,
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
                vertical: "health",
                category: "health",
                healthType,
              },
            };
          }
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
// DYNAMIC IMPORTS
// ----------------------------------------------------------------------------

// Premium
const searchAcibadem = await safeImport("../acibademAdapter.js");
const searchAcibademCheckup = await safeImport("../acibademCheckupAdapter.js");
const searchMedicalparkAdapter = await safeImport("../medicalparkAdapter.js");
const searchMedipol = await safeImport("../medipolAdapter.js");
const searchMemorial = await safeImport("../memorialAdapter.js");
const searchLiv = await safeImport("../livAdapter.js");
const searchFlorence = await safeImport("../florenceAdapter.js");

// Government / Extra
const searchMHRS = await safeImport("../mhrsAdapter.js");
const searchDental = await safeImport("../dentalAdapter.js");
const searchEnabiz = await safeImport("../enabizAdapter.js");

const searchSGKHospitals = await safeImport("../healthExtraAdapters.js", "searchSGKHospitals");
const searchLabTests = await safeImport("../healthExtraAdapters.js", "searchLabTests");
const searchDoktorSet = await safeImport("../healthExtraAdapters.js", "searchDoktorSet");
const searchHealthTourism = await safeImport("../healthExtraAdapters.js", "searchHealthTourism");
const searchGoogleMedical = await safeImport("../healthExtraAdapters.js", "searchGoogleMedical");
const searchInsuranceHealth = await safeImport("../healthExtraAdapters.js", "searchInsuranceHealth");

// Search providers (named exports preferred)
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ----------------------------------------------------------------------------
// HEALTH ADAPTER PACK — FINAL
// ----------------------------------------------------------------------------
export const healthAdapters = [
  wrapHealthAdapter("acibadem", searchAcibadem, 3500, "hospital", 1.35),
  wrapHealthAdapter("acibadem_checkup", searchAcibademCheckup, 3500, "checkup", 1.32),
  wrapHealthAdapter("medicalpark", searchMedicalparkAdapter, 3500, "hospital", 1.3),
  wrapHealthAdapter("memorial", searchMemorial, 3500, "hospital", 1.32),
  wrapHealthAdapter("liv", searchLiv, 3500, "hospital", 1.3),
  wrapHealthAdapter("florence", searchFlorence, 3500, "hospital", 1.28),
  wrapHealthAdapter("medipol", searchMedipol, 3500, "hospital", 1.26),

  wrapHealthAdapter("mhrs", searchMHRS, 3500, "government", 1.25),
  wrapHealthAdapter("sgk_hospitals", searchSGKHospitals, 3500, "government", 1.22),

  wrapHealthAdapter("dental_clinics", searchDental, 3500, "dental", 1.1),
  wrapHealthAdapter("enabiz", searchEnabiz, 3500, "doctor", 1.15),
  wrapHealthAdapter("lab_test_prices", searchLabTests, 3500, "lab", 1.08),

  wrapHealthAdapter("doktorset", searchDoktorSet, 3500, "doctor", 1.05),
  wrapHealthAdapter("health_tourism", searchHealthTourism, 3500, "tourism", 1.0),
  wrapHealthAdapter("google_medical", searchGoogleMedical, 3500, "health", 0.95),
  wrapHealthAdapter("insurance_health", searchInsuranceHealth, 3500, "health", 0.92),

  wrapHealthAdapter(
    "googleplaces_health",
    async (q, opt) => {
      const text = String(q || "").trim();
      const boosted =
        text.toLowerCase().includes("hastane") || text.toLowerCase().includes("doktor") ? text : `${text} hastane doktor klinik`;
      return searchGooglePlaces(boosted, { ...(opt || {}), region: opt?.region || "TR" });
    },
    2500,
    "discovery",
    0.6
  ),

  wrapHealthAdapter(
    "osm_health",
    async (q, opt) => {
      const text = String(q || "").trim();
      const boosted =
        text.toLowerCase().includes("hastane") || text.toLowerCase().includes("doktor") ? text : `${text} hastane doktor klinik`;
      return searchWithOpenStreetMap(boosted, opt || {});
    },
    2500,
    "discovery",
    0.5
  ),

  wrapHealthAdapter(
    "serpapi_health",
    async (q, opt) => {
      const text = String(q || "").trim();
      const query = text ? `${text} doktor hastane klinik sağlık` : "doktor hastane klinik sağlık";
      return searchWithSerpApi(query, { ...(opt || {}), region: opt?.region || "TR" });
    },
    2400,
    "discovery",
    0.4
  ),
];

export const healthAdapterFns = healthAdapters.map((a) => a.fn);

// ----------------------------------------------------------------------------
// Filters & stats (optional but consistent)
// ----------------------------------------------------------------------------
export function getHealthAdaptersByType(type) {
  const t = fixKey(type || "health") || "health";
  const names = healthAdapters.filter((a) => fixKey(a?.meta?.healthType || "") === t).map((a) => a.name);

  if (!names.length) return healthAdapters;
  return healthAdapters.filter((a) => names.includes(a.name));
}

export const healthAdapterStats = {
  totalAdapters: healthAdapters.length,
  providers: healthAdapters.map((a) => a.name),
  averageTimeout: Math.round(
    healthAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, healthAdapters.length)
  ),
  vertical: "health",
  version: "S200",
};

// ----------------------------------------------------------------------------
// Test (fn returns object)
// ----------------------------------------------------------------------------
export async function testHealthAdapterCompatibility() {
  console.log("\n🧪 Health Adapter Test (S200 kit-bound)\n");

  const test = healthAdapters[0];
  const q = "diş implant istanbul";

  try {
    const out = await test.fn(q, { region: "TR", city: "İstanbul" });
    const items = Array.isArray(out) ? out : out?.items || [];
    const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;

    console.log(`ok=${out?.ok !== false} | count=${items.length} | bad=${bad}`);
    if (items.length) {
      console.log("sample:", {
        title: items[0].title,
        provider: items[0].provider,
        providerKey: items[0].providerKey,
        price: items[0].price,
        rating: items[0].rating,
        url: items[0].url,
        healthType: items[0].healthType,
        healthCategory: items[0].healthCategory,
        healthScore: items[0].healthScore,
      });
    }
    return true;
  } catch (err) {
    console.error("HATA:", err?.message || err);
    return false;
  }
}

export default healthAdapters;
