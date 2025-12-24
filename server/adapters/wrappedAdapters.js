// server/adapters/wrappedAdapters.js
import { wrapS200 } from "./_s200wrap.js";

import { searchTrendyolAdapter } from "./trendyolAdapter.js";
import { searchBarcode } from "./barcode.js";
import { searchWithSerpApi } from "./serpApi.js";
import { searchWithOpenStreetMap } from "./openStreetMap.js";
import { searchGooglePlaces } from "./googlePlaces.js";
import { searchGooglePlacesDetails } from "./googlePlacesDetails.js";
import { searchGoogleShopping } from "./googleShopping.js";
import { searchLawyer } from "./lawyerAdapter.js";

import { resolveAdapterGroupS200 } from "../core/intentEngine.js";
import { normalizeProviderKeyS12, getProviderMetaS12 } from "../core/providerMasterS9.js";

// ============================================================
// S200 — STRICT DATA CONTRACT ENFORCER
//   - provider boş/unknown olamaz
//   - url boş olamaz
//   - title boş olamaz
//   - price/finalPrice/optimizedPrice: number>0 değilse null
// ============================================================
function _safeStr(v) {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

function _toPositiveNumberOrNull(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;

  const s = _safeStr(v);
  if (!s) return null;

  const cleaned = s.replace(/[^0-9.,]/g, "");
  if (!cleaned) return null;

  let norm = cleaned;
  const hasComma = norm.includes(",");
  const hasDot = norm.includes(".");
  if (hasComma && hasDot) {
    norm = norm.replace(/\./g, "").replace(/,/g, ".");
  } else if (hasComma && !hasDot) {
    norm = norm.replace(/,/g, ".");
  }

  const n = Number(norm);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _pickUrl(item) {
  if (!item) return "";
  return _safeStr(
    item.url ||
      item.finalUrl ||
      item.originUrl ||
      item.deeplink ||
      item.link ||
      item.href ||
      item.permalink ||
      item.website ||
      ""
  );
}

function _pickTitle(item) {
  if (!item) return "";
  return _safeStr(
    item.title ||
      item.name ||
      item.productTitle ||
      item.placeName ||
      item.company ||
      item.summary ||
      ""
  );
}

function _ensureProviderKey(itemProvider, providerKey, url) {
  const p = _safeStr(itemProvider).toLowerCase();
  const base = _safeStr(providerKey).toLowerCase();

  if (p && p !== "unknown") return p;
  if (base && base !== "unknown") return base;

  const fromUrl = normalizeProviderKeyS12(url || "");
  if (fromUrl && fromUrl !== "unknown") return fromUrl;

  return "generic";
}

function inferGroupFromAdapterKey(adapterKey, providerKey) {
  const a = _safeStr(adapterKey).toLowerCase();
  const p = _safeStr(providerKey).toLowerCase();

  if (
    a.includes("product") ||
    ["trendyol", "hepsiburada", "amazon", "n11", "ciceksepeti", "barcode", "googleshopping", "serpapi"].includes(p)
  )
    return "product";
  if (a.includes("hotel") || p === "booking") return "hotel";
  if (a.includes("flight") || p === "skyscanner") return "flight";
  if (a.includes("rental") || a.includes("car_rental") || p === "car_rental") return "car_rental";
  if (a.includes("estate") || ["sahibinden", "emlakjet"].includes(p)) return "estate";
  if (a.includes("lawyer") || p === "lawyer") return "lawyer";
  if (a.includes("health") || p === "health") return "health";
  if (a.includes("market") || ["getir", "market"].includes(p)) return "market";
  if (a.includes("fashion") || ["zalando", "shein"].includes(p)) return "fashion";
  if (a.includes("vehicle") || ["vehiclesale", "vehicle_sale"].includes(p)) return "vehicle_sale";
  if (a.includes("tour") || p === "tour") return "tour";
  if (a.includes("event") || p === "event") return "event";
  if (a.includes("office") || p === "office") return "office";
  if (a.includes("spa") || p === "spa") return "spa";
  if (["googleplaces", "openstreetmap"].includes(p)) return "location";

  return "product";
}

function _sanitizeS200Items(items, providerKey, groupKey) {
  const out = [];
  if (!Array.isArray(items)) return out;

  for (const it of items) {
    const title = _pickTitle(it);
    const url = _pickUrl(it);
    if (!title || !url) continue; // sözleşme: title+url zorunlu

    const provider = _ensureProviderKey(it?.provider, providerKey, url);
    const pInfo = getProviderMetaS12(provider);
    const providerFamily =
      _safeStr(it?.providerFamily) ||
      _safeStr(pInfo?.family || pInfo?.displayName || pInfo?.key || "") ||
      provider;

    const price = _toPositiveNumberOrNull(it?.price);
    const finalPrice = _toPositiveNumberOrNull(it?.finalPrice);
    const optimizedPrice = _toPositiveNumberOrNull(it?.optimizedPrice);

    out.push({
      ...it,
      title,
      url,
      provider,
      providerFamily,
      price,
      finalPrice,
      optimizedPrice,
      __group: groupKey || it?.__group || null,
    });
  }

  return out;
}

// ✅ recursion guard flag
const __FAE_S200_STRICT_WRAPPED = "__fae_s200_strict_wrapped__";

function wrapS200Strict(adapterKey, providerKey, runFn, timeoutMs = 5000, groupKey = null) {
  // ✅ double wrap: aynı fonksiyon ikinci kez strict'e girerse geri dön
  if (typeof runFn === "function" && runFn[__FAE_S200_STRICT_WRAPPED] === true) {
    return runFn;
  }

  // ✅ wrapS200 üstüne otur (S200 timeout / standard behavior korunur)
  let base = null;
  try {
    if (typeof wrapS200 === "function") {
      // ekstra argümanlar JS'te sorun değil; wrapS200 daha az param alıyorsa ignore eder.
      const maybe = wrapS200(adapterKey, providerKey, runFn, timeoutMs, groupKey);
      base = typeof maybe === "function" ? maybe : null;
    }
  } catch {
    base = null;
  }

  // ✅ wrapS200 yoksa / bozuksa: minimal zero-crash base
  if (!base) {
    base = async (query, opts = {}) => {
      try {
        const job = Promise.resolve().then(() => runFn(query, opts));
        const t = new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: false,
                items: [],
                count: 0,
                __timeout: true,
                provider: providerKey,
                adapterKey,
              }),
            Math.max(50, Number(timeoutMs) || 5000)
          )
        );

        const out = await Promise.race([job, t]);

        if (Array.isArray(out)) {
          return { ok: true, items: out, count: out.length, provider: providerKey, adapterKey };
        }
        if (out && typeof out === "object") {
          return { provider: providerKey, adapterKey, ...out };
        }
        return { ok: true, items: [], count: 0, provider: providerKey, adapterKey };
      } catch (e) {
        return { ok: false, items: [], count: 0, error: e?.message || String(e), provider: providerKey, adapterKey };
      }
    };
  }

  const wrapped = async (query, opts = {}) => {
    const raw = await base(query, opts);

    // ✅ base bazen array dönebilir: normalize et (array spread bug'ını öldür)
    const res = Array.isArray(raw)
      ? { ok: true, items: raw, count: raw.length, provider: providerKey, adapterKey }
      : (raw && typeof raw === "object"
          ? raw
          : { ok: false, items: [], count: 0, provider: providerKey, adapterKey });

    try {
      const g = groupKey || inferGroupFromAdapterKey(adapterKey, providerKey);

      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const clean = _sanitizeS200Items(rawItems, providerKey, g);

      const rawCount = Number.isFinite(res?.count) ? Number(res.count) : rawItems.length;
      const providerFinal = _ensureProviderKey(res?.provider, providerKey, "");

      return {
        ...res,
        ok: "ok" in res ? !!res.ok : true,
        adapterKey: res.adapterKey || adapterKey || null,
        provider: providerFinal,
        items: clean,
        count: clean.length,
        __s200Contract: {
          enforced: true,
          dropped: Math.max(0, (Number(rawCount) || 0) - clean.length),
          group: g,
        },
      };
    } catch {
      return res;
    }
  };

  // ✅ mark wrapped
  wrapped[__FAE_S200_STRICT_WRAPPED] = true;
  wrapped.__adapterKey = adapterKey || null;
  wrapped.__providerKey = providerKey || null;
  wrapped.__groupKey = groupKey || null;

  return wrapped;
}

