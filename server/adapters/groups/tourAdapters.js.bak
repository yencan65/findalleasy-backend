// server/adapters/groups/tourAdapters.js
// ============================================================================
// TOUR ADAPTER GROUP — S200 ULTRA FINAL TITAN HARMONY V15.1 (KIT-LOCKED)
// Ana Motor ile %100 Uyumlu — Contract Lock + URL Priority + Zero Crash
// - Single source: server/core/s200AdapterKit.js
// - withTimeout everywhere
// - normalizeItemS200 contract lock (title+url, price<=0 => null)
// - URL priority: affiliateUrl/deeplink/finalUrl → originUrl → url
//
// IMPORTANT:
// - PROD'da FAKE/STUB veri YASAK. Import fail → ok:false + empty.
// - Affiliate injection "best-effort": affiliateEngine varsa uygular, yoksa url korunur.
// - Discovery providers (googleplaces/serpapi): price forced null + affiliate OFF
// - ✅ S200 global ctx injected (kit logs won't say "unknown")
//
// PATCH (V15.1):
// - ✅ NO FAKE DOMAIN: getDomain() artık `${family}.com` uydurmaz
// - ✅ baseUrl empty bug fix: domain yoksa google root fallback
// - ✅ stableId URL-merkezli (title drift cache/AB bozmasın) — signature korunur
// - ✅ unknown family + relative url → fake-join yok, fallback search URL’ye düş
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  priceOrNullS200,
  isBadUrlS200 as kitIsBadUrlS200,
  normalizeUrlS200 as kitNormalizeUrlS200,
} from "../../core/s200AdapterKit.js";

// STUB’lar prod’da KESİNLİKLE kapalı olmalı.
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

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
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// SERPAPI availability (avoid strict smoke-test fails when key missing)
const HAS_SERPAPI = Boolean(process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY);


const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// Optional affiliate engine (ASLA crash etmez) — dynamic import
// ============================================================================
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok (no affiliate engine in some builds)
}

// ============================================================================
// Optional provider normalizer (ASLA crash etmez) — S9 best-effort
// ============================================================================
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ============================================================================
// S200 GLOBAL CTX — makes kit logs attribute to the real adapter (not "unknown")
// ============================================================================
function withS200Ctx(ctx, fn) {
  const g = globalThis;
  const prev = g.__S200_ADAPTER_CTX;
  try {
    g.__S200_ADAPTER_CTX = { ...(prev || {}), ...(ctx || {}) };
    return fn();
  } finally {
    g.__S200_ADAPTER_CTX = prev;
  }
}

// ============================================================================
// SAFE IMPORT — S200 Güvenli Dinamik Import (zero-crash)  [ZERO DELETE]
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  // Fake data yok: stub da ok:false/empty dönsün
  stubFactory: (providerGuess) => {
    const providerKey = fixKey(providerGuess) || "tour";
    return async () => ({
      ok: false,
      provider: providerKey,
      providerKey,
      category: "tour",
      items: [],
      count: 0,
      error: "IMPORT_FAILED",
      message: `Adapter import failed (stub): ${providerKey}`,
      _meta: { stub: true },
    });
  },
  // Import fail fallback: function döndür (çağrılır), ok:false ile pipeline net kalsın
  defaultFn: async () => ({
    ok: false,
    provider: "tour",
    providerKey: "tour",
    category: "tour",
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
  }),
});

// ZERO DELETE: eski safeImport ismi kalsın
async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// DİNAMİK IMPORTLAR
// ============================================================================
const searchEtsAdapter = await safeImport("../etsAdapter.js");
const searchEtsturAdapter = await safeImport("../etsturAdapter.js");
const searchSeturAdapter = await safeImport("../seturAdapter.js");
const searchJollyTurAdapter = await safeImport("../jollyAdapter.js", "searchJollyTurAdapter");
const searchTatilBudurAdapter = await safeImport("../tatilbudurAdapter.js", "searchTatilBudurAdapter");

const searchSpaBiletinoAdapter = await safeImport("../spaBiletinoAdapter.js", "searchSpaBiletinoAdapter");
const searchSpaNeredekalAdapter = await safeImport("../spaNeredekalAdapter.js", "searchSpaNeredekalAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");

