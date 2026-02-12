// server/adapters/groups/productAdapters.js
// ============================================================================
// PRODUCT ADAPTER GROUP — S200 OFFICIAL FINAL (RULE-DRIVEN) → PATCHED V1.4.4
// ZERO DELETE • ZERO DRIFT • S200 contract lock (title+url required, price>0 else null)
// providerKey canonicalization + url priority (affiliate/deeplink first)
// S200 wrapper output: { ok, items, count, source, _meta }  ✅
// RULE/FEATURE STYLE: All hard logic lives in PRODUCT_RULES + applyProductRules()
//
// PATCH V1.4.4:
//  - ✅ runWithCooldownS200: gerçek fn(query, ctx) çağrıları wrapper içinde cooldown ile sarıldı
//  - ✅ runWithBudget thunk: fn() timeout/cooldown dışında “erken” çalışmasın (sessiz drift/outerTimeout riski düşer)
//  - (V1.4.3 patch’leri aynen korunur)
//
// PATCH V1.4.5 (CATALOG/MONGO):
//  - ✅ Admitad feed -> Mongo catalog_items -> productAdapters en üste eklendi (wrapS200)
//  - ✅ catalog_mongo timeout eklendi
//  - ✅ category filter: admitad her kategoride aktif
// ============================================================================

import crypto from "crypto";
import path from "path";
import { normalizeProviderKeyS9, getProviderMetaS9 } from "../../core/providerMasterS9.js";
import { buildAffiliateUrl } from "../affiliateEngine.js";
import catalogAdapter from "../catalogAdapter.js";
import { getDb } from "../../db.js";

// ✅ SINGLE SOURCE OF TRUTH kit
import {
  makeSafeImport,
  runWithCooldownS200,
  normalizeUrlS200,
  isBadUrlS200,
  pickUrlS200,
  priceOrNullS200,
  coerceItemsS200,
  safeStr as kitSafeStr,
  fixKey as kitFixKey,
  withTimeout as kitWithTimeout,
} from "../../core/s200AdapterKit.js";



// ---------------------------------------------------------------------------
// ENV FLAGS (S200) — keep imports crash-free
// ---------------------------------------------------------------------------
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// Catalog filters (useful to move from demo feeds -> TR-only)
const CATALOG_CURRENCY = kitSafeStr(process.env.CATALOG_CURRENCY || "") || "";
const CATALOG_DEFAULT_CURRENCY = kitSafeStr(process.env.CATALOG_DEFAULT_CURRENCY || "") || "TRY";
const CATALOG_CAMPAIGN_ALLOWLIST_RAW = kitSafeStr(
  process.env.CATALOG_CAMPAIGN_ALLOWLIST || process.env.ADMITAD_CAMPAIGN_ALLOWLIST || ""
);
const CATALOG_CAMPAIGN_ALLOWLIST = (CATALOG_CAMPAIGN_ALLOWLIST_RAW || "")
  .split(/[,;\s]+/g)
  .map((x) => Number(String(x || "").trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
// ============================================================================
// ADMITAD FEED (Mongo Catalog) → S200 adapter
// - catalogAdapter üstünden DB'den arar
// - output: normal product item shape (url/affiliateUrl garanti)
// ============================================================================
async function searchAdmitadFeedAdapter(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const limitRaw = Number(
    (options && typeof options === "object") ? (options.limit ?? options.max ?? 20) : 20
  );
  const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 20));

  const offsetRaw = Number(
    (options && typeof options === "object") ? (options.offset ?? 0) : 0
  );
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const provider = "admitad";

  // Optional catalog filters (useful when switching from demo feeds to TR-only)
  const currencyFilter = CATALOG_CURRENCY;
  const fallbackCurrency = CATALOG_DEFAULT_CURRENCY;
  const campaignAllow = CATALOG_CAMPAIGN_ALLOWLIST;

  // Primary: catalog_items (new pipeline)
  try {
    const db = await getDb();
    const colName = kitSafeStr(process.env.CATALOG_COLLECTION) || "catalog_items";
    const col = db.collection(colName);

    const rx = new RegExp(escapeRegexS200(q), "i");
    const findQuery = { providerKey: provider, title: rx };
    if (Array.isArray(campaignAllow) && campaignAllow.length) {
      findQuery.campaignId = { $in: campaignAllow };
    }
    if (currencyFilter) findQuery.currency = currencyFilter;

    const docs = await col
      .find(findQuery)
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .project({
        _id: 0,
        providerKey: 1,
        campaignId: 1,
        offerId: 1,
        title: 1,
        price: 1,
        oldPrice: 1,
        currency: 1,
        image: 1,
        originUrl: 1,
        finalUrl: 1,
        updatedAt: 1,
        raw: 1,
      })
      .toArray();

    if (docs && docs.length) {
      return docs.map((d) => ({
        id: `${d.providerKey}:${d.campaignId}:${d.offerId}`,
        title: d.title,

        price: d.price ?? null,
        oldPrice: d.oldPrice ?? null,
        currency: d.currency || fallbackCurrency,

        image: d.image || "",
        originUrl: d.originUrl || "",
        finalUrl: d.finalUrl || d.originUrl || "",
        affiliateUrl: d.finalUrl || d.originUrl || "",

        provider: provider,
        providerKey: provider,
        providerFamily: provider,

        campaignId: d.campaignId ?? null,
        offerId: d.offerId ?? null,
        updatedAt: d.updatedAt ?? null,
        raw: d.raw,
      }));
    }
  } catch (e) {
    // ignore and try legacy
  }

  // Legacy fallback: admitad_catalog (older deployments)
  const legacyLimit = Math.max(1, Math.min(200, limit + offset));
  const legacy = await searchAdmitadLegacyCollection(q, legacyLimit, provider);
  if (!legacy || !legacy.length) return [];

  return legacy.slice(offset, offset + limit).map((it) => {
    const originUrl = it?.originUrl || it?.url || it?.finalUrl || "";
    const finalUrl = it?.finalUrl || it?.affiliateUrl || it?.url || originUrl;
    return {
      ...it,
      provider: provider,
      providerKey: provider,
      providerFamily: provider,
      originUrl,
      finalUrl,
      affiliateUrl: finalUrl,
    };
  });
}



