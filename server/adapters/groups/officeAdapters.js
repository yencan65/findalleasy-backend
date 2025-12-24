// server/adapters/groups/officeAdapters.js
// ============================================================================
// OFFICE ADAPTER PACK — S200 FINAL (KIT-BOUND) → PATCHED V1.5.4
// ZERO DELETE · S200 contract lock via s200AdapterKit (title+url required, price<=0 => null)
// providerKey canonicalization + url priority (affiliate/deeplink first)
// PROD: import fail => empty | DEV: optional stubs via FINDALLEASY_ALLOW_STUBS=1 (NAV LINK ONLY)
// PATCH (v1.5.4):
// - ✅ runWithCooldownS200: gerçek fn(query, ctx) çağrısı wrapper içinde cooldown ile sarıldı
// - ✅ GLOBAL CTX set/restore: kit/coerce loglarında [S200][unknown] düşmesin (GERÇEKTEN VAR)
// - ✅ fallback spam cut: empty/soft-fail NAV fallback default sadece discovery providers
// - ✅ discovery providers: affiliateUrl zorla null + price null (tam steril)
// ============================================================================

import {
  fixKey,
  makeSafeImport,
  withTimeout,
  runWithCooldownS200,
  coerceItemsS200,
  normalizeItemS200,
  isBadUrlS200,
  normalizeUrlS200,
  pickUrlS200,
  stableIdS200,
  nonEmptyTitleS200,
} from "../../core/s200AdapterKit.js";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ---------------------------------------------------------------------------
// ✅ SOFT_FAIL_RE (nav fallback için)
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|CERT|certificate|TLS|SSL|HTTPCLIENT_NON_2XX|No data received|\b403\b|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

const _safeStr = (v) => (v == null ? "" : String(v).trim());
const _isBadKey = (k) => {
  const x = fixKey(k);
  return !x || x === "unknown" || x === "null" || x === "undefined";
};

// ============================================================================
// Optional provider normalizer (ASLA crash etmez)
// ============================================================================
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ============================================================================
// Optional affiliate engine (ASLA crash etmez)
// ============================================================================
let buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok
}

// ============================================================================
// Canonical provider key/family (S9 master respected) — DRIFT SAFE
// ============================================================================
const canonicalProviderKey = (raw, fallback = "office") => {
  const fb = fixKey(fallback) || "office";
  const base0 = fixKey(raw || "");
  const base = _isBadKey(base0) ? fb : base0;

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(base);
      const nn = fixKey(n);
      // ✅ KRİTİK: S9 "unknown/null/undefined" döndürürse base’i ASLA ezme
      if (!_isBadKey(nn)) return nn || base;
    }
  } catch {}

  return _isBadKey(base) ? fb : base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "office");
  const fam0 = (String(k).split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, fam0) || "office";
};

const isDiscoveryFamily = (fam) => fam === "googleplaces" || fam === "osm" || fam === "serpapi";

// ============================================================================
// DOMAIN MAP — relative URL resolve için şart (kaliteyi artırır)
// ============================================================================
const DOMAIN_MAP = {
  trendyol: "trendyol.com",
  hepsiburada: "hepsiburada.com",
  n11: "n11.com",
  ciceksepeti: "ciceksepeti.com",
  koctas: "koctas.com.tr",
  migros: "migros.com.tr",
  carrefour: "carrefoursa.com",
  a101: "a101.com.tr",
  sok: "sokmarket.com.tr",
  avansas: "avansas.com",
  googleplaces: "google.com",
  osm: "openstreetmap.org",
  serpapi: "google.com",
};

// ✅ NO FAKE DOMAIN: unknown => google root
const baseUrlFor = (providerKeyOrFamily) => {
  const k = canonicalProviderKey(providerKeyOrFamily, "office");
  const fam = providerFamilyFromKey(k);

  if (fam === "googleplaces") return "https://www.google.com/maps/";
  if (fam === "osm") return "https://www.openstreetmap.org/";
  if (fam === "serpapi") return "https://www.google.com/";

  const domain = DOMAIN_MAP[k] || DOMAIN_MAP[fam] || "";
  if (!domain) return "https://www.google.com/";

  const d = String(domain).replace(/^www\./i, "");
  return `https://www.${d.replace(/\/+$/g, "")}/`;
};