const searchMNGTurAdapter = await safeImport("../mngTurAdapter.js", "searchMNGTurAdapter");
const searchBoatTourAdapter = await safeImport("../boatTourAdapter.js", "searchBoatTourAdapter");
const searchKapadokyaAdapter = await safeImport("../kapadokyaAdapter.js", "searchKapadokyaAdapter");
const searchPamukkaleAdapter = await safeImport("../pamukkaleAdapter.js", "searchPamukkaleAdapter");

const searchActivitiesAdapter = await safeImport("../activitiesAdapter.js", "searchActivitiesAdapter");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// QUERY BOOSTER (SORGUYU ÖLDÜRMEZ — ÜZERİNE EKLER)
// ============================================================================
function buildTourQuery(q) {
  const raw = _safeStr(q);
  const t = raw.toLowerCase();

  // “replace” değil, “augment” → lokasyon/niyet kaybolmasın
  if (t.includes("kapadokya")) return `${raw} cappadocia hot air balloon tour`;
  if (t.includes("pamukkale")) return `${raw} pamukkale travertines hierapolis tour`;
  if (t.includes("tekne") || t.includes("boat")) return `${raw} boat tour daily trip`;
  if (t.includes("mavi")) return `${raw} blue cruise boat tour`;
  if (t.includes("ski") || t.includes("kayak")) return `${raw} ski tour`;
  if (t.includes("rafting")) return `${raw} rafting adventure`;
  return `${raw} turkey daily tour trip excursion travel activities`;
}

// ============================================================================
// PRICE / URL HELPERS (STRICT)  [ZERO DELETE]
// ============================================================================
function cleanPriceS200(v) {
  return priceOrNullS200(v);
}
function isBadUrl(u) {
  return kitIsBadUrlS200(u);
}
function normalizeUrl(u, base) {
  return kitNormalizeUrlS200(u, base);
}

// URL priority helper (kept - ZERO DELETE)
function pickUrl(item) {
  return (
    item?.affiliateUrl ??
    item?.deeplink ??
    item?.deepLink ??
    item?.finalUrl ??
    item?.originUrl ??
    item?.url ??
    item?.link ??
    item?.href ??
    item?.website ??
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
// Provider canonical helpers (S9 best-effort)
// ============================================================================
function canonProviderKey(raw) {
  let k = fixKey(raw || "") || "tour";
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(k);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") k = nn || k;
    }
  } catch {}
  if (!k || k === "unknown" || k === "null" || k === "undefined") k = "tour";
  return k;
}

// ============================================================================
// Affiliate URL safe wrapper (signature drift-proof)
// ============================================================================
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = _safeStr(url);
  if (!u || isBadUrl(u)) return "";
  if (typeof _buildAffiliateUrl !== "function") return "";

  // object signature first (drift-proof)
  try {
    const r0 = _buildAffiliateUrl({ url: u, provider: providerKey, providerKey, ...extra });
    const s0 = _safeStr(r0);
    if (s0 && !isBadUrl(s0)) return s0;
  } catch {}

  try {
    // most likely: buildAffiliateUrl(providerKey, url, extra)
    const r = _buildAffiliateUrl(providerKey, u, extra);
    const s = _safeStr(r);
    if (s && !isBadUrl(s)) return s;
  } catch {}

  try {
    // alt: buildAffiliateUrl(url, extra)
    const r2 = _buildAffiliateUrl(u, extra);
    const s2 = _safeStr(r2);
    if (s2 && !isBadUrl(s2)) return s2;
  } catch {}

  try {
    // alt: buildAffiliateUrl(url)
    const r3 = _buildAffiliateUrl(u);
    const s3 = _safeStr(r3);
    if (s3 && !isBadUrl(s3)) return s3;
  } catch {}

  return "";
}

