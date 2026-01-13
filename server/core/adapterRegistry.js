// ============================================================================
// S200 ADAPTER REGISTRY — OFFICIAL FINAL VERSION (WRAPPED S200)
// ZERO DELETE • ZERO DRIFT • FULL ENGINE COMPATIBILITY
// Bu dosya: Tüm adapter gruplarını ANA MOTOR'a bağlayan tek merkezdir.
// adapterEngine → kategoriye göre adapter listesini buradan çeker.
// ============================================================================

// ============================================================================
// ADAPTER IMPORTLARI (GRUPLAR / ORJİNAL FONKSİYONLAR) — ZERO DRIFT MODE
// NOT: Named export'lara güvenmiyoruz. Her grubu namespace import ile alıp
// resolveGroupExport() ile array/function formatına çeviriyoruz.
// ============================================================================

// ---------------------- PRODUCT ----------------------
import * as productAdaptersMod from "../adapters/groups/productAdapters.js";

// ---------------------- MARKET ----------------------
import * as marketAdaptersMod from "../adapters/groups/marketAdapters.js";

// ---------------------- FASHION ----------------------
import * as fashionAdaptersMod from "../adapters/groups/fashionAdapters.js";

// ---------------------- FOOD ----------------------
import * as foodAdaptersMod from "../adapters/groups/foodAdapters.js";

// ---------------------- TRAVEL ----------------------
import * as travelAdaptersMod from "../adapters/groups/travelAdapters.js";

// ---------------------- CAR RENTAL ----------------------
import * as carRentalAdaptersMod from "../adapters/groups/carRentalAdapters.js";

// ---------------------- TOUR ----------------------
import * as tourAdaptersMod from "../adapters/groups/tourAdapters.js";

// ---------------------- SPA / WELLNESS ----------------------
// NOT: Dosya ismi spaAdapters.js, default export spaWellnessAdapters (ama drift olmasın diye resolver kullanıyoruz)
import * as spaAdaptersMod from "../adapters/groups/spaAdapters.js";

// ---------------------- ESTATE ----------------------
import * as estateAdaptersMod from "../adapters/groups/estateAdapters.js";

// ---------------------- INSURANCE ----------------------
import * as insuranceAdaptersMod from "../adapters/groups/insuranceAdapters.js";

// ---------------------- HEALTH ----------------------
import * as healthAdaptersMod from "../adapters/groups/healthAdapters.js";

// ---------------------- CHECKUP ----------------------
import * as checkupAdaptersMod from "../adapters/groups/checkupAdapters.js";

// ---------------------- EDUCATION ----------------------
import * as educationAdaptersMod from "../adapters/groups/educationAdapters.js";

// ---------------------- EVENT ----------------------
import * as eventAdaptersMod from "../adapters/groups/eventAdapters.js";

// ---------------------- OFFICE ----------------------
import * as officeAdaptersMod from "../adapters/groups/officeAdapters.js";

// ---------------------- CRAFT (USTA) ----------------------
import * as craftAdaptersMod from "../adapters/groups/craftAdapters.js";

// ---------------------- RENTAL EQUIPMENT ----------------------
import * as rentalAdaptersMod from "../adapters/groups/rentalAdapters.js";

// ---------------------- REPAIR SERVICE ----------------------
import * as repairAdaptersMod from "../adapters/groups/repairAdapters.js";

// ---------------------- VEHICLE SALE ----------------------
import * as vehicleSaleAdaptersMod from "../adapters/groups/vehicleSaleAdapters.js";

// ---------------------- LAWYER ----------------------
import * as lawyerAdaptersMod from "../adapters/groups/lawyerAdapters.js";


// ============================================================================
// EK ADAPTER IMPORTLARI (Ana Motor İçin Bağımsız Fonksiyonlar)
// ============================================================================
import { searchWithSerpApi } from "../adapters/serpApi.js";
import { searchGoogleShopping } from "../adapters/googleShopping.js";
import { searchGooglePlaces } from "../adapters/googlePlaces.js";
import { searchGooglePlacesDetails } from "../adapters/googlePlacesDetails.js";
import { searchWithOpenStreetMap } from "../adapters/openStreetMap.js";

// ============================================================================
// SAFE HELPERS (ZERO-CRASH)
// ============================================================================

function safeStr(v, max = 160) {
  const s = v == null ? "" : String(v);
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// CamelCase / mixed → snake_case-ish provider key
function normalizeProviderKey(raw, fallback = "unknown") {
  let s = safeStr(raw, 200);
  if (!s) return fallback;

  // yaygın prefix/suffix temizliği
  s = s.replace(/^search/i, "");
  s = s.replace(/Adapter$/i, "");
  s = s.replace(/Service$/i, "");
  s = s.replace(/Provider$/i, "");
  s = s.replace(/Scraper$/i, "");

  // camelCase → snake_case
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  s = s.replace(/__+/g, "_");

  // sadece word/underscore
  s = s.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  s = s.toLowerCase();

  return s || fallback;
}


// ---------------------------------------------------------------------------
// Category key normalizer (route/intent drift guard)
// - Turkish chars → ASCII
// - spaces/punct → underscore
// - collapses underscores
// NOTE: We still try the raw key first (non-breaking).
// ---------------------------------------------------------------------------
function normalizeCategoryKey(raw) {
  const s0 = String(raw || "").toLowerCase().trim();
  if (!s0) return "";

  const s =
    s0
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ı/g, "i")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c");

  return s
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAdapterId(name) {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "_")
    .replace(/_adapter$/i, "")
    .replace(/_+/g, "_")
    .toLowerCase()
    .trim();
}

