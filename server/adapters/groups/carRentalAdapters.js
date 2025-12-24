// server/adapters/groups/carRentalAdapters.js
// ============================================================================
// CAR RENTAL ADAPTER GROUP — S200 KIT-DRIVEN FINAL PATCHED V1.3.4 (HARDENED)
// ZERO DELETE • FULL S200 PIPELINE COMPLIANCE (NO STUB IN PROD, NO FAKE PRICE)
// - Single source of truth: ../../core/s200AdapterKit.js
// - PROD: import fail / adapter fail => empty (NO STUB) ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE)
// - VISION MODE: priority + limited concurrency + global budget (no self-DDoS)
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200, // ✅ ADDED
  TimeoutError,
  safeStr,
  stableIdS200,
  normalizeUrlS200,
  isBadUrlS200,
  pickUrlS200,
  normalizePriceS200 as kitNormalizePriceS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// VISION TUNING (defaults; override via env)
// ---------------------------------------------------------------------------
const __num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const __clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(n)));

const CAR_TIMEOUT_MS = __clampInt(__num(process.env.FINDALLEASY_CAR_TIMEOUT_MS, 6500), 2500, 20000);
const CAR_CONCURRENCY = __clampInt(__num(process.env.FINDALLEASY_CAR_CONCURRENCY, 3), 1, 8);
const CAR_BUDGET_MS = __clampInt(__num(process.env.FINDALLEASY_CAR_BUDGET_MS, 9000), 2500, 30000);
const CAR_MAX_ITEMS = __clampInt(__num(process.env.FINDALLEASY_CAR_MAX_ITEMS, 60), 10, 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

// ---------------------------------------------------------------------------
// SOFT-FAIL HELPERS (STRICT modda: ok:true + empty items; fake/stub yok)
// - Amaç: transient ağ hatalarında pipeline'ı "fail" sayma; vitrin boş kalsın ama sistem kırılmasın.
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|CERT|certificate|TLS|SSL|HTTPCLIENT_NON_2XX|\b403\b|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

function isSoftFail(err) {
  const msg = String(err?.message || err || "");
  const status = Number(err?.response?.status || err?.status || NaN);
  if (Number.isFinite(status) && [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return SOFT_FAIL_RE.test(msg);
}

// ----------------------------------------------------------------------------
// STUB HARD-LOCK (prod'da ASLA stub yok)
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// Optional provider normalizer (async load, NO top-level await needed)
let normalizeProviderKeyS9 = null;
import("../../core/providerMasterS9.js")
  .then((mod) => {
    if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
  })
  .catch(() => {});

// ============================================================================
// SAFE / CORE HELPERS
// ============================================================================
const fix = (v) => String(v ?? "").trim().toLowerCase();

const slugKey = (v) =>
  fix(v)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";

const canonicalProviderKey = (raw, fallback = "car_rental") => {
  const base0 = raw == null ? fallback : raw;
  let base = slugKey(base0);

  if (!base || base === "unknown" || base === "null" || base === "undefined") base = slugKey(fallback);

  // providerMasterS9 varsa normalize et (ama yine slug’la, boş/unknown’u kabul etme)
  try {
    if (normalizeProviderKeyS9) {
      const n = normalizeProviderKeyS9(base);
      const nn = slugKey(n);
      if (nn && nn !== "unknown") return nn;
    }
  } catch {}

  return base || slugKey(fallback);
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "car_rental");
  const fam = (k.split("_")[0] || k).trim();
  return slugKey(fam) || "car_rental";
};

const normalizeTitle = (t = "") => String(t || "").replace(/\s+/g, " ").trim();

const ensureRating = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : null);
const ensureReview = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

// kept (sha1) — legacy/debug
const stableId = (providerKey, title, url) => {
  const base = `${providerKey}|${title}|${url}`;
  const h = crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
  return `${providerKey}_${h}`;
};

// price normalizer (kit first, fallback helper second)
function normalizePriceS200(v) {
  const a = kitNormalizePriceS200(v);
  if (a != null) return a;
  return priceOrNullS200(v);
}

const fallbackSearchUrl = (providerKey, query, options = {}) => {
  const pk = canonicalProviderKey(providerKey, "car_rental");
  const q = String(query || "").trim() || "car rental";
  const loc = String(options?.location || options?.city || "").trim();

  const bits = [pk, q, loc ? loc : "", "arac kiralama"].filter(Boolean);
  return `https://www.google.com/search?q=${encodeURIComponent(bits.join(" "))}`;
};

// ---------------------------------------------------------------------------
// FALLBACK NAV CARD (REAL SEARCH LINK) — PROD-SAFE (NOT A STUB, NO FAKE PRICE)
// - Purpose: avoid "0 results" UX when providers block (403/404/429) or return empty.
// - Output: single deterministic item with price:null that links to a real search page.
// ---------------------------------------------------------------------------
function buildCarRentalFallbackNavItem(providerKey, query, options = {}, reason = "empty") {
  try {
    const pk = canonicalProviderKey(providerKey, "car_rental");
    const providerFamily = providerFamilyFromKey(pk);
    const q = safeStr(query, 400);

    const url =
      normalizeUrlS200(fallbackSearchUrl(pk, q, options), "") ||
      `https://www.google.com/search?q=${encodeURIComponent("arac kiralama " + (q || ""))}`;

    const title = normalizeTitle(`${providerFamily} — araç kiralama üzerinde ara${q ? `: ${q}` : ""}`);

    // Use the same strict normalizer so the output is indistinguishable from real items (except fallback flags)
    const one = normalizeCarRentalS200(
      {
        id: stableIdS200(pk, url, title),
        title,
        url,
        price: null,
        finalPrice: null,
        optimizedPrice: null,
        currency: String(options?.currency || "TRY").toUpperCase().slice(0, 3),
        region: String(options?.region || "TR").toUpperCase(),
        fallback: true,
        raw: { fallbackNav: true, reason, query: q },
      },
      pk,
      "fallback_nav",
      q,
      options
    );

    if (!one || !one.url || isBadUrlS200(one.url)) return null;

    return {
      ...one,
      fallback: true,
      rating: null,
      reviewCount: 0,
      raw: { ...(one.raw || {}), fallbackNav: true, reason, query: q },
    };
  } catch {
    return null;
  }
}

// kept name (kit timeout)
async function withTimeout(promise, ms, label = "task") {
  return await kitWithTimeout(Promise.resolve(promise), ms, label);
}

// kept (resolver helper)
function pickFnFromObj(obj) {
  if (!obj) return null;
  if (typeof obj === "function") return obj;
  if (typeof obj !== "object") return null;

  const keys = Object.keys(obj);
  for (const k of keys) {
    if (typeof obj[k] === "function" && /^search/i.test(k)) return obj[k];
  }
  for (const k of keys) {
    if (typeof obj[k] === "function") return obj[k];
  }
  return null;
}

// ============================================================================
// BASE URL MAP (ONLY for confident domains; unknown => "" to avoid fake joins)
// ============================================================================
const RENTAL_BASE_URLS = {
  garenta: "https://www.garenta.com.tr/",
  avis: "https://www.avis.com.tr/",
  budget: "https://www.budget.com.tr/",
  enterprise: "https://www.enterprise.com.tr/",
  sixt: "https://www.sixt.com.tr/",
  yolcu360: "https://yolcu360.com/",
  avec: "https://www.avecrentacar.com/",
  // moov/circular: domain belirsiz olabilir → bilinçli boş bırak
};

function baseUrlFor(providerKey) {
  const pk = canonicalProviderKey(providerKey, "car_rental");
  return RENTAL_BASE_URLS[pk] || "";
}

// meta için: undefined olmasın (ama normalize/join için KULLANILMIYOR)
function baseUrlForMeta(providerKey) {
  const pk = canonicalProviderKey(providerKey, "car_rental");
  return baseUrlFor(pk) || fallbackSearchUrl(pk, "", {});
}

// ============================================================================
// SAFE IMPORT — kit-driven, always returns callable function (HARD-LOCKED)
// ============================================================================
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS), // ✅ PROD'da stub ASLA
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "car_rental");
    const providerFamily = providerFamilyFromKey(pk);

    return async (query, options = {}) => {
      const q = String(query || "").trim();
      const loc = String(options?.location || options?.city || "").trim();

      const url = normalizeUrlS200(fallbackSearchUrl(pk, q, options), "") || "https://www.findalleasy.com/";
      const title = normalizeTitle(`${providerFamily} — araç kiralama (stub)${loc ? ` — ${loc}` : ""}${q ? ` — ${q}` : ""}`);

      const core = normalizeItemS200(
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          fallback: true,
          raw: { stub: true, providerGuess },
        },
        pk,
        {
          vertical: "car_rental",
          category: "car_rental",
          providerFamily,
          region: String(options?.region || "TR"),
          baseUrl: baseUrlForMeta(pk), // meta amaçlı
          fallbackUrl: url,
          requireRealUrlCandidate: false,
          titleFallback: `${providerFamily} araç kiralama`,
        }
      );

      if (!core) return [];

      return [
        {
          ...core,
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          providerType: "car_rental",
          categoryAI: "car_rental",
          version: "S200",
          region: String(options?.region || "TR").toUpperCase(),
          location: loc,
          carModel: "",
          gear: "",
          fuel: "",
          kmLimit: null,
          passengers: null,
          doors: null,
          minPrice: null,
          maxPrice: null,
        },
      ];
    };
  },
});