// ============================================================================
// Currency normalizer (TL/₺ -> TRY)
// ============================================================================
function normalizeCurrency(v) {
  const s = _safeStr(v).toUpperCase();
  if (!s) return "TRY";
  if (s === "₺" || s === "TL" || s.includes(" TL") || s.includes("₺") || s.includes("TRY")) return "TRY";
  if (s.includes("USD") || s.includes("$")) return "USD";
  if (s.includes("EUR") || s.includes("€")) return "EUR";
  if (s.includes("GBP") || s.includes("₤")) return "GBP";
  return s.replace(/\s+/g, "").slice(0, 3) || "TRY";
}

// ============================================================================
// DOMAIN MAP (providerKey bazlı) — NO FAKE DOMAIN
// ============================================================================
function getDomain(providerKey) {
  const p = String(providerKey || "").toLowerCase();
  const map = {
    ets: "etstur.com",
    etstur: "etstur.com",
    setur: "setur.com.tr",
    jolly: "jollytur.com",
    tatilbudur: "tatilbudur.com",

    biletino_tour: "biletino.com",
    neredekal_tour: "neredekal.com",

    mngtur: "mngtur.com.tr",

    googleplaces: "google.com/maps",
    googleplaces_tour: "google.com/maps",
    googleplaces_details_tour: "google.com/maps",

    serpapi_tour: "google.com",
    serpapi: "google.com",

    activities_global: "getyourguide.com",
  };
  const family = p.split("_")[0] || p;

  // ✅ unknown => empty (no `${family}.com` uydurma YOK)
  return map[p] || map[family] || "";
}

// ============================================================================
// baseUrl + fallbackUrl (search) — normalizeUrl için kritik (no fake)
// ============================================================================
const mapsSearchUrl = (q) => {
  const t = _safeStr(q);
  return t ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}` : "https://www.google.com/maps";
};
const googleSearchUrl = (q) => {
  const t = _safeStr(q);
  return t ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : "https://www.google.com/";
};

function baseRootFor(providerKeyNorm) {
  const dom = getDomain(providerKeyNorm);
  if (dom) return dom.includes("http") ? dom : `https://www.${dom}/`;

  const fam = String(providerKeyNorm || "").toLowerCase().split("_")[0] || "tour";
  if (fam === "googleplaces") return "https://www.google.com/maps/";
  if (fam === "serpapi") return "https://www.google.com/";
  return "https://www.google.com/";
}

function fallbackSearchUrlFor(providerKeyNorm, query = "", titleHint = "") {
  const fam = String(providerKeyNorm || "").toLowerCase().split("_")[0] || "tour";
  const q = _safeStr(query) || _safeStr(titleHint) || "tour";

  if (fam === "googleplaces") return mapsSearchUrl(`${q} tur`);
  if (fam === "serpapi") return googleSearchUrl(buildTourQuery(q));

  const cleanedFam = fam.replace(/[^a-z0-9]/gi, "");
  const hint = [cleanedFam || "tour", q, "tur"].filter(Boolean).join(" ");
  return googleSearchUrl(hint);
}

// ============================================================================
// Stable id (NO RANDOM EVER) — URL merkezli (title drift yok)
// signature korunuyor (title paramı bilerek IGNORE) — geriye uyumlu
// ============================================================================
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function stableId(providerKey, url, _titleIgnored) {
  const pk = String(providerKey || "tour").toLowerCase();
  const u = String(url || "");
  const base = `${pk}|${u}`; // ✅ title yok
  try {
    return `${pk}_${crypto.createHash("sha256").update(base).digest("hex").slice(0, 18)}`;
  } catch {
    const a = _fnv1a32(base);
    const b = _fnv1a32(base + "|x");
    return `${pk}_${(a + b).slice(0, 18)}`;
  }
}