const STRICT_NO_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") !== "1";

// Built-in "known stub / placeholder" providers.
// NOTE: Keep this list small + obvious; real integrations should remove themselves from this list.
const BUILTIN_DISABLED_ADAPTERS = new Set([
  "atv_placeholder",
  "scooter_placeholder",
  "motor_placeholder",
  "bike_placeholder",
  "boat_placeholder",
  "caravan_placeholder",
  "buggy_placeholder",
  // rental stubs (these currently emit "… üzerinde ara" cards)
  "garenta",
  "enterprise",
  "avec",
  "avis",
  "budget",
  "sixt",
  "moov",
  "circular",
]);

function isAdapterDisabledS200(adapterLike = {}) {
  const rawName =
    adapterLike?.name || adapterLike?.adapterName || adapterLike?.providerKey || adapterLike?.provider || "";
  const id = normalizeAdapterId(rawName);

  if (!id) return false;

  // Env override (comma-separated exact ids)
  const envList = String(process.env.FINDALLEASY_DISABLED_ADAPTERS || "")
    .split(",")
    .map((s) => normalizeAdapterId(s))
    .filter(Boolean);

  if (envList.length && envList.includes(id)) return true;

  // Built-ins
  if (BUILTIN_DISABLED_ADAPTERS.has(id)) return true;

  // Pattern disables (placeholders)
  if (id.endsWith("_placeholder") || id.includes("placeholder") || id.includes("stub")) return true;

  return false;
}

function postProcessAdaptersS200(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];

  // 1) Strict mode: drop disabled adapters (no placeholders / no stubs)
  const filtered = STRICT_NO_STUBS ? arr.filter((a) => !isAdapterDisabledS200(a)) : arr;

  // 2) Deduplicate by normalized id (prevents accidental dupes via alias groups)
  const seen = new Set();
  const out = [];
  for (const a of filtered) {
    const rawName = a?.name || a?.adapterName || a?.providerKey || a?.provider || "";
    const id = normalizeAdapterId(rawName);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(a);
  }
  return out;
}


function clampTimeout(ms, def = 5000) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.max(500, Math.min(15000, Math.floor(n)));
}

function coerceToItems(out) {
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object") {
    if (Array.isArray(out.items)) return out.items;
    if (Array.isArray(out.results)) return out.results;
    if (Array.isArray(out.data)) return out.data;
  }
  return [];
}


function extractOkMeta(out) {
  let ok = true;
  let meta = {};
  let err = null;

  try {
    if (Array.isArray(out)) {
      if (typeof out.ok === "boolean") ok = out.ok;
      if (out._meta && typeof out._meta === "object") meta = out._meta;
      if (out.meta && typeof out.meta === "object") meta = { ...meta, ...out.meta };
      if (out.error != null) err = String(out.error);
      if (!err && meta?.error) err = String(meta.error);
    } else if (out && typeof out === "object") {
      if (typeof out.ok === "boolean") ok = out.ok;
      if (out._meta && typeof out._meta === "object") meta = out._meta;
      if (out.meta && typeof out.meta === "object") meta = { ...meta, ...out.meta };
      if (out.error != null) err = String(out.error);
      if (!err && meta?.error) err = String(meta.error);
    }
  } catch {}

  return { ok: !!ok, meta: meta || {}, error: err };
}


// Array döndürür ama engine'in farklı beklentileri için üzerine metadata iliştirir.
function decorateItemsArray(items, meta = {}, ok = true, error = null) {
  const arr = Array.isArray(items) ? items : [];
  try {
    // “iki dünyayı birden” destek: hem array, hem {items}
    arr.items = arr;
    arr.ok = !!ok;
    arr.count = arr.length;
    if (error) arr.error = safeStr(error, 400);
    arr._meta = meta || {};
  } catch {}
  return arr;
}

// ============================================================================
// ZERO-DRIFT EXPORT RESOLVER — GROUP MODÜLÜNDEN ADAPTER GRUBUNU ÇEK
// - named export yoksa default'a düşer
// - object export ise içinden function/array yakalar
// - en kötü ihtimal: modül içindeki function export'ları liste yapar
// ============================================================================

function resolveGroupExport(mod, expectedName) {
  try {
    if (!mod) return [];

    const names = Array.isArray(expectedName) ? expectedName : [expectedName];

    // 1) “beklenen isim(ler)” → default → common fallbacks
    let cand = null;
    for (const n of names) {
      if (!n) continue;
      const v = mod?.[n];
      if (v != null) {
        cand = v;
        break;
      }
    }

    if (cand == null) {
      cand =
        mod?.default ??
        mod?.adapters ??
        mod?.group ??
        mod?.list ??
        null;
    }

    // 2) Direkt array
    if (Array.isArray(cand)) return cand;

    // 3) Tek fonksiyon
    if (typeof cand === "function") return cand;

    // 4) Object ise: içindeki array veya function'ları çıkar
    if (cand && typeof cand === "object") {
      // a) içinde array varsa onu kullan
      const arr = Object.values(cand).find((v) => Array.isArray(v));
      if (Array.isArray(arr)) return arr;

      // b) içinde fonksiyonlar varsa liste yap
      const fns = Object.values(cand).filter((v) => typeof v === "function");
      if (fns.length) return fns;
    }

    // 5) Modül exportlarının içinden function/array yakala (son çare)
    const arr2 = Object.values(mod).find((v) => Array.isArray(v));
    if (Array.isArray(arr2)) return arr2;

    const fns2 = Object.values(mod).filter((v) => typeof v === "function");
    if (fns2.length) return fns2;

    return [];
  } catch (e) {
    console.warn("⚠️ resolveGroupExport hata:", e?.message || e);
    return [];
  }
}