async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ CarRental safeImport fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ============================================================================
// IMPORT ALL PROVIDERS (promise based; no top-level await needed)
// ============================================================================
const MoovP = safeImport("../moovAdapter.js");
const AvecP = safeImport("../avecAdapter.js");
const CircularP = safeImport("../circularAdapter.js");
const GarentaP = safeImport("../garentaAdapter.js");
const EnterpriseP = safeImport("../enterpriseAdapter.js");
const BudgetP = safeImport("../budgetAdapter.js");
const AvisP = safeImport("../avisAdapter.js");
const Yolcu360P = safeImport("../yolcu360Adapter.js");
const SixtP = safeImport("../sixtAdapter.js");

// ============================================================================
// S200 TITAN FN RESOLVER — kept
// ============================================================================
function resolveAdapterFn(mod, candidateNames = []) {
  try {
    if (!mod) return async () => [];
    if (typeof mod === "function") return mod;

    const base = mod.default || mod;

    for (const name of candidateNames) {
      if (mod && typeof mod[name] === "function") return mod[name];
      if (mod?.default && typeof mod.default[name] === "function") return mod.default[name];
    }

    const f0 = pickFnFromObj(base);
    if (f0) return f0;

    return async () => [];
  } catch (err) {
    console.warn("resolveAdapterFn hata:", err?.message || err);
    return async () => [];
  }
}