// ============================================================================
// NORMALIZER S200 (STRICT CONTRACT) — KIT CORE + TOUR ENRICH
// ============================================================================
function normalizeTourS200(item, providerKey, query = "") {
  if (!item) return null;

  const providerKeyNorm = canonProviderKey(providerKey || item?.providerKey || item?.provider || "tour");
  const providerFamily = String(providerKeyNorm).split("_")[0] || "tour";

  const isDiscovery = providerFamily === "googleplaces" || providerFamily === "serpapi";

  const baseUrl = baseRootFor(providerKeyNorm);

  // title
  const titleRaw =
    _safeStr(item.title || item.name || item.heading || item.raw?.title || item.raw?.name) ||
    `${providerFamily} turu`;
  if (!titleRaw) return null;

  const fallbackUrl = fallbackSearchUrlFor(providerKeyNorm, query, titleRaw);

  // URL candidates
  const urlCandidate = _safeStr(pickUrl(item));
  const isAbs = /^https?:\/\//i.test(urlCandidate);
  const isRel = Boolean(urlCandidate) && !isAbs;

  // ✅ unknown family + relative url = FAKE-JOIN riski → candidate sayma
  const unknownFamilyRoot = baseUrl === "https://www.google.com/" && !isDiscovery;
  const candBad = !urlCandidate || isBadUrl(urlCandidate) || (isRel && unknownFamilyRoot);

  // normalize each candidate safely
  const cAffiliate = !candBad ? normalizeUrl(item.affiliateUrl || item.raw?.affiliateUrl || "", baseUrl) : "";
  const cDeeplink = !candBad
    ? normalizeUrl(item.deeplink || item.deepLink || item.raw?.deeplink || item.raw?.deepLink || "", baseUrl)
    : "";
  const cFinal = !candBad ? normalizeUrl(item.finalUrl || item.raw?.finalUrl || "", baseUrl) : "";
  const cOrigin = !candBad ? normalizeUrl(item.originUrl || item.raw?.originUrl || "", baseUrl) : "";

  let cUrl = !candBad
    ? normalizeUrl(
        urlCandidate || item.url || item.link || item.href || item.website || item.raw?.url || "",
        baseUrl
      )
    : "";

  // discovery + empty: synth search URL
  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl) {
    const synth =
      providerFamily === "googleplaces"
        ? mapsSearchUrl(query || titleRaw)
        : providerFamily === "serpapi"
        ? googleSearchUrl(buildTourQuery(query || titleRaw))
        : fallbackUrl;
    cUrl = synth ? normalizeUrl(synth, baseUrl) : "";
  }

  const clickUrl = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;
  if (!clickUrl || isBadUrl(clickUrl)) return null;

  // kit core: contract lock + url priority + price>0 else null
  const core = normalizeItemS200(
    {
      ...item,
      title: titleRaw,
      url: clickUrl,
      originUrl: cOrigin || clickUrl,
      finalUrl: cFinal || cDeeplink || cAffiliate || clickUrl,
      deeplink: cDeeplink || null,
      affiliateUrl: cAffiliate || null,
      currency: normalizeCurrency(item?.currency || item?.raw?.currency || "TRY"),
      region: String(item?.region || "TR").toUpperCase(),
      fallback: Boolean(item?.fallback) || (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && clickUrl === cUrl),
    },
    providerKeyNorm,
    {
      vertical: "tour",
      category: "tour",
      providerFamily,
      baseUrl,
      fallbackUrl,
      requireRealUrlCandidate: true,
      priceKeys: ["price", "finalPrice", "amount", "rate", "minPrice", "maxPrice", "totalPrice", "total_price"],
    }
  );

  if (!core || !_safeStr(core.url) || isBadUrl(core.url)) return null;

  // tourType heuristic (mevcut mantık korunur)
  const titleLower = titleRaw.toLowerCase();
  let tourType = "general";
  if (titleLower.includes("balon") || titleLower.includes("balloon")) tourType = "balloon";
  else if (titleLower.includes("mavi") || titleLower.includes("blue")) tourType = "blue_cruise";
  else if (titleLower.includes("tekne") || titleLower.includes("boat")) tourType = "boat";
  else if (titleLower.includes("safari")) tourType = "safari";
  else if (titleLower.includes("yemek") || titleLower.includes("food")) tourType = "food";
  else if (titleLower.includes("kültür") || titleLower.includes("culture")) tourType = "culture";

  // price (discovery: forced null)
  let price = cleanPriceS200(
    item.price ??
      item.finalPrice ??
      item.amount ??
      item.rate ??
      item.minPrice ??
      item.maxPrice ??
      core.price
  );
  if (isDiscovery) price = null;

  const minPrice = isDiscovery ? null : cleanPriceS200(item.minPrice) || (price || null);
  const maxPrice = isDiscovery ? null : cleanPriceS200(item.maxPrice) || (price || null);

  const deeplink =
    normalizeUrl(item.deeplink || item.deepLink || item.finalUrl || core.url, baseUrl) || core.url;

  // discovery’de affiliate injection YASAK
  let affiliateUrl = normalizeUrl(item.affiliateUrl || "", baseUrl) || null;
  if (!isDiscovery) {
    if (!affiliateUrl || isBadUrl(affiliateUrl)) {
      const built = buildAffiliateUrlSafe(providerKeyNorm, core.url, { query: _safeStr(query) });
      affiliateUrl = built && !isBadUrl(built) ? normalizeUrl(built, baseUrl) : null;
    }
  } else {
    affiliateUrl = null;
  }

  return {
    ...core,
    id: item.id || item.listingId || stableId(providerKeyNorm, core.url, titleRaw),

    title: titleRaw,
    price,
    finalPrice: price,
    optimizedPrice: price,
    currency: normalizeCurrency(core.currency || item.currency || "TRY"),

    // ✅ canonical provider fields
    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    rating:
      typeof item.rating === "number" && Number.isFinite(item.rating)
        ? item.rating
        : typeof item.score === "number" && Number.isFinite(item.score)
        ? item.score
        : core.rating ?? null,

    region: item.region || core.region || "TR",
    location: item.location || "",
    description: item.description || "",
    duration: item.duration || "",
    tourType,

    image: item.image || item.photo || core.image || "",
    imageGallery: Array.isArray(item.images) ? item.images : [],

    commissionRate:
      typeof item.commissionRate === "number" && Number.isFinite(item.commissionRate)
        ? item.commissionRate
        : 0,

    providerType: "tour",
    vertical: "tour",
    category: "tour",
    categoryAI: "tour",
    version: "S200",
    adapterSource: providerKeyNorm,

    minPrice,
    maxPrice,

    deeplink,
    affiliateUrl,

    availability: "available",
    stockStatus: "available",

    qualityScore: item.qualityScore ?? 0.75,
    metaScore: item.metaScore ?? 0,

    fallback: Boolean(item.fallback),
    raw: item.raw || { legacy: item },
  };
}

