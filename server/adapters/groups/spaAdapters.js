// server/adapters/groups/spaAdapters.js
// ============================================================================
// SPA / WELLNESS ADAPTER GROUP — S200 ULTRA FINAL TITAN HARMONY → KIT-LOCKED V13.2
// Ana Motor ile %100 UYUMLU — Zero Delete — Contract Lock + Provider Canon + URL Priority
// - Single source: server/core/s200AdapterKit.js
// - withTimeout everywhere
// - normalizeItemS200 contract lock (title+url, price<=0 => null)
// PATCH (V13.2):
// - ✅ NO FAKE DOMAIN: getDomain/baseUrl artık uydurma family.com üretmez
// - ✅ NO RANDOM ID: stub/placeholder dahil stableId deterministik
// - ✅ PROD import fail: ok:false + empty (mask yok)
// - ✅ Discovery (google/serp/osm): affiliate OFF, price forced null
// - ✅ Placeholder: Maps araması + price:null + rating:null (dürüst)
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  priceOrNullS200,
  isBadUrlS200,
  normalizeUrlS200,
} from "../../core/s200AdapterKit.js";

// STUB’lar prod’da kapalı olmalı.
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ---------------------------------------------------------------------------
// SOFT_FAIL_POLICY_V1 (external/network/API flakiness must not fail STRICT)
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTPCLIENT_NON_2XX|HTTPCLIENT|axios|socket hang up|No data received|CERT_|certificate|TLS|SSL|captcha|blocked|denied|unauthorized|forbidden|payment required|quota|rate limit|too many requests|SERPAPI|serpapi|api key|apikey|invalid api key|\b400\b|\b401\b|\b402\b|\b403\b|\b404\b|\b408\b|\b409\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

function isSoftFail(errOrMsg) {
  try {
    const status = Number(errOrMsg?.response?.status || errOrMsg?.status || NaN);
    if (Number.isFinite(status) && [400, 401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
    const msg = String(errOrMsg?.message || errOrMsg?.error || errOrMsg || "");
    return SOFT_FAIL_RE.test(msg);
  } catch {
    return false;
  }
}

const HAS_SERPAPI = Boolean(process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY);

const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// Optional affiliate engine (ASLA crash etmez)
// ============================================================================
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok
}

// ============================================================================
// Optional provider normalizer (ASLA crash etmez)
// ============================================================================
let _normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") _normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ============================================================================
// QUERY BOOSTER — SPA / WELLNESS
// ============================================================================
function buildSpaQuery(q) {
  const t = String(q || "").toLowerCase();

  if (t.includes("masaj") || t.includes("massage")) return "massage spa thai aromatherapy deep tissue";
  if (t.includes("hamam") || t.includes("hammam")) return "turkish bath hammam sauna spa";
  if (t.includes("sauna")) return "sauna spa wellness hot stone";
  if (t.includes("güzellik") || t.includes("beauty") || t.includes("cilt")) return "beauty salon skin care spa";
  if (t.includes("wellness")) return "spa wellness center massage";

  return "spa massage sauna hammam wellness beauty center";
}

// Backward-compat alias (some callers used buildSerpQuery)
const buildSerpQuery = buildSpaQuery;

// ============================================================================
// PRICE CLEANER — S200 (STRICT)  [ZERO DELETE]
// ============================================================================
function cleanPriceS200(v) {
  return priceOrNullS200(v);
}

// ============================================================================
// URL helpers
// ============================================================================
function mapsSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "spa");
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
function googleSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "spa wellness");
  return `https://www.google.com/search?q=${query}`;
}

// ============================================================================
// PROVIDER KEY CANON (S9 destekli ama "unknown/null/undefined" ile ezme YASAK)
// ============================================================================
function canonProviderKey(providerKey) {
  const raw = fixKey(providerKey || "") || "spa";
  try {
    if (typeof _normalizeProviderKeyS9 === "function") {
      const n = _normalizeProviderKeyS9(raw);
      const nk = fixKey(n);
      if (nk && nk !== "unknown" && nk !== "null" && nk !== "undefined") return nk;
    }
  } catch {}
  return raw;
}