// Old function names preserved (wrap await inside)
function getMoovSearchFn() {
  return async (query, options) => {
    const mod = await MoovP;
    const fn = resolveAdapterFn(mod, ["searchMoovAdapter", "search", "searchMoov"]);
    return fn(query, options);
  };
}
function getAvecSearchFn() {
  return async (query, options) => {
    const mod = await AvecP;
    const fn = resolveAdapterFn(mod, ["searchAvecAdapter", "search", "searchAvec"]);
    return fn(query, options);
  };
}
function getCircularSearchFn() {
  return async (query, options) => {
    const mod = await CircularP;
    const fn = resolveAdapterFn(mod, ["searchCircularAdapter", "search", "searchCircular"]);
    return fn(query, options);
  };
}
function getGarentaSearchFn() {
  return async (query, options) => {
    const mod = await GarentaP;
    const fn = resolveAdapterFn(mod, ["searchGarentaAdapter", "search", "searchGarenta"]);
    return fn(query, options);
  };
}
function getEnterpriseSearchFn() {
  return async (query, options) => {
    const mod = await EnterpriseP;
    const fn = resolveAdapterFn(mod, ["searchEnterpriseAdapter", "search", "searchEnterprise"]);
    return fn(query, options);
  };
}
function getBudgetSearchFn() {
  return async (query, options) => {
    const mod = await BudgetP;
    const fn = resolveAdapterFn(mod, ["searchBudgetAdapter", "search", "searchBudget"]);
    return fn(query, options);
  };
}
function getAvisSearchFn() {
  return async (query, options) => {
    const mod = await AvisP;
    const fn = resolveAdapterFn(mod, ["searchAvisAdapter", "search", "searchAvis"]);
    return fn(query, options);
  };
}
function getYolcu360SearchFn() {
  return async (query, options) => {
    const mod = await Yolcu360P;
    const fn = resolveAdapterFn(mod, ["searchYolcu360Adapter", "search", "searchYolcu360"]);
    return fn(query, options);
  };
}
function getSixtSearchFn() {
  return async (query, options) => {
    const mod = await SixtP;
    const fn = resolveAdapterFn(mod, ["searchSixtAdapter", "search", "searchSixt"]);
    return fn(query, options);
  };
}