// ============================================================
// S200 STANDART WRAPPED ADAPTERS
// ============================================================

// TRENDYOL - PRODUCT
export const trendyolAdapterS200 = wrapS200Strict(
  "trendyol_product",
  "trendyol",
  async (query, opts = {}) => {
    const result = await searchTrendyolAdapter(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "trendyol",
      ...(result?.meta || {}),
    };
  },
  5000
);

// BARCODE - PRODUCT
export const barcodeAdapterS200 = wrapS200Strict(
  "barcode_product",
  "barcode",
  async (query, opts = {}) => {
    const result = await searchBarcode(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "barcode",
      ...(result?.meta || {}),
    };
  },
  2000
);

// SERP API - PRODUCT/SEARCH
export const serpApiAdapterS200 = wrapS200Strict(
  "serpapi_product",
  "serpapi",
  async (query, opts = {}) => {
    const result = await searchWithSerpApi(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "serpapi",
      ...(result?.meta || {}),
    };
  },
  3000
);

// GOOGLE SHOPPING - PRODUCT
export const googleShoppingAdapterS200 = wrapS200Strict(
  "googleshopping_product",
  "googleshopping",
  async (query, opts = {}) => {
    const result = await searchGoogleShopping(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "googleshopping",
      ...(result?.meta || {}),
    };
  },
  4000
);