// ============================================================================
// OPTIONAL MODULE IMPORT — drift-safe (file name variations)
// (static import fail → process crash; burada crash yerine empty group)
// ============================================================================

async function importFirstAvailable(relPaths, label = "module") {
  const paths = Array.isArray(relPaths) ? relPaths : [relPaths];
  let lastErr = null;

  for (const rel of paths) {
    if (!rel) continue;
    try {
      // URL ile çöz → platform bağımsız
      return await import(new URL(rel, import.meta.url));
    } catch (e) {
      lastErr = e;
    }
  }

  console.warn(
    `⚠️ importFirstAvailable: ${safeStr(label, 120)} modülü yüklenemedi → ${paths.join(" | ")}`,
    safeStr(lastErr?.message || lastErr, 300)
  );
  return null;
}

// ============================================================================
// WRAP HELPER'LAR — FONKSİYON → S200 ADAPTER OBJESİ
// ============================================================================

function makeBaseMeta(provider, providerType = "generic", vertical = "generic", category = "generic", weight = 1.0) {
  const p = normalizeProviderKey(provider, "unknown");
  const providerFamily = p.split("_")[0] || p;

  return {
    provider: p,
    providerFamily,
    providerType,
    vertical,
    category,
    version: "S200",
    weight: Number.isFinite(Number(weight)) ? Number(weight) : 1.0,
  };
}

/**
 * Basit bir fonksiyonu (searchFunction) S200 adapter objesine çevirir.
 * @param {string} name - adapter name
 * @param {string} providerKey - provider id (normalized-ish)
 * @param {Function} fn - orijinal arama fonksiyonu
 * @param {number} timeoutMs - timeout
 */
function wrapFunctionAdapter(name, providerKey, fn, timeoutMs = 5000, metaOpts = {}) {
  const inferredProvider = normalizeProviderKey(providerKey || name || fn?.name, "unknown");
  const providerFamily = inferredProvider.split("_")[0] || inferredProvider;

  const meta = {
    ...makeBaseMeta(
      inferredProvider,
      metaOpts.providerType || "generic",
      metaOpts.vertical || metaOpts.category || "generic",
      metaOpts.category || "generic",
      metaOpts.weight || 1.0
    ),
    ...(metaOpts.meta && typeof metaOpts.meta === "object" ? metaOpts.meta : {}),
  };

  const tms = clampTimeout(timeoutMs, 5000);

  return {
    name: safeStr(name || inferredProvider || "unnamed", 120),
    provider: inferredProvider,
    timeoutMs: tms,
    meta,
    tags: Array.isArray(metaOpts.tags) && metaOpts.tags.length ? metaOpts.tags : [meta.category, meta.vertical, inferredProvider],

    // ENGINE-COMPAT:
    // - Array döndürür (legacy engine ok)
    // - Aynı array üzerinde {items, ok, count, _meta} da var (modern engine ok)
    fn: async (query, opts = {}) => {
      const q = safeStr(query, 500);
      try {
        const out = await fn(q, opts);
        const items = coerceToItems(out);
        const x = extractOkMeta(out);

        const metaPack = {
          ...x.meta,
          adapter: inferredProvider,
          providerFamily,
          query: q,
          opts,
          timestamp: Date.now(),
          vertical: meta.vertical,
          category: meta.category,
        };

        return decorateItemsArray(items, metaPack, x.ok, x.ok ? null : x.error);
      } catch (error) {
        const msg = safeStr(error?.message || error, 400);

        const metaPack = {
          adapter: inferredProvider,
          providerFamily,
          query: q,
          opts,
          timestamp: Date.now(),
          vertical: meta.vertical,
          category: meta.category,
        };

        console.warn(`❌ Function adapter error (${inferredProvider}):`, msg);
        return decorateItemsArray([], metaPack, false, msg);
      }
    },
  };
}

// ============================================================================
// Adapter grubunu normalize eder:
// - Zaten { name, fn } objesiyse korur (gerekirse güçlendirir)
// - Fonksiyssa wrapFunctionAdapter ile sarar
// NOT: defaultProvider parametresi ESKİDEN provider'ı ezip sistemi bozuyordu.
//     Artık bu parametre "categoryKey" olarak kullanılıyor.
// ============================================================================

let __anonCounter = 0;