// ============================================================================
// QUALITY HEURISTIC (no lies)
// ============================================================================
function computeQualityScoreCarRental(item) {
  try {
    let s = 0.35;
    const hasPrice = Number.isFinite(item?.price) && item.price > 0;
    const hasModel = Boolean(String(item?.carModel || item?.model || "").trim());
    const hasLoc = Boolean(String(item?.location || item?.city || "").trim());
    const hasImage =
      Boolean(item?.image) ||
      (Array.isArray(item?.images) && item.images.some(Boolean)) ||
      (Array.isArray(item?.imageGallery) && item.imageGallery.some(Boolean));
    const hasGearFuel = Boolean(String(item?.gear || item?.fuel || "").trim());

    if (hasPrice) s += 0.25;
    if (hasModel) s += 0.15;
    if (hasImage) s += 0.1;
    if (hasLoc) s += 0.1;
    if (hasGearFuel) s += 0.05;

    return Math.max(0, Math.min(1, s));
  } catch {
    return 0.5;
  }
}

// ============================================================================
// NORMALIZER — kit core + car_rental extras (contract lock: title+url)
// ============================================================================
function normalizeCarRentalS200(item, providerKey, adapterName = providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, "car_rental");
  const providerFamily = providerFamilyFromKey(pk);
  const q = safeStr(queryForFallback, 400);

  const enrichedTitle =
    normalizeTitle(item.title || item.name || item.carModel || item.model || "") ||
    normalizeTitle(`${providerFamily} araç kiralama`);

  const baseUrl = baseUrlFor(pk); // "" olabilir (fake join yok)
  const fallbackUrl = fallbackSearchUrl(pk, q, options);

  const urlCandidateRaw =
    pickUrlS200(item) ||
    item?.url ||
    item?.link ||
    item?.href ||
    item?.originUrl ||
    item?.finalUrl ||
    item?.deeplink ||
    item?.deepLink ||
    "";

  const urlCandidate = normalizeUrlS200(urlCandidateRaw, baseUrl) || "";

  const core = normalizeItemS200(
    {
      ...item,
      title: item.title || item.name ? item.title || item.name : enrichedTitle,
      url: urlCandidate || item?.url || item?.link || item?.href || "",
    },
    pk,
    {
      vertical: "car_rental",
      category: "car_rental",
      providerFamily,
      region: String(options?.region || item?.region || "TR"),
      baseUrl, // sadece confident base
      fallbackUrl,
      requireRealUrlCandidate: true,
      titleFallback: `${providerFamily} araç kiralama`,
      priceKeys: ["price", "finalPrice", "optimizedPrice", "amount", "rate", "dailyPrice", "totalPrice", "minPrice", "maxPrice"],
    }
  );

  if (!core) return null;

  const regionFixed = String(item.region || options?.region || "TR").toUpperCase();

  const originUrl =
    normalizeUrlS200(item.originUrl || item.url || item.link || item.href || "", baseUrl) || core.url;

  const finalUrl =
    normalizeUrlS200(item.finalUrl || item.deeplink || item.deepLink || item.affiliateUrl || "", baseUrl) || core.url;

  const minPrice = normalizePriceS200(item.minPrice ?? item.raw?.minPrice);
  const maxPrice = normalizePriceS200(item.maxPrice ?? item.raw?.maxPrice);

  const finalPrice = normalizePriceS200(item.finalPrice ?? item.raw?.finalPrice) ?? core.price ?? null;
  const optimizedPrice = normalizePriceS200(item.optimizedPrice ?? item.raw?.optimizedPrice) ?? null;

  const location = safeStr(item.location || options?.location || options?.city || "", 120);

  const carModel = safeStr(item.carModel || item.model || "", 120);
  const gear = safeStr(item.gear || item.transmission || "", 60);
  const fuel = safeStr(item.fuel || "", 60);

  const computedQuality = computeQualityScoreCarRental({
    ...item,
    price: core.price,
    carModel,
    location,
    gear,
    fuel,
    images: item.images,
  });

  const id = String(core.id || "").trim() || stableIdS200(pk, core.url, core.title || enrichedTitle);

  return {
    ...core,
    id,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    originUrl,
    finalUrl,
    deeplink: core.deeplink || finalUrl || core.url,
    affiliateUrl: core.affiliateUrl || null,

    minPrice,
    maxPrice,
    finalPrice,
    optimizedPrice,

    category: "car_rental",
    vertical: "car_rental",
    providerType: "car_rental",
    categoryAI: "car_rental",
    version: "S200",
    adapterSource: adapterName || pk,
    region: regionFixed,

    description: String(item.description || "").trim(),
    carModel,
    gear,
    fuel,
    kmLimit: item.kmLimit ?? null,
    passengers: item.passengers ?? null,
    doors: item.doors ?? null,
    location,

    imageGallery: Array.isArray(item.images) ? item.images.filter(Boolean).slice(0, 12) : [],

    rating: ensureRating(core.rating ?? item.rating),
    reviewCount: ensureReview(core.reviewCount ?? item.reviewCount),

    commissionRate: Number.isFinite(item.commissionRate) ? item.commissionRate : null,

    availability: item.availability ?? null,
    stockStatus: item.stockStatus ?? null,

    qualityScore: Number.isFinite(item.qualityScore) ? item.qualityScore : computedQuality,
    metaScore: Number.isFinite(item.metaScore) ? item.metaScore : Math.round(computedQuality * 100) / 100,

    raw: item.raw || core.raw || item,
  };
}