// GOOGLE PLACES - TRAVEL/LOCATION
export const googlePlacesAdapterS200 = wrapS200Strict(
  "googleplaces_location",
  "googleplaces",
  async (query, opts = {}) => {
    const result = await searchGooglePlaces(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "googleplaces",
      ...(result?.meta || {}),
    };
  },
  3000
);

// GOOGLE PLACES DETAILS - TRAVEL/LOCATION
export const googlePlacesDetailsAdapterS200 = wrapS200Strict(
  "googleplaces_details",
  "googleplaces",
  async (query, opts = {}) => {
    const result = await searchGooglePlacesDetails(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "googleplaces",
      ...(result?.meta || {}),
    };
  },
  3000
);

// OPEN STREET MAP - LOCATION
export const openStreetMapAdapterS200 = wrapS200Strict(
  "openstreetmap_location",
  "openstreetmap",
  async (query, opts = {}) => {
    const result = await searchWithOpenStreetMap(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "openstreetmap",
      ...(result?.meta || {}),
    };
  },
  4000
);

// LAWYER - LAWYER
export const lawyerAdapterS200 = wrapS200Strict(
  "lawyer_service",
  "lawyer",
  async (query, opts = {}) => {
    const result = await searchLawyer(query, opts);
    return {
      ok: true,
      items: Array.isArray(result) ? result : result?.items || [],
      count: Array.isArray(result) ? result.length : result?.count || 0,
      provider: "lawyer",
      ...(result?.meta || {}),
    };
  },
  5000
);

// ============================================================
// YENİ ADAPTER'LAR - PLACEHOLDER IMPLEMENTATION
// ============================================================

export const hepsiburadaAdapterS200 = wrapS200Strict(
  "hepsiburada_product",
  "hepsiburada",
  async (query) => {
    console.log(`🔍 Hepsiburada aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "hepsiburada", error: "NOT_IMPLEMENTED", note: "Hepsiburada adapter implementasyonu bekleniyor" };
  },
  5000
);

export const amazonAdapterS200 = wrapS200Strict(
  "amazon_product",
  "amazon",
  async (query) => {
    console.log(`🔍 Amazon aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "amazon", error: "NOT_IMPLEMENTED", note: "Amazon adapter implementasyonu bekleniyor" };
  },
  6000
);

export const n11AdapterS200 = wrapS200Strict(
  "n11_product",
  "n11",
  async (query) => {
    console.log(`🔍 N11 aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "n11", error: "NOT_IMPLEMENTED", note: "N11 adapter implementasyonu bekleniyor" };
  },
  4500
);

export const ciceksepetiAdapterS200 = wrapS200Strict(
  "ciceksepeti_product",
  "ciceksepeti",
  async (query) => {
    console.log(`🔍 ÇiçekSepeti aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "ciceksepeti", error: "NOT_IMPLEMENTED", note: "ÇiçekSepeti adapter implementasyonu bekleniyor" };
  },
  5000
);

export const bookingAdapterS200 = wrapS200Strict(
  "booking_travel",
  "booking",
  async (query) => {
    console.log(`🔍 Booking.com aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "booking", error: "NOT_IMPLEMENTED", note: "Booking.com adapter implementasyonu bekleniyor" };
  },
  7000
);

export const skyscannerAdapterS200 = wrapS200Strict(
  "skyscanner_travel",
  "skyscanner",
  async (query) => {
    console.log(`🔍 Skyscanner aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "skyscanner", error: "NOT_IMPLEMENTED", note: "Skyscanner adapter implementasyonu bekleniyor" };
  },
  8000
);

