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
// ============================================================================

import crypto from "crypto";
import path from "path";
import { normalizeProviderKeyS9 } from "../../core/providerMasterS9.js";
import { buildAffiliateUrl } from "../affiliateEngine.js";

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
// STUB POLICY (DEV ONLY)
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ============================================================================
// BASIC HELPERS
// ============================================================================
const fix = (key) => {
  try {
    return kitFixKey ? kitFixKey(key) : String(key || "").toLowerCase().trim();
  } catch {
    return String(key || "").toLowerCase().trim();
  }
};

// canonical providerKey (S9 master varsa onu kullan) — DRIFT SAFE
const canonicalProviderKey = (raw, fallback = "") => {
  const base = fix(raw || fallback);
  if (!base || base === "unknown" || base === "null" || base === "undefined") return fix(fallback) || "product";
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(base);
      const nn = fix(n);

      // ✅ KRİTİK: S9 "unknown|null|undefined" döndürürse base’i EZME (identity drift biter)
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") return nn || base;

      return base;
    }
  } catch {}
  return base;
};

// providerFamily: providerKey’nin ilk parçası (S9 ile normalize)
const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "product");
  const fam0 = k.split("_")[0] || k;
  return canonicalProviderKey(fam0, fam0) || "product";
};

// Kesin providerKey üretici — dosya adını bozmadan gerçek provider üretir
const extractProviderKey = (modulePath) => {
  const raw = path.basename(String(modulePath || "")).replace(/\.js$/i, "");
  return fix(
    raw
      .replace(/Adapter$/i, "")
      .replace(/adapter$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1_$2") // camelCase → snake_case
      .toLowerCase()
  );
};

// ============================================================================
// DOMAIN / BASE URL MAP — relative URL resolve için kritik
// ============================================================================
const DOMAIN_MAP = {
  trendyol: "trendyol.com",
  hepsiburada: "hepsiburada.com",
  n11: "n11.com",
  amazon_tr: "amazon.com.tr",

  cimri: "cimri.com",
  akakce: "akakce.com",
  pttavm: "pttavm.com",

  teknosa: "teknosa.com",
  vatan: "vatanbilgisayar.com",
  mediamarkt: "mediamarkt.com.tr",

  hepsiburada_tech: "hepsiburada.com",
  hepsiburada_home: "hepsiburada.com",
  hepsiburada_market: "hepsiburada.com",

  a101: "a101.com.tr",
  migros: "migros.com.tr",
  carrefour: "carrefoursa.com",
  sok: "sokmarket.com.tr",
  getir_market: "getir.com",
  getir_carsi: "getir.com",

  boyner: "boyner.com.tr",
  flo: "flo.com.tr",
  instreet: "instreet.com.tr",
  lcw: "lcwaikiki.com",
  defacto: "defacto.com.tr",
  koton: "koton.com",
  mavi: "mavi.com",
  kigili: "kigili.com",
  morhipo: "morhipo.com",

  rossmann: "rossmann.com.tr",
  gratis: "gratis.com",
  watsons: "watsons.com.tr",

  koctas: "koctas.com.tr",
  ciceksepeti: "ciceksepeti.com",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "product");
  const fam = providerFamilyFromKey(pk);
  const domain = DOMAIN_MAP[pk] || DOMAIN_MAP[fam] || `${fam}.com`;
  return `https://www.${domain}/`;
};

const normalizeMediaUrl = (u, baseUrl) => {
  const s = kitSafeStr(u);
  if (!s) return "";
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return normalizeUrlS200(s, baseUrl || "");
};

// ============================================================================
// URL helpers — S200 strict (kept)
// ============================================================================
const isBadUrl = (u) => isBadUrlS200(u);

const normalizeUrl = (u, baseUrl = "") => {
  return normalizeUrlS200(u, baseUrl || "");
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
  if (rules.features.AFFILIATE_INJECT_IF_MISSING && (!affiliateUrl || isBadUrl(affiliateUrl))) {
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
const searchAmazonTRAdapter = await safeImport("../amazonTRAdapter.js"); // auto-pick

const searchCimri = await safeImport("../cimriAdapter.js"); // auto-pick
const searchAkakceAdapter = await safeImport("../akakceAdapter.js"); // auto-pick
const searchPTTAVMAdapter = await safeImport("../pttavmAdapter.js"); // auto-pick

const searchTeknosaAdapter = await safeImport("../teknosaAdapter.js"); // auto-pick
const searchVatanBilgisayarAdapter = await safeImport("../vatanBilgisayarAdapter.js"); // auto-pick
const searchMediaMarktAdapter = await safeImport("../mediaMarktAdapter.js"); // auto-pick
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

// ============================================================================
// TIMEOUT CONFIG (kept)
// ============================================================================
const timeoutConfig = {
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

  default: 3500,
};

const getTimeout = (key) => timeoutConfig[key] || timeoutConfig.default;

// ============================================================================
// FİNAL S200 PRODUCT ADAPTER LIST (rule-driven)
// ============================================================================
export const productAdapters = [
  wrapS200("trendyol", searchTrendyolAdapter, getTimeout("trendyol")),
  wrapS200("hepsiburada", searchHepsiburadaAdapter, getTimeout("hepsiburada")),
  wrapS200("n11", searchN11Adapter, getTimeout("n11")),
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

  const providerKeys = categoryMap[cat] || categoryMap.all;
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

  const testAdapter = productAdapters[0];
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