// ============================================================================
// TOUR TYPE MAP
// ============================================================================
export const tourTypes = {
  daily: {
    name: "Günlük Tur",
    keywords: ["günlük", "daily", "gezi", "tur", "tour"],
    popularDestinations: ["İstanbul", "Kapadokya", "Pamukkale", "Efes"],
  },
  balloon: {
    name: "Balon Turu",
    keywords: ["balon", "balloon", "havabalonu"],
    popularDestinations: ["Kapadokya"],
  },
  blue_cruise: {
    name: "Mavi Tur",
    keywords: ["mavi", "blue", "tekne", "cruise"],
    popularDestinations: ["Bodrum", "Fethiye"],
  },
  boat: {
    name: "Tekne Turu",
    keywords: ["tekne", "boat", "cruise"],
    popularDestinations: ["İstanbul", "Ege"],
  },
  safari: {
    name: "Safari Turu",
    keywords: ["safari", "jeep"],
    popularDestinations: ["Antalya"],
  },
  food: {
    name: "Yemek Turu",
    keywords: ["food", "yemek", "gastronomi"],
    popularDestinations: ["İstanbul", "Gaziantep"],
  },
  culture: {
    name: "Kültür Turu",
    keywords: ["kültür", "culture", "tarih"],
    popularDestinations: ["Efes", "İstanbul"],
  },
};

export function detectTourType(query = "") {
  const q = String(query || "").toLowerCase();
  for (const [type, info] of Object.entries(tourTypes)) {
    if (info.keywords.some((kw) => q.includes(kw))) return type;
  }
  return "daily";
}