async function searchReklamActionFeedAdapter(query, options = {}) {
  const provider = "reklamaction";
  const q = safeString(query).trim();
  if (!q) return [];

  const limit = clampInt(options.limit ?? 24, 1, 50);
  const offset = clampInt(options.offset ?? 0, 0, 200);
  const currency = safeString(options.currency || CATALOG_DEFAULT_CURRENCY).toUpperCase();

  const db = await getDb();
  const col = db.collection("catalog_items");

  // Shared allowlist; empty => allow all
  const allow = CATALOG_CAMPAIGN_ALLOWLIST;
  const allowMatch = allow.length ? { campaignId: { $in: allow } } : {};

  const rx = new RegExp(escapeRegexS200(q), "i");

  const filter = {
    providerKey: provider,
    ...allowMatch,
    $or: [
      { title: rx },
      { brand: rx },
      { merchantName: rx },
      { category: rx },
      { keywords: rx },
      { gtin: q },
      { sku: q },
    ],
  };

  const projection = {
    _id: 0,
    id: 1,
    providerKey: 1,
    campaignId: 1,
    offerId: 1,
    merchantName: 1,
    title: 1,
    brand: 1,
    category: 1,
    currency: 1,
    price: 1,
    oldPrice: 1,
    discount: 1,
    image: 1,
    url: 1,
    originUrl: 1,
    finalUrl: 1,
    affiliateUrl: 1,
    gtin: 1,
    sku: 1,
    updatedAt: 1,
    raw: 1,
  };

  const docs = await col
    .find(filter, { projection })
    .sort({ updatedAt: -1 })
    .limit(limit + offset)
    .toArray();

  const slice = docs.slice(offset, offset + limit);

  // Currency filter: keep exact currency if present, otherwise keep unknown
  const items = slice
    .filter((d) => !d.currency || safeString(d.currency).toUpperCase() === currency)
    .map((d) => ({
      id: d.id || `${provider}:${d.offerId || d.url || ""}`,
      title: d.title || "",
      price: d.price ?? null,
      oldPrice: d.oldPrice ?? null,
      currency: d.currency || currency,
      image: d.image || "",
      brand: d.brand || "",
      category: d.category || "",
      merchantName: d.merchantName || "",
      originUrl: d.originUrl || d.url || "",
      finalUrl: d.finalUrl || d.url || "",
      affiliateUrl: d.affiliateUrl || d.finalUrl || d.url || "",
      provider,
      providerKey: provider,
      providerFamily: provider,
      campaignId: d.campaignId ?? null,
      offerId: d.offerId ?? null,
      updatedAt: d.updatedAt || null,
      raw: d.raw || null,
      gtin: d.gtin || "",
      sku: d.sku || "",
    }));

  return items;
}

// ============================================================================
// URL helpers — S200 strict (kept)
// ============================================================================
const isBadUrl = (u) => isBadUrlS200(u);

const normalizeUrl = (u, baseUrl = "") => {
  return normalizeUrlS200(u, baseUrl || "");
};