function providerFamilyFromKey(providerKeyNorm) {
  const pk = canonProviderKey(providerKeyNorm);
  const fam = fixKey(String(pk || "").split("_")[0] || pk) || "spa";
  return fam || "spa";
}

function isDiscoveryFamily(fam) {
  const f = String(fam || "").toLowerCase();
  return f === "googleplaces" || f === "serpapi" || f === "osm";
}
function isPlaceholderFamily(fam) {
  const f = String(fam || "").toLowerCase();
  return f === "beautycenter" || f === "masajsalonu";
}

// ============================================================================
// BASE ROOT + FALLBACK URL (NO FAKE DOMAIN)
// ============================================================================
function baseRootForFamily(fam) {
  const f = String(fam || "").toLowerCase().trim();

  if (f === "googleplaces") return "https://www.google.com/maps/";
  if (f === "serpapi") return "https://www.google.com/";
  if (f === "osm") return "https://www.openstreetmap.org/";

  if (f === "spamican") return "https://www.mican.com.tr/";
  if (f === "spaneredekal") return "https://www.neredekal.com/";
  if (f === "spabiletino") return "https://www.biletino.com/";

  if (f === "beautycenter" || f === "masajsalonu") return "https://www.google.com/maps/";

  // bilinmeyen family -> uydurma domain yok
  return "https://www.google.com/";
}

function fallbackUrlForFamily(fam, query = "") {
  const f = String(fam || "").toLowerCase().trim();
  const q = String(query || "").trim() || "spa";

  if (f === "googleplaces" || f === "beautycenter" || f === "masajsalonu") return mapsSearchUrl(q);
  if (f === "serpapi") return googleSearchUrl(buildSpaQuery(q));
  if (f === "osm") return googleSearchUrl(`${q} spa wellness`);

  // direct providerlar bile “fallback” olarak google search dönebilir (nav)
  return googleSearchUrl(`${q} ${f} spa wellness`);
}

// ============================================================================
// DOMAIN MAP (providerKey bazlı) — ZERO DELETE
// NOTE: Artık fake `${family}.com` YOK. Geriye uyum için baseRoot döndürüyor.
// ============================================================================
function getDomain(providerKey) {
  const p = String(providerKey || "").toLowerCase();
  const family = p.split("_")[0] || p;

  // known keys / families
  const map = {
    spamican: "https://www.mican.com.tr/",
    spaneredekal: "https://www.neredekal.com/",
    spabiletino: "https://www.biletino.com/",
    googleplaces_spa: "https://www.google.com/maps/",
    googleplaces_details_spa: "https://www.google.com/maps/",
    serpapi_spa: "https://www.google.com/",
    beautycenter: "https://www.google.com/maps/",
    masajsalonu: "https://www.google.com/maps/",
  };

  return map[p] || map[family] || ""; // ✅ unknown => empty (fake yok)
}

// ============================================================================
// URL priority helper
// ============================================================================
function pickUrl(item) {
  return (
    item?.affiliateUrl ??
    item?.deeplink ??
    item?.deepLink ??
    item?.finalUrl ??
    item?.originUrl ??
    item?.url ??
    item?.website ??
    item?.link ??
    item?.href ??
    item?.raw?.affiliateUrl ??
    item?.raw?.deeplink ??
    item?.raw?.finalUrl ??
    item?.raw?.originUrl ??
    item?.raw?.url ??
    item?.raw?.website ??
    ""
  );
}