// ============================================================================
// WRAP — S200 Wrapper (canonical meta) + TIMEOUT
// ============================================================================
function wrapTourAdapter(providerKey, fn, timeoutMs = 6000, weight = 1.0, tag = "general") {
  const providerKeyNorm = canonProviderKey(providerKey || "tour");
  const providerFamily = providerKeyNorm.split("_")[0] || "tour";
  const name = providerKeyNorm;

  const baseUrl = baseRootFor(providerKeyNorm);

  return {
    name,
    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,
    timeoutMs,
    meta: {
      provider: providerFamily,
      providerKey: providerKeyNorm,
      providerFamily,
      providerType: "tour",
      vertical: "tour",
      category: "tour",
      version: "S200",
      weight,
      priority: weight,
      baseUrl,
    },
    tags: ["tour", "travel", tag],
    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = _safeStr(query);

      return await withS200Ctx(
        { adapter: providerKeyNorm, name: providerKeyNorm, providerKey: providerKeyNorm, providerFamily, url: baseUrl },
        async () => {
          try {
            const options2 = { ...(options || {}) };
    options2.timeoutMs = (typeof options2.timeoutMs === "number" && Number.isFinite(options2.timeoutMs))
      ? Math.min(options2.timeoutMs, timeoutMs)
      : timeoutMs;
    const out = await withTimeout(Promise.resolve(fn(q, options2)), timeoutMs, name);

            // Adapter ok:false döndürürse saygı duy (mask yok)
            if (out && typeof out === "object" && out.ok === false) {
              const msg0 = String(out?.error || out?.message || "ADAPTER_FAILED");
              const soft =
                isSoftFail(out) || isSoftFail(msg0) || String(providerKeyNorm).startsWith("serpapi");
              return {
                ok: soft ? true : false,
                items: [],
                count: 0,
                error: msg0,
                source: providerKeyNorm,
                _meta: {
                  ...out._meta,
                  adapter: providerKeyNorm,
                  providerFamily,
                  query: q,
                  timestamp: ts,
                  vertical: "tour",
                  tag,
                  softFail: Boolean(soft),
                  softFailReason: soft ? msg0 : null,
                },
              };
            }

            const items = coerceItemsS200(out);
            const normalizedItems = items.map((it) => normalizeTourS200(it, providerKeyNorm, q)).filter(Boolean);

            return {
              ok: true,
              items: normalizedItems,
              count: normalizedItems.length,
              source: providerKeyNorm,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "tour",
                tag,
              },
            };
          } catch (err) {
            const msg = err?.message || String(err);
        const soft = isSoftFail(err) || isSoftFail(msg) || String(providerKeyNorm).startsWith("serpapi");
            const timeout = String(err?.name || "").toLowerCase().includes("timeout");
            console.warn(`❌ Tour adapter error (${providerKeyNorm}):`, msg);

            return {
              ok: false,
              items: [],
              count: 0,
              error: msg,
              timeout,
              source: providerKeyNorm,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "tour",
                tag,
                error: msg,
              },
            };
          }
        }
      );
    },
  };
}