// ============================================================================
// WRAP — ANA MOTOR UYUMLU (timeout guard + strict normalize)
// - FIX: name/pk/provider/providerFamily + meta.baseUrl dolu (undefined yok)
// ============================================================================
function wrapCarRentalAdapter(providerKey, fn, timeoutMs = CAR_TIMEOUT_MS, weight = 1.0, adapterName = null) {
  const pk = canonicalProviderKey(providerKey, "car_rental");
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk) || fallbackSearchUrl(pk, "", {});

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
      providerType: "car_rental",
      vertical: "car_rental",
      category: "car_rental",
      version: "S200",
      commissionPreferred: true,
      regionAffinity: ["TR"],
      weight,
      priority: weight,
      baseUrl,
    },

    tags: ["car", "rental", "vehicle"],

    fn: async (query, options = {}) => {

      const strictNoStubs = String(process.env.FINDALLEASY_ALLOW_STUBS ?? "0") !== "1";
      const allowFallbackNav = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0") === "1";

      // NOTE: Bu wrapper'ın tags'i sabit. İçeride "tags" diye serbest değişken kullanmak
      // runtime crash üretir (ReferenceError). Burada sadece STRICT stub kapatma guard'ı var.
      const adapterTags = ["car", "rental", "vehicle"];
      if (strictNoStubs && adapterTags.includes("placeholder")) {
        return {
          ok: false,
          items: [],
          count: 0,
          source: pk,
          _meta: {
            expectedFail: {
              code: "STUB_DISABLED",
              reason: "placeholder adapter disabled in STRICT mode (FINDALLEASY_ALLOW_STUBS=0)",
            },
            providerKey: pk,
            tags: adapterTags,
          },
        };
      }
      const ts = Date.now();
      const q = safeStr(query, 400);

      try {
        // ✅ COOLDOWN WRAP (mevcut akış aynen içeride)
        const out = await runWithCooldownS200(
          pk,
          async () => {
            return await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
          },
          { group: "car_rental", query: q, providerKey: pk, timeoutMs }
        );

        const rawItems = coerceItemsS200(out);
        const normalized = rawItems
          .filter(Boolean)
          .map((x) => normalizeCarRentalS200(x, pk, adapterName || pk, q, options))
          .filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

        const fallbackOne = (allowFallbackNav && !normalized.length) ? buildCarRentalFallbackNavItem(pk, q, options, "empty") : null;

        const finalItems = normalized.length ? normalized : fallbackOne ? [fallbackOne] : [];

        return {
          ok: true,
          items: finalItems,
          count: finalItems.length,
          source: pk,
          _meta: { adapter: pk, providerFamily, query: q, timestamp: ts, vertical: "car_rental", category: "car_rental" },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const isTimeout =
          (typeof TimeoutError === "function" && err instanceof TimeoutError) ||
          err?.name === "TimeoutError" ||
          /timed out|timeout/i.test(msg);

        const soft = isSoftFail(err);

        console.warn(`❌ Car rental adapter error (${pk}):`, msg);

        // PROD veya stub kapalıysa: crash yok.
        // IMPORTANT: fallback-nav ENV'e saygılı olmalı; allowFallbackNav=0 iken kart basmayacağız.
        if (IS_PROD || !ALLOW_STUBS) {
          const fallbackOne = allowFallbackNav
            ? buildCarRentalFallbackNavItem(pk, q, options, soft ? "soft_fail" : "error")
            : null;
          const finalItems = fallbackOne ? [fallbackOne] : [];

          return {
            ok: true, // soft-fail policy
            items: finalItems,
            count: finalItems.length,
            error: msg,
            timeout: Boolean(isTimeout),
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "car_rental",
              category: "car_rental",
              softFail: true,
              fallbackNav: Boolean(fallbackOne),
              softFailReason: String(msg).slice(0, 180),
              soft: Boolean(soft),
            },
          };
        }

        // DEV + ALLOW_STUBS: tek fallback kart (FAKE PRICE YOK) — ama allowFallbackNav=0 ise kart basma.
        const url = normalizeUrlS200(fallbackSearchUrl(pk, q, options), "") || "https://www.findalleasy.com/";
        const title = `${providerFamily} — araç kiralama (geçici erişim sorunu)`;

        const one = allowFallbackNav
          ? normalizeCarRentalS200(
          {
            id: stableIdS200(pk, url, title),
            title,
            url,
            price: null,
            finalPrice: null,
            optimizedPrice: null,
            currency: "TRY",
            fallback: true,
            raw: { error: msg },
          },
          pk,
          adapterName || pk,
          q,
          options
        )
          : null;

        return {
          ok: true,
          items: one ? [one] : [],
          count: one ? 1 : 0,
          error: msg,
          timeout: Boolean(isTimeout),
          source: pk,
          _meta: { adapter: pk, providerFamily, query: q, timestamp: ts, vertical: "car_rental", category: "car_rental", stub: true },
        };
      }
    },
  };
}