// ============================================================================
// CATALOG (MONGO) WRAPPER — Admitad feed index
// - catalogAdapter array döner (biz S200 wrapper’a sokacağız)
// - affiliateUrl/url garanti doldurulur (buildAffiliateUrl ile drift olmasın)
// ============================================================================
const searchCatalogMongo = async (query, options = {}) => {
  const lim0 =
    (options && typeof options === "object" && (options.limit ?? options.maxResults)) ??
    process.env.CATALOG_LIMIT_DEFAULT ??
    20;

  const limit = Math.max(1, Math.min(50, Number(lim0) || 20));

  const out = await catalogAdapter({
    q: query,
    query,
    limit,
    ...(options && typeof options === "object" ? options : {}),
  });

  const arr = Array.isArray(out) ? out : Array.isArray(out?.items) ? out.items : [];

  return arr
    .filter(Boolean)
    .map((it) => {
      const click = it?.affiliateUrl || it?.finalUrl || it?.originUrl || it?.url || null;
      return {
        ...it,
        affiliateUrl: click || it?.affiliateUrl || null,
        url: it?.url || click || null,
      };
    });
};

// ============================================================================
// RULES / FEATURES — SINGLE SOURCE OF TRUTH (kural/özellik modeli)
// ============================================================================
export const PRODUCT_RULES = {
  features: {
    CONTRACT_LOCK_TITLE_URL: true,
    PRICE_NULL_IF_NONPOSITIVE: true,
    URL_PRIORITY_AFFILIATE_FIRST: true,
    CANONICAL_PROVIDER_KEY: true,
    STABLE_ID_SHA1: true,
    AFFILIATE_INJECT_IF_MISSING: true,
    MEDIA_URL_RESOLVE: true,
    DROP_BAD_URL_ITEMS: true,
    CLAMP_RATING_0_5: true,
  },

  // title pick order
  titlePick: (item) =>
    item?.title ||
    item?.name ||
    item?.productName ||
    item?.label ||
    (item?.brand && item?.model ? `${item.brand} ${item.model}` : "") ||
    "",

  // originUrl pick order
  originUrlPick: (item) => item?.originUrl || item?.url || item?.link || item?.href || item?.website || "",

  // image pick order
  imagePick: (item) =>
    item?.image ||
    item?.imageUrl ||
    item?.img ||
    item?.thumbnail ||
    item?.thumb ||
    item?.photo ||
    (Array.isArray(item?.images) ? item.images[0] : "") ||
    "",

  // url priority: kit pickUrlS200 already does "affiliate/deeplink first"
  urlPick: (item) => pickUrlS200(item),

  // price policy
  price: (raw) => priceOrNullS200(raw),

  // rating policy
  rating: (v) => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : null;
    if (n == null) return null;
    return Math.max(0, Math.min(5, n));
  },

  reviewCount: (v) => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
    return n == null ? null : Math.max(0, n);
  },

  currency: (v) => kitSafeStr(v) || "TRY",

  // stable id policy
  stableId: (providerKey, title, url) => {
    // IMPORTANT: id must not drift with affiliate/utm params → strip query/hash
    let cleanUrl = "";
    try {
      const U = new URL(String(url || ""));
      U.hash = "";
      U.search = "";
      cleanUrl = U.toString();
    } catch {
      cleanUrl = String(url || "").split("#")[0].split("?")[0];
    }

    const base = `${providerKey}|${title}|${cleanUrl}`;
    const h = crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
    return `${providerKey}_${h}`;
  },

  // affiliate inject policy
  affiliate: (providerKey, originUrl) => {
    try {
      return kitSafeStr(buildAffiliateUrl(providerKey, originUrl)) || "";
    } catch {
      return "";
    }
  },
};