// ============================================================================
// ADAPTER PACK
// ============================================================================
export const tourAdapters = [
  wrapTourAdapter(
    "googleplaces_tour",
    async (q, o) => {
      const text = String(q || "");
      const boosted = text.toLowerCase().includes("tur") ? text : `${text} tur`;
      return searchGooglePlaces(boosted, o);
    },
    2600,
    0.85,
    "location"
  ),

  wrapTourAdapter(
    "googleplaces_details_tour",
    async (q, o) => searchGooglePlacesDetails(q, o),
    2600,
    0.8,
    "location"
  ),

  
  HAS_SERPAPI
    ? wrapTourAdapter(
        "serpapi_tour",
        async (q, o) =>
          searchWithSerpApi(buildTourQuery(q), {
            ...(o || {}),
            timeoutMs: Math.min(Number(o?.timeoutMs) || 6400, 6400),
            num: 5,
          }),
        6400,
        0.9,
        "general"
      )
    : null,

  wrapTourAdapter("ets", (q, o) => searchEtsAdapter(q, o), 4200, 1.25, "package"),
  wrapTourAdapter("etstur", (q, o) => searchEtsturAdapter(q, o), 4200, 1.3, "package"),
  wrapTourAdapter("setur", (q, o) => searchSeturAdapter(q, o), 4200, 1.22, "package"),
  wrapTourAdapter("jolly", (q, o) => searchJollyTurAdapter(q, o), 4200, 1.2, "package"),
  wrapTourAdapter("tatilbudur", (q, o) => searchTatilBudurAdapter(q, o), 4200, 1.18, "package"),

  wrapTourAdapter("mngtur", (q, o) => searchMNGTurAdapter(q, o), 4200, 1.15, "general"),
  wrapTourAdapter("biletino_tour", (q, o) => searchSpaBiletinoAdapter(q, o), 4200, 1.1, "spa"),
  wrapTourAdapter("neredekal_tour", (q, o) => searchSpaNeredekalAdapter(q, o), 4200, 1.08, "spa"),

  wrapTourAdapter(
    "boat_tour",
    async (q, o) => searchBoatTourAdapter(buildTourQuery(q), o),
    2800,
    1.25,
    "boat"
  ),

  wrapTourAdapter(
    "kapadokya_tour",
    async (q, o) => searchKapadokyaAdapter(buildTourQuery(q), o),
    2800,
    1.4,
    "balloon"
  ),

  wrapTourAdapter(
    "pamukkale_tour",
    async (q, o) => searchPamukkaleAdapter(buildTourQuery(q), o),
    2800,
    1.35,
    "culture"
  ),

  wrapTourAdapter(
    "activities_global",
    async (q, o) => searchActivitiesAdapter(buildTourQuery(q), o),
    3400,
    1.15,
    "activities"
  ),
].filter(Boolean);

export const tourAdapterFns = tourAdapters.map((a) => a.fn);

// ============================================================================
// UNIFIED SEARCH (no “zeki boş dönme”) + DEDUPE
// ============================================================================
export async function searchTours(query, options = {}) {
  const tourType = detectTourType(query);
  const location = options.location || "";
  const dates = options.dates || {};

  const typeInfo = tourTypes[tourType];
  let relevantAdapters = tourAdapters;

  if (tourType !== "daily") {
    const key = tourType.split("_")[0];
    relevantAdapters = tourAdapters.filter((a) => {
      return (
        a.tags.includes(tourType) ||
        a.tags.includes(key) ||
        a.tags.includes("general") ||
        a.tags.includes("location") ||
        a.name.includes(key)
      );
    });
    if (!relevantAdapters.length) relevantAdapters = tourAdapters;
  }

  const results = [];

  await Promise.allSettled(
    relevantAdapters.map(async (adapter) => {
      try {
        const result = await adapter.fn(query, options);
        if (result && result.ok && Array.isArray(result.items) && result.items.length) results.push(...result.items);
      } catch (err) {
        console.warn(`⚠️ Tour unified search error (${adapter.name}):`, err?.message || err);
      }
    })
  );

  // ✅ tourType filtresi yüzünden 0 çıktıysa (ve daily değilse), full run fallback
  if (!results.length && tourType !== "daily" && relevantAdapters.length !== tourAdapters.length) {
    await Promise.allSettled(
      tourAdapters.map(async (adapter) => {
        try {
          const result = await adapter.fn(query, options);
          if (result && result.ok && Array.isArray(result.items) && result.items.length) results.push(...result.items);
        } catch {}
      })
    );
  }

  // DEDUPE (id > url+title)
  const seen = new Set();
  const deduped = [];
  for (const it of results) {
    const k = it?.id || `${_safeStr(it?.url)}|${_safeStr(it?.title)}`;
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }

  return {
    ok: true,
    items: deduped,
    count: deduped.length,
    tourType,
    typeInfo: typeInfo?.name || "Tur",
    popularDestinations: typeInfo?.popularDestinations || [],
    source: "tour_search",
    _meta: {
      query,
      location,
      dates,
      adapterCount: relevantAdapters.length,
      totalAdapters: tourAdapters.length,
      timestamp: Date.now(),
    },
  };
}

// ============================================================================
// STATS
// ============================================================================
export const tourAdapterStats = {
  totalAdapters: tourAdapters.length,
  tourTypes,
  providers: tourAdapters.map((a) => a.name),
  totalWeight: tourAdapters.reduce((s, a) => s + (a.meta?.weight || 1), 0),
};

export default tourAdapters;