/*
  =====================================================================
  LEGACY / BROKEN STRAY BLOCK (ZERO-DELETE: kept as comment)
  =====================================================================
*/

// ============================================================================
// CATEGORY MAP (kept)
// ============================================================================
export const carCategories = {
  economy: { name: "Ekonomik Araç", priceRange: [150, 350], keywords: ["ekonomik", "compact", "küçük"] },
  suv: { name: "SUV", priceRange: [500, 900], keywords: ["suv", "4x4", "crossover"] },
  luxury: { name: "Lüks Araç", priceRange: [800, 2000], keywords: ["lüks", "luxury", "premium"] },
  van: { name: "Minibüs / Van", priceRange: [400, 800], keywords: ["minibüs", "van"] },
};

export function detectCarCategory(query) {
  const q = String(query || "").toLowerCase();
  for (const [cat, info] of Object.entries(carCategories)) {
    if (info.keywords.some((k) => q.includes(String(k).toLowerCase()))) return cat;
  }
  return "economy";
}

// ============================================================================
// FINAL PACK (priority/weight used by VISION runner)
// ============================================================================
export const CAR_RENTAL_ADAPTERS_ALL = [
  wrapCarRentalAdapter("yolcu360", getYolcu360SearchFn(), CAR_TIMEOUT_MS, 1.4, "yolcu360"),
  wrapCarRentalAdapter("garenta", getGarentaSearchFn(), CAR_TIMEOUT_MS, 1.3, "garenta"),
  wrapCarRentalAdapter("moov", getMoovSearchFn(), CAR_TIMEOUT_MS, 1.25, "moov"),
  wrapCarRentalAdapter("enterprise", getEnterpriseSearchFn(), CAR_TIMEOUT_MS, 1.2, "enterprise"),
  wrapCarRentalAdapter("avec", getAvecSearchFn(), CAR_TIMEOUT_MS, 1.15, "avec"),
  wrapCarRentalAdapter("budget", getBudgetSearchFn(), CAR_TIMEOUT_MS, 1.15, "budget"),
  wrapCarRentalAdapter("avis", getAvisSearchFn(), CAR_TIMEOUT_MS, 1.1, "avis"),
  wrapCarRentalAdapter("sixt", getSixtSearchFn(), CAR_TIMEOUT_MS, 1.1, "sixt"),
  wrapCarRentalAdapter("circular", getCircularSearchFn(), CAR_TIMEOUT_MS, 1.0, "circular"),
];


