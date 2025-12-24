// server/adapters/groups/insuranceAdapters.js
// ============================================================================
// INSURANCE ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.6.1 (ENGINE COMPATIBLE)
// ZERO DELETE · SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// S200 contract lock: title+url required, price<=0 => null
// Wrapper output: { ok, items, count, source, _meta } ✅
// PROD: import fail / adapter fail => empty (no stub)
// DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (PROD'da asla stub yok)
// Timeout guard + provider canonical + URL sanitize + search-url fallback
//
// PATCH (V1.6.1):
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// ============================================================================

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// S200 KIT (single source of truth)
import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200,
  fixKey,
  nonEmptyTitleS200,
  isBadUrlS200,
  normalizeUrlS200,
  priceOrNullS200,
  stableIdS200,
  pickUrlS200 as pickUrlPriorityS200, // ✅ drift-proof: kit'te pickUrlS200 var
} from "../../core/s200AdapterKit.js";

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ----------------------------
// tiny utils (local, safe)
// ----------------------------
const safeStr = (v) => {
  const s = String(v ?? "").trim();
  return s && !/^(undefined|null)$/i.test(s) ? s : "";
};

const fix = (v) => String(v || "").toLowerCase().trim();

// ----------------------------
// provider canonical (fixKey + S9 master varsa)
// ----------------------------
const canonicalProviderKey = (raw, fallback = "insurance") => {
  let base = fixKey(raw || "") || fix(raw || "");
  if (!base || /^(unknown|null|undefined)$/i.test(base)) base = fixKey(fallback) || fix(fallback) || "insurance";

  try {
    if (normalizeProviderKeyS9) {
      const n = normalizeProviderKeyS9(base);
      const k = fixKey(n) || fix(n);
      if (k) base = k;
    }
  } catch {}

  if (!base || /^(unknown|null|undefined)$/i.test(base)) base = fixKey(fallback) || "insurance";
  return base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "insurance");
  const fam0 = (k.split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, fam0) || "insurance";
};

// ----------------------------
// Query-aware fallbacks for search providers
// ----------------------------
const mapsSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}`;
};

const osmSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(t)}`;
};

const googleSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
};

// ----------------------------
// Companies (official quote page cards; no fake price)
// ----------------------------
const INSURANCE_COMPANIES = [
  { name: "allianz", display: "Allianz Sigorta", weight: 1.25, url: "https://www.allianz.com.tr" },
  { name: "aksigorta", display: "Aksigorta", weight: 1.22, url: "https://www.aksigorta.com.tr" },
  { name: "sompo", display: "Sompo Sigorta", weight: 1.18, url: "https://www.sompo.com.tr" },
  { name: "mapfre", display: "Mapfre Sigorta", weight: 1.15, url: "https://www.mapfre.com.tr" },
  { name: "turkiyesigorta", display: "Türkiye Sigorta", weight: 1.12, url: "https://www.turkiyesigorta.com.tr" },
  { name: "hdi", display: "HDI Sigorta", weight: 1.1, url: "https://www.hdisigorta.com.tr" },
  { name: "anadolu", display: "Anadolu Sigorta", weight: 1.3, url: "https://www.anadolusigorta.com.tr" },
  { name: "groupama", display: "Groupama Sigorta", weight: 1.0, url: "https://www.groupama.com.tr" },
  { name: "zurich", display: "Zurich Sigorta", weight: 0.95, url: "https://www.zurich.com.tr" },
  { name: "gunes", display: "Güneş Sigorta", weight: 0.9, url: "https://www.gunessigorta.com.tr" },
  { name: "ray", display: "Ray Sigorta", weight: 0.88, url: "https://www.raysigorta.com.tr" },
  { name: "neova", display: "Neova Sigorta", weight: 0.85, url: "https://www.neovasigorta.com.tr" },
];

// Provider baseUrl (relative resolve + safe fallback)
const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "insurance");
  const fam = providerFamilyFromKey(pk);

  // company url override
  const c = INSURANCE_COMPANIES.find((x) => x.name === pk || x.name === fam);
  if (c?.url) return normalizeUrlS200(c.url, c.url) || c.url;

  // infra/search providers
  if (pk.includes("googleplaces")) return "https://www.google.com/maps";
  if (pk.includes("osm")) return "https://www.openstreetmap.org/";
  if (pk.includes("serpapi")) return "https://www.google.com/";

  return "https://www.findalleasy.com/";
};