// ============================================================================
// Search fallbacks (url yoksa üret)
// ============================================================================
const mapsSearchUrl = (q) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(q || "").trim() || "ofis")}`;

const osmSearchUrl = (q) =>
  `https://www.openstreetmap.org/search?query=${encodeURIComponent(String(q || "").trim() || "office")}`;

const googleSearchUrl = (q) =>
  `https://www.google.com/search?q=${encodeURIComponent(String(q || "").trim() || "office supplies")}`;

// Serp query builder
function buildSerpOfficeQuery(q) {
  const t = String(q || "").toLowerCase();
  if (t.includes("toner") || t.includes("kartuş")) return "printer toner cartridge office supplies";
  if (t.includes("printer") || t.includes("yazıcı")) return "office printer laser inkjet";
  if (t.includes("sandalye")) return "office chair ergonomic chair";
  if (t.includes("masa")) return "office desk workstation";
  if (t.includes("kırtasiye")) return "stationery office supplies pens notebooks";
  return "office supplies stationery printer chair desk";
}

// ============================================================================
// Relative URL resolver (kit normalizeUrlS200 sadece “/...” çözer; “product/123” için burada)
// ============================================================================
function resolveRelativeUrl(candidate, baseUrl) {
  const u = String(candidate || "").trim();
  if (!u) return "";
  if (u.startsWith("//") || u.startsWith("/") || /^https?:\/\//i.test(u)) return u;

  // başka scheme'ler (mailto:, tel:, etc) click target değil → geçersiz say
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return "";

  const b = String(baseUrl || "").trim().replace(/\/+$/g, "");
  if (!b || !/^https?:\/\//i.test(b)) return "";
  return `${b}/${u.replace(/^\/+/g, "")}`;
}

// kit + fallback (drift-proof)
function pickUrlPriority(obj) {
  try {
    const s = typeof pickUrlS200 === "function" ? pickUrlS200(obj) : "";
    if (s) return s;
  } catch {}
  return (
    obj?.affiliateUrl ??
    obj?.deeplink ??
    obj?.deepLink ??
    obj?.finalUrl ??
    obj?.originUrl ??
    obj?.url ??
    obj?.link ??
    obj?.href ??
    obj?.website ??
    obj?.raw?.affiliateUrl ??
    obj?.raw?.deeplink ??
    obj?.raw?.finalUrl ??
    obj?.raw?.originUrl ??
    obj?.raw?.url ??
    obj?.raw?.website ??
    ""
  );
}

function patchUrlsForKit(item, baseUrl, providerFamily, query) {
  const obj = item && typeof item === "object" ? item : {};
  const picked = pickUrlPriority(obj);

  let urlCandidate = resolveRelativeUrl(picked, baseUrl);

  // search providers url vermezse üret
  if (isBadUrlS200(urlCandidate)) {
    const q = String(query || "").trim();
    if (providerFamily === "osm") urlCandidate = osmSearchUrl(q);
    else if (providerFamily === "serpapi") urlCandidate = googleSearchUrl(buildSerpOfficeQuery(q));
    else if (providerFamily === "googleplaces") urlCandidate = mapsSearchUrl(q);
  }

  const fixField = (k) => resolveRelativeUrl(obj?.[k], baseUrl);

  return {
    ...obj,
    url: urlCandidate || obj.url,
    originUrl: fixField("originUrl") || obj.originUrl,
    finalUrl: fixField("finalUrl") || obj.finalUrl,
    deeplink: fixField("deeplink") || obj.deeplink,
    deepLink: fixField("deepLink") || obj.deepLink,
    affiliateUrl: fixField("affiliateUrl") || obj.affiliateUrl,
    link: fixField("link") || obj.link,
    href: fixField("href") || obj.href,
    website: fixField("website") || obj.website,
  };
}

// ============================================================================
// NAV FALLBACK ITEM (NO FAKE PRICE) — soft-fail / empty result UX
// ============================================================================
function buildOfficeFallbackNavItem(providerKey, query, vertical = "office", region = "TR", reason = "soft_fail") {
  try {
    const pk = canonicalProviderKey(providerKey, "office");
    const fam = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    const q = String(query || "").trim() || "ofis malzemeleri";

    const url =
      fam === "googleplaces"
        ? mapsSearchUrl(q)
        : fam === "osm"
        ? osmSearchUrl(q)
        : fam === "serpapi"
        ? googleSearchUrl(buildSerpOfficeQuery(q))
        : googleSearchUrl(`${fam} ${q} ofis kırtasiye`);

    const title = nonEmptyTitleS200(`${fam} üzerinde ara: ${q}`, "ofis üzerinde ara");
    const core = normalizeItemS200(
      {
        id: stableIdS200(pk, url, title),
        title,
        url,
        price: null,
        finalPrice: null,
        optimizedPrice: null,
        rating: null,
        currency: "TRY",
        region,
        fallback: true,
        raw: { fallbackNav: true, reason, query: q },
      },
      pk,
      {
        vertical,
        category: "office",
        providerFamily: fam,
        baseUrl,
        fallbackUrl: url,
        region,
        requireRealUrlCandidate: false,
        titleFallback: "ofis üzerinde ara",
      }
    );

    if (!core || !core.url || isBadUrlS200(core.url)) return null;

    return {
      ...core,
      id: stableIdS200(pk, core.url, core.title),
      provider: fam,
      providerKey: pk,
      providerFamily: fam,
      category: "office",
      vertical,
      price: null,
      finalPrice: null,
      optimizedPrice: null,
      rating: null,
      reviewCount: 0,
      affiliateUrl: null,
      deeplink: core.url,
      originUrl: core.url,
      finalUrl: core.url,
      fallback: true,
      raw: { ...(core.raw || {}), fallbackNav: true, reason, query: q },
    };
  } catch {
    return null;
  }
}

// ============================================================================
// SAFE IMPORT via KIT
// - PROD: import fail => empty fn (no crash)
// - DEV: allow stubs => NAV-only minimal result (fake fiyat yok)
// ============================================================================
const safeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "office");
    const fam = providerFamilyFromKey(pk);
    return async (query, options = {}) => {
      const region = String(options?.region || "TR").toUpperCase().trim();
      const one = buildOfficeFallbackNavItem(pk, query, "office", region, `import_stub:${fam}`);
      return one ? [one] : [];
    };
  },
  defaultFn: async () => [],
});