function wrapAdapterGroup(group, categoryKey = "generic") {
  if (!group) {
    console.error("❌ wrapAdapterGroup: group NULL veya UNDEFINED!");
    return [];
  }

  const cat = normalizeProviderKey(categoryKey, "generic");

  // Group ARRAY ise
  if (Array.isArray(group)) {
    return group
      .map((adapter) => {
        // -----------------------------
        // 1) Eğer adapter FONKSIYONSA
        // -----------------------------
        if (typeof adapter === "function") {
          const rawName = adapter.name || `${cat}_anon_${++__anonCounter}`;
          const provider = normalizeProviderKey(rawName, `${cat}_anon_${__anonCounter}`);

          return wrapFunctionAdapter(rawName, provider, adapter, 5000, {
            category: cat,
            vertical: cat,
            providerType: "source",
            weight: 1.0,
            tags: [cat, provider],
          });
        }

        // ----------------------------------------
        // 2) Eğer adapter NESNE ise (S200 / legacy)
        // ----------------------------------------
        if (adapter && typeof adapter === "object") {
          // fn bul: fn/search/run/handler
          const fn =
            (typeof adapter.fn === "function" && adapter.fn) ||
            (typeof adapter.search === "function" && adapter.search) ||
            (typeof adapter.run === "function" && adapter.run) ||
            (typeof adapter.handler === "function" && adapter.handler) ||
            null;

          if (!fn) {
            console.error("❌ HATALI ADAPTER: fn() / search() / run() yok →", adapter);
            return null;
          }

          // name kurtar
          const rawName =
            safeStr(adapter.name, 120) ||
            safeStr(adapter.provider, 120) ||
            safeStr(adapter.providerKey, 120) ||
            safeStr(fn.name, 120) ||
            `${cat}_obj_${++__anonCounter}`;

          // provider kurtar
          const provider =
            normalizeProviderKey(adapter.provider || adapter.providerKey || rawName || fn.name, "unknown");

          // timeout kurtar
          const tms = clampTimeout(adapter.timeoutMs || adapter.timeout || adapter?.meta?.timeoutMs, 5000);

          // meta birleştir (categoryKey en azından burada sabit)
          const meta = {
            ...makeBaseMeta(
              provider,
              adapter?.meta?.providerType || adapter.providerType || "source",
              adapter?.meta?.vertical || adapter.vertical || cat,
              adapter?.meta?.category || adapter.category || cat,
              adapter?.meta?.weight || adapter.weight || 1.0
            ),
            ...(adapter.meta && typeof adapter.meta === "object" ? adapter.meta : {}),
          };

          const tags = Array.isArray(adapter.tags) && adapter.tags.length ? adapter.tags : [meta.category, meta.vertical, provider];

          // Eğer zaten “S200 object” gibi görünüyorsa yine de dönüş uyumluluğunu garantilemek için fn’i sarıyoruz.
          const wrapped = {
            ...adapter,
            name: rawName,
            provider,
            timeoutMs: tms,
            meta,
            tags,

            fn: async (query, opts = {}) => {
              const q = safeStr(query, 500);
              try {
                const out = await fn(q, opts);
                const items = coerceToItems(out);
                const x = extractOkMeta(out);

                const metaPack = {
                  ...x.meta,
                  adapter: provider,
                  providerFamily: provider.split("_")[0] || provider,
                  query: q,
                  opts,
                  timestamp: Date.now(),
                  vertical: meta.vertical,
                  category: meta.category,
                };

                return decorateItemsArray(items, metaPack, x.ok, x.ok ? null : x.error);
              } catch (e) {
                const msg = safeStr(e?.message || e, 400);

                const metaPack = {
                  adapter: provider,
                  providerFamily: provider.split("_")[0] || provider,
                  query: q,
                  opts,
                  timestamp: Date.now(),
                  vertical: meta.vertical,
                  category: meta.category,
                };

                console.warn(`❌ Object adapter error (${provider}):`, msg);
                return decorateItemsArray([], metaPack, false, msg);
              }
            },
          };

          return wrapped;
        }

        // ----------------------------------------
        // 3) TAMAMEN GEÇERSİZ ADAPTER
        // ----------------------------------------
        console.error("❌ GEÇERSİZ ADAPTER TİPİ:", adapter);
        return null;
      })
      .filter(Boolean); // Hatalıları listeden çıkar
  }

  // Group TEKİL FONKSIYONSA (group-level adapter gibi düşün)
  if (typeof group === "function") {
    const rawName = group.name || `${cat}_group_${++__anonCounter}`;
    const provider = normalizeProviderKey(rawName, `${cat}_group_${__anonCounter}`);

    return [
      wrapFunctionAdapter(rawName, provider, group, 6000, {
        category: cat,
        vertical: cat,
        providerType: "group",
        weight: 1.0,
        tags: [cat, provider, "group"],
      }),
    ];
  }

  // Group tanınmıyorsa
  console.error("❌ wrapAdapterGroup: Beklenmeyen group tipi:", group);
  return [];
}

// ============================================================================
// ORJİNAL ADAPTER GRUPLARINI (DRIFT-SAFE) ÇÖZ + S200 FORMATINA DÖNÜŞTÜR
// ============================================================================

// ---------------------- PSYCHOLOGY (DRIFT-SAFE) ----------------------
// Dosya adı drift edebilir: psychologyAdapters.js / psychologistAdapters.js
const psychologyAdaptersMod = await importFirstAvailable(
  ["../adapters/groups/psychologyAdapters.js", "../adapters/groups/psychologistAdapters.js"],
  "psychologyAdapters group"
);