const STRICT_NO_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") !== "1";

// These providers currently emit navigation/stub cards ("… üzerinde ara").
// In STRICT mode we skip calling them entirely (NO FAKE / less noise).
const DISABLED_CAR_RENTAL_PROVIDERS = new Set([
  "garenta",
  "enterprise",
  "avec",
  "avis",
  "budget",
  "sixt",
  "moov",
  "circular",
]);

const carRentalAdapters = STRICT_NO_STUBS
  ? CAR_RENTAL_ADAPTERS_ALL.filter((a) => {
      const n = String(a?.name || "").toLowerCase().trim();
      return !DISABLED_CAR_RENTAL_PROVIDERS.has(n);
    })
  : CAR_RENTAL_ADAPTERS_ALL;


export const carRentalAdapterFns = carRentalAdapters.map((a) => a.fn);

// ============================================================================
// SEARCH WRAPPER (VISION MODE: priority + limited concurrency + global budget)
// ============================================================================
export async function searchCarRentals(query, options = {}) {
  const category = detectCarCategory(query);
  const q = String(query || "").trim();

  const concurrency = __clampInt(__num(options?.concurrency, CAR_CONCURRENCY), 1, 8);
  const budgetMs = __clampInt(__num(options?.budgetMs, CAR_BUDGET_MS), 2500, 30000);
  const maxItems = __clampInt(__num(options?.maxItems, CAR_MAX_ITEMS), 10, 200);

  // priority first (weight/priority high → earlier)
  const ordered = [...carRentalAdapters].sort((a, b) => {
    const pa = Number(a?.meta?.priority || a?.meta?.weight || 0);
    const pb = Number(b?.meta?.priority || b?.meta?.weight || 0);
    return pb - pa;
  });

  const startedAt = Date.now();
  const bag = [];
  let idx = 0;
  let stop = false;

  const runOne = async (a) => {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 60) return;

    // adapter promise (attach catch to avoid unhandled if we bail early)
    const p = Promise.resolve(a.fn(q, options)).catch(() => null);

    // global-budget guard (does NOT cancel network; just stops awaiting)
    const out = await Promise.race([p, sleep(remaining).then(() => null)]);
    if (!out) return;

    const items = Array.isArray(out) ? out : out?.items || [];
    if (items?.length) bag.push(...items);
  };

  const worker = async () => {
    while (!stop) {
      const i = idx++;
      if (i >= ordered.length) return;

      await runOne(ordered[i]);

      if (bag.length >= maxItems) {
        stop = true;
        return;
      }

      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 60) {
        stop = true;
        return;
      }
    }
  };

  // limited concurrency (prevents self-DDoS)
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // dedupe by id
  const seen = new Set();
  const results = [];
  for (const it of bag) {
    const id = String(it?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    results.push(it);
  }

  return {
    ok: true,
    items: results.slice(0, maxItems),
    count: Math.min(results.length, maxItems),
    category,
    _meta: {
      timestamp: Date.now(),
      vertical: "car_rental",
      category: "car_rental",
      budgetMs,
      concurrency,
      timeoutMs: CAR_TIMEOUT_MS,
      maxItems,
    },
  };
}

export default carRentalAdapters;

// ============================================================================
// ✓ S200 REAL COMPLIANCE (KIT-DRIVEN): title+url lock, price<=0 null, NO STUB IN PROD
// ============================================================================