// fallback URL for error cards
const fallbackSearchUrl = (providerKey, query) => {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const q = safeStr(query) || "sigorta";
  if (pk.includes("googleplaces")) return mapsSearchUrl(q) || "https://www.google.com/maps";
  if (pk.includes("osm")) return osmSearchUrl(q) || "https://www.openstreetmap.org/";
  if (pk.includes("serpapi")) return googleSearchUrl(q) || "https://www.google.com/";
  const b = baseUrlFor(pk);
  return normalizeUrlS200(b, b) || "https://www.findalleasy.com/";
};

// ----------------------------
// safeImport (kit-based, caller-relative, optional stubs)
// ----------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "insurance");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    return async (query) => {
      const title = `${safeStr(query) || "sigorta"} - ${providerFamily} (stub)`;
      const url = normalizeUrlS200(baseUrl, baseUrl) || "https://www.findalleasy.com/";

      return [
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          // ✅ no fake price
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          category: "insurance",
          vertical: "insurance",
          providerType: "insurance",
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
    console.warn(`⚠️ Insurance safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------
// QUERY → INSURANCE TYPE (kept)
// ----------------------------
export function detectInsuranceType(query) {
  const q = String(query || "").toLowerCase();

  if (q.includes("kasko") || q.includes("araba")) return "vehicle";
  if (q.includes("trafik")) return "traffic";
  if (q.includes("konut") || q.includes("dask") || q.includes("ev")) return "home";
  if (q.includes("sağlık") || q.includes("hastane")) return "health";
  if (q.includes("seyahat") || q.includes("vize")) return "travel";
  if (q.includes("hayat")) return "life";
  if (q.includes("işyeri") || q.includes("iş yeri")) return "business";
  if (q.includes("cihaz") || q.includes("elektronik")) return "device";

  return "general";
}

// ----------------------------
// SERP QUERY BUILDER (type-aware)
// ----------------------------
function buildSerpInsuranceQuery(q) {
  const type = detectInsuranceType(q);
  const base = String(q || "").trim() || "sigorta";
  const map = {
    vehicle: `${base} kasko teklifi`,
    traffic: `${base} trafik sigortası teklifi`,
    home: `${base} konut sigortası dask teklifi`,
    health: `${base} sağlık sigortası teklifi`,
    travel: `${base} seyahat sigortası teklifi`,
    life: `${base} hayat sigortası teklifi`,
    business: `${base} işyeri sigortası teklifi`,
    device: `${base} cihaz sigortası teklifi`,
    general: `${base} sigorta teklifi`,
  };
  return map[type] || map.general;
}

// ----------------------------
// Normalizer (kit-core + insurance extra fields preserved)
// ----------------------------
function normalizeInsuranceItemS200(item, providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const isSearchProvider = pk.includes("googleplaces") || pk.includes("osm") || pk.includes("serpapi");

  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.label ?? item.productName ?? item.raw?.title ?? item.raw?.name,
    `${providerFamily} sigorta sonucu`
  );

  // URL priority (kit) + search-url fallback if missing
  let urlCandidate = typeof pickUrlPriorityS200 === "function" ? pickUrlPriorityS200(item) : "";
  const hasCandidate = !isBadUrlS200(urlCandidate);

  if (!hasCandidate && isSearchProvider) {
    urlCandidate =
      pk.includes("osm")
        ? osmSearchUrl(queryForFallback)
        : pk.includes("serpapi")
        ? googleSearchUrl(queryForFallback)
        : mapsSearchUrl(queryForFallback);
  }

  // Ensure we pass candidate into normalizeItemS200 (kit reads from standard fields)
  const base = normalizeItemS200(
    {
      ...item,
      title,
      url: urlCandidate || item.url,
    },
    pk,
    {
      vertical: "insurance",
      category: "insurance",
      providerFamily,
      baseUrl,
      fallbackUrl: baseUrl,
      region: options?.region || item.region || "TR",
      // search providers can use fallback url; company/real quote providers should require real candidate unless explicitly fallback
      requireRealUrlCandidate: !isSearchProvider,
      titleFallback: `${providerFamily} sigorta sonucu`,
      priceKeys: ["premium", "annualPremium", "monthlyPremium", "fee", "totalPremium", "total", "amount"],
    }
  );

  if (!base) return null;

  // Preserve insurance-specific fields
  const insuranceType = safeStr(item.insuranceType) || detectInsuranceType(queryForFallback);
  const company = safeStr(item.company) || safeStr(item.providerName) || null;

  const coverage = item.coverage ?? item.coverages ?? null;
  const features = Array.isArray(item.features)
    ? item.features
    : Array.isArray(item.raw?.features)
    ? item.raw.features
    : null;

  const phone = safeStr(item.phone) || safeStr(item.phoneNumber) || safeStr(item.tel) || null;

  // If adapter gave "price" hint but kit didn't pick (rare), try one more time (still S200: <=0 => null)
  const priceHint = priceOrNullS200(item.price ?? item.finalPrice ?? item.optimizedPrice);
  const price = base.price ?? priceHint ?? null;

  return {
    ...base,

    // override prices if we found a valid one (still null-safe)
    price,
    finalPrice: price,
    optimizedPrice: price,

    insuranceType,
    company,
    coverage,
    features,
    phone,
  };
}

// ----------------------------
// Wrapper — returns { ok, items, count, source, _meta }
// ----------------------------
function wrapInsuranceAdapter(providerKey, fn, timeoutMs = 2500, weight = 1.0) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const group = "insurance";

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
      providerType: "insurance",
      vertical: "insurance",
      category: "insurance",
      version: "S200",
      weight,
      baseUrl,
    },

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = String(query || "").trim();

      try {
        // ✅ COOLDOWN WRAP (istenen nokta: fn(query, ctx/options) çağrısı)
        const out = await runWithCooldownS200(
          pk,
          async () => {
            return await kitWithTimeout(() => Promise.resolve().then(() => fn(q, options)), timeoutMs, pk);
          },
          { group, query: q, providerKey: pk, timeoutMs }
        );

        const rawItems = coerceItemsS200(out);
        const items = rawItems
          .filter(Boolean)
          .map((i) => normalizeInsuranceItemS200(i, pk, q, options))
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
            vertical: "insurance",
            category: "insurance",
          },
        };
      } catch (err) {
        console.warn(`❌ ${pk} insurance adapter error:`, err?.message || err);

        // PROD: empty (no fake cards)
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
              vertical: "insurance",
              category: "insurance",
            },
          };
        }

        // DEV: minimum fallback item (still S200)
        const title = `${providerFamily} sigorta servisi şu anda yanıt vermiyor`;
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
          insuranceType: detectInsuranceType(q),
          company: null,
          category: "insurance",
          vertical: "insurance",
          providerType: "insurance",
          version: "S200",
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
            vertical: "insurance",
            category: "insurance",
          },
        };
      }
    },
  };
}

// ----------------------------
// SEARCH ADAPTER IMPORTS (named exports preferred)
// ----------------------------
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");

// ----------------------------
// STATIC COMPANY ADAPTERS (NO FAKE PRICE)
// ----------------------------
const staticInsuranceAdapters = INSURANCE_COMPANIES.map((company) =>
  wrapInsuranceAdapter(
    company.name,
    async (q) => {
      const type = detectInsuranceType(q);
      const typeLabels = {
        vehicle: "Kasko",
        traffic: "Trafik",
        home: "Konut/DASK",
        health: "Sağlık",
        travel: "Seyahat",
        life: "Hayat",
        business: "İş Yeri",
        device: "Cihaz",
        general: "Sigorta",
      };

      const title = `${safeStr(q) || "sigorta"} - ${company.display} ${typeLabels[type]} Teklif Al`;

      // best-effort official quote path (do not invent price)
      const primary = normalizeUrlS200(`${company.url}/teklif-al`, company.url);
      const fallback = normalizeUrlS200(company.url, company.url);
      const url = !isBadUrlS200(primary)
        ? primary
        : !isBadUrlS200(fallback)
        ? fallback
        : "https://www.findalleasy.com/";

      return [
        {
          id: stableIdS200(company.name, url, title),
          title,
          url,

          provider: company.name,
          providerKey: canonicalProviderKey(company.name, "insurance"),
          providerFamily: providerFamilyFromKey(company.name),

          insuranceType: type,
          company: company.display,

          // ✅ no fake price/rating
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",

          coverage: null,
          phone: null,
          features: ["Online teklif", "Resmi sayfa", "Hızlı yönlendirme"],

          category: "insurance",
          vertical: "insurance",
          providerType: "insurance",
          version: "S200",

          raw: { kind: "official_quote_page" },
        },
      ];
    },
    2300,
    company.weight
  )
);

// ----------------------------
// FINAL ADAPTERS
// ----------------------------
export const insuranceAdapters = [
  ...staticInsuranceAdapters,

  wrapInsuranceAdapter(
    "googleplaces_insurance",
    async (q, opt) => {
      const text = safeStr(q);
      const boosted = text.toLowerCase().includes("sigorta") ? text : `${text} sigorta acentesi`;
      return searchGooglePlaces(boosted, { ...(opt || {}), region: opt?.region || "TR" });
    },
    2500,
    0.95
  ),

  wrapInsuranceAdapter(
    "osm_insurance",
    async (q, opt) => {
      const text = safeStr(q);
      const boosted = text.toLowerCase().includes("sigorta") ? text : `${text} sigorta`;
      return searchWithOpenStreetMap(boosted, opt || {});
    },
    2400,
    0.85
  ),

  wrapInsuranceAdapter(
    "serpapi_insurance",
    async (q, opt) => {
      return searchWithSerpApi(buildSerpInsuranceQuery(q), opt || {});
    },
    2600,
    0.9
  ),
];

export const insuranceAdapterFns = insuranceAdapters.map((a) => a.fn);

// ----------------------------
// FILTERS (kept)
// ----------------------------
export function getInsuranceAdaptersByType(type) {
  const t = String(type || "general").toLowerCase();

  const map = {
    vehicle: ["allianz", "aksigorta", "anadolu", "sompo"],
    traffic: ["allianz", "aksigorta", "mapfre", "turkiyesigorta"],
    home: ["allianz", "aksigorta", "sompo", "zurich"],
    health: ["allianz", "anadolu", "groupama", "hdi"],
    travel: ["allianz", "aksigorta", "mapfre"],
    life: ["anadolu", "allianz", "sompo", "zurich"],
    business: ["allianz", "aksigorta", "sompo", "mapfre"],
    device: ["allianz", "aksigorta"],
    general: ["allianz", "aksigorta", "anadolu", "sompo", "mapfre", "googleplaces_insurance", "serpapi_insurance"],
  };

  const names = map[t] || map.general;
  return insuranceAdapters.filter((a) => names.includes(a.name));
}

export function getTopInsuranceCompanies() {
  return [...INSURANCE_COMPANIES]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map((c) => c.name);
}

// ----------------------------
// INSURANCE TYPE DETAILS (kept)
// Not: Bu blok UI'da gösteriliyorsa “tahmini aralık” olarak etiketle; fiyat beyanı değil.
// ----------------------------
export const insuranceTypeDetails = {
  vehicle: {
    name: "Kasko Sigortası",
    coverage: ["Çarpma", "Hırsızlık", "Yangın"],
    averagePrice: "1.500-5.000 TL",
  },
  traffic: {
    name: "Trafik Sigortası",
    coverage: ["Üçüncü şahıs", "Maddi hasar"],
    averagePrice: "500-1.500 TL",
    mandatory: true,
  },
  home: {
    name: "Konut Sigortası",
    coverage: ["Yangın", "Deprem", "Hırsızlık"],
    averagePrice: "300-1.000 TL",
  },
  health: {
    name: "Sağlık Sigortası",
    coverage: ["Hastane", "Ameliyat"],
    averagePrice: "2.000-10.000 TL",
  },
};

// ----------------------------
// TEST (updated: fn returns object)
// ----------------------------
export async function testInsuranceAdapterCompatibility() {
  console.log("🏦 Insurance Adapter Test (S200 kit-bound)\n");

  const test = insuranceAdapters[0];
  const q = "kasko sigortası teklifi";

  try {
    const out = await test.fn(q, { region: "TR" });
    const items = Array.isArray(out) ? out : out?.items || [];

    const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;

    console.log(`ok=${out?.ok !== false} | count=${items.length} | bad=${bad}`);
    if (items.length) {
      console.log("sample:", {
        title: items[0].title,
        provider: items[0].provider,
        providerKey: items[0].providerKey,
        price: items[0].price,
        url: items[0].url,
        insuranceType: items[0].insuranceType,
        company: items[0].company,
      });
    }
    return true;
  } catch (err) {
    console.error("HATA:", err?.message || err);
    return false;
  }
}

// ----------------------------
// STATS
// ----------------------------
export const insuranceAdapterStats = {
  totalAdapters: insuranceAdapters.length,
  companies: INSURANCE_COMPANIES.length,
  topCompanies: getTopInsuranceCompanies(),
  providers: insuranceAdapters.map((a) => a.name),
  averageTimeout: Math.round(
    insuranceAdapters.reduce((s, a) => s + (a.timeoutMs || 2500), 0) / Math.max(1, insuranceAdapters.length)
  ),
  vertical: "insurance",
  version: "S200",
};

// Default export
export default insuranceAdapters;