const productAdapters     = resolveGroupExport(productAdaptersMod, "productAdapters");
const marketAdapters      = resolveGroupExport(marketAdaptersMod, "marketAdapters");
const fashionAdapters     = resolveGroupExport(fashionAdaptersMod, "fashionAdapters");
const foodAdapters        = resolveGroupExport(foodAdaptersMod, "foodAdapters");
const travelAdapters      = resolveGroupExport(travelAdaptersMod, "travelAdapters");
const carRentalAdapters   = resolveGroupExport(carRentalAdaptersMod, "carRentalAdapters");
const tourAdapters        = resolveGroupExport(tourAdaptersMod, "tourAdapters");
const spaWellnessAdapters = resolveGroupExport(spaAdaptersMod, "spaWellnessAdapters"); // default da olabilir
const estateAdapters      = resolveGroupExport(estateAdaptersMod, "estateAdapters");
const insuranceAdapters   = resolveGroupExport(insuranceAdaptersMod, "insuranceAdapters");
const healthAdapters      = resolveGroupExport(healthAdaptersMod, "healthAdapters");
const psychologyAdapters = resolveGroupExport(
  psychologyAdaptersMod,
  ["psychologyAdapters", "psychologistAdapters"]
);

const checkupAdapters     = resolveGroupExport(checkupAdaptersMod, "checkupAdapters");
const educationAdapters   = resolveGroupExport(educationAdaptersMod, "educationAdapters");
const eventAdapters       = resolveGroupExport(eventAdaptersMod, "eventAdapters");
const officeAdapters      = resolveGroupExport(officeAdaptersMod, "officeAdapters");
const craftAdapters       = resolveGroupExport(craftAdaptersMod, "craftAdapters");
const rentalAdapters      = resolveGroupExport(rentalAdaptersMod, "rentalAdapters");
const repairAdapters      = resolveGroupExport(repairAdaptersMod, "repairAdapters");
const vehicleSaleAdapters = resolveGroupExport(vehicleSaleAdaptersMod, "vehicleSaleAdapters");
const lawyerAdapters      = resolveGroupExport(lawyerAdaptersMod, "lawyerAdapters");


// ============================================================================
// ORJİNAL ADAPTER GRUPLARINI S200 FORMATINA DÖNÜŞTÜR
// ============================================================================

const wrappedProductAdapters       = wrapAdapterGroup(productAdapters, "product");
const wrappedMarketAdapters        = wrapAdapterGroup(marketAdapters, "market");
const wrappedFashionAdapters       = wrapAdapterGroup(fashionAdapters, "fashion");
const wrappedFoodAdapters          = wrapAdapterGroup(foodAdapters, "food");
const wrappedTravelAdapters        = wrapAdapterGroup(travelAdapters, "travel");
const wrappedCarRentalAdapters     = wrapAdapterGroup(carRentalAdapters, "car_rental");
const wrappedTourAdapters          = wrapAdapterGroup(tourAdapters, "tour");
const wrappedSpaWellnessAdapters   = wrapAdapterGroup(spaWellnessAdapters, "spa");
const wrappedEstateAdapters        = wrapAdapterGroup(estateAdapters, "estate");
const wrappedInsuranceAdapters     = wrapAdapterGroup(insuranceAdapters, "insurance");
const wrappedHealthAdapters        = wrapAdapterGroup(healthAdapters, "health");
const wrappedPsychologyAdapters    = wrapAdapterGroup(psychologyAdapters, "psychology");
const wrappedCheckupAdapters       = wrapAdapterGroup(checkupAdapters, "checkup");
const wrappedEducationAdapters     = wrapAdapterGroup(educationAdapters, "education");
const wrappedEventAdapters         = wrapAdapterGroup(eventAdapters, "event");
const wrappedOfficeAdapters        = wrapAdapterGroup(officeAdapters, "office");
const wrappedCraftAdapters         = wrapAdapterGroup(craftAdapters, "craft");
const wrappedRentalAdapters        = wrapAdapterGroup(rentalAdapters, "rental");


// ---------------------------------------------------------------------------
// Group merge helper (prevents drift between legacy car_rental group and new rental group)
// - Keeps order (first wins)
// - De-dupes by providerKey/name/provider
// ---------------------------------------------------------------------------
function mergeAdapterGroups(...groups) {
  const flat = [];
  for (const g of groups) {
    if (Array.isArray(g)) flat.push(...g);
  }

  const seen = new Set();
  const out = [];

  for (const a of flat) {
    if (!a) continue;
    const k = String(a?.providerKey || a?.name || a?.provider || "").toLowerCase().trim();
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(a);
  }

  return out;
}

// car_rental intentleri: legacy + new rental pack birlikte (maxAdaptersPerGroup zaten engine'de kısıyor)
const wrappedCarRentalUnified = mergeAdapterGroups(wrappedCarRentalAdapters, wrappedRentalAdapters);
const wrappedRepairAdapters        = wrapAdapterGroup(repairAdapters, "repair");
const wrappedVehicleSaleAdapters   = wrapAdapterGroup(vehicleSaleAdapters, "vehicle_sale");
const wrappedLawyerAdapters        = wrapAdapterGroup(lawyerAdapters, "lawyer");

// ============================================================================
// BAĞIMSIZ FONKSİYONLAR İÇİN S200 ADAPTER OBJELERİ
// ============================================================================

const serpApiAdapterS200 = wrapFunctionAdapter(
  "serpApiAdapter",
  "serpapi",
  async (q, o) => searchWithSerpApi(q, o),
  3000,
  {
    category: "product",
    vertical: "product",
    providerType: "meta",
    weight: 1.0,
    tags: ["serpapi", "meta", "product"],
  }
);