export const carRentalAdapterS200 = wrapS200Strict(
  "car_rental",
  "car_rental",
  async (query) => {
    console.log(`🔍 Araç kiralama aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "car_rental", error: "NOT_IMPLEMENTED", note: "Araç kiralama adapter implementasyonu bekleniyor" };
  },
  6000
);

export const sahibindenEstateAdapterS200 = wrapS200Strict(
  "sahibinden_estate",
  "sahibinden",
  async (query) => {
    console.log(`🔍 Sahibinden emlak aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "sahibinden", error: "NOT_IMPLEMENTED", note: "Sahibinden emlak adapter implementasyonu bekleniyor" };
  },
  6000
);

export const emlakjetAdapterS200 = wrapS200Strict(
  "emlakjet_estate",
  "emlakjet",
  async (query) => {
    console.log(`🔍 Emlakjet aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "emlakjet", error: "NOT_IMPLEMENTED", note: "Emlakjet adapter implementasyonu bekleniyor" };
  },
  6000
);

export const healthAdapterS200 = wrapS200Strict(
  "health_service",
  "health",
  async (query) => {
    console.log(`🔍 Sağlık hizmetleri aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "health", error: "NOT_IMPLEMENTED", note: "Sağlık adapter implementasyonu bekleniyor" };
  },
  5000
);

export const marketAdapterS200 = wrapS200Strict(
  "market_generic",
  "market",
  async (query) => {
    console.log(`🔍 Market aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "market", error: "NOT_IMPLEMENTED", note: "Market adapter implementasyonu bekleniyor" };
  },
  4000
);

export const getirAdapterS200 = wrapS200Strict(
  "getir_market",
  "getir",
  async (query) => {
    console.log(`🔍 Getir aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "getir", error: "NOT_IMPLEMENTED", note: "Getir adapter implementasyonu bekleniyor" };
  },
  4000
);

export const zalandoAdapterS200 = wrapS200Strict(
  "zalando_fashion",
  "zalando",
  async (query) => {
    console.log(`🔍 Zalando aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "zalando", error: "NOT_IMPLEMENTED", note: "Zalando adapter implementasyonu bekleniyor" };
  },
  5000
);

export const sheinAdapterS200 = wrapS200Strict(
  "shein_fashion",
  "shein",
  async (query) => {
    console.log(`🔍 Shein aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "shein", error: "NOT_IMPLEMENTED", note: "Shein adapter implementasyonu bekleniyor" };
  },
  6000
);

export const vehicleSaleAdapterS200 = wrapS200Strict(
  "vehicle_sale",
  "vehicle_sale",
  async (query) => {
    console.log(`🔍 Araç satış aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "vehicle_sale", error: "NOT_IMPLEMENTED", note: "Araç satış adapter implementasyonu bekleniyor" };
  },
  7000
);

export const tourAdapterS200 = wrapS200Strict(
  "tour_service",
  "tour",
  async (query) => {
    console.log(`🔍 Tur aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "tour", error: "NOT_IMPLEMENTED", note: "Tur adapter implementasyonu bekleniyor" };
  },
  6000
);

export const eventAdapterS200 = wrapS200Strict(
  "event_generic",
  "event",
  async (query) => {
    console.log(`🔍 Etkinlik aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "event", error: "NOT_IMPLEMENTED", note: "Etkinlik adapter implementasyonu bekleniyor" };
  },
  5000
);

export const officeAdapterS200 = wrapS200Strict(
  "office_service",
  "office",
  async (query) => {
    console.log(`🔍 Ofis aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "office", error: "NOT_IMPLEMENTED", note: "Ofis adapter implementasyonu bekleniyor" };
  },
  5000
);

export const spaAdapterS200 = wrapS200Strict(
  "spa_service",
  "spa",
  async (query) => {
    console.log(`🔍 Spa aranıyor: ${query}`);
    return { ok: false, items: [], count: 0, provider: "spa", error: "NOT_IMPLEMENTED", note: "Spa adapter implementasyonu bekleniyor" };
  },
  5000
);