// ============================================================================
// ADAPTER IMPORTS
// ============================================================================
const searchTrendyolAdapter = await safeImport("../trendyolAdapter.js", "searchTrendyolAdapter");
const searchHepsiburadaAdapter = await safeImport("../hepsiburadaAdapter.js", "searchHepsiburadaAdapter");
const searchN11Adapter = await safeImport("../n11Adapter.js", "searchN11Adapter");
const searchCicekSepetiAdapter = await safeImport("../ciceksepetiAdapter.js", "searchCiceksepetiAdapter");
const searchKoctasAdapter = await safeImport("../koctasAdapter.js", "searchKoctasAdapter");

const searchMigrosAdapter = await safeImport("../migrosAdapter.js", "searchMigrosAdapter");
const searchCarrefourAdapter = await safeImport("../carrefourAdapter.js", "searchCarrefourAdapter");
const searchA101Adapter = await safeImport("../a101Adapter.js", "searchA101Adapter");
const searchSokAdapter = await safeImport("../sokAdapter.js", "searchSokAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// TIMEOUT
// ============================================================================
const officeTimeoutConfig = {
  trendyol: 3500,
  hepsiburada: 3500,
  n11: 3500,
  ciceksepeti: 3500,
  koctas: 5200, // ✅ bumped
  avansas: 3500,
  migros: 3500,
  carrefour: 3500,
  a101: 3500,
  sok: 3500,
  googleplaces: 3500,
  osm: 3500,
  serpapi: 3500,
  default: 3500,
};
const getOfficeTimeout = (providerKey) => officeTimeoutConfig[providerKey] || officeTimeoutConfig.default;

// ============================================================================
// NORMALIZE + affiliate inject (KIT core)
// ============================================================================
function normalizeOfficeItemViaKit(item, providerKey, vertical, query, region = "TR") {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const fam = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const patched = patchUrlsForKit(item, baseUrl, fam, query);
  const discovery = isDiscoveryFamily(fam);

  const norm = normalizeItemS200(patched, pk, {
    vertical,
    category: "office",
    providerFamily: fam,
    baseUrl,
    region,
    requireRealUrlCandidate: !discovery,
    titleFallback: `${fam} ofis`,
  });

  if (!norm) return null;

  // discovery providers: sterile (no price, no affiliate)
  if (discovery) {
    norm.price = null;
    norm.finalPrice = null;
    norm.optimizedPrice = null;
    norm.affiliateUrl = null;
  }

  // affiliate inject (discovery OFF)
  if (!discovery && !norm.affiliateUrl && norm.url && !isBadUrlS200(norm.url) && typeof buildAffiliateUrl === "function") {
    try {
      const built = buildAffiliateUrl(pk, norm.url);
      const aff = built ? normalizeUrlS200(built, baseUrl) : "";
      if (aff && !isBadUrlS200(aff)) norm.affiliateUrl = aff;
    } catch {}
  }

  // provider canonical (garanti)
  norm.provider = fam;
  norm.providerKey = pk;
  norm.providerFamily = fam;

  return norm;
}

// ============================================================================
// WRAP — engine uyumu için fn => Array<Item>
// (soft-fail => NAV fallback item) — default sadece discovery providers
// ============================================================================
function wrapOfficeAdapter(providerKey, fn, timeoutMs = 2600, vertical = "office") {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const fam = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const discovery = isDiscoveryFamily(fam);

  return {
    name: `${pk}_office`,
    provider: fam,
    providerKey: pk,
    providerFamily: fam,
    timeoutMs,

    meta: {
      provider: fam,
      providerKey: pk,
      providerFamily: fam,
      providerType: "office",
      vertical,
      category: "office",
      version: "S200",
      weight: 1.0,
      baseUrl,
    },

    fn: async (query, options = {}) => {
      const region = String(options?.region || "TR").toUpperCase().trim();

      // ✅ GLOBAL CTX set/restore — kit/coerce loglarında [S200][unknown] düşmesin
      const prev = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = { adapter: pk, url: baseUrl };

      try {
        // ✅ COOL DOWN WRAP — gerçek fn(query, ctx) çağrısı burada
                // Hard outer cap: cooldown/acquire must not hang beyond smoke-test outer timeout.
        const hardLimit = Math.min(
          6000,
          Math.max(timeoutMs + 900, Math.floor(timeoutMs * 2 + 500))
        );

        const out = await withTimeout(() => runWithCooldownS200(
          pk,
          async () => {
            const startedAt = Date.now();
            const label = `${pk}:office`;

            // 1) (query, options)
            try {
              return await withTimeout(() => fn(query, options), timeoutMs, label);
            } catch (err1) {
              const msg1 = String(err1?.message || "");
              const elapsed = Date.now() - startedAt;
              const remainingRaw = timeoutMs - elapsed;

              const isTimeout1 = err1?.name === "TimeoutError" || /timed out/i.test(msg1) || /ETIMEDOUT/i.test(msg1);
              if (isTimeout1 || remainingRaw <= 0) throw err1;

              const remaining = Math.max(150, remainingRaw);
              // 2) (query, region)
              return await withTimeout(() => fn(query, region), remaining, label);
            }
          },
          { group: "office", query, providerKey: pk, timeoutMs }
        ), hardLimit, `${pk}:office:outer`);

        const items = coerceItemsS200(out);
        const norm = items
          .filter(Boolean)
          .map((it) => normalizeOfficeItemViaKit(it, pk, vertical, query, region))
          .filter(Boolean);

        // empty -> NAV fallback only for discovery (or explicitly forced)
        const forceNav = options?.forceNavFallback === true;
        if (!norm.length) {
          if (discovery || forceNav) {
            const one = buildOfficeFallbackNavItem(pk, query, vertical, region, "empty");
            return one ? [one] : [];
          }
          return [];
        }

        return norm;
      } catch (e) {
        const msg = String(e?.message || e);
        const status = e?.response?.status || e?.status || null;
        const soft = SOFT_FAIL_RE.test(msg) || [403, 404, 429, 500, 502, 503, 504].includes(Number(status));

        console.warn(`❌ ${pk} office adapter error:`, msg);

        // soft-fail -> NAV fallback only for discovery (or explicitly forced)
        const forceNav = options?.forceNavFallback === true;
        if (soft && (discovery || forceNav)) {
          const one = buildOfficeFallbackNavItem(pk, query, vertical, region, "soft_fail");
          return one ? [one] : [];
        }

        return [];
      } finally {
        globalThis.__S200_ADAPTER_CTX = prev;
      }
    },
  };
}

// ============================================================================
// AVANSAS Placeholder (ZERO DELETE) — S200 compliant (no fake success)
// ============================================================================
const searchAvansasAdapter = async (_query) => {
  const err = new Error("NOT_IMPLEMENTED:avansas");
  err.code = "NOT_IMPLEMENTED";
  throw err;
};

// ============================================================================
// OFFICE ADAPTER PACK — FINAL
// ============================================================================
export const officeAdapters = [
  wrapOfficeAdapter("trendyol", searchTrendyolAdapter, getOfficeTimeout("trendyol")),
  wrapOfficeAdapter("hepsiburada", searchHepsiburadaAdapter, getOfficeTimeout("hepsiburada")),
  wrapOfficeAdapter("n11", searchN11Adapter, getOfficeTimeout("n11")),
  wrapOfficeAdapter("ciceksepeti", searchCicekSepetiAdapter, getOfficeTimeout("ciceksepeti")),
  wrapOfficeAdapter("koctas", searchKoctasAdapter, getOfficeTimeout("koctas"), "office_furniture"),

  wrapOfficeAdapter("migros", searchMigrosAdapter, getOfficeTimeout("migros")),
  wrapOfficeAdapter("carrefour", searchCarrefourAdapter, getOfficeTimeout("carrefour")),
  wrapOfficeAdapter("a101", searchA101Adapter, getOfficeTimeout("a101")),
  wrapOfficeAdapter("sok", searchSokAdapter, getOfficeTimeout("sok")),

  wrapOfficeAdapter(
    "googleplaces",
    async (q, opt) => {
      const text = String(q || "");
      const boosted = text.toLowerCase().includes("ofis") ? text : `${text} ofis malzemeleri kırtasiye`;
      return searchGooglePlaces(boosted, opt || {});
    },
    getOfficeTimeout("googleplaces"),
    "office_local"
  ),

  wrapOfficeAdapter(
    "osm",
    async (q, opt) => {
      const text = String(q || "");
      const boosted = text.toLowerCase().includes("ofis") ? text : `${text} ofis mağaza kırtasiye`;
      return searchWithOpenStreetMap(boosted, opt || {});
    },
    getOfficeTimeout("osm"),
    "office_local"
  ),

  wrapOfficeAdapter(
    "serpapi",
    async (q, opt) => {
      const officeQuery = buildSerpOfficeQuery(q);
      return searchWithSerpApi(officeQuery, opt || {});
    },
    getOfficeTimeout("serpapi"),
    "office_meta"
  ),

  wrapOfficeAdapter("avansas", searchAvansasAdapter, getOfficeTimeout("avansas")),
];

export const officeAdapterFns = officeAdapters.map((x) => x.fn);

// ============================================================================
// HELPERS (korunur)
// ============================================================================
export function detectOfficeProductType(query) {
  const q = String(query || "").toLowerCase();

  if (q.includes("sandalye") || q.includes("koltuk")) return "furniture";
  if (q.includes("masa") || q.includes("desk")) return "furniture";
  if (q.includes("yazıcı") || q.includes("printer") || q.includes("fotokopi")) return "electronics";
  if (q.includes("toner") || q.includes("kartuş") || q.includes("mürekkep")) return "consumables";
  if (q.includes("kırtasiye") || q.includes("kalem") || q.includes("kağıt") || q.includes("defter")) return "stationery";
  if (q.includes("projeksiyon") || q.includes("beyaz tahta") || q.includes("flipchart")) return "presentation";
  if (q.includes("dolap") || q.includes("raf") || q.includes("depolama")) return "storage";

  return "general_office";
}

export function getOfficeAdaptersByProductType(productType) {
  const type = String(productType || "").toLowerCase();

  const typeMap = {
    furniture: ["koctas", "trendyol", "hepsiburada", "n11"],
    electronics: ["trendyol", "hepsiburada", "n11", "serpapi"],
    consumables: ["avansas", "ciceksepeti", "trendyol", "hepsiburada"],
    stationery: ["avansas", "migros", "carrefour", "a101", "sok"],
    presentation: ["koctas", "trendyol", "hepsiburada"],
    storage: ["koctas", "trendyol", "hepsiburada"],
    general_office: ["avansas", "trendyol", "hepsiburada", "n11", "ciceksepeti"],
  };

  const keys = typeMap[type] || typeMap.general_office;
  return officeAdapters.filter((a) => keys.includes(a.providerKey));
}

// ============================================================================
// OFİS ÜRÜN KATEGORİLERİ (korunur)
// ============================================================================
export const officeProductCategories = {
  furniture: ["Sandalye", "Masa", "Dolap", "Raf", "Ayaklık"],
  electronics: ["Yazıcı", "Fotokopi", "Taramalı", "Projeksiyon", "Telefon"],
  consumables: ["Toner", "Kartuş", "Kağıt", "Zımba", "Zımba teli"],
  stationery: ["Kalem", "Defter", "Klasör", "Zarf", "Post-it"],
  presentation: ["Beyaz tahta", "Flipchart", "Projeksiyon perdesi", "Sunum tahtası"],
  storage: ["Dosya dolabı", "Arşiv kutusu", "Dosya", "Klasör"],
  cleaning: ["Temizlik malzemesi", "Çöp kovası", "Süpürge", "Temizlik bezi"],
};

// ============================================================================
// STATS
// ============================================================================
export const officeAdapterStats = {
  totalAdapters: officeAdapters.length,
  categories: Object.keys(officeProductCategories),
  averageTimeout: Math.round(
    officeAdapters.reduce((sum, a) => sum + (a.timeoutMs || 2600), 0) / Math.max(1, officeAdapters.length)
  ),
  providers: officeAdapters.map((a) => a.providerKey),
  specialistProviders: ["avansas", "koctas"],
  version: "S200",
  vertical: "office",
};

// ============================================================================
// KIT/REGISTRY ENTRY — AdapterRegistry bunu toplayacak
// ============================================================================
export const OFFICE_ADAPTER_REGISTRY = {
  category: "office",
  vertical: "office",
  version: "S200",
  adapters: officeAdapters,
  adapterFns: officeAdapterFns,
  stats: officeAdapterStats,
  detectType: detectOfficeProductType,
  getAdaptersByType: getOfficeAdaptersByProductType,
};

export default officeAdapters;