const googleShoppingAdapterS200 = wrapFunctionAdapter(
  "googleShoppingAdapter",
  "googleshopping",
  async (q, o) => searchGoogleShopping(q, o),
  4000,
  {
    category: "product",
    vertical: "product",
    providerType: "shopping",
    weight: 0.95,
    tags: ["google", "shopping", "product"],
  }
);

const googlePlacesAdapterS200 = wrapFunctionAdapter(
  "googlePlacesAdapter",
  "googleplaces",
  async (q, o) => searchGooglePlaces(q, o),
  3000,
  {
    category: "location",
    vertical: "location",
    providerType: "location",
    weight: 1.0,
    tags: ["google", "maps", "location"],
  }
);

const googlePlacesDetailsAdapterS200 = wrapFunctionAdapter(
  "googlePlacesDetailsAdapter",
  "googleplaces_details",
  async (q, o) => searchGooglePlacesDetails(q, o),
  3000,
  {
    category: "location",
    vertical: "location",
    providerType: "location",
    weight: 0.95,
    tags: ["google", "maps", "details"],
  }
);

const openStreetMapAdapterS200 = wrapFunctionAdapter(
  "openStreetMapAdapter",
  "openstreetmap",
  async (q, o) => searchWithOpenStreetMap(q, o),
  4000,
  {
    category: "location",
    vertical: "location",
    providerType: "location",
    weight: 0.9,
    tags: ["osm", "map", "location"],
  }
);

// ============================================================================
// CATEGORY → ADAPTER LIST MAP (S200 WRAPPED)
// ============================================================================

export const CATEGORY_ADAPTER_MAP = {
  // ----------- TEMEL TİCARİ KATEGORİLER -----------
  product: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  market: wrappedMarketAdapters,
  fashion: wrappedFashionAdapters,
  food: wrappedFoodAdapters,

  // ----------- SEYAHAT & KONAKLAMA -----------
  travel: wrappedTravelAdapters,
  flight: wrappedTravelAdapters, // alias
  hotel: wrappedTravelAdapters,  // alias

  // ----------- ARAÇ KİRALAMA & TUR -----------
  car_rental: wrappedCarRentalUnified,
  tour: wrappedTourAdapters,

  // ----------- SAĞLIK & WELLNESS -----------
 spa: wrappedSpaWellnessAdapters,
health: [...wrappedHealthAdapters, ...wrappedPsychologyAdapters],
psychology: wrappedPsychologyAdapters,
psychologist: wrappedPsychologyAdapters,
therapy: wrappedPsychologyAdapters,
therapist: wrappedPsychologyAdapters,
psikolog: wrappedPsychologyAdapters,
psikoloji: wrappedPsychologyAdapters,
terapi: wrappedPsychologyAdapters,
terapist: wrappedPsychologyAdapters,
psikiyatrist: wrappedPsychologyAdapters,
psikoterapi: wrappedPsychologyAdapters,
checkup: wrappedCheckupAdapters,


  // ----------- EMLAK & SİGORTA -----------
  estate: wrappedEstateAdapters,
  insurance: wrappedInsuranceAdapters,

  // ----------- EĞİTİM & ETKİNLİK -----------
  education: wrappedEducationAdapters,
  event: wrappedEventAdapters,

  // ----------- OFİS & İŞ -----------
  office: wrappedOfficeAdapters,
  craft: wrappedCraftAdapters,

  // Drift guard: "usta/handyman" intents sometimes leak as category keys
  usta: wrappedCraftAdapters,
  handyman: wrappedCraftAdapters,
  // ----------- KİRALAMA & TAMİR -----------
  rental: wrappedRentalAdapters,

// rental intent aliases (route/intent drift guard)
// NOTE: "car_rental" is the dedicated vertical; "rental" is general rentals (bike/scooter/boat/etc).
vehicle_rental: wrappedCarRentalUnified,
rent_a_car: wrappedCarRentalUnified,
rentacar: wrappedCarRentalUnified,
// Turkish-ish variants (normalizeCategoryKey turns "araç kiralama" -> "arac_kiralama")
arac_kiralama: wrappedCarRentalUnified,
araba_kiralama: wrappedCarRentalUnified,
oto_kiralama: wrappedCarRentalUnified,
arac_kirala: wrappedCarRentalUnified,
araba_kirala: wrappedCarRentalUnified,
oto_kirala: wrappedCarRentalUnified,
kiralik_arac: wrappedCarRentalUnified,

// Generic rental fallbacks
rent: wrappedRentalAdapters,
rentals: wrappedRentalAdapters,
rental_service: wrappedRentalAdapters,
  repair: wrappedRepairAdapters,

  // Drift guard: Turkish variants
  tamir: wrappedRepairAdapters,
  tamirci: wrappedRepairAdapters,
  // ----------- ARAÇ SATIŞ -----------
  vehicle_sale: wrappedVehicleSaleAdapters,

  // ----------- AVUKAT -----------
  lawyer: wrappedLawyerAdapters,

  // ----------- LOKASYON & HARİTA -----------
  location: [
    googlePlacesAdapterS200,
    googlePlacesDetailsAdapterS200,
    openStreetMapAdapterS200,
  ],

  // =============================================
  // 🔥 ANA MOTOR ALIAS MAPPING (%100 UYUMLU)
  // =============================================

  // --- PRODUCT ALIAS'LARI ---
  tech: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  electronics: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  gadget: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  device: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  appliance: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],

  // --- MARKET ALIAS'LARI ---
  grocery: wrappedMarketAdapters,
  supermarket: wrappedMarketAdapters,
  store: wrappedMarketAdapters,

  // --- FASHION ALIAS'LARI ---
  clothing: wrappedFashionAdapters,
  apparel: wrappedFashionAdapters,
  fashion_product: wrappedFashionAdapters,
  shoes: wrappedFashionAdapters,

  // --- FOOD ALIAS'LARI ---
  restaurant: wrappedFoodAdapters,
  cafe: wrappedFoodAdapters,
  meal: wrappedFoodAdapters,
  delivery: wrappedFoodAdapters,

  // --- TRAVEL ALIAS'LARI ---
  trip: wrappedTravelAdapters,
  vacation: wrappedTravelAdapters,
  holiday: wrappedTravelAdapters,
  accommodation: wrappedTravelAdapters,

  // --- HEALTH ALIAS'LARI ---
  medical: wrappedHealthAdapters,
  hospital: wrappedHealthAdapters,
  doctor: wrappedHealthAdapters,
  clinic: wrappedHealthAdapters,

  // --- ESTATE ALIAS'LARI ---
  real_estate: wrappedEstateAdapters,
  property: wrappedEstateAdapters,
  housing: wrappedEstateAdapters,
  home: wrappedEstateAdapters,

  // --- VEHICLE ALIAS'LARI ---
  car: wrappedVehicleSaleAdapters,
  vehicle: wrappedVehicleSaleAdapters,
  automobile: wrappedVehicleSaleAdapters,
  motorcycle: wrappedVehicleSaleAdapters,

  // --- GENERAL FALLBACKS ---
  misc: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  unknown: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
  genel: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],

  // --- SPECIAL CASES ---
  barcode: wrappedProductAdapters,
  qr: wrappedProductAdapters,
  image: wrappedProductAdapters,
  voice: [
    ...wrappedProductAdapters,
    serpApiAdapterS200,
    googleShoppingAdapterS200,
  ],
};