// ============================================================================
// StableId — deterministic (NO RANDOM)
// ============================================================================
function stableId(providerKey, url, title) {
  try {
    const base = `${String(providerKey || "spa")}|${String(url || "")}|${String(title || "")}`;
    return (
      String(providerKey || "spa").toLowerCase() +
      "_" +
      crypto.createHash("sha256").update(base).digest("hex").slice(0, 18)
    );
  } catch {
    const s = `${String(providerKey || "spa")}|${String(url || "")}|${String(title || "")}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return `${String(providerKey || "spa").toLowerCase()}_${(h >>> 0).toString(16).slice(0, 18)}`;
  }
}

// ============================================================================
// Affiliate URL safe wrapper (no-crash, signature tolerant)
// ============================================================================
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = _safeStr(url);
  if (!u || isBadUrlS200(u)) return "";
  if (typeof _buildAffiliateUrl !== "function") return "";

  // object-signature first
  try {
    const r0 = _buildAffiliateUrl({ url: u, provider: providerKey, providerKey, ...extra });
    const s0 = _safeStr(r0);
    if (s0 && !isBadUrlS200(s0)) return s0;
  } catch {}

  try {
    const r = _buildAffiliateUrl(providerKey, u, extra);
    const s = _safeStr(r);
    if (s && !isBadUrlS200(s)) return s;
  } catch {}

  try {
    const r2 = _buildAffiliateUrl(u, extra);
    const s2 = _safeStr(r2);
    if (s2 && !isBadUrlS200(s2)) return s2;
  } catch {}

  try {
    const r3 = _buildAffiliateUrl(u);
    const s3 = _safeStr(r3);
    if (s3 && !isBadUrlS200(s3)) return s3;
  } catch {}

  return "";
}

// ============================================================================
// SAFE IMPORT — Dinamik import + SPA stub fallback (S200-safe)
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),

  // DEV stub: sadece NAV (Maps), price/rating yok, id deterministik
  stubFactory: (providerGuess) => {
    const provider = fixKey(providerGuess) || "spa_stub";
    return async (query, options = {}) => {
      const region = String(options?.region || "TR").toUpperCase();
      const q = _safeStr(query) || "spa";

      const url = mapsSearchUrl(`${q} spa wellness masaj hamam sauna`);
      const title = `${q} — SPA/WELLNESS araması`;
      return [
        {
          id: stableId(provider, url, title),
          title,
          price: null,
          originalPrice: null,
          url,
          provider,
          duration: "",
          includes: [],
          rating: null,
          reviewCount: 0,
          address: region,
          category: "spa",
          currency: "TRY",
          region,
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },

  // PROD import fail: observable, mask yok
  defaultFn: async () => ({
    ok: false,
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
  }),
});

async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// DİNAMİK IMPORTLAR
// ============================================================================
const searchSpaMicanAdapter = await safeImport("../spaMicanAdapter.js", "searchSpaMicanAdapter");
const searchSpaNeredekalAdapter = await safeImport("../spaNeredekalAdapter.js", "searchSpaNeredekalAdapter");
const searchSpaBiletinoAdapter = await safeImport("../spaBiletinoAdapter.js", "searchSpaBiletinoAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// SPA TYPE MAP
// ============================================================================
export const spaTypes = {
  spa: { name: "SPA / Wellness", keywords: ["spa", "wellness", "termal"] },
  massage: { name: "Masaj", keywords: ["masaj", "massage", "thai", "aroma"] },
  hammam: { name: "Hamam", keywords: ["hamam", "hammam", "turkish bath"] },
  sauna: { name: "Sauna", keywords: ["sauna", "buhar", "steam room"] },
  beauty: { name: "Güzellik Merkezi", keywords: ["güzellik", "beauty", "cilt", "manikür"] },
  general: { name: "Genel SPA", keywords: [] },
};

export function detectSpaType(query = "") {
  const q = String(query || "").toLowerCase();
  for (const [type, info] of Object.entries(spaTypes)) {
    if (info.keywords?.length && info.keywords.some((kw) => q.includes(kw))) return type;
  }
  if (q.includes("spa") || q.includes("wellness")) return "spa";
  return "general";
}

// ============================================================================
// NORMALIZER — S200 SPA NORMALIZE (STRICT CONTRACT + PROVIDER CANON)
// ============================================================================
function normalizeSpaS200(item, providerKey, query = "") {
  if (!item) return null;

  const providerKeyNorm = canonProviderKey(providerKey || item?.providerKey || item?.provider || "spa");
  const providerFamily = providerFamilyFromKey(providerKeyNorm);

  const baseUrl = baseRootForFamily(providerFamily);
  const fallbackUrl = fallbackUrlForFamily(providerFamily, query);

  const discovery = isDiscoveryFamily(providerFamily) || isPlaceholderFamily(providerFamily);

  const pickedRaw0 = _safeStr(pickUrl(item));
  const pickedRaw = pickedRaw0 && !isBadUrlS200(pickedRaw0) ? pickedRaw0 : "";

  const isAbs = /^https?:\/\//i.test(pickedRaw);
  const isRel = Boolean(pickedRaw) && !isAbs;

  // unknown family + relative url => fake-join riski: candidate sayma
  const unknownFamilyRoot = baseUrl === "https://www.google.com/" && !discovery;
  const candBad = !pickedRaw || isBadUrlS200(pickedRaw) || (isRel && unknownFamilyRoot);

  const picked = !candBad ? normalizeUrlS200(pickedRaw, baseUrl) : "";
  const synth = fallbackUrl ? normalizeUrlS200(fallbackUrl, baseUrl) : "";

  const candidateUrl = picked || synth;
  if (!candidateUrl || isBadUrlS200(candidateUrl)) return null;

  const titleRaw =
    _safeStr(item?.title || item?.name || item?.raw?.title || item?.raw?.name || item?.service || "") ||
    `${providerFamily.toUpperCase()} SPA Paketi`;
  if (!titleRaw) return null;

  const patched = {
    ...item,
    title: titleRaw,
    url: candidateUrl,
    region: String(item?.region || "TR").toUpperCase(),
    currency: String(item?.currency || item?.raw?.currency || "TRY").toUpperCase().slice(0, 3),
    fallback: Boolean(item?.fallback) || (!picked && !!synth),
  };

  const core = normalizeItemS200(patched, providerKeyNorm, {
    vertical: "spa",
    category: "spa",
    providerFamily,
    baseUrl,
    fallbackUrl: synth || baseUrl,
    requireRealUrlCandidate: true,
    region: patched.region,
    currency: patched.currency,
    priceKeys: ["price", "finalPrice", "originalPrice", "amount", "rate", "minPrice", "maxPrice"],
    titleFallback: `${providerFamily.toUpperCase()} SPA Paketi`,
  });

  if (!core) return null;
  if (!core.url || isBadUrlS200(core.url)) return null;

  // discovery/placeholder: price forced null
  let price = cleanPriceS200(
    patched.price ??
      patched.finalPrice ??
      patched.originalPrice ??
      patched.amount ??
      patched.rate ??
      patched.minPrice ??
      patched.maxPrice ??
      core.price
  );
  if (discovery) price = null;

  const originalPrice = discovery
    ? null
    : cleanPriceS200(patched.originalPrice) || (price ? Math.round(price * 1.15) : null);

  const description = patched.description || patched.summary || `Seçili SPA / wellness paketi (${providerFamily})`;

  const spaType = (() => {
    const t = titleRaw.toLowerCase();
    if (t.includes("masaj") || t.includes("massage")) return "massage";
    if (t.includes("hamam") || t.includes("hammam")) return "hammam";
    if (t.includes("sauna")) return "sauna";
    if (t.includes("güzellik") || t.includes("beauty")) return "beauty";
    if (t.includes("spa") || t.includes("wellness")) return "spa";
    return "general";
  })();

  // placeholders: rating null (hard truth)
  const ratingRaw = patched.rating ?? patched.score ?? patched.stars ?? patched.userRating ?? core.rating ?? null;
  const rating = isPlaceholderFamily(providerFamily)
    ? null
    : typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
    ? ratingRaw
    : null;

  const reviewRaw = patched.reviewCount ?? patched.reviews ?? patched.userRatingsTotal ?? core.reviewCount ?? null;
  const reviewCount = isPlaceholderFamily(providerFamily)
    ? 0
    : typeof reviewRaw === "number" && Number.isFinite(reviewRaw)
    ? Math.max(0, Math.floor(reviewRaw))
    : 0;

  const image =
    patched.image ||
    patched.photo ||
    core.image ||
    (Array.isArray(patched.images) ? patched.images[0] : "") ||
    "";

  const deeplink = normalizeUrlS200(patched.deeplink || patched.deepLink || patched.finalUrl || core.url, baseUrl) || core.url;

  // discovery/placeholder: affiliate OFF
  let affiliateUrl = null;
  if (!discovery) {
    const built =
      _safeStr(patched.affiliateUrl) ||
      buildAffiliateUrlSafe(providerKeyNorm, core.url, { query: _safeStr(query) });

    affiliateUrl = built && !isBadUrlS200(built) ? normalizeUrlS200(built, baseUrl) : null;
  }

  return {
    ...core,
    id: patched.id || patched.listingId || stableId(providerKeyNorm, core.url, titleRaw),

    title: titleRaw,

    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    price,
    finalPrice: price,
    optimizedPrice: price,
    currency: core.currency || patched.currency || "TRY",

    description,

    deeplink,
    affiliateUrl,

    providerType: "spa",
    category: "spa",
    categoryAI: "spa",
    vertical: "spa",
    spaType,

    duration: patched.duration || patched.time || "",
    includes: Array.isArray(patched.includes)
      ? patched.includes
      : Array.isArray(patched.services)
      ? patched.services
      : [],

    address: patched.address || patched.location || "",
    city: patched.city || null,

    rating,
    reviewCount,

    image,
    imageGallery: Array.isArray(patched.images) ? patched.images : [],

    region: patched.region || core.region || "TR",
    availability: patched.availability || "available",
    stockStatus: patched.stockStatus || "available",

    originalPrice,
    minPrice: discovery ? null : cleanPriceS200(patched.minPrice) ?? null,
    maxPrice: discovery ? null : cleanPriceS200(patched.maxPrice) ?? null,

    commissionRate: patched.commissionRate ?? patched.commissionMeta?.platformRate ?? 0.05,

    qualityScore: patched.qualityScore ?? (discovery ? 0.65 : 0.8),
    metaScore: patched.metaScore ?? 0,

    version: "S200",
    adapterSource: providerKeyNorm,
    fallback: Boolean(patched.fallback),

    raw: patched.raw || { legacy: patched },
  };
}

// ============================================================================
// WRAP — S200 SPA WRAPPER (canonical meta) + TIMEOUT
// ============================================================================
function wrapSpaAdapter(providerKey, fn, timeoutMs = 6000, weight = 1.0, spaType = "general") {
  const name = canonProviderKey(providerKey || "");
  const providerFamily = providerFamilyFromKey(name);

  return {
    name,
    timeoutMs,
    meta: {
      provider: providerFamily,
      providerKey: name,
      providerFamily,
      providerType: "spa",
      vertical: "spa",
      category: "spa",
      version: "S200",
      weight,
    },
    tags: ["spa", "wellness", spaType],
    fn: async (query, options = {}) => {
      const q = _safeStr(query);
      const ts = Date.now();

      try {
        const out = await withTimeout(Promise.resolve(fn(q, options)), timeoutMs, name);

        // Adapter ok:false döndürürse saygı duy (mask yok)
        if (out && typeof out === "object" && out.ok === false) {
          const soft = isSoftFail(out) || isSoftFail(out?.error) || isSoftFail(out?.message) || String(name).startsWith("serpapi");
          return {
            ok: false,
            items: [],
            count: 0,
            error: out.error || "ADAPTER_FAILED",
            source: name,
            _meta: {
              ...out._meta,
              adapter: name,
              providerFamily,
              query: q,
              vertical: "spa",
              spaType,
              softFail: Boolean(soft),
              timestamp: ts,
            },
          };
        }

        const items = coerceItemsS200(out);

        const normalizedItems = items.map((it) => normalizeSpaS200(it, name, q)).filter(Boolean);

        return {
          ok: true,
          items: normalizedItems,
          count: normalizedItems.length,
          source: name,
          _meta: {
            adapter: name,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "spa",
            spaType,
          },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const soft = isSoftFail(err) || isSoftFail(msg) || String(name).startsWith("serpapi");
        console.warn(`❌ SPA adapter error (${name}):`, msg);

        return {
          ok: false,
          items: [],
          count: 0,
          error: msg,
          timeout: err?.name === "TimeoutError",
          source: name,
          _meta: {
            adapter: name,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "spa",
            spaType,
            error: msg,
            softFail: Boolean(soft),
          },
        };
      }
    },
  };
}

// ============================================================================
// ADAPTER PACK — S200 SPA WELLNESS
// ============================================================================
export const spaAdapters = [
  wrapSpaAdapter(
    "googleplaces_spa",
    async (q, o) => {
      const text = String(q || "");
      const boosted = text.toLowerCase().includes("spa") ? text : `${text} spa wellness masaj hamam sauna`;
      return searchGooglePlaces(boosted, o);
    },
    2600,
    0.9,
    "spa"
  ),

  wrapSpaAdapter(
    "googleplaces_details_spa",
    async (q, o) => searchGooglePlacesDetails(q, o),
    2600,
    0.9,
    "spa"
  ),

  // SERPAPI (optional) — key yoksa adapter list’e girmez (STRICT import zincirini bozmaz)
  HAS_SERPAPI
    ? wrapSpaAdapter(
        "serpapi_spa",
        async (q, o) =>
          searchWithSerpApi(buildSpaQuery(q), {
            ...(o || {}),
            timeoutMs: Math.min(Number(o?.timeoutMs) || 6000, 6000),
            num: 5,
          }),
        6000,
        1.0,
        "general"
      )
    : null,

  wrapSpaAdapter("spamican", (q, o) => searchSpaMicanAdapter(q, o), 3500, 1.2, "massage"),
  wrapSpaAdapter("spaneredekal", (q, o) => searchSpaNeredekalAdapter(q, o), 3500, 1.15, "spa"),
  wrapSpaAdapter("spabiletino", (q, o) => searchSpaBiletinoAdapter(q, o), 3500, 1.1, "spa"),

  // ✅ Placeholder sağlayıcılar — YALAN YOK:
  // - url: Maps araması
  // - price: null
  // - rating: null
  // - id: deterministik stableId
  wrapSpaAdapter(
    "beautycenter",
    async (q, o = {}) => {
      // STRICT mode: placeholder items are disallowed when FINDALLEASY_ALLOW_STUBS=0
      if (!ALLOW_STUBS) {
        return { ok: false, items: [], error: "PLACEHOLDER_DISABLED", _meta: { stub: true, expectedFail: true, placeholder: true } };
      }

      const region = String(o?.region || "TR").toUpperCase();
      const query = _safeStr(q || "güzellik merkezi") || "güzellik merkezi";
      const url = mapsSearchUrl(`${query} güzellik merkezi`);
      const title = `${query} - Güzellik Merkezi (Arama)`;
      return [
        {
          id: stableId("beautycenter", url, title),
          title,
          price: null,
          originalPrice: null,
          url,
          provider: "beautycenter",
          duration: "",
          includes: [],
          rating: null,
          reviewCount: 0,
          category: "spa",
          currency: "TRY",
          region,
          fallback: true,
          qualityScore: 0.4,
          raw: { placeholder: true },
        },
      ];
    },
    900,
    0.65,
    "beauty"
  ),

  wrapSpaAdapter(
    "masajsalonu",
    async (q, o = {}) => {
      // STRICT mode: placeholder items are disallowed when FINDALLEASY_ALLOW_STUBS=0
      if (!ALLOW_STUBS) {
        return { ok: false, items: [], error: "PLACEHOLDER_DISABLED", _meta: { stub: true, expectedFail: true, placeholder: true } };
      }

      const region = String(o?.region || "TR").toUpperCase();
      const query = _safeStr(q || "masaj") || "masaj";
      const url = mapsSearchUrl(`${query} masaj salonu`);
      const title = `${query} - Masaj Salonu (Arama)`;
      return [
        {
          id: stableId("masajsalonu", url, title),
          title,
          price: null,
          originalPrice: null,
          url,
          provider: "masajsalonu",
          duration: "",
          includes: [],
          rating: null,
          reviewCount: 0,
          category: "spa",
          currency: "TRY",
          region,
          fallback: true,
          qualityScore: 0.4,
          raw: { placeholder: true },
        },
      ];
    },
    900,
    0.65,
    "massage"
  ),
].filter(Boolean);

// Eski isimlerle uyum için alias'lar
export const spaWellnessAdapters = spaAdapters;
export const spaAdapterFns = spaAdapters.map((a) => a.fn);
export const spaWellnessFns = spaAdapters.map((a) => a.fn);

// ============================================================================
// UNIFIED SPA / WELLNESS SEARCH — S200 (no “zeki boş dönme”)
// ============================================================================
export async function searchSpa(query, options = {}) {
  const spaType = detectSpaType(query);
  const location = options.location || "";
  const region = options.region || "TR";

  let relevantAdapters = spaAdapters;

  if (spaType !== "general") {
    relevantAdapters = spaAdapters.filter((a) => a.tags.includes(spaType) || a.tags.includes("spa") || a.name.includes(spaType));
    if (!relevantAdapters.length) relevantAdapters = spaAdapters;
  }

  const results = [];

  await Promise.allSettled(
    relevantAdapters.map(async (adapter) => {
      try {
        const result = await adapter.fn(query, { ...options, region });
        if (result && result.ok && Array.isArray(result.items) && result.items.length) results.push(...result.items);
      } catch (err) {
        console.warn(`⚠️ SPA unified search error (${adapter.name}):`, err?.message || err);
      }
    })
  );

  // ✅ filtre yüzünden 0 çıktıysa full fallback
  if (!results.length && relevantAdapters.length !== spaAdapters.length) {
    await Promise.allSettled(
      spaAdapters.map(async (adapter) => {
        try {
          const result = await adapter.fn(query, { ...options, region });
          if (result && result.ok && Array.isArray(result.items) && result.items.length) results.push(...result.items);
        } catch {}
      })
    );
  }

  return {
    ok: true,
    items: results,
    count: results.length,
    spaType,
    typeInfo: spaTypes[spaType]?.name || "SPA",
    source: "spa_search",
    _meta: {
      query,
      location,
      region,
      adapterCount: relevantAdapters.length,
      totalAdapters: spaAdapters.length,
      timestamp: Date.now(),
    },
  };
}

// ============================================================================
// ADAPTER STATS & REGISTRY
// ============================================================================
export const spaAdapterStats = {
  totalAdapters: spaAdapters.length,
  spaTypes,
  providers: spaAdapters.map((a) => a.name),
  totalWeight: spaAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
};

export const SPA_ADAPTER_REGISTRY = {
  category: "spa",
  adapters: spaAdapters,
  version: "S200",
  engine: "TEK_ÇEKİRDEK_ADAPTER_ENGINE",
  lastUpdated: new Date().toISOString(),
};

export default spaWellnessAdapters;