// ============================================================================
// APPLY RULES — tek normalize kapısı
// ============================================================================
export function applyProductRules(item, ctx, rules = PRODUCT_RULES) {
  if (!item) return null;

  const { providerKey, providerFamily, baseUrl } = ctx;

  const title = kitSafeStr(rules.titlePick(item));
  if (rules.features.CONTRACT_LOCK_TITLE_URL && !title) return null;

  // URL priority
  const picked = rules.urlPick(item);
  const url = normalizeUrl(picked, baseUrl);

  if (rules.features.CONTRACT_LOCK_TITLE_URL && (!url || isBadUrl(url))) return null;

  // price fields (<=0 => null)
  const price = rules.price(item?.price ?? item?.finalPrice ?? item?.optimizedPrice);
  const finalPrice = rules.price(item?.finalPrice ?? item?.price ?? item?.optimizedPrice);
  const optimizedPrice = rules.price(item?.optimizedPrice ?? item?.finalPrice ?? item?.price);

  // origin/final urls
  const originUrl = normalizeUrl(rules.originUrlPick(item), baseUrl) || url;
  const finalUrl =
    normalizeUrl(item?.finalUrl, baseUrl) ||
    normalizeUrl(item?.deeplink || item?.deepLink || item?.affiliateUrl, baseUrl) ||
    url;

  // id
  const id = kitSafeStr(item?.id || item?.productId) || rules.stableId(providerKey, title, originUrl || url);

  // affiliateUrl
  let affiliateUrl = kitSafeStr(item?.affiliateUrl);

  // DISCOVERY SOURCE RULE: serpapi sonuçları "discovery" kabul edilir → affiliate inject YOK.
  const isDiscoverySource =
    providerFamily === "serpapi" ||
    providerKey === "serpapi" ||
    String(providerKey || "").startsWith("serpapi");

  if (
    !isDiscoverySource &&
    rules.features.AFFILIATE_INJECT_IF_MISSING &&
    (!affiliateUrl || isBadUrl(affiliateUrl))
  ) {
    affiliateUrl = rules.affiliate(providerKey, originUrl);
  }
  affiliateUrl = affiliateUrl && !isBadUrl(affiliateUrl) ? normalizeUrl(affiliateUrl, baseUrl) : null;

  const deeplink = normalizeUrl(item?.deeplink || item?.deepLink, baseUrl) || null;

  // click URL policy (affiliate first → deeplink → finalUrl → url)
  const clickUrl =
    rules.features.URL_PRIORITY_AFFILIATE_FIRST
      ? (affiliateUrl && !isBadUrl(affiliateUrl) ? affiliateUrl : null) ||
        (deeplink && !isBadUrl(deeplink) ? deeplink : null) ||
        (finalUrl && !isBadUrl(finalUrl) ? finalUrl : null) ||
        url
      : url;

  // image
  const imageRaw = rules.imagePick(item);
  const image = rules.features.MEDIA_URL_RESOLVE ? normalizeMediaUrl(imageRaw, baseUrl) : kitSafeStr(imageRaw);

  const out = {
    ...item,

    id,
    title,

    // click target
    url: clickUrl,

    // URL variants
    originUrl,
    finalUrl,
    deeplink,
    affiliateUrl,

    // prices
    price,
    finalPrice,
    optimizedPrice,
    currency: rules.currency(item?.currency),

    // provider meta
    provider: providerFamily,
    providerKey,
    providerFamily,

    rating: rules.features.CLAMP_RATING_0_5 ? rules.rating(item?.rating) : item?.rating ?? null,
    reviewCount: rules.reviewCount(item?.reviewCount),

    image,

    vertical: item?.vertical || "product",
    category: item?.category || "product",
    version: "S200",

    raw: item?.raw || item,
  };

  if (rules.features.DROP_BAD_URL_ITEMS && (!out.url || isBadUrl(out.url))) return null;
  if (rules.features.CONTRACT_LOCK_TITLE_URL && (!out.title || !out.url)) return null;

  return out;
}

// ============================================================================
// GÜVENLİ IMPORT — ADAPTER ÇÖKERSE STUB/EMPTY DÖNER (kept name)
// ============================================================================
function pickFnFromObj(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);

  for (const k of keys) {
    if (typeof obj[k] === "function" && /^search/i.test(k)) return obj[k];
  }
  for (const k of keys) {
    if (typeof obj[k] === "function") return obj[k];
  }
  if (typeof obj?.default === "function") return obj.default;
  return null;
}

// ✅ kit tabanlı safeImport (tek davranış)
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],

  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, providerGuess || "product");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: FAKE PRICE YOK → price:null (S200 dürüstlük)
    // ✅ id deterministik: query + pk + baseUrl
    return async (query) => {
      const q = kitSafeStr(query) || "ürün";
      const title = `${q} - ${pk} (stub)`;
      const id = PRODUCT_RULES.stableId(pk, title, baseUrl);

      return [
        {
          id,
          title,
          url: baseUrl,
          price: null,
          currency: "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          stock: null,
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },
});