// ============================================================================
// ANA MOTOR HELPER FONKSİYONLARI
// ============================================================================

/**
 * Ana motor için kategori resolver
 * @param {string} category - Kategori adı (veya alias)
 * @returns {Array} Adapter listesi (S200 wrapped)
 */

export function resolveAdaptersForCategory(category) {
  const rawKey = String(category || "").toLowerCase().trim();

  // 1) direct hit (backward compatible)
  if (rawKey && CATEGORY_ADAPTER_MAP[rawKey]) {
    return postProcessAdaptersS200(CATEGORY_ADAPTER_MAP[rawKey] || []);
  }

  // 2) normalized hit (handles: "araç kiralama" -> "arac_kiralama", "rent a car" -> "rent_a_car")
  const normKey = normalizeCategoryKey(rawKey);
  if (normKey && CATEGORY_ADAPTER_MAP[normKey]) {
    return postProcessAdaptersS200(CATEGORY_ADAPTER_MAP[normKey] || []);
  }

  // 3) aliases (try both raw and normalized)
  const aliasMap = {
    // Market
    grocery: "market",
    supermarket: "market",

    // Fashion
    clothing: "fashion",
    apparel: "fashion",

    // Food
    restaurant: "food",
    dining: "food",

    // Travel / Rental
    hotel: "travel",
    accommodation: "travel",
    rent: "rental",
    rentals: "rental",
    rentacar: "car_rental",
    rent_a_car: "car_rental",
    arac_kiralama: "car_rental",
    araba_kiralama: "car_rental",
    oto_kiralama: "car_rental",

    arac_kirala: "car_rental",
    araba_kirala: "car_rental",
    oto_kirala: "car_rental",
    kiralik_arac: "car_rental",
    vehicle_rental: "car_rental",
    // Real estate
    property: "estate",
    realestate: "estate",

    // Auto
    car: "vehicle_sale",
    cars: "vehicle_sale",
    vehicle: "vehicle_sale",
    vehicles: "vehicle_sale",
    automotive: "vehicle_sale",

    // Health / Psychology
    medical: "health",
    hospital: "health",
    doctor: "health",
    clinic: "health",

    // Education
    course: "education",
    training: "education",
    school: "education",

    // Events
    events: "event",
    entertainment: "event",

    // Office / Work
    coworking: "office",
    workspace: "office",

    // Repair / Services
    maintenance: "repair",
    fix: "repair",
    service: "repair",
  };

  const aliased = aliasMap[rawKey] || (normKey ? aliasMap[normKey] : null) || null;
  if (aliased) {
    const a0 = String(aliased || "").toLowerCase().trim();
    const a1 = normalizeCategoryKey(a0);

    if (CATEGORY_ADAPTER_MAP[a0]) return postProcessAdaptersS200(CATEGORY_ADAPTER_MAP[a0] || []);
    if (a1 && CATEGORY_ADAPTER_MAP[a1]) return postProcessAdaptersS200(CATEGORY_ADAPTER_MAP[a1] || []);
  }

  // Default fallback
  return postProcessAdaptersS200(wrappedProductAdapters);
}

/**
 * Adapter health check / sistem durumu
 * @returns {Object} Adapter sistem durumu
 */