// Tüm adapter'ları dışa aktar
export const S200_WRAPPED_ADAPTERS = {
  trendyolAdapterS200,
  barcodeAdapterS200,
  serpApiAdapterS200,
  googleShoppingAdapterS200,
  googlePlacesAdapterS200,
  googlePlacesDetailsAdapterS200,
  openStreetMapAdapterS200,
  lawyerAdapterS200,

  hepsiburadaAdapterS200,
  amazonAdapterS200,
  n11AdapterS200,
  ciceksepetiAdapterS200,
  bookingAdapterS200,
  skyscannerAdapterS200,
  carRentalAdapterS200,
  sahibindenEstateAdapterS200,
  emlakjetAdapterS200,
  healthAdapterS200,
  marketAdapterS200,
  getirAdapterS200,
  zalandoAdapterS200,
  sheinAdapterS200,
  vehicleSaleAdapterS200,
  tourAdapterS200,
  eventAdapterS200,
  officeAdapterS200,
  spaAdapterS200,
};

// ============================================================
// S200 — GROUP CHAINS (fallback dahil)
// ============================================================
export const S200_GROUP_CHAINS = {
  product: [
    trendyolAdapterS200,
    hepsiburadaAdapterS200,
    amazonAdapterS200,
    n11AdapterS200,
    ciceksepetiAdapterS200,
    barcodeAdapterS200,
    googleShoppingAdapterS200,
    serpApiAdapterS200,
  ],
  hotel: [bookingAdapterS200, googlePlacesAdapterS200, openStreetMapAdapterS200, serpApiAdapterS200],
  flight: [skyscannerAdapterS200, serpApiAdapterS200],
  tour: [tourAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
  event: [eventAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
  car_rental: [carRentalAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
  estate: [sahibindenEstateAdapterS200, emlakjetAdapterS200, serpApiAdapterS200],
  lawyer: [lawyerAdapterS200, googlePlacesAdapterS200, openStreetMapAdapterS200, serpApiAdapterS200],
  health: [healthAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
  market: [getirAdapterS200, marketAdapterS200, googleShoppingAdapterS200, serpApiAdapterS200],
  fashion: [zalandoAdapterS200, sheinAdapterS200, googleShoppingAdapterS200, serpApiAdapterS200],
  vehicle_sale: [vehicleSaleAdapterS200, serpApiAdapterS200],
  location: [googlePlacesAdapterS200, openStreetMapAdapterS200, serpApiAdapterS200],
  food: [googlePlacesAdapterS200, serpApiAdapterS200],
  insurance: [serpApiAdapterS200, googlePlacesAdapterS200, openStreetMapAdapterS200],
  office: [officeAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
  spa: [spaAdapterS200, googlePlacesAdapterS200, serpApiAdapterS200],
};

export function getS200GroupChain(groupKey = "product") {
  const g = String(groupKey || "product").toLowerCase().trim();
  return S200_GROUP_CHAINS[g] || S200_GROUP_CHAINS.product;
}

export async function runS200AdapterChain(chain = [], query = "", opts = {}) {
  const maxTotal = Number.isFinite(opts.maxTotal) ? opts.maxTotal : 40;
  const minItems = Number.isFinite(opts.minItems) ? opts.minItems : 10;

  const results = [];
  const meta = [];

  for (const adapter of chain) {
    if (typeof adapter !== "function") continue;

    try {
      const r = await adapter(query, opts);
      const items = Array.isArray(r?.items) ? r.items : [];
      if (items.length) results.push(...items);

      meta.push({
        adapter: r?.adapterKey || r?.provider || "unknown",
        provider: r?.provider || "unknown",
        ok: !!r?.ok,
        count: items.length,
        err: r?.error || null,
        note: r?.note || null,
      });

      if (results.length >= maxTotal) break;
      if (results.length >= minItems && opts.earlyExit !== false) break;
    } catch (e) {
      meta.push({
        adapter: "unknown",
        provider: "unknown",
        ok: false,
        count: 0,
        err: e?.message || String(e),
      });
    }
  }

  return {
    ok: results.length > 0,
    items: results.slice(0, maxTotal),
    count: Math.min(results.length, maxTotal),
    meta,
  };
}

export async function runS200ByIntent(intent = "product", query = "", opts = {}) {
  const group = resolveAdapterGroupS200(intent);
  const chain = getS200GroupChain(group);

  const r = await runS200AdapterChain(chain, query, opts);
  if (r?.ok) return { ...r, group, intent };

  const fallback = [serpApiAdapterS200, googleShoppingAdapterS200, googlePlacesAdapterS200, openStreetMapAdapterS200];
  const r2 = await runS200AdapterChain(fallback, query, { ...opts, earlyExit: false });
  return { ...r2, group, intent, __fallback: true };
}