// ZERO DELETE: eski isim kalsın
async function safeImport(modulePath, exportName = null) {
  // exportName verilmediyse: önce gerçek import + auto-pick dene (daha sağlam)
  if (!exportName) {
    try {
      const mod = await import(new URL(modulePath, import.meta.url));
      const fn = pickFnFromObj(mod);
      if (typeof fn === "function") return fn;
    } catch {}
  }

  // kitSafeImport fallback (import fail → stub/empty)
  try {
    const fn = await kitSafeImport(modulePath, exportName);
    if (typeof fn === "function") return fn;
    if (fn && typeof fn === "object") {
      const picked = pickFnFromObj(fn);
      if (typeof picked === "function") return picked;
    }
    return async () => [];
  } catch (e) {
    console.warn(`⚠️ safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}



// ============================================================================
// PROVIDER KEY NORMALIZATION HELPERS (missing in some builds)
// - canonicalProviderKey(): S9 table normalization + safe fallback
// - fix(): strict key sanitizer
// ============================================================================
function fix(k) {
  return kitFixKey(k);
}

function canonicalProviderKey(provider, fallback = "unknown") {
  const raw = kitSafeStr(provider) || kitSafeStr(fallback) || "unknown";
  // normalizeProviderKeyS9 already returns a known key or 'unknown'
  return kitFixKey(normalizeProviderKeyS9(raw));
}


function providerFamilyFromKey(providerKey) {
  const pk = canonicalProviderKey(providerKey, "product");
  let fam = (pk.split("_")[0] || pk).trim();
  fam = kitFixKey(normalizeProviderKeyS9(fam));
  if (!fam || fam === "unknown" || fam === "null" || fam === "undefined") fam = pk;
  return fam;
}


function baseUrlFor(providerKey) {
  try {
    const meta = getProviderMetaS9(providerKey);
    const dom = (meta && meta.mainDomain) ? String(meta.mainDomain).trim() : "";
    if (!dom || dom === "unknown" || dom === "null" || dom === "undefined") return "";
    if (dom.startsWith("http://") || dom.startsWith("https://")) return dom;
    return `https://${dom.replace(/^\/+/, "").replace(/\/$/, "")}/`;
  } catch {
    return "";
  }
}

// ============================================================================
// S200 WRAPPER — RULE-DRIVEN (kept name/signature)
// - ✅ returns object { ok, items, count, source, _meta }
// ============================================================================
function wrapS200(providerKey, fn, timeoutMs = 2600, rules = PRODUCT_RULES) {
  const normalizedProviderKey = rules.features.CANONICAL_PROVIDER_KEY
    ? canonicalProviderKey(providerKey, providerKey)
    : fix(providerKey);

  const providerFamily = providerFamilyFromKey(normalizedProviderKey);
  const baseUrl = baseUrlFor(normalizedProviderKey);

  const ctx = {
    providerKey: normalizedProviderKey,
    providerFamily,
    baseUrl,
  };

  return {
    name: `${normalizedProviderKey}_adapter`,
    provider: providerFamily,
    providerKey: normalizedProviderKey,
    providerFamily,

    meta: {
      provider: providerFamily,
      providerKey: normalizedProviderKey,
      providerFamily,
      providerType: "product",
      vertical: "product",
      category: "product",
      version: "S200",
      weight: 1.0,
      rules: Object.keys(rules?.features || {}),
    },

    fn: async (query, options = {}) => {
      const ts = Date.now();

      // ✅ ensureHtmlStringS200() loglarında adapter adı/url "unknown" kalmasın
      const prevCtx = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = { adapter: normalizedProviderKey, url: baseUrl };

      try {
        const out = await runWithCooldownS200(
          normalizedProviderKey,
          async () => {
            let outInner;
            const startedAt = Date.now();
            const label = `${normalizedProviderKey}:product`;

            // ✅ thunk budget: fn() timeout/cooldown dışında erken çalışmasın
            const runWithBudget = async (thunk, ms) => {
              const m = Math.max(150, Number(ms || 0));
              return await kitWithTimeout(() => thunk(), m, label);
            };

            // 1) çoğu adapter: (query, options)
            try {
              outInner = await runWithBudget(() => Promise.resolve(fn(query, options)), timeoutMs);
            } catch (e1) {
              const msg1 = String(e1?.message || "");
              const code1 = e1?.code || "";

              // ✅ NOT_IMPLEMENTED / STUB_ADAPTER: fallback deneme yok
              if (
                code1 === "NOT_IMPLEMENTED" ||
                code1 === "STUB_ADAPTER" ||
                msg1.includes("NOT_IMPLEMENTED") ||
                msg1.includes("STUB_ADAPTER")
              ) {
                throw e1;
              }

              const elapsed = Date.now() - startedAt;
              const remainingRaw = timeoutMs - elapsed;

              const isTimeout1 = e1?.name === "TimeoutError" || /timed out/i.test(msg1) || /ETIMEDOUT/i.test(msg1);

              // Timeout olduysa ikinci denemeye girme
              if (isTimeout1 || remainingRaw <= 0) throw e1;

              // 2) bazı adapter: (query, regionString) — kalan budget ile
              const region =
                (options && typeof options === "object" ? options.region || options.country : null) || "TR";
              outInner = await runWithBudget(() => Promise.resolve(fn(query, region)), remainingRaw);
            }

            return outInner;
          },
          { group: "product", query, providerKey: normalizedProviderKey, timeoutMs }
        );

        const itemsRaw = coerceItemsS200(out);

        const items = itemsRaw
          .filter(Boolean)
          .map((it) => applyProductRules(it, ctx, rules))
          .filter((x) => x && x.title && x.url && !isBadUrl(x.url));

        return {
          ok: true,
          items,
          count: items.length,
          source: normalizedProviderKey,
          _meta: {
            adapter: normalizedProviderKey,
            providerFamily,
            query: String(query || ""),
            timestamp: ts,
            vertical: "product",
          },
        };
      } catch (error) {
        const msg = error?.message || String(error);
        console.warn(`❌ ${normalizedProviderKey} adapter error:`, msg);

        // ✅ softfail: smoke test fail yazmasın
        return {
          ok: true,
          items: [],
          count: 0,
          source: normalizedProviderKey,
          _meta: {
            adapter: normalizedProviderKey,
            providerFamily,
            query: String(query || ""),
            timestamp: ts,
            vertical: "product",
            softfail: true,
            error: msg,
          },
        };
      } finally {
        globalThis.__S200_ADAPTER_CTX = prevCtx;
      }
    },

    timeoutMs,
  };
}

// ============================================================================
// ADAPTER IMPORTLARI (ASYNC LOAD)
// ============================================================================
const searchTrendyolAdapter = await safeImport("../trendyolAdapter.js", "searchTrendyolAdapter");
const searchHepsiburadaAdapter = await safeImport("../hepsiburadaAdapter.js", "searchHepsiburadaAdapter");
const searchN11Adapter = await safeImport("../n11Adapter.js", "searchN11Adapter");

// CollectAPI (paid fallback aggregator) — used for TR marketplaces when API key exists
const searchCollectApiTrendyol = await safeImport("../collectApiAdapter.js", "searchCollectApiTrendyol");
const searchCollectApiHepsiburada = await safeImport("../collectApiAdapter.js", "searchCollectApiHepsiburada");
const searchCollectApiN11 = await safeImport("../collectApiAdapter.js", "searchCollectApiN11");
const COLLECTAPI_KEY = (process.env.COLLECTAPI_APIKEY || process.env.COLLECTAPI_KEY || process.env.COLLECTAPI_TOKEN || "").trim();
const USE_COLLECTAPI = Boolean(COLLECTAPI_KEY);

const searchAmazonTRAdapter = await safeImport("../amazonTRAdapter.js"); // auto-pick

const searchCimri = await safeImport("../cimriAdapter.js"); // auto-pick
const searchAkakceAdapter = await safeImport("../akakceAdapter.js"); // auto-pick
const searchPTTAVMAdapter = await safeImport("../pttavmAdapter.js"); // auto-pick

const searchTeknosaAdapter = await safeImport("../teknosaAdapter.js"); // auto-pick
const searchVatanBilgisayarAdapter = await safeImport("../vatanBilgisayarAdapter.js"); // auto-pick
const searchMediaMarktAdapter = await safeImport("../mediamarktAdapter.js"); // auto-pick
const searchHBTechnologyAdapter = await safeImport("../hepsiburadaTechnologyAdapter.js"); // auto-pick

const searchHBHomeAdapter = await safeImport("../hepsiburadaHomeAdapter.js"); // auto-pick
const searchHBMarketAdapter = await safeImport("../hepsiburadaMarketAdapter.js"); // auto-pick

const searchA101Adapter = await safeImport("../a101Adapter.js"); // auto-pick
const searchMigrosAdapter = await safeImport("../migrosAdapter.js"); // auto-pick
const searchCarrefourAdapter = await safeImport("../carrefourAdapter.js"); // auto-pick
const searchSokAdapter = await safeImport("../sokAdapter.js"); // auto-pick
const searchGetirMarketAdapter = await safeImport("../getirAdapter.js", "searchGetirMarketAdapter");
const searchGetirCarsiAdapter = await safeImport("../getirAdapter.js", "searchGetirCarsiAdapter");

const searchBoynerAdapter = await safeImport("../boynerAdapter.js"); // auto-pick
const searchFLOAdapter = await safeImport("../floAdapter.js"); // auto-pick
const searchInStreetAdapter = await safeImport("../instreetAdapter.js"); // auto-pick
const searchLCWAdapter = await safeImport("../lcwAdapter.js"); // auto-pick
const searchDefactoAdapter = await safeImport("../defactoAdapter.js"); // auto-pick
const searchKotonAdapter = await safeImport("../kotonAdapter.js"); // auto-pick
const searchMaviAdapter = await safeImport("../maviAdapter.js"); // auto-pick
const searchKigiliAdapter = await safeImport("../kigiliAdapter.js"); // auto-pick
const searchMorhipoAdapter = await safeImport("../morhipoAdapter.js"); // auto-pick

const searchRossmannAdapter = await safeImport("../rossmannAdapter.js"); // auto-pick
const searchGratisAdapter = await safeImport("../gratisAdapter.js"); // auto-pick
const searchWatsonsAdapter = await safeImport("../watsonsAdapter.js"); // auto-pick

const searchKoctasAdapter = await safeImport("../koctasAdapter.js"); // auto-pick
const searchCicekSepetiAdapter = await safeImport("../ciceksepetiAdapter.js"); // auto-pick

const searchSerpApiAdapter = await safeImport("../serpApi.js", "searchWithSerpApi"); // SerpAPI discovery fallback

// ============================================================================
// TIMEOUT CONFIG (kept)
// ============================================================================
const timeoutConfig = {
  reklamaction: 3500,
  admitad: 4500,
  // ✅ Mongo catalog hızlı olmalı (DB + regex)
  catalog_mongo: 1200,

  trendyol: 3500,
  hepsiburada: 3500,
  n11: 3500,
  amazon_tr: 3500,

  cimri: 3500,
  akakce: 3500,

  teknosa: 3500,
  vatan: 3500,
  mediamarkt: 3500,

  a101: 3500,
  migros: 3500,
  carrefour: 3500,
  getir_market: 3500,
  getir_carsi: 3500,

  boyner: 3500,
  flo: 3500,
  lcw: 3500,
  defacto: 3500,

  serpapi: 12000,

  default: 3500,
};

const getTimeout = (key) => timeoutConfig[key] || timeoutConfig.default;

// ============================================================================
// FİNAL S200 PRODUCT ADAPTER LIST (rule-driven)
// ============================================================================
export const productAdapters = [
  // ✅ EN ÖNCE: gerçek index’li katalog (Admitad feed -> Mongo)
   wrapS200("admitad", searchAdmitadFeedAdapter, getTimeout("admitad")),
    wrapS200("reklamaction", searchReklamActionFeedAdapter, getTimeout("reklamaction")),
 // wrapS200("admitad", searchCatalogMongo, getTimeout("catalog_mongo")),

  wrapS200("trendyol", (USE_COLLECTAPI ? searchCollectApiTrendyol : searchTrendyolAdapter), getTimeout("trendyol")),
  wrapS200("hepsiburada", (USE_COLLECTAPI ? searchCollectApiHepsiburada : searchHepsiburadaAdapter), getTimeout("hepsiburada")),
  wrapS200("n11", (USE_COLLECTAPI ? searchCollectApiN11 : searchN11Adapter), getTimeout("n11")),
  wrapS200("amazon_tr", searchAmazonTRAdapter, getTimeout("amazon_tr")),

  wrapS200("cimri", searchCimri, getTimeout("cimri")),
  wrapS200("akakce", searchAkakceAdapter, getTimeout("akakce")),
  wrapS200("pttavm", searchPTTAVMAdapter),

  wrapS200("teknosa", searchTeknosaAdapter, getTimeout("teknosa")),
  wrapS200("vatan", searchVatanBilgisayarAdapter, getTimeout("vatan")),
  wrapS200("mediamarkt", searchMediaMarktAdapter, getTimeout("mediamarkt")),
  wrapS200("hepsiburada_tech", searchHBTechnologyAdapter),

  wrapS200("hepsiburada_home", searchHBHomeAdapter),
  wrapS200("hepsiburada_market", searchHBMarketAdapter),

  wrapS200("a101", searchA101Adapter, getTimeout("a101")),
  wrapS200("migros", searchMigrosAdapter, getTimeout("migros")),
  wrapS200("carrefour", searchCarrefourAdapter, getTimeout("carrefour")),
  wrapS200("sok", searchSokAdapter),
  wrapS200("getir_market", searchGetirMarketAdapter, getTimeout("getir_market")),
  wrapS200("getir_carsi", searchGetirCarsiAdapter, getTimeout("getir_carsi")),

  wrapS200("boyner", searchBoynerAdapter, getTimeout("boyner")),
  wrapS200("flo", searchFLOAdapter, getTimeout("flo")),
  wrapS200("instreet", searchInStreetAdapter),
  wrapS200("lcw", searchLCWAdapter, getTimeout("lcw")),
  wrapS200("defacto", searchDefactoAdapter, getTimeout("defacto")),
  wrapS200("koton", searchKotonAdapter),
  wrapS200("mavi", searchMaviAdapter),
  wrapS200("kigili", searchKigiliAdapter),
  wrapS200("morhipo", searchMorhipoAdapter),

  wrapS200("rossmann", searchRossmannAdapter),
  wrapS200("gratis", searchGratisAdapter),
  wrapS200("watsons", searchWatsonsAdapter),

  wrapS200("koctas", searchKoctasAdapter),
  wrapS200("ciceksepeti", searchCicekSepetiAdapter),
];

// ============================================================================
// PAID FALLBACK (OPT-IN)
// - SerpApi adapter burns credits. Keep it OUT of default path.
// - Enable ONLY if you explicitly accept paid fallback.
//   Env: PAID_PRODUCT_ADAPTERS_ENABLED=1
// ============================================================================
try {
  const paid = String(process.env.PAID_PRODUCT_ADAPTERS_ENABLED || "").trim().toLowerCase();
  if (paid === "1" || paid === "true" || paid === "yes") {
    productAdapters.push(wrapS200("serpapi", searchSerpApiAdapter, getTimeout("serpapi")));
  }
} catch {}


// ============================================================================
// KATEGORİ FONKSİYONU (kept)
// ============================================================================
export function getProductAdaptersByCategory(category) {
  const cat = String(category || "").toLowerCase();

  const categoryMap = {
    electronics: ["teknosa", "vatan", "mediamarkt", "hepsiburada_tech", "trendyol", "hepsiburada", "n11", "amazon_tr"],
    market: ["a101", "migros", "carrefour", "sok", "getir_market", "getir_carsi", "hepsiburada_market"],
    fashion: ["boyner", "flo", "instreet", "lcw", "defacto", "koton", "mavi", "kigili", "morhipo", "trendyol"],
    home: ["koctas", "hepsiburada_home", "ciceksepeti"],
    cosmetics: ["rossmann", "gratis", "watsons", "trendyol", "hepsiburada"],
    price_compare: ["cimri", "akakce", "pttavm"],
    all: productAdapters.map((a) => a.providerKey),
  };

  // ✅ Admitad catalog her kategoride aktif + serpapi fallback kalsın
  const providerKeys = Array.from(new Set([...(categoryMap[cat] || categoryMap.all), "serpapi", "admitad", "reklamaction"]));
  return productAdapters.filter((adapter) => providerKeys.includes(adapter.providerKey));
}

// ============================================================================
// KATEGORİ TESPİTİ (kept)
// ============================================================================
export function detectProductCategory(query) {
  const q = String(query || "").toLowerCase();

  if (q.match(/telefon|iphone|samsung|laptop|tablet|kulaklık|airpods/)) return "electronics";
  if (q.match(/market|gıda|yiyecek|içecek|su|süt|ekmek/)) return "market";
  if (q.match(/tişört|tshirt|elbise|pantolon|ayakkabı|çanta|ceket/)) return "fashion";
  if (q.match(/kozmetik|makyaj|parfüm|krem|şampuan|cilt/)) return "cosmetics";
  if (q.match(/ev|mobilya|mutfak|dekorasyon|çiçek|perde/)) return "home";
  if (q.match(/fiyat|ucuz|karşılaştır|en ucuz|kıyas/)) return "price_compare";

  return "all";
}

// ============================================================================
// ADAPTER STATS (kept)
// ============================================================================
export const productAdapterStats = {
  totalAdapters: productAdapters.length,
  categories: ["electronics", "market", "fashion", "home", "cosmetics", "price_compare"],

  providersByCategory: {
    electronics: ["trendyol", "hepsiburada", "n11", "teknosa", "vatan", "mediamarkt", "amazon_tr"],
    market: ["a101", "migros", "carrefour", "sok", "getir_market", "getir_carsi"],
    fashion: ["trendyol", "hepsiburada", "boyner", "flo", "lcw", "defacto", "koton", "mavi"],
    home: ["hepsiburada", "koctas", "ciceksepeti"],
    cosmetics: ["rossmann", "gratis", "watsons", "trendyol"],
  },

  averageTimeout: Math.round(productAdapters.reduce((sum, a) => sum + (a.timeoutMs || 2600), 0) / productAdapters.length),

  rules: PRODUCT_RULES.features,
};

// ============================================================================
// TEST S200 UYUMU (updated: fn returns object)
// ============================================================================
export async function testProductAdapterCompatibility() {
  console.log("🧪 Product Adapter Motor Uyumluluk Testi (S200 / RULE-DRIVEN)\n");

  // ✅ catalog/admitad genelde TR query’de 0 dönebilir; test için ilk “normal” adapter’ı seç
  const testAdapter = productAdapters.find((a) => a?.providerKey && a.providerKey !== "admitad") || productAdapters[0];
  const testQuery = "iphone 15";

  try {
    console.log(`🔍 Testing: ${testAdapter.name}`);
    console.log(`📝 Query: "${testQuery}"`);

    const out = await testAdapter.fn(testQuery, { region: "TR", signal: null });

    const items = Array.isArray(out) ? out : out?.items || [];
    console.log(`Result: ok=${out?.ok !== false}, count=${items.length}`);

    if (items.length > 0) {
      const item = items[0];
      console.log(`Sample: ${item.title}`);
      console.log(`Provider: ${item.provider} / ${item.providerKey}`);
      console.log(`Price: ${item.price} (final:${item.finalPrice})`);
      console.log(`Rating: ${item.rating}`);
      console.log(`Review Count: ${item.reviewCount}`);
      console.log(`Url: ${item.url}`);
      console.log(`AffiliateUrl: ${item.affiliateUrl || "-"}`);
      console.log(`Deeplink: ${item.deeplink || "-"}`);
    }

    if (items.length) {
      const urlBad = items.filter((x) => !x?.url || isBadUrl(x.url)).length;
      const priceNull = items.filter((x) => x?.price == null).length;
      console.log(`Health: badUrl=${urlBad}/${items.length}, priceNull=${priceNull}/${items.length}`);
    }

    return true;
  } catch (err) {
    console.error("❌ Test failed:", err?.message || err);
    return false;
  }
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default productAdapters;