export function getAdapterSystemStatus() {
  const categories = Object.keys(CATEGORY_ADAPTER_MAP);
  let totalAdapters = 0;
  const adapterDetails = {};

  for (const [category, adapters] of Object.entries(CATEGORY_ADAPTER_MAP)) {
    if (!Array.isArray(adapters)) continue;

    const filtered = adapters.filter(Boolean);
    totalAdapters += filtered.length;

    adapterDetails[category] = {
      count: filtered.length,
      adapters: filtered.map((ad) => {
        if (ad && typeof ad === "object") {
          return {
            name: ad.name || "unnamed",
            provider: ad.provider || "unknown",
            timeoutMs: ad.timeoutMs || 5000,
            wrapped: true,
          };
        }
        return { type: typeof ad, wrapped: false };
      }),
    };
  }

  return {
    status: "ACTIVE",
    version: "S200-WRAPPED",
    totalCategories: categories.length,
    totalAdapters,
    adapterDetails,
    lastUpdated: new Date().toISOString(),
    compatibleWith: "adapterEngine.js vS200",
    note: "Tam uyumlu S200 wrapped adapter registry (array-return + items-meta dual-compat)",
  };
}

/**
 * Adapter bulucu (debug için)
 * @param {string} name - Adapter adı
 * @returns {Object|null} Adapter ve kategori bilgisi
 */
export function findAdapterByName(name) {
  const needle = safeStr(name, 200);
  if (!needle) return null;

  for (const [category, adapters] of Object.entries(CATEGORY_ADAPTER_MAP)) {
    if (!Array.isArray(adapters)) continue;

    const adapter = adapters.find((ad) => {
      if (ad && typeof ad === "object") {
        return ad.name === needle || ad.provider === needle;
      }
      return false;
    });

    if (adapter) {
      return { adapter, category };
    }
  }
  return null;
}

/**
 * Yeni adapter kaydet (runtime için)
 * @param {string} category - Kategori
 * @param {Object} adapterConfig - S200 wrapped adapter config
 * @returns {boolean} Başarı durumu
 */
export function registerAdapter(category, adapterConfig) {
  if (!category || !adapterConfig) return false;

  const cat = String(category).toLowerCase().trim();

  // S200 formatı kontrolü
  if (!adapterConfig.name || !adapterConfig.provider || typeof adapterConfig.fn !== "function") {
    console.error("❌ Adapter S200 formatında olmalı: {name, provider, fn, timeoutMs}");
    return false;
  }

  if (!CATEGORY_ADAPTER_MAP[cat]) {
    CATEGORY_ADAPTER_MAP[cat] = [];
  }

  // Zaten var mı?
  const existingIndex = CATEGORY_ADAPTER_MAP[cat].findIndex(
    (a) => a && typeof a === "object" && a.name === adapterConfig.name
  );

  if (existingIndex >= 0) {
    CATEGORY_ADAPTER_MAP[cat][existingIndex] = adapterConfig;
    console.log(`🔄 Adapter güncellendi: ${adapterConfig.name} → ${cat}`);
  } else {
    CATEGORY_ADAPTER_MAP[cat].push(adapterConfig);
    console.log(`✅ Adapter eklendi: ${adapterConfig.name} → ${cat}`);
  }

  return true;
}

/**
 * Tüm wrapped adapter'ları listele (debug için)
 * @returns {Array} Tüm wrapped adapter'lar
 */
export function getAllWrappedAdapters() {
  const allAdapters = [];

  for (const [category, adapters] of Object.entries(CATEGORY_ADAPTER_MAP)) {
    if (!Array.isArray(adapters)) continue;

    adapters.forEach((adapter) => {
      if (adapter && typeof adapter === "object") {
        allAdapters.push({
          category,
          ...adapter,
        });
      }
    });
  }

  return allAdapters;
}

// ============================================================================
// ANA MOTOR İÇİN ÖZEL EXPORT'LAR
// ============================================================================

// Ana motorun ihtiyaç duyduğu ek adapter'lar (wrapped)
export const EXTRA_ADAPTERS = {
  serpApi: serpApiAdapterS200,
  googleShopping: googleShoppingAdapterS200,
  googlePlaces: googlePlacesAdapterS200,
  googlePlacesDetails: googlePlacesDetailsAdapterS200,
  openStreetMap: openStreetMapAdapterS200,
};

// Hızlı erişim için kategori grupları
export const CATEGORY_GROUPS = {
  // Ticari gruplar
  COMMERCE: ["product", "market", "fashion", "food"],

  // Seyahat grupları
  TRAVEL: ["travel", "flight", "hotel", "car_rental", "tour"],

  // Hizmet grupları
 SERVICES: ["health", "psychology", "spa", "estate", "insurance", "education", "event"],


  // Uzmanlık grupları
  SPECIALIZED: ["office", "craft", "rental", "repair", "vehicle_sale", "lawyer"],

  // Location grupları
  LOCATION: ["location"],
};

// ============================================================================
// DEFAULT EXPORT (ANA MOTOR BUNU KULLANIR)
// ============================================================================

export default CATEGORY_ADAPTER_MAP;

// ============================================================================
// SİSTEM BAŞLATMA
// ============================================================================

const status = getAdapterSystemStatus();
console.log("🚀 S200 WRAPPED ADAPTER REGISTRY YÜKLENDİ");
console.log(`📊 Toplam Kategori: ${status.totalCategories}`);
console.log(`🧩 Toplam Adapter: ${status.totalAdapters}`);
console.log(`🔧 Sistem: ${status.status} (${status.version})`);
console.log(`⚡ Uyumluluk: ${status.compatibleWith}`);
console.log(`📝 Not: ${status.note}`);
