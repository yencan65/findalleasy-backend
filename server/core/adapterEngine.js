// server/core/adapterEngine.js
// ===============================================================
//  FindAllEasy – H E R K Ü L S8 → S9 → S10 → S100 → S200
//  TEK ÇEKİRDEK ADAPTER ENGINE (BEST ODAKLI)
//  FINAL HARDENED — TEK DOSYA — ZERO-CRASH
//  (Blue/Green gerçek split + RL bucket fix + raw JSON-safe + deadline/partial)
// ===============================================================

import crypto from "crypto";
import { rankItemsS200 } from "./bestEngineS200.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { searchTrendyolAdapter } from "../adapters/trendyolAdapter.js";
import { detectIntent } from "./intentEngine.js";
import { searchBarcode } from "../adapters/barcode.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";
import { searchWithOpenStreetMap } from "../adapters/openStreetMap.js";
import { searchGooglePlaces } from "../adapters/googlePlaces.js";
import { searchGooglePlacesDetails } from "../adapters/googlePlacesDetails.js";
import { searchGoogleShopping } from "../adapters/googleShopping.js";
import { searchLawyer } from "../adapters/lawyerAdapter.js";
import { buildAffiliateUrl } from "../adapters/affiliateEngine.js";
import * as wrappedAdapters from "../adapters/wrappedAdapters.js";
import { ensureCoverageFloorS200, runWithCooldownS200, filterStubItemsS200 } from "./s200AdapterKit.js";

// ===============================================================
// S10.2 – Commission Fusion Modülü
// ===============================================================
import {
  attachCommissionMetaS10,
  rankItemsByCommissionAndProviderS10,
  providerPriorityS10,
  getCommissionRateS10,
} from "./commissionEngineS10.js";

import {
  normalizeProviderKeyS9,
  getProviderAffiliateCapabilitiesS9,
  PROVIDER_MASTER_S9,
} from "./providerMasterS9.js";

import {
  decorateResultsWithCommission,
  safeDecorateResultsWithCommission,
  providerPriority,
} from "./commissionEngine.js";

import {
  finalCategoryMultiplier,
  finalPlatformCommission,
} from "./commissionRates.js";

// ------------------------
// MERKEZİ ADAPTER REGISTRY IMPORT
// ------------------------
import CATEGORY_ADAPTER_MAP, {
  resolveAdaptersForCategory,
  getAdapterSystemStatus,
} from "./adapterRegistry.js";

import { detectCategoryS100 } from "./categoryBrain.js";
import { inferCategoryS5 } from "./categoryBrainDynamic.js";
import { detectCategory } from "./categoryDetector.js";
import { getProviderRevenueStats } from "./revenueMemoryEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

// ============================================================
// S35 GLOBAL PRICE NORMALIZER
// ============================================================
import { optimizePrice, autoInjectPrice } from "../utils/priceFixer.js";

globalThis.AdapterStats = globalThis.AdapterStats || {};
globalThis.__S200_RL_DISABLED = globalThis.__S200_RL_DISABLED || false;

// ============================================================
// GLOBAL S40 ROUTER OVERRIDE — default OFF
// ============================================================
export const s40_routerOverride = {
  enable: false,
  forceCategory: null,
};

// Sistem başlangıç log'u
console.log("🚀 S200 Adapter Engine Başlatıldı");
console.log("📊 Adapter Registry Durumu:", getAdapterSystemStatus());

// ============================================================
// S40 SAFE INTENT / SAFE CATEGORY MAP
// ============================================================
export function s40_safeDetectIntent(query = "") {
  try {
    const r = detectCategoryS100({ query });
    if (Array.isArray(r) && r.length) return String(r[0] || "product");
    if (typeof r === "string" && r.trim()) return r.trim();
    return "product";
  } catch {
    return "product";
  }
}

export function s40_mapIntentToCategory(intent = "") {
  if (!intent) return "product";
  const t = String(intent).toLowerCase().trim();

  // Core commerce
  if (["product", "tech", "electronics", "gadget", "device", "appliance"].includes(t)) return "product";
  if (["market", "grocery", "supermarket", "store"].includes(t)) return "market";
  if (["fashion", "clothing", "apparel", "shoes"].includes(t)) return "fashion";
  if (["food", "restaurant", "cafe", "meal", "delivery"].includes(t)) return "food";

  // Travel verticals (keep them distinct even if registry aliases them internally)
  if (["travel", "trip", "vacation", "holiday"].includes(t)) return "travel";
  if (["hotel", "accommodation"].includes(t)) return "hotel";
  if (["flight"].includes(t)) return "flight";
  if (["tour", "activity", "activities"].includes(t)) return "tour";
  if (["spa", "wellness"].includes(t)) return "spa";

  // Services
  if (["health", "medical", "doctor", "hospital", "clinic"].includes(t)) return "health";
  if (["psychology", "psychologist", "therapy", "therapist", "psikolog", "psikoloji", "terapi", "terapist", "psikiyatrist", "psikoterapi"].includes(t)) return "psychology";
  if (["estate", "real_estate", "property", "housing", "home"].includes(t)) return "estate";
  if (["insurance"].includes(t)) return "insurance";
  if (["education", "course", "kurs", "training", "okul"].includes(t)) return "education";
  if (["event"].includes(t)) return "event";
  if (["office"].includes(t)) return "office";
  if (["craft", "usta", "handyman", "repair", "tamir", "tamirci"].includes(t)) return "repair";

  // Rentals / vehicles
  if (["rental", "rent", "rentals", "rental_service"].includes(t)) return "rental";
  if (["car_rental", "vehicle_rental", "rent_a_car", "rentacar", "arac_kiralama", "araba_kiralama", "oto_kiralama", "arac_kirala", "araba_kirala", "oto_kirala", "kiralik_arac"].includes(t)) return "car_rental";
  if (["vehicle_sale", "car", "vehicle", "automobile", "motorcycle"].includes(t)) return "vehicle_sale";

  // Other
  if (["lawyer"].includes(t)) return "lawyer";
  if (["location"].includes(t)) return "location";
  if (["barcode", "qr", "image"].includes(t)) return "barcode";
  if (["voice"].includes(t)) return "voice";
  if (["misc", "unknown", "genel"].includes(t)) return "unknown";

  return "product";
}

// ======================================================================
// FS + path init
// ======================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REVENUE_DIFF_LOG = path.join(
  __dirname,
  "..",
  "_logs",
  "s40_revenue_diff.jsonl"
);

function writeRevenueDiff(entry) {
  try {
    const dir = path.dirname(REVENUE_DIFF_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const line = JSON.stringify(entry) + "\n";
    fs.appendFile(REVENUE_DIFF_LOG, line, () => {});
  } catch (err) {
    console.warn("⚠️ Revenue diff log yazılamadı:", err?.message || err);
  }
}

// ============================================================
// küçük yardımcılar
// ============================================================
function safeString(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function clampArray(arr, maxLen = 500) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= maxLen) return arr;
  return arr.slice(0, maxLen);
}

function isValidNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// -----------------------------------------------------------------------------
// S200 PRICE CONTRACT — HARD KILL-SWITCH
// - UI'da "0 TL" yalanını yasakla.
// - price/finalPrice/optimizedPrice: sadece >0 number veya null.
// - optimizePrice / autoInjectPrice bazen 0 yazabiliyor; burada kilitliyoruz.
// -----------------------------------------------------------------------------
function s35_priceOrNull(v) {
  if (v === null || v === undefined) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;

    // keep digits, dot, comma, minus
    let cleaned = s.replace(/[^\d.,-]/g, "");
    if (!cleaned) return null;

    // If there is a comma but no dot, treat comma as decimal separator.
    if (cleaned.includes(",") && !cleaned.includes(".")) {
      cleaned = cleaned.replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }

    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

function s35_enforcePriceContract(it) {
  if (!it || typeof it !== "object") return it;

  const p = s35_priceOrNull(it.price);
  const fp = s35_priceOrNull(it.finalPrice);
  const op = s35_priceOrNull(it.optimizedPrice);

  // Avoid extra allocations when already compliant
  const same =
    (it.price === p || (it.price === null && p === null)) &&
    (it.finalPrice === fp || (it.finalPrice === null && fp === null)) &&
    (it.optimizedPrice === op || (it.optimizedPrice === null && op === null));

  if (same) return it;

  const out = { ...it, price: p, finalPrice: fp, optimizedPrice: op };

  // If all are null, any "0 TL" style leftover should die quietly.
  if (out.price === null && out.finalPrice === null && out.optimizedPrice === null) {
    if (typeof out.priceText === "string" && out.priceText.trim()) out.priceText = null;
  }

  return out;
}

function safeLog(tag, payload) {
  try {
    console.log(`🧠 ADAPTER:${tag}`, payload);
  } catch {}
}

function normalizeQuery(q) {
  return String(q || "")
    .replace(/\s+/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function basicSimilarity(a, b) {
  const t1 = safeString(a)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const t2 = safeString(b)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t1 || !t2) return 0;
  if (t1 === t2) return 1;

  const w1 = Array.from(new Set(t1.split(" ").filter((w) => w.length > 2)));
  const w2 = Array.from(new Set(t2.split(" ").filter((w) => w.length > 2)));

  if (!w1.length || !w2.length) return 0;

  const inter = w1.filter((w) => w2.includes(w)).length;
  const union = new Set([...w1, ...w2]).size || 1;

  return inter / union;
}

// ============================================================
// S35 normalize: array OR object payload (items/best/smart/others sync)
// ============================================================
function s35_effectivePrice(it) {
  if (!it) return null;
  const op = it.optimizedPrice;
  const fp = it.finalPrice;
  const p = it.price;
  if (isValidNumber(op) && op > 0) return op;
  if (isValidNumber(fp) && fp > 0) return fp;
  if (isValidNumber(p) && p > 0) return p;
  return null;
}

function s35_fixOne(it, ctx) {
  try {
    let fixed = optimizePrice(it, ctx);
    fixed = autoInjectPrice(fixed, ctx);
    return s35_enforcePriceContract(fixed);
  } catch {
    return s35_enforcePriceContract(it);
  }
}

function s35_fixArray(arr, ctx) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map((it) => (it ? s35_fixOne(it, ctx) : it));
}

function s35_findBestInItems(best, items) {
  try {
    if (!best) return items?.[0] || null;
    const bid = best.id || null;
    const burl = best.finalUrl || best.url || null;
    const btitle = (best.title || "").slice(0, 80).toLowerCase();

    if (bid) {
      const hit = items.find((x) => x && x.id === bid);
      if (hit) return hit;
    }
    if (burl) {
      const hit = items.find(
        (x) => x && (x.finalUrl === burl || x.url === burl)
      );
      if (hit) return hit;
    }
    if (btitle) {
      const hit = items.find(
        (x) =>
          x && (x.title || "").slice(0, 80).toLowerCase() === btitle
      );
      if (hit) return hit;
    }
    return items?.[0] || best || null;
  } catch {
    return items?.[0] || best || null;
  }
}

function normalizeAdapterResultsS35(raw = [], context = {}) {
  // Array payload
  if (Array.isArray(raw)) {
    const ctx = {
      ...(context || {}),
      provider: context?.provider || "unknown",
      category: context?.category || null,
    };
    return s35_fixArray(raw, ctx);
  }

  // Object payload
  if (raw && typeof raw === "object") {
    const baseItems = Array.isArray(raw.items) ? raw.items : [];
    const ctx = {
      ...(context || {}),
      provider: context?.provider || raw?.provider || "unknown",
      category: context?.category || raw?.category || null,
    };

    const items = s35_fixArray(baseItems, ctx);

    const smart = Array.isArray(raw.smart)
      ? s35_fixArray(raw.smart, ctx)
      : raw.smart;

    const others = Array.isArray(raw.others)
      ? s35_fixArray(raw.others, ctx)
      : raw.others;

    const bestFixedRaw = raw.best ? s35_fixOne(raw.best, ctx) : null;
    const best = s35_findBestInItems(bestFixedRaw, items);

    return {
      ...raw,
      items,
      best,
      smart,
      others,
    };
  }

  return raw;
}

function mergeQueryWithQr(query, qrPayload) {
  const base = String(query || "").trim();
  if (!qrPayload) return base;

  const qrText = String(qrPayload || "").trim();
  if (/^https?:\/\//i.test(qrText)) return qrText;
  if (!base) return qrText;
  if (!qrText) return base;

  return `${base} ${qrText}`;
}

// ============================================================
// S40 SHADOW ENGINE (BLUE/GREEN) — GERÇEK VARIANT
// ============================================================
async function runEngineS30(query, opts = {}) {
  const region = typeof opts.region === "string" ? opts.region : "TR";
  const categoryHint = opts.categoryHint || null;

  const raw = await runAdapters(query, region, {
    ...opts,
    categoryHint,
    shadow: !!opts.shadow,
    engineVariant: "S30",
  });

  return normalizeAdapterResultsS35(raw, {
    provider: "engine",
    category: raw?.category || null,
    region,
    mode: "S30",
  });
}

async function runEngineS40(query, opts = {}) {
  const region = typeof opts.region === "string" ? opts.region : "TR";
  const categoryHint = opts.categoryHint || null;

  const raw = await runAdapters(query, region, {
    ...opts,
    categoryHint,
    shadow: !!opts.shadow,
    engineVariant: "S40",
  });

  return normalizeAdapterResultsS35(raw, {
    provider: "engine",
    category: raw?.category || null,
    region,
    mode: "S40",
  });
}

function estimateRevenue(result) {
  try {
    const items = Array.isArray(result)
      ? result
      : Array.isArray(result?.items)
      ? result.items
      : [];

    if (!items.length) return 0;

    let total = 0;

    for (const it of items) {
      if (!it) continue;

      const price = s35_effectivePrice(it);

      const rateRaw =
        (isValidNumber(it.commissionRate) && it.commissionRate > 0
          ? it.commissionRate
          : 0) ||
        (it?.commissionMeta?.platformRate || 0);

      const rate =
        typeof rateRaw === "number" && rateRaw > 0 ? rateRaw : 0;

      if (price && rate) {
        total += price * rate;
      }
    }

    return total;
  } catch {
    return 0;
  }
}

function seededRandom(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000; // 0..1
}

// ============================================================
// MASTER ROUTER — BLUE/GREEN TRAFFIC SPLIT
// (shadow default DEV’de KAPALI, env ile açılır)
// ============================================================
export async function runVitrineS40(query, opts = {}) {
  const pctRaw = Number(process.env.S40_NEW_TRAFFIC_PCT ?? 0.1);
  const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(1, pctRaw)) : 0.1;

  // ✅ deterministik: aynı session/user + aynı query -> aynı variant
  const seedKey = `${opts?.sessionId || opts?.userId || ""}::${normalizeQuery(
    query
  )}`;
  const trafficSeed = seededRandom(seedKey);

  const useNewEngine = trafficSeed < pct;

  const runShadow =
    process.env.S40_SHADOW === "1" ||
    process.env.S40_SHADOW_RUN === "1" ||
    (process.env.NODE_ENV === "production" &&
      process.env.S40_SHADOW_PROD === "1");

  let finalResults;
  let shadowResults = null;

  finalResults = useNewEngine
    ? await runEngineS40(query, opts)
    : await runEngineS30(query, opts);

  if (runShadow) {
    try {
      const shadowEngine = useNewEngine ? runEngineS30 : runEngineS40;
      shadowResults = await shadowEngine(query, { ...opts, shadow: true });
      writeRevenueDiff({
        query,
        mode: useNewEngine ? "S40-live" : "S30-live",
        liveRevenue: estimateRevenue(finalResults),
        shadowRevenue: estimateRevenue(shadowResults),
        timestamp: Date.now(),
      });
    } catch (e) {
      console.warn("⚠️ S40 shadow run / revenue diff hata:", e?.message || e);
    }
  }

  return finalResults;
}

// ==================================================================
// SOFT TIMEOUT AYARI
// ==================================================================
const DEFAULT_ADAPTER_TIMEOUT_MS = 6000;

// ==================================================================
// CATEGORY-BASED TIMEOUT / DEADLINE (S40 HARDENED)
// ==================================================================
function minTimeoutByCategory(cat = "product") {
  const c = String(cat || "product").toLowerCase();
  if (c === "product" || c === "market" || c === "fashion") return 9000;
  if (c === "travel" || c === "tour") return 10000;
  if (c === "estate" || c === "health" || c === "car_rental") return 9000;
  return 8000;
}

function engineDeadlineByCategory(cat = "product") {
  const c = String(cat || "product").toLowerCase();
  if (c === "product" || c === "market" || c === "fashion") return 8500;
  if (c === "travel" || c === "tour") return 9500;
  if (c === "estate" || c === "health" || c === "car_rental") return 9000;
  return 8000;
}

// ==================================================================
// Hizmet / Avukat dikey algılayıcı
// ==================================================================
function detectServiceVertical(q = "") {
  const txt = String(q).toLowerCase();
  if (
    txt.includes("avukat") ||
    txt.includes("hukuk") ||
    txt.includes("boşanma") ||
    txt.includes("bosanma") ||
    txt.includes("icra") ||
    txt.includes("tazminat")
  )
    return "lawyer";

  return null;
}

// ===========================================================
// S200 PROXY HEADERS
// ===========================================================
const S200_DEFAULT_UA =
  process.env.S200_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function s200_buildProxyHeaders(region = "TR", extra = {}) {
  const r = String(region || "TR").toUpperCase();
  const acceptLang =
    r === "TR"
      ? "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6"
      : "en-US,en;q=0.9";

  const h = {
    "User-Agent": extra.ua || S200_DEFAULT_UA,
    Accept:
      extra.accept ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": extra.lang || acceptLang,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
  };

  if (extra.referer) h.Referer = String(extra.referer);
  if (extra.origin) h.Origin = String(extra.origin);

  return h;
}

function s200_mergeHeaders(base = {}, extra = {}) {
  const out = { ...(base || {}) };
  for (const k of Object.keys(extra || {})) {
    if (extra[k] != null && String(extra[k]).trim() !== "") out[k] = extra[k];
  }
  return out;
}

// ===========================================================
// TEXT/IMAGE/SPECS helpers
// ===========================================================
function stripHtml(txt = "") {
  return String(txt || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(txt = "", maxLen = 600) {
  const t = stripHtml(txt).replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen - 1).trim() + "…" : t;
}

function parsePriceLoose(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;

  const s = String(v).trim();
  if (!s) return null;

  let t = s.replace(/[^\d.,]/g, "");
  if (!t) return null;

  const hasDot = t.includes(".");
  const hasComma = t.includes(",");

  if (hasDot && hasComma) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      t = t.replace(/\./g, "").replace(",", ".");
    } else {
      t = t.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    if (/,(\d{1,2})$/.test(t)) t = t.replace(",", ".");
    else t = t.replace(/,/g, "");
  } else {
    if (/\.(\d{3})(\D|$)/.test(t) && !/\.\d{1,2}$/.test(t)) {
      t = t.replace(/\./g, "");
    }
  }

  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fixImageUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("data:")) return s;
  return s;
}

function collectImageCandidates(raw) {
  const list = [];

  const push = (x) => {
    if (!x) return;
    if (Array.isArray(x)) x.forEach(push);
    else list.push(x);
  };

  push(raw.image);
  push(raw.imageUrl);
  push(raw.img);
  push(raw.thumbnail);
  push(raw.photo);
  push(raw.picture);

  push(raw.images);
  push(raw.imageUrls);
  push(raw.gallery);
  push(raw.photos);

  if (raw.imageVariants && typeof raw.imageVariants === "object") {
    push(Object.values(raw.imageVariants));
  }

  return Array.from(new Set(list.map((x) => fixImageUrl(x)).filter(Boolean))).slice(
    0,
    8
  );
}

function extractSummaryFromRaw(raw) {
  return (
    normalizeText(raw.summary) ||
    normalizeText(raw.snippet) ||
    normalizeText(raw.shortDescription) ||
    normalizeText(raw.description) ||
    normalizeText(raw.desc) ||
    normalizeText(raw.details) ||
    null
  );
}

function extractBrandFromRaw(raw) {
  const b =
    raw.brand ||
    raw.marka ||
    raw.manufacturer ||
    raw?.product?.brand ||
    raw?.meta?.brand ||
    null;
  return b ? normalizeText(b, 80) : null;
}

function extractFeaturesFromRaw(raw) {
  const f =
    raw.features ||
    raw.highlights ||
    raw.bullets ||
    raw.attributes ||
    raw.specs ||
    raw?.product?.features ||
    null;

  const out = [];

  const add = (x) => {
    const t = normalizeText(x, 140);
    if (t) out.push(t);
  };

  if (Array.isArray(f)) {
    f.forEach((x) => add(x));
  } else if (f && typeof f === "object") {
    for (const k of Object.keys(f)) {
      const v = f[k];
      if (v == null) continue;
      add(`${k}: ${String(v)}`);
    }
  } else if (typeof f === "string") {
    String(f)
      .split(/[\n•\-|]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 10)
      .forEach(add);
  }

  return Array.from(new Set(out)).slice(0, 10);
}

function extractSpecsFromRaw(raw = null) {
  try {
    if (!raw || typeof raw !== "object") return null;

    const direct =
      raw.specs ||
      raw.specifications ||
      raw.attributes ||
      raw.props ||
      raw.properties ||
      raw.details ||
      raw.techSpecs ||
      raw.technicalDetails ||
      raw?.product?.specs ||
      raw?.product?.attributes ||
      null;

    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      const out = {};
      let c = 0;
      for (const k of Object.keys(direct)) {
        if (c >= 30) break;
        const key = safeString(k).trim();
        if (!key) continue;

        const v = direct[k];
        const val =
          v == null
            ? ""
            : typeof v === "string"
            ? v
            : typeof v === "number"
            ? String(v)
            : Array.isArray(v)
            ? v.map((x) => safeString(x)).filter(Boolean).join(", ")
            : typeof v === "object"
            ? JSON.stringify(v)
            : safeString(v);

        const cleanVal = safeString(val).replace(/\s+/g, " ").trim().slice(0, 180);
        if (!cleanVal) continue;

        out[key.slice(0, 60)] = cleanVal;
        c++;
      }
      return Object.keys(out).length ? out : null;
    }

    if (Array.isArray(direct)) {
      const out = {};
      let c = 0;
      for (const row of direct) {
        if (c >= 30) break;
        if (!row || typeof row !== "object") continue;
        const k = safeString(row.name || row.key || row.label || "").trim();
        const v = safeString(row.value || row.val || row.content || "").trim();
        if (!k || !v) continue;
        out[k.slice(0, 60)] = v.slice(0, 180);
        c++;
      }
      return Object.keys(out).length ? out : null;
    }

    return null;
  } catch {
    return null;
  }
}

// ===========================================================
// CATEGORY SANITY GUARD
// ===========================================================
function s200_categorySanityGuard(q = "", cat = "product") {
  const t = String(q || "").toLowerCase();
  const hasAny = (arr) => arr.some((x) => t.includes(x));

  const travel = [
    "otel",
    "hotel",
    "uçak",
    "ucak",
    "uçuş",
    "ucus",
    "flight",
    "bilet",
    "tur",
    "tatil",
    "rezervasyon",
    "check-in",
    "havaalan",
    "havaalanı",
    "airport",
  ];
  const carRental = [
    "araç kirala",
    "arac kirala",
    "rent a car",
    "car rental",
    "kiralık araç",
    "kiralik arac",
  ];
  const health = [
    "doktor",
    "hastane",
    "klinik",
    "randevu",
    "mhrs",
    "psikolog",
    "psikiyatri",
    "diş",
    "dis",
    "implant",
  ];
  const estate = [
    "satılık",
    "satilik",
    "kiralık",
    "kiralik",
    "daire",
    "villa",
    "arsa",
    "tarla",
    "emlak",
    "sahibinden",
    "emlakjet",
  ];
  const market = [
    "market",
    "grocery",
    "getir",
    "migros",
    "a101",
    "bim",
    "carrefour",
    "sipariş",
    "siparis",
  ];
  const fashion = [
    "tişört",
    "tshirt",
    "pantolon",
    "elbise",
    "ayakkabı",
    "ayakkabi",
    "mont",
    "ceket",
    "zara",
    "bershka",
    "nike",
    "adidas",
    "shein",
  ];

  const c = String(cat || "product").toLowerCase();

  if (c === "travel" && !hasAny(travel)) return "product";
  if (c === "car_rental" && !hasAny(carRental)) return "product";
  if (c === "health" && !hasAny(health)) return "product";
  if (c === "estate" && !hasAny(estate)) return "product";
  if (c === "market" && !hasAny(market)) return "product";
  if (c === "fashion" && !hasAny(fashion)) return "product";

  return c;
}

function normalizeProviderS9(v) {
  if (!v) return "unknown";

  let lower = String(v).trim().toLowerCase();

  lower = lower.replace(/^www\./, "").replace(/\.com(\.tr)?$/, "").trim();

  try {
    const canon = normalizeProviderKeyS9(lower);
    if (canon && canon !== "unknown") return canon;
  } catch {}

  return lower || "unknown";
}

// ===========================================================
// Provider URL çözümleyici
// ===========================================================
function resolveProviderFromUrlS9(url) {
  if (!url) return "unknown";

  try {
    const u = new URL(url.startsWith("//") ? "https:" + url : url);
    const host = u.hostname.toLowerCase();

    for (const key in PROVIDER_MASTER_S9) {
      const meta = PROVIDER_MASTER_S9[key];
      if (!meta?.mainDomain) continue;

      if (host.includes(meta.mainDomain.toLowerCase())) return key;

      if (Array.isArray(meta.altDomains)) {
        for (const dom of meta.altDomains) {
          if (host.includes(dom.toLowerCase())) return key;
        }
      }
    }
  } catch {}

  return "unknown";
}

// ===========================================================
// SYSTEM/NO RESULT FILTERS
// ===========================================================
const NO_RESULT_PATTERNS = [
  "sonuç bulunamadı",
  "sonuc bulunamadi",
  "ürün bulunamadı",
  "urun bulunamadi",
  "no result",
  "no results",
  "bulunamadı",
  "0 sonuç",
  "0 sonuc",
  "sonuç yok",
  "sonuc yok",
];

const SYSTEM_TITLE_PATTERNS = [
  "şu anda yanıt vermiyor",
  "su anda yanit vermiyor",
  "yanıt vermiyor",
  "yanit vermiyor",
  "geçici olarak",
  "gecici olarak",
  "erişilemiyor",
  "erisilemiyor",
  "bağlanılamadı",
  "baglanilamadi",
  "request failed",
  "status code",
  "timeout",
  "aborted",
  "forbidden",
  "not found",
  "cannot find module",
  "rate limit",
  // botwalls
  "access denied",
  "just a moment",
  "enable javascript",
  "captcha",
  "robot check",
  "cloudflare",
  "incapsula",
  "akamai",
  "ddos protection",
  "verifying you are human",
  "unusual traffic",
  "blocked",
  "was blocked",
  "security check",
  "attention required",
  "one more step",
  "too many requests",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "request blocked",
  "request denied",
  "please enable cookies",
  "enable cookies",
  "not authorized",
];

function isSystemishTitle(title = "") {
  const t = safeString(title).toLowerCase();
  return SYSTEM_TITLE_PATTERNS.some((p) => t.includes(p));
}

function isNoResultTitle(title) {
  const t = safeString(title).toLowerCase();
  if (isSystemishTitle(t)) return true;
  return NO_RESULT_PATTERNS.some((p) => t.includes(p));
}

function isHttpUrl(u) {
  if (!u) return false;
  try {
    const x = new URL(String(u).startsWith("//") ? "https:" + u : u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

// URL'siz item sadece bazı “lokasyon” kaynaklarında tolere edilebilir
const URL_OPTIONAL_PROVIDERS = new Set([
  "googleplaces",
  "osm",
  "openstreetmap",
  "mhrs",
  "enabiz",
]);

// ===========================================================
// RAW JSON-SAFE (circular/huge killer) — response patlamasın
// ===========================================================
function sanitizeRawForResponse(raw, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 5;
  const maxKeys = Number.isFinite(opts.maxKeys) ? opts.maxKeys : 120;
  const maxArray = Number.isFinite(opts.maxArray) ? opts.maxArray : 40;
  const maxStr = Number.isFinite(opts.maxStr) ? opts.maxStr : 2000;

  const seen = new WeakSet();

  const cutStr = (s) => {
    const t = String(s);
    if (t.length <= maxStr) return t;
    return t.slice(0, maxStr - 1) + "…";
  };

  const walk = (v, depth) => {
    if (v == null) return v;

    const tv = typeof v;

    if (tv === "string") return cutStr(v);
    if (tv === "number" || tv === "boolean") return v;

    if (tv === "function") return undefined;
    if (tv === "bigint") return String(v);

    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: cutStr(v.message) };

    try {
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
        return { _type: "Buffer", length: v.length };
      }
      if (ArrayBuffer.isView(v)) {
        return { _type: v.constructor?.name || "TypedArray", length: v.byteLength };
      }
    } catch {}

    if (tv === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);

      if (depth >= maxDepth) return "[MaxDepth]";

      if (Array.isArray(v)) {
        const out = [];
        const lim = Math.min(v.length, maxArray);
        for (let i = 0; i < lim; i++) {
          out.push(walk(v[i], depth + 1));
        }
        if (v.length > lim) out.push(`…(+${v.length - lim})`);
        return out;
      }

      const out = {};
      const keys = Object.keys(v);
      const lim = Math.min(keys.length, maxKeys);

     for (let i = 0; i < lim; i++) {
  const k = keys[i];
  if (!k) continue;

  // ✅ SENSITIVE KEY GUARD (raw içinde token/cookie sızmasın)
  const kk = String(k).toLowerCase();
  if (
    kk === "headers" ||
    kk.includes("cookie") ||
    kk.includes("authorization") ||
    kk.includes("token") ||
    kk.includes("apikey") ||
    kk.includes("api_key") ||
    kk.includes("secret") ||
    kk.includes("password")
  ) {
    continue;
  }

  // existing skip list (devam)
  if (
    k === "req" ||
    k === "request" ||
    k === "res" ||
    k === "response" ||
    k === "socket" ||
    k === "agent" ||
    k === "client" ||
    k === "config" ||
    k === "_raw" ||
    k === "internalData" ||
    k === "debug"
  ) {
    continue;
  }

  try {
    const val = walk(v[k], depth + 1);
    if (val !== undefined) out[k] = val;
  } catch {}
}


      if (keys.length > lim) out._truncatedKeys = keys.length - lim;

      return out;
    }

    return undefined;
  };

  try {
    return walk(raw, 0);
  } catch {
    return null;
  }
}

// ==========================================================
// priceText helper (V4 enrich için)
// ==========================================================
function s200_priceText(price, currency = "TRY") {
  if (!isValidNumber(price) || price <= 0) return null;
  const sym =
    currency === "TRY"
      ? "₺"
      : currency === "USD"
      ? "$"
      : currency === "EUR"
      ? "€"
      : `${currency} `;
  const rounded = Math.round(price * 100) / 100;
  return sym + String(rounded);
}

// ==========================================================
// UNIVERSAL NORMALIZE (S200 ITEM SHAPE)
// ==========================================================
function normalizeItem(raw, mainCategory, adapterName = "unknown_adapter") {
  if (!raw || typeof raw !== "object") return null;

  // -------- FİYAT --------
  const priceRaw =
    raw.price ??
    raw.finalPrice ??
    raw.amount ??
    raw.minPrice ??
    raw.maxPrice ??
    raw?.priceValue ??
    raw?.priceAmount ??
    raw?.pricing?.price ??
    raw?.pricing?.amount?.value ??
    null;

  // ✅ Loose parser (TRY/locale tolerant)
  const price = parsePriceLoose(priceRaw);

  // -------- RATING --------
  const ratingRaw =
    raw.rating ??
    raw.score ??
    raw.stars ??
    raw.reviewScore ??
    raw?.reviews?.average ??
    null;

 const ratingNorm =
  typeof ratingRaw === "string" ? ratingRaw.replace(",", ".") : ratingRaw;

const rating =
  typeof ratingNorm === "number"
    ? ratingNorm
    : Number.isFinite(Number(ratingNorm))
    ? Number(ratingNorm)
    : null;


  // -------- TITLE --------
   const titleCandidate =
    raw.title ||
    raw.name ||
    raw.productName ||
    raw.label ||
    raw.description ||
    null;

  const title = normalizeText(titleCandidate, 300);
  if (!title) return null;

  // -------- URL / ORIGIN / FINAL --------
  const finalUrlRaw =
    raw.finalUrl || raw.finalURL || raw.deeplink || raw.deepLink || null;

  // originUrl: identity/debug; should NOT be replaced by affiliate params
  let originUrlRaw =
    raw.originUrl ||
    raw.originURL ||
    raw.sourceUrl ||
    raw.sourceURL ||
    raw.originalUrl ||
    raw.originalURL ||
    null;

  // if originUrl not explicitly provided, fall back to the first "real" link we can find
  if (!originUrlRaw) {
    originUrlRaw =
      raw.url ||
      raw.link ||
      raw.href ||
      raw.permalink ||
      raw.website ||
      raw.pageUrl ||
      null;
  }

  const urlRaw =
    raw.url ||
    originUrlRaw ||
    finalUrlRaw ||
    raw.link ||
    raw.href ||
    raw.permalink ||
    raw.website ||
    raw.pageUrl ||
    null;

  const originUrl = originUrlRaw ? safeString(originUrlRaw) : null;
  const url = urlRaw ? safeString(urlRaw) : null;
  const finalUrl = finalUrlRaw ? safeString(finalUrlRaw) : null;

  // -------- URL FIX (DEEP LINK GUARD) --------
  // Some affiliate injectors may downgrade product links to the provider homepage.
  // That kills conversion. Prefer originUrl when finalUrl/url is a homepage.
  const isHomeUrl = (u) => {
    const s = String(u || "").trim();
    if (!s) return true;
    try {
      const U = new URL(s);
      const p = String(U.pathname || "/").toLowerCase();
      return p === "/" || p === "/index.html";
    } catch {
      // if it's not a valid URL string, don't treat as home
      return false;
    }
  };

  const mergeTrackingParams = (fromUrl, toUrl) => {
    const a = String(fromUrl || "").trim();
    const b = String(toUrl || "").trim();
    if (!b) return a || null;
    try {
      const A = new URL(a);
      const B = new URL(b);
      // Common affiliate / analytics params we may want to preserve.
      const keys = [
        "subid",
        "aff",
        "affid",
        "affiliate",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
      ];
      for (const k of keys) {
        const v = A.searchParams.get(k);
        if (v && !B.searchParams.get(k)) B.searchParams.set(k, v);
      }
      return B.toString();
    } catch {
      return b || a || null;
    }
  };

  let finalUrlFix = finalUrl;
  let urlFix = url;

  // If affiliate url is homepage but originUrl is deep, use originUrl (+copy tracking params)
  if (isHomeUrl(finalUrlFix) && originUrl && !isHomeUrl(originUrl)) {
    finalUrlFix = mergeTrackingParams(finalUrlFix, originUrl);
  }

  // If url is homepage but originUrl is deep, use originUrl (+copy tracking params from final/url)
  if (isHomeUrl(urlFix) && originUrl && !isHomeUrl(originUrl)) {
    urlFix = mergeTrackingParams(finalUrlFix || urlFix, originUrl);
  }

  // If finalUrlFix is deep, prefer it for urlFix
  if (finalUrlFix && !isHomeUrl(finalUrlFix)) {
    urlFix = finalUrlFix;
  }

  // canonical URL for stable IDs (strip query/hash to avoid affiliate/utm drift)
  const canonicalUrlForId = (u) => {
    if (!u) return null;
    try {
      const U = new URL(String(u));
      U.hash = "";
      U.search = "";
      return U.toString();
    } catch {
      const s = String(u);
      return s.split("#")[0].split("?")[0];
    }
  };

  // -------- ID --------
  let id =
    raw.id ||
    raw.sku ||
    raw.productId ||
    raw.offerId ||
    raw.uid ||
    originUrl ||
    url ||
    finalUrl ||
    null;

  try {
    id = id == null ? null : String(id);
    if (id && /^https?:\/\//i.test(id)) id = canonicalUrlForId(id);
    if (id && id.length > 260) {
      id = crypto.createHash("sha1").update(id).digest("hex");
    }
  } catch {
    id = null;
  }

  if (!id) {
    const seedUrl = canonicalUrlForId(originUrl || urlFix || finalUrlFix || "") || "";
    const seed = `${title || ""}|${adapterName || ""}|${seedUrl}`;
    id =
      "fae_" +
      crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
  }

  // -------- PROVIDER --------
  let providerRaw =
    raw.provider ||
    raw.vendor ||
    raw.source ||
    raw.platform ||
    raw.channel ||
    adapterName ||
    "unknown";

  let provider = String(providerRaw || "").toLowerCase();

  provider =
    String(provider || "")
      .toLowerCase()
      .replace(/scraper|adapter/g, "")
      .replace("googleplacesdetails", "googleplaces")
      .replace("google_places", "googleplaces")
      .replace("google_maps", "googleplaces")
      .replace("google-places", "googleplaces")
      .replace("booking.com", "booking")
      .replace("trendyol.com", "trendyol")
      .replace("www.trendyol.com", "trendyol")
      .replace("hepsiburada.com", "hepsiburada")
      .replace("www.hepsiburada.com", "hepsiburada")
      .replace("akakce.com", "akakce")
      .replace("www.akakce.com", "akakce")
      .replace("google shopping", "googleshopping")
      .replace("google_shopping", "googleshopping")
      .replace("google-shopping", "googleshopping")
      .replace("shopping.google", "googleshopping")
      .replace("google.shop", "googleshopping")
      .replace("google_shop", "googleshopping")
      .replace("google.shopping", "googleshopping")
      .replace("serp_api", "serpapi")
      .replace(/^www\./, "")
      .trim() || "unknown";

  if ((!provider || provider === "unknown") && (url || finalUrl)) {
  const resolvedProvider = resolveProviderFromUrlS9(finalUrl || url);
  if (resolvedProvider && resolvedProvider !== "unknown") {
    provider = resolvedProvider;
  }
}



  provider = String(provider || "unknown").trim().toLowerCase();
  provider = normalizeProviderS9(provider);

  // -------- CATEGORY --------
  let category = mainCategory;

  if (mainCategory && mainCategory !== "genel") {
    category = mainCategory.toLowerCase();
  }

  if (raw.aiCategory && typeof raw.aiCategory === "string") {
    category = raw.aiCategory.toLowerCase().trim();
  } else {
    if (provider.includes("booking")) category = "travel";
    else if (provider.includes("skyscanner")) category = "travel";
    else if (provider.includes("googleplaces")) category = "location";
    else if (provider.includes("openstreetmap") || provider === "osm")
      category = "location";
    else if (
      provider.includes("trendyol") ||
      provider.includes("hepsiburada") ||
      provider.includes("googleshopping") ||
      provider.includes("akakce")
    ) {
      category = "product";
    } else if (provider.includes("office")) {
      category = "office";
    }
  }

  const currency =
    raw.currency ||
    raw.ccy ||
    raw.currencyCode ||
    raw?.pricing?.currency ||
    "TRY";

  const region = raw.region || raw.country || raw.locale || "TR";

  // ✅ S35/S200 fiyat kanalı korunumu
  const optimizedPriceRaw = raw.optimizedPrice ?? raw.optimized_price ?? null;
  const finalPriceRaw = raw.finalPrice ?? raw.final_price ?? null;

  const optimizedPrice =
    typeof optimizedPriceRaw === "number"
      ? optimizedPriceRaw
      : Number.isFinite(Number(optimizedPriceRaw))
      ? Number(optimizedPriceRaw)
      : null;

  const finalPrice =
    typeof finalPriceRaw === "number"
      ? finalPriceRaw
      : Number.isFinite(Number(finalPriceRaw))
      ? Number(finalPriceRaw)
      : null;

  const priceInjected = !!(
    raw.priceInjected ?? raw._priceInjected ?? raw.__priceInjected ?? false
  );

  // ✅ Image + Summary + Features + Specs
  const images = collectImageCandidates(raw);
  const image = images[0] || null;
  const summary = extractSummaryFromRaw(raw);
  const brand = extractBrandFromRaw(raw);
  const features = extractFeaturesFromRaw(raw);
  const specs = extractSpecsFromRaw(raw);

  // ✅ RAW JSON-safe (circular/huge protection)
  const rawSafe = sanitizeRawForResponse(raw, {
    maxDepth: 5,
    maxKeys: 140,
    maxArray: 45,
    maxStr: 2000,
  });

  // V4 enrich (schema-safe)
  const ratingCountRaw =
    raw?.ratingCount ??
    raw?.reviewCount ??
    raw?.reviewsCount ??
    raw?.reviews?.count ??
    null;

  const availability =
    raw?.availability ?? raw?.inStock ?? raw?.stock ?? raw?.stockStatus ?? null;

  const seller =
    raw?.seller ?? raw?.merchant ?? raw?.store ?? raw?.sellerName ?? null;

  const model =
    raw?.model ??
    raw?.modelName ??
    raw?.mpn ??
    raw?.productCode ??
    raw?.sku ??
    null;

  const effectivePrice =
    (isValidNumber(optimizedPrice) && optimizedPrice > 0
      ? optimizedPrice
      : null) ??
    (isValidNumber(finalPrice) && finalPrice > 0 ? finalPrice : null) ??
    (isValidNumber(price) && price > 0 ? price : null);

  const ratingCount = isValidNumber(ratingCountRaw)
    ? ratingCountRaw
    : Number.isFinite(Number(ratingCountRaw))
    ? Number(ratingCountRaw)
    : null;

  const priceText = s200_priceText(effectivePrice, currency || "TRY");

  return {
    id,
    title, // ✅ zaten normalizeText ile temiz + 300 limitli
    url: urlFix ? safeString(urlFix).trim() : null,
    originUrl: originUrl ? safeString(originUrl).trim() : null,
    finalUrl: finalUrlFix ? safeString(finalUrlFix).trim() : null,

    price: price ?? null,
    finalPrice: finalPrice ?? null,
    optimizedPrice: optimizedPrice ?? null,
    priceInjected,
    rating: rating ?? null,

    image: image ? safeString(image) : null,
    images: Array.isArray(images) ? images.slice(0, 8) : [],
    brand: brand ? safeString(brand).slice(0, 80) : null,
    summary: summary ? safeString(summary).slice(0, 500) : null,
    features: Array.isArray(features) ? features.slice(0, 20) : [],
    specs: specs && typeof specs === "object" ? specs : null,

    // V4 enrich (optional fields)
    priceText,
    ratingCount,
    availability,
    seller: seller ? safeString(seller).slice(0, 80) : null,
    model: model ? safeString(model).slice(0, 80) : null,

    provider,
    currency,
    region,
    category,
    adapterSource: adapterName || raw.adapterSource || "unknown",
    raw: rawSafe,
  };
}

// ===========================================================
// CLEAN + FILTER PIPELINE
// ===========================================================
function cleanResults(arr = []) {
  const base = Array.isArray(arr) ? arr : [];
  const out = [];

  for (const item of base) {
    if (!item) continue;
    if (!item.title) continue;
    if (isNoResultTitle(item.title)) continue;

    const prov = safeString(item.provider || "unknown").toLowerCase();

    const bestUrl = item.finalUrl || item.url || null;
    if (!bestUrl && !URL_OPTIONAL_PROVIDERS.has(prov)) continue;
    if (bestUrl && !isHttpUrl(bestUrl)) continue;

    if (
      item.price !== null &&
      item.price !== undefined &&
      typeof item.price !== "number"
    )
      continue;

    // bot-wall / systemish raw flags
    try {
      const r = item.raw;
      if (r && typeof r === "object") {
        if (r.ok === false) continue;
        if (r.error) continue;
        if (r.timeout) continue;
        if (r.aborted) continue;
        if (r.status && (r.status === 403 || r.status === 429 || r.status >= 500))
          continue;
      }
    } catch {}

    // classic botwall keywords in title
    try {
      const title = String(item.title || "").toLowerCase();
      if (
        title.includes("captcha") ||
        title.includes("cloudflare") ||
        title.includes("verifying") ||
        title.includes("unusual traffic") ||
        title.includes("access denied") ||
        title.includes("attention required") ||
        title.includes("robot check")
      ) {
        continue;
      }
    } catch {}

    out.push(item);
  }

  return out;
}

function antiCorruptionFilter(items = []) {
  const cleaned = [];
  const base = Array.isArray(items) ? items : [];

  for (const item of base) {
    if (!item) continue;

    const title = safeString(item.title || "").trim();
    if (title.length < 2) continue;
    if (isSystemishTitle(title)) continue;

    // price: null serbest; varsa sayı olmalı ve mantıklı aralıkta olmalı
    if (item.price != null) {
      const p = Number(item.price);
      if (!isValidNumber(p) || p <= 0 || p > 10_000_000) {
        item.price = null;
      } else {
        item.price = p;
      }
    }

    if (item.finalPrice != null) {
      const fp = Number(item.finalPrice);
      if (!isValidNumber(fp) || fp <= 0 || fp > 10_000_000) {
        item.finalPrice = null;
      } else {
        item.finalPrice = fp;
      }
    }

    if (item.optimizedPrice != null) {
      const op = Number(item.optimizedPrice);
      if (!isValidNumber(op) || op <= 0 || op > 10_000_000) {
        item.optimizedPrice = null;
      } else {
        item.optimizedPrice = op;
      }
    }

    if (item.rating != null) {
      const r = Number(item.rating);
      if (!isValidNumber(r)) continue;
      if (r < 0 || r > 5.1) continue;
      item.rating = r;
    }

    const provider = safeString(item.provider || "unknown").toLowerCase();
    if (provider.length > 60) continue;

    cleaned.push(item);
  }

  return cleaned;
}


function dropPriceOutliers(items = []) {
  const prices = items
  .map((it) => s35_effectivePrice(it))
  .filter((p) => isValidNumber(p) && p > 0)
  .sort((a, b) => a - b);


  if (prices.length < 6) return items;

  const mid = Math.floor(prices.length / 2);
  const median = prices[mid];

  if (!isValidNumber(median) || median <= 0) return items;

  const minAllowed = median / 8;
  const maxAllowed = median * 8;
return items.filter((it) => {
  const p = s35_effectivePrice(it);
  if (!isValidNumber(p) || p <= 0) return true; // fiyat yoksa dokunma

  if (p < minAllowed) return false;
  if (p > maxAllowed) return false;
  return true;
});
}

function mergeDuplicates(items = []) {
  const map = new Map();

  for (const item of items) {
    const key =
      (item.title || "").slice(0, 80).toLowerCase() +
      "::" +
      (item.provider || "unknown");

    if (!map.has(key)) {
      map.set(key, item);
    } else {
      const old = map.get(key);
      const merged = {
        ...old,
        price:
          old.price && item.price
            ? Math.min(old.price, item.price)
            : old.price || item.price,
        rating:
          old.rating && item.rating
            ? Math.max(old.rating, item.rating)
            : old.rating || item.rating,
        adapterSource:
          (old.adapterSource || "").length >= (item.adapterSource || "").length
            ? old.adapterSource
            : item.adapterSource,
        url: old.url || item.url || null,
        finalUrl: old.finalUrl || item.finalUrl || null,
      };
      map.set(key, merged);
    }
  }

  return Array.from(map.values());
}

function buildUltraKey(item) {
  const provider = (item.provider || "unknown").toLowerCase();
  const title = safeString(item.title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  const ep = s35_effectivePrice(item);
const priceBand = isValidNumber(ep) && ep > 0 ? Math.round(ep / 100) : "noprice";


  return `${provider}::${title}::${priceBand}`;
}

function ultraMergeByProviderAndProduct(items = []) {
  const map = new Map();

  for (const item of items) {
    if (!item || !item.title) continue;

    const key = buildUltraKey(item);

    if (!map.has(key)) {
      map.set(key, { ...item });
      continue;
    }

    const existing = map.get(key);
    const sim = basicSimilarity(existing.title, item.title);
    if (sim < 0.15) {
      // ✅ deterministic altKey (no Math.random): stable across runs/caches/debug
      const seed = `${key}|${safeString(item.title || "").toLowerCase()}|${safeString(item.finalUrl || item.url || "")}|${String(item.price ?? "")}`;
      const altKey = `${key}::alt_${crypto
        .createHash("sha1")
        .update(seed)
        .digest("hex")
        .slice(0, 8)}`;
      map.set(altKey, { ...item });
      continue;
    }

    const merged = {
      ...existing,
      price:
        typeof existing.price === "number" && typeof item.price === "number"
          ? Math.min(existing.price, item.price)
          : existing.price ?? item.price ?? null,
      rating:
        typeof existing.rating === "number" &&
        typeof item.rating === "number"
          ? Math.max(existing.rating, item.rating)
          : existing.rating ?? item.rating ?? null,
      url: existing.url || item.url || null,
      finalUrl: existing.finalUrl || item.finalUrl || null,
      currency: existing.currency || item.currency || "TRY",
      region: existing.region || item.region || "TR",
      adapterSource: Array.from(
        new Set(
          []
            .concat(existing.adapterSource || [])
            .concat(item.adapterSource || [])
            .map((x) => String(x))
        )
      ).join(","),
    };

    map.set(key, merged);
  }

  return Array.from(map.values());
}

// ==================================================================
// ADAPTER RESOLVE (string / object.fn string → wrappedAdapters)
// ==================================================================
function s200_resolveAdapterCallable(adapter) {
  try {
    if (!adapter) return null;

    if (typeof adapter === "function") return adapter;

    // string adapter name -> wrappedAdapters lookup
    if (typeof adapter === "string") {
      const key = String(adapter).trim();
      if (!key) return null;

      // direct hit
      if (wrappedAdapters && typeof wrappedAdapters[key] === "function") {
        return wrappedAdapters[key];
      }

      // try normalized keys
      const k2 = key.replace(/[^a-z0-9_]/gi, "_");
      if (wrappedAdapters && typeof wrappedAdapters[k2] === "function") {
        return wrappedAdapters[k2];
      }

      // sometimes exports are like searchXxxAdapter
      const alt1 = "search" + key[0]?.toUpperCase() + key.slice(1);
      if (wrappedAdapters && typeof wrappedAdapters[alt1] === "function") {
        return wrappedAdapters[alt1];
      }

      return null;
    }

    // object adapter
    if (adapter && typeof adapter === "object") {
      if (typeof adapter.fn === "function") return adapter.fn;

      // fn is string name
      if (typeof adapter.fn === "string") {
        const fnKey = String(adapter.fn).trim();
        if (wrappedAdapters && typeof wrappedAdapters[fnKey] === "function") {
          return wrappedAdapters[fnKey];
        }
        const fnKey2 = fnKey.replace(/[^a-z0-9_]/gi, "_");
        if (wrappedAdapters && typeof wrappedAdapters[fnKey2] === "function") {
          return wrappedAdapters[fnKey2];
        }
      }

      // sometimes object itself is exported name under adapter.name
      if (typeof adapter.name === "string") {
        const nm = String(adapter.name).trim();
        if (wrappedAdapters && typeof wrappedAdapters[nm] === "function") {
          return wrappedAdapters[nm];
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ==================================================================
// SAFE ABORT WRAPPER (timer cleanup + parent abort + headers propagate)
// ==================================================================
async function runWithSoftTimeout(adapterDef, query, options = {}) {
  const {
    name = "unknown_adapter",
    fn,
    timeoutMs = DEFAULT_ADAPTER_TIMEOUT_MS,
    providerKey = null,
  } = adapterDef || {};

  const started = Date.now();

  if (typeof fn !== "function") {
    return { ok: false, items: [], count: 0, error: "Invalid adapter fn" };
  }

  const controller = new AbortController();
  const signal = controller.signal;

  const { parentSignal, ...passOptions } = options || {};
  const adapterOptions = { ...(passOptions || {}), signal };

  // ✅ Proxy / Anti-403 header seti (adapter isterse kullanır)
  try {
    const regionForHeaders = adapterOptions.region || "TR";
    const baseHeaders = s200_buildProxyHeaders(regionForHeaders, {
      referer: adapterOptions.referer || adapterOptions.referrer || null,
      origin: adapterOptions.origin || null,
      ua: adapterOptions.ua || null,
      accept: adapterOptions.accept || null,
      lang: adapterOptions.lang || null,
    });

    adapterOptions.headers = s200_mergeHeaders(
      baseHeaders,
      adapterOptions.headers || {}
    );
    adapterOptions.requestHeaders = adapterOptions.headers;
    adapterOptions.proxyHeaders = adapterOptions.headers;
  } catch {}

  let finished = false;
  let timerId = null;

  const parentAbortHandler = () => {
    try {
      controller.abort();
    } catch {}
  };

  try {
    if (parentSignal?.aborted) {
      parentAbortHandler();
    } else if (parentSignal?.addEventListener) {
      parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
    }

    const execution = (async () => {
      const prevCtx = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = {
        ...(prevCtx && typeof prevCtx === "object" ? prevCtx : {}),
        adapter: String(providerKey || name || "unknown").slice(0, 80),
      };

      try {
        const res = await fn(query, adapterOptions);
        finished = true;
        return res;
      } finally {
        globalThis.__S200_ADAPTER_CTX = prevCtx;
      }
    })().catch((err) => {
      finished = true;

      const msg = err?.message || String(err);
      const looksAborted =
        signal.aborted ||
        parentSignal?.aborted ||
        err?.name === "AbortError" ||
        /abort|aborted/i.test(msg);

      if (looksAborted) {
        return { ok: false, aborted: true, items: [], count: 0, error: msg };
      }

      console.warn(`❌ Adapter hata (${name}) →`, msg);
      return { ok: false, items: [], count: 0, error: msg };
    });

    const timeoutPromise = new Promise((resolve) => {
      timerId = setTimeout(() => {
        if (finished) return resolve(null);

        const dur = Date.now() - started;
        console.warn(`⏳ ${name} timeout (${timeoutMs}ms) → abort (dur=${dur}ms)`);

        try {
          controller.abort();
        } catch {}

        resolve({ ok: false, timeout: true, items: [], count: 0 });
      }, timeoutMs);
    });

    const raced = await Promise.race([execution, timeoutPromise]);
    const result = raced != null ? raced : { ok: false, items: [], count: 0 };

    const dur = Date.now() - started;
    const count =
      (Array.isArray(result)
        ? result.length
        : Array.isArray(result?.items)
        ? result.items.length
        : result?.count || 0) || 0;

    const sample =
      (Array.isArray(result) ? result?.[0]?.title : result?.items?.[0]?.title) ||
      null;

    console.log(`⚡ ${name} bitti → ${dur}ms`, {
      count,
      sample,
      timeout: !!result?.timeout,
      aborted: !!result?.aborted,
    });

    return result;
  } catch (err) {
    const msg = err?.message || String(err);
    const status = err?.status ?? err?.response?.status ?? err?.cause?.status;
    const code = err?.code;
    return { ok: false, items: [], count: 0, error: msg, status: status || undefined, code: code || undefined };
  } finally {
    try {
      if (timerId) clearTimeout(timerId);
    } catch {}

    try {
      parentSignal?.removeEventListener?.("abort", parentAbortHandler);
    } catch {}
  }
}


// ==================================================================
// S200 RL CONTROL (DEV’de soft, PROD’da strict)
// ==================================================================
const S200_RL = {
  strict:
    process.env.NODE_ENV === "production" || process.env.S200_RL_STRICT === "1",
  bypass:
    process.env.S200_DISABLE_RL === "1" ||
    process.env.S200_RL_BYPASS === "1" ||
    process.env.DISABLE_RATE_LIMIT === "1",
  tripAfter: Number(process.env.S200_RL_TRIP_AFTER || 6),
  tripRatio: Number(process.env.S200_RL_TRIP_RATIO || 0.9),
};

function s200_shouldBypassRL(opts = null) {
  if (opts?.shadow && process.env.NODE_ENV !== "production") return true;
  if (S200_RL.bypass) return true;
  if (!S200_RL.strict && globalThis.__S200_RL_DISABLED) return true;
  return false;
}

function s200_tripRLIfBroken(rlCtx) {
  if (S200_RL.strict) return false;
  if (!rlCtx) return false;
  if (rlCtx.tried < S200_RL.tripAfter) return false;

  const ratio = rlCtx.denied / Math.max(1, rlCtx.tried);
  if (ratio >= S200_RL.tripRatio) {
    globalThis.__S200_RL_DISABLED = true;
    console.warn(
      "🧯 S200 RL TRIPPED (dev) → rate limit bypass açıldı (bu process için).",
      { tried: rlCtx.tried, denied: rlCtx.denied, ratio }
    );
    return true;
  }
  return false;
}

function s200_guessProviderKeyFromName(name = "") {
  let s = String(name || "").toLowerCase().trim();

  s = s
    .replace(/^search_?/i, "")
    .replace(/^fetch_?/i, "")
    .replace(/^run_?/i, "")
    .replace(/_?adapter$/i, "")
    .replace(/_?scraper$/i, "")
    .replace(/_?search$/i, "");

  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const alias = {
    google_shopping: "googleshopping",
    google_shop: "googleshopping",
    googleshopping: "googleshopping",
    googleplacesdetails: "googleplaces",
    google_places: "googleplaces",
    google_maps: "googleplaces",
    openstreetmap: "osm",
    osm: "osm",
    serp: "serpapi",
    serp_api: "serpapi",
    serpapi: "serpapi",
  };

  return alias[s] || s || "unknown";
}

// ==================================================================
// S200 — RATE LIMITER İÇİN GELİŞMİŞ ADAPTER META ÇÖZÜMLEYİCİ
// ==================================================================
function resolveAdapterMetaForRL(adapter, mainCategory) {
  let adapterName = "unknown_adapter";
  let providerKey = "unknown";

  if (adapter && typeof adapter === "object") {
    adapterName = adapter.name || adapterName;

    if (typeof adapter.provider === "string" && adapter.provider.trim()) {
      providerKey = adapter.provider.trim();
    } else {
      providerKey = s200_guessProviderKeyFromName(adapterName);
    }
  } else if (typeof adapter === "function") {
    adapterName = adapter.name || "anonymous_adapter";
    providerKey = s200_guessProviderKeyFromName(adapterName);
  } else if (typeof adapter === "string") {
    adapterName = adapter;
    providerKey = s200_guessProviderKeyFromName(adapterName);
  }

  try {
    const norm = normalizeProviderKeyS9(
      String(providerKey || "").toLowerCase()
    );
    if (norm && norm !== "unknown") providerKey = norm;
  } catch {
    providerKey = String(providerKey || "unknown").toLowerCase();
  }

  try {
    providerKey = String(providerKey || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  } catch {}

  try {
    if (!PROVIDER_MASTER_S9?.[providerKey] && providerKey.includes("_")) {
      const head = providerKey.split("_")[0];
      if (PROVIDER_MASTER_S9?.[head]) providerKey = head;
    }
  } catch {}

  const category = mainCategory || "product";

  return {
    adapterName: adapterName || "unknown_adapter",
    providerKey: providerKey || "unknown",
    category: category || "product",
  };
}

// ==================================================================
// SAFE RUN ADAPTER — S200 RL v8.1 (bucket fix + guard)
// ==================================================================
async function safeRunAdapter(
  adapter,
  query,
  region,
  mainCategory,
  engineSignal = null,
  rlCtx = null,
  engineOpts = null
) {
  // ✅ string/object.fn string resolve (adapterRegistry drift killer)
  try {
    const callable = s200_resolveAdapterCallable(adapter);
    if (callable && typeof callable === "function") {
      adapter =
        typeof adapter === "object" && adapter && typeof adapter === "object"
          ? { ...(adapter || {}), fn: callable }
          : callable;
    } else {
      // if adapter is a plain string and cannot resolve -> drop early
      if (typeof adapter === "string") {
        console.warn("⚠️ Adapter string resolve edilemedi:", adapter);
        return [];
      }
      if (adapter && typeof adapter === "object" && typeof adapter.fn === "string") {
        console.warn("⚠️ Adapter.fn string resolve edilemedi:", adapter.fn);
      }
    }
  } catch {}

  const { adapterName, providerKey, category } = resolveAdapterMetaForRL(
    adapter,
    mainCategory
  );

  if (rlCtx) rlCtx.tried++;

  let allowed = true;

  const bypass = s200_shouldBypassRL(engineOpts);

  if (!bypass) {
    try {
      if (rateLimiter && typeof rateLimiter.checkAdapter === "function") {
        allowed = await rateLimiter.checkAdapter(providerKey, region, category, {
          provider: providerKey,
          adapter: adapterName,
        });
      } else if (rateLimiter && typeof rateLimiter.check === "function") {
        // ✅ FIX: adapterName bucket’ı parçalama -> provider+region+category tek bucket
        const key = `adapter_${providerKey}_${region}_${category}`;
        allowed = await rateLimiter.check(key, {
          limit: 30,
          windowMs: 60_000,
          burst: true,
        });
      } else {
        allowed = true;
      }
    } catch (e) {
      console.warn("⚠️ RL error → allow (dev-safe):", e?.message || e);
      allowed = true;
    }
  }

  if (!allowed) {
    if (rlCtx) rlCtx.denied++;

    if (s200_tripRLIfBroken(rlCtx)) {
      allowed = true;
    }
  }

  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → ${adapterName} [${providerKey}]`);
    return [];
  }

  try {
    return await safeRun(adapter, category, query, region, engineSignal, {
      adapterName,
      providerKey,
      engineOpts,
    });
  } catch (err) {
    console.warn("safeRunAdapter hata:", err?.message || err);
    return [];
  }
}

// ==========================================================
// SAFE RUN (HARDENED: adapterName drift FIX + providerHint)
// ==========================================================
async function safeRun(
  adapter,
  mainCategory,
  query,
  region,
  engineSignal = null,
  ctx = null
) {
  const start = Date.now();

  const ctxAdapterName =
    ctx && typeof ctx.adapterName === "string" && ctx.adapterName.trim()
      ? ctx.adapterName.trim()
      : null;

  const providerKeyHint =
    ctx && typeof ctx.providerKey === "string" && ctx.providerKey.trim()
      ? ctx.providerKey.trim()
      : null;

  // Engine options (diagCollector, shadow flags, etc.)
  const opts = (ctx && typeof ctx === "object" ? ctx.engineOpts : null) || {};

  let adapterName = ctxAdapterName || "unknown_adapter";
  let fn = null;
  let timeoutMs = DEFAULT_ADAPTER_TIMEOUT_MS;

  // adapter çözümle (ama ctxAdapterName varsa ÜSTÜNE YAZMA)
  if (typeof adapter === "function") {
    fn = adapter;
    if (!ctxAdapterName) adapterName = adapter.name || "unknown_adapter";
  } else if (adapter && typeof adapter === "object") {
    if (!ctxAdapterName) adapterName = adapter.name || adapterName;

    // ✅ object.fn function OR string resolve
    if (typeof adapter.fn === "function") fn = adapter.fn;
    else {
      const resolved = s200_resolveAdapterCallable(adapter);
      if (resolved && typeof resolved === "function") fn = resolved;
    }

    if (adapter.timeoutMs && Number.isFinite(adapter.timeoutMs)) {
      timeoutMs = adapter.timeoutMs;
    }
  } else if (typeof adapter === "string") {
    // ✅ string adapter name resolve
    const resolved = s200_resolveAdapterCallable(adapter);
    if (resolved && typeof resolved === "function") {
      fn = resolved;
      if (!ctxAdapterName) adapterName = adapter;
    }
  }

  try {
    timeoutMs = Math.max(timeoutMs, minTimeoutByCategory(mainCategory));
  } catch {
    timeoutMs = Math.max(timeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS);
  }

  if (typeof fn !== "function") {
    console.warn("safeRun: geçersiz adapter fn:", adapterName);
    return [];
  }

    try {
    const baseHeaders = s200_buildProxyHeaders(region, {});
    const mergedHeaders = s200_mergeHeaders(
      baseHeaders,
      (ctx && typeof ctx === "object" ? ctx.headers : null) || {}
    );

    // ✅ S200 global adapter ctx (cheerio HTML warnings will show real adapter name)
    const prevCtx = globalThis.__S200_ADAPTER_CTX;
    globalThis.__S200_ADAPTER_CTX = {
      adapter:
        providerKeyHint ||
        adapter?.providerKey ||
        adapter?.provider ||
        adapterName ||
        adapter?.name ||
        "unknown",
    };

    let raw;
    try {
      const providerKey = providerKeyHint || s200_guessProviderKeyFromName(adapterName);


const wrappedFn = async (q2, ctx2) =>
  runWithCooldownS200(
    providerKey,
    () => fn(q2, ctx2),
    { group: mainCategory, query: q2, providerKey, timeoutMs }
  );

raw = await runWithSoftTimeout(
  { name: adapterName, fn: wrappedFn, timeoutMs, providerKey },
  query,
  { region, parentSignal: engineSignal, headers: mergedHeaders }
);


    } finally {
      globalThis.__S200_ADAPTER_CTX = prevCtx;
    }


    const duration = Date.now() - start;

   if (raw?.timeout || raw?.error || raw?.aborted || raw?.ok === false) {
      s10_registerAdapterStatus(adapterName, false, duration);
    } else {
      s10_registerAdapterStatus(adapterName, true, duration);
    }

// ✅ Optional per-adapter diagnostics collector (NO BREAKING CHANGE)
try {
  if (Array.isArray(opts?.diagCollector)) {
    const providerKey = providerKeyHint || s200_guessProviderKeyFromName(adapterName);
    let count = 0;
    if (Array.isArray(raw)) count = raw.length;
    else if (raw && Array.isArray(raw.items)) count = raw.items.length;
    else if (raw && Number.isFinite(Number(raw.count))) count = Number(raw.count);

    const statusCode =
      raw?.timeout ? "timeout" :
      raw?.aborted ? "aborted" :
      (raw?.ok === false) ? "ok_false" :
      (raw?.error ? "error" : "ok");

    opts.diagCollector.push({
      adapter: adapterName,
      providerKey,
      ok: statusCode === "ok",
      statusCode,
      ms: duration,
      count,
      status: raw?.status || null,
      code: raw?.code || null,
      error: raw?.error || null,
      timeout: !!raw?.timeout,
      aborted: !!raw?.aborted,
      shadow: !!opts?.shadow,
    });
  }
} catch {}


    let arr;
    if (Array.isArray(raw)) arr = raw;
    else if (raw && Array.isArray(raw.items)) arr = raw.items;
    else arr = raw ? [raw] : [];

    arr = clampArray(arr, 400);

    // Price normalize (S35) — provider/category context tutarlı
    const providerKey = providerKeyHint || s200_guessProviderKeyFromName(adapterName);

const priceCtx = {
  provider: providerKey,
  category: mainCategory,
  region,
  stage: "adapter",
};


    arr = normalizeAdapterResultsS35(arr, priceCtx);

    const normalized = arr
      .map((x) => normalizeItem(x, mainCategory, adapterName))
      .map((item) => {
        if (!item) return null;

        const resolvedProvider = resolveProviderFromUrlS9(
          item.finalUrl || item.url
        );

        // ✅ Provider canonicalization:
        // - Prefer explicit providerKey/providerFamily/provider coming from S200 adapters
        // - Never downgrade a known adapter hint (e.g. admitad) to "unknown" just because master list doesn't include it
        let normalizedProvider = "unknown";
        try {
          normalizedProvider = normalizeProviderS9(
            item?.providerKey || item?.providerFamily || item?.provider || "unknown"
          );
        } catch {}

        let finalProv =
          resolvedProvider !== "unknown" ? resolvedProvider : normalizedProvider;

        if ((!finalProv || finalProv === "unknown") && providerKeyHint) {
          let pk = "unknown";
          try {
            pk = normalizeProviderS9(providerKeyHint);
          } catch {}
          if (pk && pk !== "unknown") finalProv = pk;
          else {
            const rawHint = String(providerKeyHint || "").toLowerCase().trim();
            if (rawHint && rawHint !== "unknown") finalProv = rawHint;
          }
        }

        item.provider = finalProv || "unknown";
        if (!item.providerKey) item.providerKey = item.provider;
        if (!item.providerFamily) item.providerFamily = item.provider;

        // ✅ Affiliate + URL pipeline (deterministic):
        // - originUrl: raw/original link (identity / debug)
        // - finalUrl: affiliate/deeplink link (click target)
        // - url: always points to finalUrl when available
        try {
          const origin = item.originUrl || item.url || item.finalUrl || null;
          if (!item.originUrl && origin) item.originUrl = origin;

          if (!item.finalUrl && (item.url || origin)) {
            item.finalUrl = item.url || origin;
          }

          const baseForAff = item.finalUrl || item.url || item.originUrl || "";
          if (baseForAff) {
            const aff = buildAffiliateUrlS9(
              { ...item, url: baseForAff },
              { subid: "fae_s9" } // stable subid (no session randomness)
            );
            if (aff && typeof aff === "string") item.finalUrl = aff;
          }

          if (item.finalUrl) item.url = item.finalUrl;
          else if (!item.url && item.originUrl) item.url = item.originUrl;
        } catch {}

        return item;
      })
      .filter(Boolean);

    safeLog("adapter_result", {
      adapterName,
      duration,
      count: normalized.length,
      sample: normalized[0]?.title || null,
    });

    return normalized;
  } catch (err) {
    const duration = Date.now() - start;
    s10_registerAdapterStatus(adapterName, false, duration);

    console.warn("⚠️ Adapter hata:", adapterName, "-", err?.message || err);
    safeLog("adapter_error", {
      adapterName,
      duration,
      error: err?.message || String(err),
    });

    return [];
  }
}

// ==========================================================
// S100 — Nihai Provider Öncelik Haritası
// ==========================================================
const S100_PROVIDER_PRIORITY = {
  trendyol: 1.25,
  hepsiburada: 1.18,
  amazon: 1.12,
  teknosa: 1.08,
  n11: 1.02,
  a101: 0.95,
  googleshopping: 0.9,
  akakce: 0.92,
};

function scoreItem(item, index = 0) {
  if (!item) return { score: 0.01 };

  let provKey = "unknown";
try { provKey = normalizeProviderKeyS9(item?.provider || "unknown"); } catch {}


  const basePrice =
    typeof item.price === "number" && item.price > 0 ? item.price : null;
  const optimizedPrice =
    typeof item.optimizedPrice === "number" && item.optimizedPrice > 0
      ? item.optimizedPrice
      : null;
  const finalPrice =
    typeof item.finalPrice === "number" && item.finalPrice > 0
      ? item.finalPrice
      : null;

  const effectivePrice = optimizedPrice ?? finalPrice ?? basePrice;

  let priceScore = 0.05; // fiyat yoksa cezalı kalsın
if (effectivePrice && effectivePrice > 0) {
  priceScore = 1 / (1 + Math.log(1 + effectivePrice));
}

  let discountBonus = 0;
  if (optimizedPrice && basePrice && optimizedPrice < basePrice) {
    const discountRatio = (basePrice - optimizedPrice) / basePrice;
    discountBonus = Math.max(0, Math.min(0.25, discountRatio));
  }

  let ratingScore = 0.3;
  if (item.rating && item.rating > 0) {
    ratingScore = Math.min(1, item.rating / 5);
  }

  let provWeight = 1;
  try {
    provWeight =
      (typeof providerPriority === "function"
        ? providerPriority(provKey)
        : providerPriority?.[provKey]) ?? 1;
  } catch {
    provWeight = 1;
  }

  const s100Weight = S100_PROVIDER_PRIORITY[provKey] ?? 1;
  provWeight *= s100Weight;

  const providerScore = Math.min(1, Math.max(0, provWeight / 5));

  let memoryBoostScore = 0;
  try {
    if (typeof providerPolicyBoost === "function") {
      memoryBoostScore = providerPolicyBoost(provKey) || 0;
    }
  } catch {}

  const platformBaseRate =
    finalPlatformCommission[provKey] ?? finalPlatformCommission.unknown ?? 0;

  const legacyItemCommission = item?.commissionMeta?.platformRate;

  let effectiveCommissionRate = platformBaseRate;

  try {
    if (typeof getCommissionRateS10 === "function") {
      const s10Rate = getCommissionRateS10(provKey, item);
      if (isValidNumber(s10Rate) && s10Rate > 0) {
        effectiveCommissionRate = s10Rate;
      }
    }
  } catch {}

  if (
    (!isValidNumber(effectiveCommissionRate) || effectiveCommissionRate <= 0) &&
    isValidNumber(legacyItemCommission) &&
    legacyItemCommission > 0
  ) {
    effectiveCommissionRate = legacyItemCommission;
  }

  if (!isValidNumber(effectiveCommissionRate) || effectiveCommissionRate < 0) {
    effectiveCommissionRate = 0;
  }

  let commissionScore = 0;
  if (effectiveCommissionRate > 0) {
    commissionScore = Math.min(1, effectiveCommissionRate / 0.15);
  }

  const catKey =
    item.category != null ? String(item.category).toLowerCase() : "unknown";
  const catMul =
    finalCategoryMultiplier[catKey] ?? finalCategoryMultiplier.unknown ?? 1;
  const categoryBoost = Math.max(0.7, Math.min(1.25, catMul));

  const userBoost =
    typeof item.userTrendScore === "number"
      ? Math.min(0.15, Math.max(0, item.userTrendScore))
      : 0;

  const big4 = ["amazon", "trendyol", "hepsiburada", "n11"];
  const isBig4 = big4.includes(provKey);
  const big4Boost = isBig4 && effectiveCommissionRate > 0 ? 0.03 : 0;

  const injectedPenalty = item.priceInjected ? -0.04 : 0;

  const baseScore =
    priceScore * 0.35 +
    ratingScore * 0.25 +
    providerScore * 0.15 +
    commissionScore * 0.2 +
    discountBonus * 0.05 +
    userBoost * 0.05 +
    big4Boost +
    memoryBoostScore +
    injectedPenalty;

  const finalScore = baseScore * categoryBoost;

  return {
    ...item,
    score: isValidNumber(finalScore) ? finalScore : 0.01,
    commissionRate: effectiveCommissionRate,
    _s9: {
      basePrice,
      finalPrice,
      optimizedPrice,
      discountBonus,
      commissionScore,
      providerScore,
      categoryBoost,
      injectedPenalty,
    },
  };
}

// ==========================================================
// S9.1 — TIE-BREAKER
// ==========================================================
function compareItemsS9(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const sA = isValidNumber(a.score) ? a.score : 0;
  const sB = isValidNumber(b.score) ? b.score : 0;
  const diffScore = sB - sA;

  if (Math.abs(diffScore) > 0.015) return diffScore;

  const cA = isValidNumber(a.commissionRate) ? a.commissionRate : 0;
  const cB = isValidNumber(b.commissionRate) ? b.commissionRate : 0;
  const diffCommission = cB - cA;
  if (Math.abs(diffCommission) > 0.0005) return diffCommission;

  const rA = isValidNumber(a.rating) ? a.rating : 0;
  const rB = isValidNumber(b.rating) ? b.rating : 0;
  const diffRating = rB - rA;
  if (Math.abs(diffRating) > 0.05) return diffRating;

   const pA = s35_effectivePrice(a) ?? Number.POSITIVE_INFINITY;
  const pB = s35_effectivePrice(b) ?? Number.POSITIVE_INFINITY;

  if (pA !== pB) return pA - pB;


  return 0;
}

// ====================================================================
// HEALTH CATEGORY BRAIN
// ====================================================================
export function healthCategoryBrain(query, adapters) {
  const q = String(query || "").toLowerCase();

  const specialties = [
    "kardiyoloji",
    "ortopedi",
    "dermatoloji",
    "psikiyatri",
    "psikolog",
    "göz",
    "goz",
    "kadın doğum",
    "kbb",
    "nöroloji",
    "noroloji",
    "dahiliye",
    "üroloji",
    "uroloji",
    "fizik tedavi",
    "pediatri",
    "çocuk doktoru",
  ];
  const isSpecialty = specialties.some((s) => q.includes(s));

  const isDental =
    q.includes("diş") ||
    q.includes("dis") ||
    q.includes("implant") ||
    q.includes("ortodonti") ||
    q.includes("kanal tedavisi");

  const isLab =
    q.includes("tahlil") ||
    q.includes("kan tahlili") ||
    q.includes("lab") ||
    q.includes("analiz") ||
    q.includes("test") ||
    q.includes("horm") ||
    q.includes("vitamin");

  const isCheckup = q.includes("checkup") || q.includes("check-up");

  const isHospital =
    q.includes("hastane") ||
    q.includes("hospital") ||
    q.includes("acil") ||
    q.includes("acile");

  const isTourism =
    q.includes("estetik") ||
    q.includes("implant") ||
    q.includes("hair") ||
    q.includes("burun estetiği") ||
    q.includes("burun estetigi") ||
    q.includes("liposuction");

  let ordered = [...adapters];

  if (isDental) {
    ordered = prioritize(ordered, [
      "dental_clinics",
      "enabiz",
      "doktorset",
      "google_medical",
      "googleplaces_health",
    ]);
  }

  if (isLab) {
    ordered = prioritize(ordered, [
      "lab_test_prices",
      "enabiz",
      "google_medical",
      "sgk_hospitals",
      "googleplaces_health",
    ]);
  }

  if (isCheckup) {
    ordered = prioritize(ordered, [
      "acibadem_checkup",
      "memorial",
      "medicalpark",
      "lab_test_prices",
      "google_medical",
    ]);
  }

  if (isSpecialty) {
    ordered = prioritize(ordered, [
      "mhrs",
      "enabiz",
      "doktorset",
      "google_medical",
      "googleplaces_health",
    ]);
  }

  if (isHospital) {
    ordered = prioritize(ordered, [
      "acibadem",
      "medicalpark",
      "memorial",
      "liv",
      "florence",
      "sgk_hospitals",
      "health_tourism",
      "googleplaces_health",
      "osm_health",
    ]);
  }

  if (isTourism) {
    ordered = prioritize(ordered, [
      "health_tourism",
      "dental_clinics",
      "lab_test_prices",
      "google_medical",
    ]);
  }

  return ordered;
}

// ====================================================================
// ESTATE CATEGORY BRAIN
// ====================================================================
export function estateCategoryBrain(query, adapters) {
  const q = String(query || "").toLowerCase();

  const isSale =
    q.includes("satılık") || q.includes("satilik") || q.includes("for sale");

  const isRent =
    q.includes("kiralık") ||
    q.includes("kiralik") ||
    q.includes("rent") ||
    q.includes("rental");

  const isLand =
    q.includes("arsa") ||
    q.includes("tarla") ||
    q.includes("bahçe") ||
    q.includes("bahce") ||
    q.includes("land") ||
    q.includes("field") ||
    q.includes("plot");

  const isCommercial =
    q.includes("ofis") ||
    q.includes("dükkan") ||
    q.includes("dukkan") ||
    q.includes("depo") ||
    q.includes("işyeri") ||
    q.includes("isyeri") ||
    q.includes("atölye") ||
    q.includes("atolye") ||
    q.includes("mağaza") ||
    q.includes("magaza");

  const isLuxury =
    q.includes("villa") ||
    q.includes("rezidans") ||
    q.includes("site") ||
    q.includes("loft");

  const mustPrioritize = [];

  if (isSale || isRent || isCommercial || isLand || isLuxury) {
    mustPrioritize.push(
      "sahibinden_estate",
      "sahibinden_scrape_estate",
      "sahibinden_adapter_estate",

      "hepsiemlak_estate",
      "hepsiemlak_scrape_estate",
      "hepsiemlak_adapter_estate",

      "emlakjet_estate",
      "emlakjet_scrape_estate",
      "emlakjet_adapter_estate",

      "zingat_estate",
      "zingat_scrape_estate",
      "zingat_adapter_estate",

      "turyap_estate",
      "remax_estate",
      "coldwell_estate",
      "tapucom_estate",
      "endeksa_estate"
    );
  }

  if (isLuxury) {
    mustPrioritize.unshift("remax_estate", "coldwell_estate", "turyap_estate");
  }

  if (isLand) {
    mustPrioritize.unshift("tapucom_estate", "endeksa_estate");
  }

  const ordered = [];

  for (const ad of adapters) {
    if (mustPrioritize.includes(ad.name)) ordered.push(ad);
  }

  for (const ad of adapters) {
    if (!mustPrioritize.includes(ad.name)) ordered.push(ad);
  }

  return ordered;
}

// ====================================================================
// PRIORITIZE HELPER
// ====================================================================
function prioritize(list, names) {
  const out = [];
  const rest = [];

  for (const a of list) {
    if (names.includes(a.name)) out.push(a);
    else rest.push(a);
  }

  return [...out, ...rest];
}

// ====================================================================
// S9.3 — Multi-Platform Revenue Maximizer (S40 variant uses this)
// ====================================================================
function applyRevenueClusterBoostS93(items, mainCategory = "product") {
  if (!Array.isArray(items) || items.length === 0) return items;

  const revenueCategories = new Set([
    "product",
    "electronics",
    "market",
    "fashion",
    "food",
    "office",
    "outdoor",
    "vehicle",
    "vehicle_sale",
  ]);

  const normalizedMain =
    typeof mainCategory === "string" ? mainCategory.toLowerCase() : "product";

  const shouldAggressive =
    revenueCategories.has(normalizedMain) || normalizedMain === "genel";

  const big4 = new Set(["amazon", "trendyol", "hepsiburada", "n11"]);

  function familyKey(title) {
    return safeString(title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  const clustersMap = new Map();

  for (const it of items) {
    if (!it || !it.title) continue;
    const key = familyKey(it.title);
    if (!key) continue;

    if (!clustersMap.has(key)) clustersMap.set(key, []);
    clustersMap.get(key).push(it);
  }

  for (const [, cluster] of clustersMap.entries()) {
    if (!Array.isArray(cluster) || cluster.length < 2) continue;

    const hasBig4 = cluster.some((it) =>
      big4.has((it.provider || "unknown").toLowerCase())
    );
    if (!hasBig4 && !shouldAggressive) continue;

    let best = null;
    let bestScore = -Infinity;

    for (const it of cluster) {
      const provKey = (it.provider || "unknown").toLowerCase();

      const commission =
        isValidNumber(it.commissionRate) && it.commissionRate > 0
          ? it.commissionRate
          : 0;

      let trustRaw = 3;
      try {
        if (typeof providerPriority === "function") {
          trustRaw = providerPriority(provKey) ?? 3;
        } else if (providerPriority && typeof providerPriority === "object") {
          trustRaw =
            providerPriority[provKey] ?? providerPriority.unknown ?? 3;
        }
      } catch {
        trustRaw = 3;
      }
      const trustNorm = (Math.max(1, Math.min(5, trustRaw)) - 1) / 4;

      let priceNorm = 0.5;
const ep = s35_effectivePrice(it);
if (isValidNumber(ep) && ep > 0) {
  priceNorm = 1 / (1 + Math.log(1 + ep));
}


      const baseScore = isValidNumber(it.score) ? it.score : 0;

      const revenueScore =
        commission * 0.6 +
        trustNorm * 0.2 +
        priceNorm * 0.1 +
        baseScore * 0.1;

      if (revenueScore > bestScore) {
        bestScore = revenueScore;
        best = it;
      }
    }

    if (!best) continue;

    for (const it of cluster) {
      const current = isValidNumber(it.score) ? it.score : 0.01;

      if (it === best) {
        it.score = current + 0.04;
      } else {
        it.score = Math.max(0.001, current - 0.02);
      }
    }
  }

  return items;
}

// ====================================================================
// S9.2 — Provider re-balance (S40 variant uses this)
// ====================================================================
function rebalanceByProviderS92(items, maxPerProvider = 5, windowSize = 20) {
  if (!Array.isArray(items) || items.length === 0) return items || [];

  const result = [];
  const skipped = [];
  const counts = new Map();

  const big4 = new Set(["amazon", "trendyol", "hepsiburada", "n11"]);

  for (const it of items) {
    const prov = (it?.provider || "unknown").toLowerCase();
    const used = counts.get(prov) || 0;
    const hardCap = big4.has(prov) ? maxPerProvider + 2 : maxPerProvider;

    if (result.length < windowSize && used >= hardCap) {
      skipped.push(it);
      continue;
    }

    result.push(it);
    counts.set(prov, used + 1);
  }

  for (const it of skipped) {
    result.push(it);
  }

  return result;
}

// ============================================================
// S9 Affiliate Engine Booster
// ============================================================
const originalBuildAffiliateUrl = buildAffiliateUrl;

export function buildAffiliateUrlS9(item, context = {}) {
  const url = item?.url || "";
  const provider = normalizeProviderKeyS9(item?.provider);

  const caps = getProviderAffiliateCapabilitiesS9(provider);

  if (!caps.hasAffiliate) {
    return originalBuildAffiliateUrl(item, context);
  }

  let updated = originalBuildAffiliateUrl(item, context);

  const envKey = provider.toUpperCase() + "_AFF_ID";
  const realId = process.env[envKey] || null;

  const subid = context?.subid || "fae_s9";

  try {
    const u = new URL(updated || url);

    if (caps.hasDeepLink && realId) {
      u.searchParams.set("aff_id", realId);
    }

    if (caps.hasSubId) {
      u.searchParams.set("subid", subid);
    }

    updated = u.toString();
  } catch {}

  return updated;
}

// ===========================================================
// 🔥 S200 ROUTER — adapterRegistry.js ile tam uyumlu (FINAL)
// ===========================================================
function getAdaptersForCategory(cat) {
  // Prefer registry resolver (STRICT_NO_STUBS + dedupe + aliases) but keep backward fallback.
  const fallbackProduct = () => {
    try {
      const dyn = resolveAdaptersForCategory("product");
      if (Array.isArray(dyn)) return dyn;
    } catch {}
    return CATEGORY_ADAPTER_MAP.product || [];
  };

  if (!cat) return fallbackProduct();

  const key = String(cat).toLowerCase().trim();

  const aliasMap = {

    tech: "product",
    electronics: "product",
    gadget: "product",

    grocery: "market",
    supermarket: "market",

    clothing: "fashion",
    apparel: "fashion",
    fashion_product: "fashion",
    craft: "craft",
    usta: "craft",
    tamir: "repair",
    tamirci: "repair",

    location: "location",

    misc: "product",
    unknown: "product",
    genel: "product",
  };

  const resolvedKey = aliasMap[key] || key;

  try {
    const dyn = resolveAdaptersForCategory(resolvedKey);
    if (Array.isArray(dyn)) return dyn;
  } catch (err) {
    console.warn("resolveAdaptersForCategory hatası:", err?.message || err);
  }

  if (CATEGORY_ADAPTER_MAP[resolvedKey]) return CATEGORY_ADAPTER_MAP[resolvedKey];

  return fallbackProduct();
}

// ===========================================================
// S100 CATEGORY ENFORCEMENT
// ===========================================================
function s100_enforceCategoryAndVertical(items, mainCategory, q) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const cat = String(mainCategory || "").toLowerCase();

  const productLike = ["product", "electronics", "market", "fashion", "office", "food"];

  if (!productLike.includes(cat)) {
    return items;
  }

  const bannedVerticals = new Set([
    "travel",
    "estate",
    "car_rental",
    "health",
    "insurance",
    "event",
  ]);

  const bannedCategories = new Set([
    "car_rental",
    "flight",
    "hotel",
    "tour",
    "travel",
    "estate",
	 "location",
  ]);

  const bannedProviderTypes = new Set(["travel_info"]);

  return items.filter((item) => {
    const vertical = String(item.vertical || "").toLowerCase();
    const category = String(item.category || "").toLowerCase();
    const categoryAI = String(
      item.categoryAI || item.aiCategory || item.ai_category || ""
    ).toLowerCase();

    const providerType = String(item.providerType || "").toLowerCase();

    if (bannedVerticals.has(vertical)) return false;
    if (bannedCategories.has(category)) return false;
    if (bannedProviderTypes.has(providerType)) return false;

    if (categoryAI.includes("travel") || categoryAI.includes("hotel")) {
      return false;
    }

    return true;
  });
}

// ==============================================================
// ANA MOTOR (S200 BEST ONLY) - GÜNCELLENMİŞ (S30/S40 variant aware)
// ==============================================================


// ---------------------------------------------------------------------------
// Query heuristics (drift guards)
// ---------------------------------------------------------------------------
function looksLikeCarRentalQuery(q = "") {
  const t = String(q || "").toLowerCase();
  // Intentionally strict: prevent hijacking "araba satılık" / "oto fiyat" queries.
  return (
    t.includes("rent a car") ||
    t.includes("rentacar") ||
    t.includes("car rental") ||
    t.includes("araç kiral") ||
    t.includes("arac kiral") ||
    t.includes("araba kiral") ||
    t.includes("oto kiral") ||
    t.includes("kiralık araç") ||
    t.includes("kiralik arac")
  );
}


// Price outlier filtering is only reliable for retail-like verticals.
// For travel/estate/health/etc it can delete valid results (wide price distributions).
const OUTLIER_SAFE_MAIN_CATEGORIES = new Set([
  "product",
  "market",
  "fashion",
  "office",
  "food",
  "vehicle_sale",
]);
function shouldApplyPriceOutlierFilter(category = "") {
  const c = String(category || "product").toLowerCase();
  return OUTLIER_SAFE_MAIN_CATEGORIES.has(c);
}

// ============================================================
// S200 BARCODE TWO-STAGE — resolved name extraction
// - Stage-1: barcode adapter (openfacts/local/serp)
// - Stage-2: resolved product title -> full product search
// ============================================================
function s200_pickResolvedQueryFromBarcode(items = [], barcode = "") {
  try {
    const code = String(barcode || "").trim();
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];

    const clean = (s) =>
      String(s || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const cleanForSearch = (title) => {
      let t = clean(title);
      if (!t) return "";

      // Drop obvious placeholders
      if (/^\s*(barkod|barcode)\b/i.test(t)) {
        // "Barkod 123..." gibi
        t = t.replace(/^\s*(barkod|barcode)\b\s*/i, "").trim();
      }

      // Remove raw GTIN digits if present
      if (code && code.length >= 8) {
        t = t.replace(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
      }

      // Trim noise brackets
      t = t.replace(/\((ean|upc|gtin)[^)]*\)/gi, " ");
      t = t.replace(/\[[^\]]*\]/g, " ");
      t = clean(t);

      // Clamp
      if (t.length > 120) t = t.slice(0, 120).trim();
      return t;
    };

    let bestTitle = "";
    let bestScore = -1e9;

    for (const it of arr) {
      const title0 = clean(it?.title);
      if (!title0) continue;

      const tl = title0.toLocaleLowerCase("tr");
      if (code && tl.includes(code) && (tl.startsWith("barkod") || tl.startsWith("barcode"))) continue;
      if (/^\s*(barkod|barcode)\b/i.test(title0) && (!code || tl.includes(code))) continue;

      const title = cleanForSearch(title0);
      if (!title) continue;
      if (title.length < 4) continue;

      // Trust-ish priors
      const provider = String(it?.provider || "").toLowerCase();
      const trust =
        (typeof it?.providerTrust === "number" && Number.isFinite(it.providerTrust) && it.providerTrust > 0)
          ? it.providerTrust
          : (typeof it?.trustScore === "number" && Number.isFinite(it.trustScore) && it.trustScore > 0)
          ? it.trustScore
          : 0.75;

      let s = trust * 10;

      if (/open(food|beauty|products)facts/.test(provider)) s += 2.5;
      if (/serpapi/.test(provider)) s += 1.0;

      if (code && title0.includes(code)) s -= 4.0;
      if (/\b(barkod|barcode)\b/i.test(title0)) s -= 2.0;

      const L = title.length;
      if (L >= 8 && L <= 90) s += 2.0;
      if (L > 140) s -= 2.0;

      // Bonus if brand exists
      if (it?.productInfo?.brand || it?.brand) s += 0.6;

      if (s > bestScore) {
        bestScore = s;
        bestTitle = title;
      }
    }

    // Minimum sanity
    if (!bestTitle) return "";
    if (/^\d{8,14}$/.test(bestTitle)) return "";
    if (bestTitle.length < 4) return "";

    return bestTitle;
  } catch {
    return "";
  }
}

export async function runAdapters(query, region = "TR", opts = {}) {
  const {
    source = "text",
    visionLabels = [],
    embedding = null,
    qrPayload = null,
    userProfile = null,
    categoryHint = null,
    shadow = false,
    engineVariant: engineVariantInput,
  } = opts || {};
  // Engine variant default: if env/opts doesn't specify, pick based on registry/system version.
  let engineVariant = String(engineVariantInput || process.env.FINDALLEASY_ENGINE_VARIANT || "").trim();
  if (!engineVariant) {
    const sys = (typeof getAdapterSystemStatus === "function") ? getAdapterSystemStatus() : null;
    const sysVer = String(sys?.version || "");
    engineVariant = sysVer.includes("S200") ? "S200" : "S30";
  }


  const variant = String(engineVariant || "S30").toUpperCase();

  const visionClean = Array.isArray(visionLabels)
    ? visionLabels.map((v) => String(v).toLowerCase().trim())
    : [];

  const safeEmbedding =
    embedding && typeof embedding === "object" ? embedding : null;

  // region normalize (RL bucket drift biter)
  try {
    region = String(region || "TR").toUpperCase();
    if (!region || region.length > 10) region = "TR";
  } catch {
    region = "TR";
  }

  const mergedQuery = mergeQueryWithQr(query, qrPayload);
  const q = normalizeQuery(mergedQuery);

  const carRentalHit = looksLikeCarRentalQuery(q);
  const vertical = detectServiceVertical(q);

  // diag collector must exist before any early-return fast-paths
  const adapterDiag = [];

  // ----------------- LAWYER FAST PATH -----------------
  if (vertical === "lawyer") {
    const lawyerAdapters = getAdaptersForCategory("lawyer");

    if (lawyerAdapters && lawyerAdapters.length > 0) {
      const rlCtxLawyer = { tried: 0, denied: 0 };

      const lawyerItems = await safeRunAdapter(
        lawyerAdapters[0],
        q,
        region,
        "lawyer",
        null,
        rlCtxLawyer,
        { shadow, diagCollector: adapterDiag }
      );

      if (lawyerItems.length > 0) {
        const scoredLawyers = lawyerItems
          .map((it, i) => scoreItem(it, i))
          .sort((a, b) => compareItemsS9(a, b));

        const bestLawyer = scoredLawyers[0] || null;

        return {
          ok: true,
          category: "lawyer",
          items: scoredLawyers,
          best: bestLawyer,
          smart: [],
          others: [],
          _meta: {
            engineVariant: variant,
            totalRawAdapters: 1,
            totalItemsAfterMerge: scoredLawyers.length,
            query,
            region,
            adapterSource: lawyerAdapters[0]?.name || "lawyer_adapter",
            rateLimit: {
              ...rlCtxLawyer,
              bypassed:
                s200_shouldBypassRL({ shadow, diagCollector: adapterDiag }) ||
                globalThis.__S200_RL_DISABLED,
            },
          },
        };
      }
    }
  }

  if (!q) {
    return {
      ok: false,
      category: "unknown",
      items: [],
      best: null,
      smart: [],
      others: [],
      _meta: {
        engineVariant: variant,
        totalRawAdapters: 0,
        totalItemsAfterMerge: 0,
        query: "",
        region,
      },
    };
  }

  // === S200 Intent Engine
  let mainCategory = "product";
  let s100Categories = [];

  const forcedCategoryRaw = safeString(
    opts.category ||
      opts.mainCategory ||
      opts.forceCategory ||
      opts.intentCategory ||
      ""
  )
    .toLowerCase()
    .trim();

  const forcedAliasMap = {
    grocery: "market",
    electronics: "product",
    tech: "product",
    fashion_product: "fashion",

    craft: "craft",
    usta: "craft",
    tamir: "repair",
    tamirci: "repair",

    unknown: "product",
    misc: "product",
    genel: "product",
  };

  const forcedResolved = forcedAliasMap[forcedCategoryRaw] || forcedCategoryRaw;

  const forcedCategory =
    forcedResolved &&
    CATEGORY_ADAPTER_MAP &&
    CATEGORY_ADAPTER_MAP[forcedResolved]
      ? forcedResolved
      : "";

  const hasForcedCategory = !!forcedCategory;

  if (hasForcedCategory) {
    mainCategory = forcedCategory;
    s100Categories = [forcedCategory];
  }

  let intentInfo = null;
  if (!hasForcedCategory) {
    try {
      intentInfo = await detectIntent({
        query: q,
        source: source || "text",
        visionLabels: visionClean,
        qrPayload,
        embedding: safeEmbedding,
        userProfile: userProfile || null,
      });
    } catch (e) {
      console.warn("S200 Intent hata:", e?.message || e);
    }
  }

  if (intentInfo) {
    const intentText = String(intentInfo.group || intentInfo.finalIntent || intentInfo.type || "")
      .toLowerCase()
      .trim();
    if (
      !carRentalHit &&
      (q.includes("araba") ||
        q.includes("otomobil") ||
        q.includes("oto ") ||
        q.includes("suv") ||
        q.includes("4x4") ||
        q.includes("sahibinden") ||
        q.includes("ikinci el") ||
        q.includes("0 km") ||
        q.includes("motorsiklet") ||
        q.includes("motor ") ||
        q.includes("vavacars") ||
        q.includes("arabam.com"))
    ) {
      mainCategory = "vehicle_sale";
    }


    // Car rental drift guard: "araba/araç" keyword can mean sale OR rental.
    // If the query clearly signals rental, lock to car_rental unless caller explicitly forced a category.
    // Car rental drift guard: "araba/araç" keyword can mean sale OR rental.
// If the query clearly signals rental, lock to car_rental unless caller explicitly forced a category.
const preS40Locked =
  mainCategory && mainCategory !== "product" && mainCategory !== "genel";

if (!opts.forceCategory && !preS40Locked && carRentalHit) {
  mainCategory = "car_rental";
}
    // Keep intent categories specific; adapterRegistry can alias if needed.
    const qNorm = String(q || "").toLowerCase();

    const PSY_RE =
      /(psikolog|psikoloji|psikiyatrist|terapist|terapi|psikoterapi|psycholog|psychology|therap(y|ist))/i;
    const EDU_RE =
      /(kurs|kursu|course|lesson|eğitim|egitim|ders|bootcamp|sertifika|udemy|coursera|akademi|üniversite|universite)/i;

    if (EDU_RE.test(qNorm) || intentText.includes("education")) {
      mainCategory = "education";
    } else if (PSY_RE.test(qNorm) || intentText.includes("psychology")) {
      mainCategory = "psychology";
    } else if (!carRentalHit && (intentText.includes("hotel") || intentText.includes("accommodation"))) {
      mainCategory = "hotel";
    } else if (intentText.includes("flight")) {
      mainCategory = "flight";
    } else if (intentText.includes("travel")) {
      mainCategory = "travel";
    } else if (intentText.includes("car_rental") || intentText.includes("rent")) {
      mainCategory = "car_rental";
    } else if (intentText.includes("tour")) {
      mainCategory = "tour";
    } else if (intentText.includes("health")) {
      mainCategory = "health";
    } else if (intentText.includes("spa")) {
      mainCategory = "spa";
    } else if (intentText.includes("estate")) {
      mainCategory = "estate";
    } else if (intentText.includes("market") || intentText.includes("grocery")) {
      mainCategory = "market";
    } else if (intentText.includes("fashion") || intentText.includes("clothing")) {
      mainCategory = "fashion";
    } else if (intentText.includes("food") || intentText.includes("restaurant")) {
      mainCategory = "food";
    } else if (intentText.includes("craft") || intentText.includes("usta")) {
      mainCategory = "craft";
    }
  }

  // 🔒 Drift guard: query açıkça araç kiralama diyor; hotel/travel'e kayma yok.
  if (!hasForcedCategory && !opts?.forceCategory && carRentalHit) {
    const mc = String(mainCategory || "").toLowerCase();
    if (mc === "hotel" || mc === "travel" || mc === "product" || mc === "unknown" || mc === "misc") {
      mainCategory = "car_rental";
    }
  }


  mainCategory = mainCategory || "product";

  const commerceBrandRegex =
    /(iphone|samsung|xiaomi|huawei|oppo|dyson|playstation|ps5)/i;
  const commerceModelRegex =
    /\b(11|12|13|14|15|16)\b.*\b(pro\s*max|promax|pro|max)\b/i;

  if (
    mainCategory !== "product" &&
    (commerceBrandRegex.test(q) || commerceModelRegex.test(q))
  ) {
    mainCategory = "product";
  }

  if (mainCategory === "electronics") mainCategory = "product";
  if (mainCategory === "tech") mainCategory = "product";
  if (mainCategory === "grocery") mainCategory = "market";
  if (mainCategory === "fashion_product") mainCategory = "fashion";
  if (mainCategory === "craft") mainCategory = "repair";

  // ✅ SANITY GUARD
  mainCategory = s200_categorySanityGuard(q, mainCategory);

  const looksLikeBarcode = /^\d{8,14}$/.test(q);

  const s40Locked =
    mainCategory && mainCategory !== "product" && mainCategory !== "genel";

  // ============================================================
  // 🔥 S200 BARKOD SHORT PATH (TWO-STAGE)
  //  - Stage-1: barcode adapter (openfacts/local/serp)
  //  - Stage-2: resolved product title -> full product search
  //  - Final: merged + reranked best list
  // ============================================================
  if (looksLikeBarcode) {
    const rlCtxBarcode = { tried: 0, denied: 0 };

    // --------------------
    // Stage-1: barcode adapter
    // --------------------
    const barcodeItems = await safeRunAdapter(
      searchBarcode,
      q,
      region,
      "product",
      null,
      rlCtxBarcode,
      { shadow, diagCollector: adapterDiag }
    );

    let flat1 = Array.isArray(barcodeItems) ? barcodeItems.filter(Boolean) : [];

    flat1 = cleanResults(flat1);
    flat1 = antiCorruptionFilter(flat1);
    // S200 NO-FAKE: drop stub/navigation items in STRICT mode
    flat1 = filterStubItemsS200(flat1, { query: q });

    const OUTLIER_SAFE = new Set(["product", "market", "fashion", "office", "food"]);
    if (OUTLIER_SAFE.has(String(mainCategory || "product").toLowerCase())) {
      if (shouldApplyPriceOutlierFilter(mainCategory)) {
        flat1 = dropPriceOutliers(flat1);
      }
    }

    flat1 = clampArray(flat1, 500);
    flat1 = mergeDuplicates(flat1);
    flat1 = ultraMergeByProviderAndProduct(flat1);

    try {
      flat1 = flat1.map((it) => {
        const ctx = {
          provider: it?.provider || "unknown",
          category: "product",
          region,
          stage: "barcode",
        };
        let fixed = optimizePrice(it, ctx);
        fixed = autoInjectPrice(fixed, ctx);
        return s35_enforcePriceContract(fixed);
      });
    } catch (e) {
      console.warn("S35 optimizePrice (barcode) hata:", e?.message || e);
    }

    let rankedStage1 = rankItemsByCommissionAndProviderS10(flat1, {
      mainCategory: "product",
      region,
      query: q,
    });

    if (variant === "S40") {
      try {
        rankedStage1 = rankedStage1.map((it, i) => scoreItem(it, i)).sort(compareItemsS9);
        rankedStage1 = applyRevenueClusterBoostS93(rankedStage1, "product");
        rankedStage1 = rebalanceByProviderS92(rankedStage1, 5, 20);
        rankedStage1 = rankedStage1.sort(compareItemsS9);
      } catch {}
    }

    // -------------------------------------------------------------
    // Stage-2: resolved name search (optional)
    // -------------------------------------------------------------
    const envTwoStage = String(process.env.S200_BARCODE_TWO_STAGE ?? "1") === "1";
    const optTwoStage = opts?.barcodeTwoStage !== false;
    const nested = Boolean(opts?.__barcodeTwoStageNested);

    const resolvedFromClient = String(
      opts?.barcodeResolvedQuery || opts?.resolvedQuery || opts?.__barcodeResolvedQueryFromClient || ""
    ).trim();

    const resolvedQuery =
      resolvedFromClient && !/^\d{8,14}$/.test(resolvedFromClient)
        ? resolvedFromClient
        : s200_pickResolvedQueryFromBarcode(rankedStage1, q);

    let stage2 = null;
    let rankedFinal = rankedStage1;

    if (envTwoStage && optTwoStage && !nested && resolvedQuery && !/^\d{8,14}$/.test(resolvedQuery)) {
      try {
        stage2 = await runAdapters(resolvedQuery, region, {
          ...opts,
          source: "barcode_resolved",
          forceCategory: "product",
          categoryHint: "product",
          __barcodeTwoStageNested: true,
          __barcodeOriginal: q,
          __barcodeResolvedQuery: resolvedQuery,
        });
      } catch (e) {
        stage2 = null;
      }

      const stage2Items = Array.isArray(stage2?.items) ? stage2.items.filter(Boolean) : [];

      if (stage2Items.length > 0) {
        // Merge stage1 + stage2 and rerank
        let merged = [...rankedStage1, ...stage2Items];

        merged = cleanResults(merged);
        merged = antiCorruptionFilter(merged);
        merged = filterStubItemsS200(merged, { query: resolvedQuery || q });

        if (shouldApplyPriceOutlierFilter("product")) {
          merged = dropPriceOutliers(merged);
        }

        merged = clampArray(merged, 700);
        merged = mergeDuplicates(merged);
        merged = ultraMergeByProviderAndProduct(merged);

        try {
          merged = merged.map((it) => {
            const ctx = {
              provider: it?.provider || "unknown",
              category: "product",
              region,
              stage: "barcode_two_stage",
            };
            let fixed = optimizePrice(it, ctx);
            fixed = autoInjectPrice(fixed, ctx);
            return s35_enforcePriceContract(fixed);
          });
        } catch {}

        rankedFinal = rankItemsByCommissionAndProviderS10(merged, {
          mainCategory: "product",
          region,
          query: resolvedQuery || q,
        });

        if (variant === "S40") {
          try {
            rankedFinal = rankedFinal.map((it, i) => scoreItem(it, i)).sort(compareItemsS9);
            rankedFinal = applyRevenueClusterBoostS93(rankedFinal, "product");
            rankedFinal = rebalanceByProviderS92(rankedFinal, 5, 20);
            rankedFinal = rankedFinal.sort(compareItemsS9);
          } catch {}
        }

        // Prefer deterministic BEST ranking at engine level (barcode use-case)
        try {
          const providerTrustMap = opts?.providerTrustMap || providerPriority || {};
          const reranked = rankItemsS200(rankedFinal, {
            query: resolvedQuery || q,
            group: "product",
            region,
            providerTrustMap,
          });
          if (Array.isArray(reranked) && reranked.length) rankedFinal = reranked;
        } catch (e) {
          console.warn("⚠️ rankItemsS200 (barcode-two-stage) hata:", e?.message || e);
        }
      }
    }

    // -------------------------------------------------------------
    // OPTIONAL: deterministic BEST ranking at engine level
    // Use: opts.rank="best" (no schema mutation, no fake)
    // -------------------------------------------------------------
    try {
      const mode = String(opts?.rank || opts?.sort || "").toLowerCase();
      if (mode === "best" || mode === "s200_best") {
        const providerTrustMap = opts?.providerTrustMap || providerPriority || {};
        const reranked = rankItemsS200(rankedFinal, {
          query: (resolvedQuery || q) || query,
          group: "product",
          region,
          providerTrustMap,
        });
        if (Array.isArray(reranked) && reranked.length) rankedFinal = reranked;
      }
    } catch (e) {
      console.warn("⚠️ rankItemsS200 hata:", e?.message || e);
    }

    const safeBest = rankedFinal[0] || null;

    const stage2Used = Boolean(stage2 && Array.isArray(stage2?.items) && stage2.items.length);
    const stage2AdapterCount = Number(stage2?._meta?.totalRawAdapters || 0) || 0;

    return {
      ok: true,
      category: "product",
      items: rankedFinal,
      best: safeBest,
      smart: [],
      others: [],
      _meta: {
        engineVariant: variant,
        query: q,
        region,
        mode: stage2Used ? "barcode-two-stage" : "barcode-only",
        resolvedQuery: resolvedQuery || null,
        stage2: {
          enabled: envTwoStage && optTwoStage,
          used: stage2Used,
          query: resolvedQuery || null,
          items: stage2Used ? (stage2?.items?.length || 0) : 0,
        },
        totalRawAdapters: 1 + stage2AdapterCount,
        totalItemsAfterMerge: rankedFinal.length,
        rateLimit: {
          ...rlCtxBarcode,
          bypassed:
            s200_shouldBypassRL({ shadow, diagCollector: adapterDiag }) || globalThis.__S200_RL_DISABLED,
        },
      },
    };
  }

  // ===========================================================
  // CATEGORY_ADAPTER_MAP — adapterRegistry.js'den al
  // ===========================================================
  if (s40_routerOverride?.enable === true) {
    if (typeof s40_routerOverride.forceCategory === "string") {
      mainCategory = s40_routerOverride.forceCategory;
    }
  }

  if (
    !mainCategory ||
    mainCategory === "unknown" ||
    mainCategory === "misc" ||
    mainCategory.length < 2
  ) {
    mainCategory = "product";
  }

  // Kategori setini oluştur
  const categorySet = new Set();

  categorySet.add(String(mainCategory || "product").toLowerCase());
  if (mainCategory !== "product" && mainCategory !== "genel") {
    categorySet.delete("product");
  }

  // S100 kategorilerini ekle
  if (!s40Locked) {
    try {
      const maybeCats = detectCategoryS100({
        query: q,
        providers: [],
        vision: visionClean,
        embedding: safeEmbedding,
      });

      const s200CategoriesRaw =
        maybeCats && typeof maybeCats.then === "function" ? await maybeCats : maybeCats;

      let inferredList = [];

      if (Array.isArray(s200CategoriesRaw)) {
        inferredList = s200CategoriesRaw;
      } else if (
        typeof s200CategoriesRaw === "string" &&
        s200CategoriesRaw.trim()
      ) {
        inferredList = [s200CategoriesRaw];
      }

      inferredList = inferredList
        .map((c) => String(c || "").toLowerCase().trim())
        .filter(Boolean);

      if (inferredList.length > 0) {
        s100Categories = inferredList;
        mainCategory = inferredList[0];

        // ✅ sanity guard (S100 sonrası da)
        mainCategory = s200_categorySanityGuard(q, mainCategory);

        for (const cat of inferredList) {
          categorySet.add(cat);
        }
      }
    } catch (err) {
      console.warn("S100 hata verdi → S5 fallback:", err?.message || err);

      try {
        const maybeFallback = inferCategoryS5({
          query: q,
          providers: [],
          vision: [],
        });

        const fallback =
          maybeFallback && typeof maybeFallback.then === "function"
            ? await maybeFallback
            : maybeFallback;

        if (fallback && typeof fallback === "string") {
          mainCategory = s200_categorySanityGuard(q, fallback);
          categorySet.add(mainCategory);
        }
      } catch (e2) {
        console.warn("S5 de hata verdi:", e2?.message || e2);
      }
    }
  }

  if (typeof categoryHint === "string" && categoryHint.trim()) {
    categorySet.add(categoryHint.toLowerCase().trim());
  }

  categorySet.delete("");
  categorySet.delete("unknown");
  categorySet.delete("misc");

  // ✅ FIX: S100 sonrası mainCategory product değilse product sızmasını engelle
  if (mainCategory !== "product" && mainCategory !== "genel") {
    categorySet.delete("product");
  }

  // Adapter'ları topla
  let adapters = [];

  for (const cat of categorySet) {
    const arr = getAdaptersForCategory(cat);
    if (Array.isArray(arr)) adapters.push(...arr);
  }

  // ✅ FIX: Set(object) dedupe etmez → adapter.name üzerinden tekilleştir
  const seenAdapters = new Set();
  adapters = adapters.filter((ad) => {
    const name =
      (ad && typeof ad === "object" ? ad.name : null) ||
      (typeof ad === "function" ? ad.name : null) ||
      (ad && typeof ad === "object" ? ad.provider : null) ||
      (typeof ad === "string" ? ad : null) ||
      "unknown_adapter";

    const key = String(name).toLowerCase().trim();
    if (!key) return true;

    if (seenAdapters.has(key)) return false;
    seenAdapters.add(key);
    return true;
  });

  if (mainCategory === "estate") {
    adapters = estateCategoryBrain(q, adapters);
  }

  if (mainCategory === "health") {
    adapters = healthCategoryBrain(q, adapters);
  }

  // ===========================================================
  // ENGINE DEADLINE + PARTIAL RESULTS (HARDENED)
  // ===========================================================
  const engineController = new AbortController();
  const engineSignal = engineController.signal;

  const ENGINE_DEADLINE_MS = engineDeadlineByCategory(mainCategory);
  let deadlineHit = false;
  let deadlineTimerId = null;

  const deadlinePromise = new Promise((resolve) => {
    deadlineTimerId = setTimeout(() => {
      deadlineHit = true;
      try {
        engineController.abort();
      } catch {}
      resolve("__ENGINE_DEADLINE__");
    }, ENGINE_DEADLINE_MS);
  });

  const resultsBag = [];
  const rlCtx = { tried: 0, denied: 0 };

  // ✅ gerçek completed metrikleri
  let completedAdapters = 0;
  let adaptersWithItems = 0;

  const allTasks = adapters.map((adapter) =>
    safeRunAdapter(
      adapter,
      q,
      region,
      mainCategory,
      engineSignal,
      rlCtx,
      { shadow, diagCollector: adapterDiag }
    )
      .then((v) => {
        if (Array.isArray(v)) {
          resultsBag.push(v);
          if (v.length > 0) adaptersWithItems++;
        }
        return v;
      })
      .catch(() => [])
      .finally(() => {
        completedAdapters++;
      })
  );

  await Promise.race([Promise.allSettled(allTasks), deadlinePromise]);

  // ✅ deadline vurduysa küçük toparlama
  if (deadlineHit) {
    await Promise.race([
      Promise.allSettled(allTasks),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }

  try {
    if (deadlineTimerId) clearTimeout(deadlineTimerId);
  } catch {}

  let resultArrays = resultsBag.filter((x) => Array.isArray(x)).map((x) => x);

  if (!Array.isArray(resultArrays)) {
    resultArrays = [];
  }

  let flat = resultArrays.flat().filter(Boolean);

  flat = cleanResults(flat);
  flat = antiCorruptionFilter(flat);
  if (shouldApplyPriceOutlierFilter(mainCategory)) {
    flat = dropPriceOutliers(flat);
  }
  flat = clampArray(flat, 1000);
  flat = mergeDuplicates(flat);
  flat = ultraMergeByProviderAndProduct(flat);
  try {
    flat = filterStubItemsS200(flat, { query: q, category: mainCategory, region });
  } catch (e) {
    console.warn("⚠️ filterStubItemsS200 hata:", e?.message || e);
  }
  flat = flat.slice(0, 500);
flat = s100_enforceCategoryAndVertical(flat, mainCategory, q);

// =========================================================
// COVERAGE FLOOR — SADECE product/fashion + gerçekten lazımsa
// =========================================================
const COVERAGE_MIN = 8;

if (
  (mainCategory === "product" || mainCategory === "fashion") &&
  Array.isArray(flat) &&
  flat.length < COVERAGE_MIN
) {
  try {
    flat = await ensureCoverageFloorS200({
      group: mainCategory, // "product" / "fashion"
      query: q,
      region,
      items: flat,
      minItems: COVERAGE_MIN,
    });

    // ✅ floor sonrası tekrar hijyen + dedupe + enforcement
    flat = cleanResults(flat);
    flat = antiCorruptionFilter(flat);
    flat = dropPriceOutliers(flat);
    flat = clampArray(flat, 1000);
    flat = mergeDuplicates(flat);
    flat = ultraMergeByProviderAndProduct(flat);
    try {
      flat = filterStubItemsS200(flat, { query: q, category: mainCategory, region });
    } catch (e) {
      console.warn("⚠️ filterStubItemsS200 (floor) hata:", e?.message || e);
    }
    flat = flat.slice(0, 500);

    flat = s100_enforceCategoryAndVertical(flat, mainCategory, q);
  } catch (e) {
    console.warn("⚠️ ensureCoverageFloorS200 hata:", e?.message || e);
  }
}


try {
  // price normalize / optimize map...

    flat = flat.map((it) => {
      const ctx = {
        provider: it?.provider || "unknown",
        category: mainCategory,
        region,
        stage: "post-fusion",
      };
      let fixed = optimizePrice(it, ctx);
      fixed = autoInjectPrice(fixed, ctx);
return s35_enforcePriceContract(fixed);
    });
  } catch (e) {
    console.warn("S35 optimizePrice hata:", e?.message || e);
  }

  // ===========================================================
  // RANKING
  // ===========================================================
  let ranked = rankItemsByCommissionAndProviderS10(flat, {
    mainCategory,
    region,
    query: q,
  });

  // ✅ GERÇEK S40 farkı: scoreItem + revenue cluster + provider rebalance
  if (variant === "S40") {
    try {
      ranked = ranked
        .map((it, i) => scoreItem(it, i))
        .sort((a, b) => compareItemsS9(a, b));

      ranked = applyRevenueClusterBoostS93(ranked, mainCategory);
      ranked = rebalanceByProviderS92(ranked, 5, 20);

      ranked = ranked.sort((a, b) => compareItemsS9(a, b));
    } catch (e) {
      console.warn("S40 variant ranking error:", e?.message || e);
    }
  }

  // -------------------------------------------------------------
  // OPTIONAL: deterministic BEST ranking at engine level
  // Use: opts.rank="best" (no schema mutation, no fake)
  // -------------------------------------------------------------
  try {
    const mode = String(opts?.rank || opts?.sort || "").toLowerCase();
    if (mode === "best" || mode === "s200_best") {
      const providerTrustMap = opts?.providerTrustMap || providerPriority || {};
      const reranked = rankItemsS200(ranked, {
        query: q || query,
        group: mainCategory || "product",
        region,
        providerTrustMap,
      });
      if (Array.isArray(reranked) && reranked.length) ranked = reranked;
    }
  } catch (e) {
    console.warn("⚠️ rankItemsS200 hata:", e?.message || e);
  }

  const safeBest = ranked[0] || null;

  const result = {
    ok: true,
    category: mainCategory,
    items: ranked,
    best: safeBest,
    smart: [],
    others: [],
    _meta: {
      engineVariant: variant,
      totalRawAdapters: adapters.length,
      completedRawAdapters: completedAdapters, // ✅ fix
      adaptersWithItems, // ✅ fix
      totalItemsAfterMerge: ranked.length,
      query: q,
      region,
      adapterCount: adapters.length,
      categories: Array.from(categorySet),
      engineDeadlineMs: ENGINE_DEADLINE_MS,
      deadlineHit,
adapterDiagnostics: adapterDiag,
adapterDiagnosticsSummary: (() => {
  try {
    const total = Array.isArray(adapterDiag) ? adapterDiag.length : 0;
    const ok = adapterDiag.filter((d) => d?.ok).length;
    const timeout = adapterDiag.filter((d) => d?.statusCode === "timeout").length;
    const aborted = adapterDiag.filter((d) => d?.statusCode === "aborted").length;
    const okFalse = adapterDiag.filter((d) => d?.statusCode === "ok_false").length;
    const error = adapterDiag.filter((d) => d?.statusCode === "error").length;
    return { total, ok, timeout, aborted, okFalse, error };
  } catch {
    return { total: 0, ok: 0, timeout: 0, aborted: 0, okFalse: 0, error: 0 };
  }
})(),
      rateLimit: {
        ...rlCtx,
        bypassed:
          s200_shouldBypassRL({ shadow, diagCollector: adapterDiag }) || globalThis.__S200_RL_DISABLED,
      },
    },
  };

  s10_registerQueryIntent(q);

  safeLog("runAdapters_DONE", {
    category: mainCategory,
    total: ranked.length,
    deadlineHit,
    engineVariant: variant,
  });

  return result;
}

// ===============================================================
// S10 – Provider Policy & User Model & Fusion
// ===============================================================
const BASE_POLICY = {
  goodBoost: 0.03,
  mediumBoost: 0.015,
  lightBoost: 0.005,
  penalty: -0.04,
  neutral: 0,
  maxDiff: 0.18,
};

export function providerPolicyBoost(provider) {
  if (!provider) return 0;

  const p = provider.toLowerCase();

  let stats = null;
  try {
    stats = getProviderRevenueStats(p);
  } catch {
    stats = null;
  }

  if (!stats) return BASE_POLICY.neutral;

  const revenue = Number(stats.totalRevenue || 0);
  const conv = Number(stats.conversionRate || 0);
  const risk = Number(stats.riskScore || 0);

  if (risk > 0.35) return BASE_POLICY.penalty;

  if (revenue > 1000 || conv > 0.07) {
    return BASE_POLICY.goodBoost;
  }

  if (revenue > 300 || conv > 0.03) {
    return BASE_POLICY.mediumBoost;
  }

  if (revenue > 100 || conv > 0.015) {
    return BASE_POLICY.lightBoost;
  }

  return BASE_POLICY.neutral;
}

// ===============================================================
// S10 – Neo Adapter Intelligence Layer
// ===============================================================
const S10_UserModel = {
  clicks: {},
  selections: {},
};

export function s10_registerUserAction(provider, score = 1) {
  const p = String(provider || "unknown").toLowerCase();

  if (!S10_UserModel.clicks[p]) S10_UserModel.clicks[p] = 0;
  if (!S10_UserModel.selections[p]) S10_UserModel.selections[p] = 0;

  S10_UserModel.clicks[p] += 1;
  S10_UserModel.selections[p] += score;

  return true;
}

function s10_userPreferenceWeight(provider) {
  const p = String(provider || "unknown").toLowerCase();

  const click = S10_UserModel.clicks[p] || 0;
  const sel = S10_UserModel.selections[p] || 0;

  if (click + sel === 0) return 0;

  const weight = Math.min(0.12, sel / (click * 3 + 1));

  return weight;
}

function s10_dynamicProviderBoost(provider) {
  try {
    const stats = getProviderRevenueStats(provider);

    if (!stats) return 0;

    const rev = Number(stats.totalRevenue || 0);
    const conv = Number(stats.conversionRate || 0);
    const risk = Number(stats.riskScore || 0);

    if (risk > 0.35) return -0.05;

    if (rev > 1500 || conv > 0.08) return 0.06;

    if (rev > 600 || conv > 0.04) return 0.035;

    if (rev > 200 || conv > 0.02) return 0.015;

    return 0;
  } catch {
    return 0;
  }
}

function s10_buildFusionKey(it) {
  if (!it || !it.title) return null;

  const titleBase = safeString(it.title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  if (!titleBase) return null;

  let priceBand = "noprice";
const ep = s35_effectivePrice(it);
if (isValidNumber(ep) && ep > 0) {
  priceBand = String(Math.round(ep / 50));
}


  return `${titleBase}::${priceBand}`;
}

function s10_fuseItemsInternal(items = []) {
  if (!Array.isArray(items) || items.length < 2) return items;

  const map = new Map();

  for (const it of items) {
    if (!it || !it.title) continue;

    const key = s10_buildFusionKey(it);
    if (!key) continue;

    if (!map.has(key)) {
      const providers = new Set();
      const adapters = new Set();

      if (it.provider) providers.add(String(it.provider).toLowerCase());
      if (it.adapterSource) adapters.add(String(it.adapterSource));

      map.set(key, {
        base: { ...it },
        providers,
        adapters,
        minPrice: typeof it.price === "number" && it.price > 0 ? it.price : null,
        maxRating:
          typeof it.rating === "number" && it.rating > 0 ? it.rating : null,
        bestScore: isValidNumber(it.score) ? it.score : 0.01,
      });

      continue;
    }

    const bucket = map.get(key);

    if (it.provider) bucket.providers.add(String(it.provider).toLowerCase());
    if (it.adapterSource) bucket.adapters.add(String(it.adapterSource));

    if (typeof it.price === "number" && it.price > 0) {
      if (bucket.minPrice == null || it.price < bucket.minPrice) {
        bucket.minPrice = it.price;
      }
    }

    if (typeof it.rating === "number" && it.rating > 0) {
      if (bucket.maxRating == null || it.rating > bucket.maxRating) {
        bucket.maxRating = it.rating;
      }
    }

    const sc = isValidNumber(it.score) ? it.score : 0.01;
    if (sc > bucket.bestScore) {
      bucket.bestScore = sc;
      bucket.base = {
        ...bucket.base,
        url: it.url || bucket.base.url,
        finalUrl: it.finalUrl || bucket.base.finalUrl,
        currency: it.currency || bucket.base.currency,
        region: it.region || bucket.base.region,
      };
    }
  }

  const fused = [];
  for (const [, bucket] of map.entries()) {
    const { base, providers, adapters, minPrice, maxRating, bestScore } = bucket;

    const fusionProviders = providers;
    const fusionAdapters = adapters;

    const fusionCount = fusionProviders.size;
    const adapterCount = fusionAdapters.size;

    const fusionBoost = Math.min(
      0.07,
      fusionCount * 0.015 + adapterCount * 0.01
    );

    const finalScore = (bestScore || base.score || 0.01) + fusionBoost;

    fused.push({
      ...base,
      price:
        typeof minPrice === "number" && minPrice > 0
          ? minPrice
          : base.price ?? null,
      rating:
        typeof maxRating === "number" && maxRating > 0
          ? maxRating
          : base.rating ?? null,
      fusionProviders: Array.from(fusionProviders),
      fusionAdapters: Array.from(fusionAdapters),
      fusionCount,
      score: finalScore,
    });
  }

  try {
    globalThis.S10_lastFusionResult = fused;
  } catch {}

  return fused;
}

export function applyS10Boost(
  items = [],
  query = "",
  mainCategory = "",
  source = "text"
) {
  if (!Array.isArray(items)) return items;

  return items.map((it) => {
    let sourceBoost = 0;
    if (source === "vision") sourceBoost = 0.25;
    if (source === "voice") sourceBoost = 0.15;
    if (source === "qr") sourceBoost = 0.35;

    const providerKey = String(it.provider || "unknown").toLowerCase();

    const uW = s10_userPreferenceWeight(providerKey);
    const dW = s10_dynamicProviderBoost(providerKey);
    const cW = s10_categoryOverdrive(it, mainCategory);
    const iW = s10_intentWeight(it, query);
    const rW = s10_realtimeWeight(providerKey);

    it.score = (it.score || 0.01) + uW + dW + cW + iW + rW + sourceBoost;

    return it;
  });
}

const S10_QueryMemory = {
  patterns: {},
};

export function s10_registerQueryIntent(query) {
  const q = String(query || "").toLowerCase().trim();
  const words = q.split(/\s+/g).filter((w) => w.length >= 3);

  for (const w of words) {
    if (!S10_QueryMemory.patterns[w]) S10_QueryMemory.patterns[w] = 0;
    S10_QueryMemory.patterns[w] += 1;
  }
}

function s10_intentWeight(item, query) {
  const q = String(query || "").toLowerCase();
  const words = q.split(/\s+/g).filter((w) => w.length >= 3);
  if (!words.length) return 0;

  let sum = 0;
  for (const w of words) {
    sum += S10_QueryMemory.patterns[w] || 0;
  }

  const norm = Math.min(0.07, sum * 0.008);
  return norm;
}

function s10_categoryOverdrive(item, mainCategory) {
  if (!item || !mainCategory) return 0;

  const itemCat = String(item.category || "").toLowerCase();
  const main = String(mainCategory || "").toLowerCase();

  if (itemCat === main) return 0.05;
  if (itemCat.includes(main) || main.includes(itemCat)) return 0.03;

  return -0.015;
}

const S10_AdapterRealtime = {};

export function s10_registerAdapterStatus(name, ok = true, duration = 300) {
  const key = String(name || "unknown").toLowerCase();

  if (!S10_AdapterRealtime[key]) {
    S10_AdapterRealtime[key] = { fail: 0, success: 0, avg: duration };
  }

  if (!ok) S10_AdapterRealtime[key].fail++;
  else S10_AdapterRealtime[key].success++;

  S10_AdapterRealtime[key].avg =
    S10_AdapterRealtime[key].avg * 0.7 + duration * 0.3;

  try {
    globalThis.AdapterStats[key] = {
      ok,
      duration,
      ts: Date.now(),
      fail: S10_AdapterRealtime[key]?.fail || 0,
      success: S10_AdapterRealtime[key]?.success || 0,
      avg: S10_AdapterRealtime[key]?.avg || duration,
    };
  } catch {}
}

function s10_realtimeWeight(provider) {
  const key = String(provider || "unknown").toLowerCase();
  const st = S10_AdapterRealtime[key];
  if (!st) return 0;

  const failRate =
    st.fail + st.success > 0 ? st.fail / (st.fail + st.success) : 0;

  if (failRate > 0.4) return -0.05;
  if (failRate > 0.25) return -0.03;

  if (st.avg < 350) return 0.02;
  if (st.avg < 550) return 0.01;

  return 0;
}

// ===============================================================
// S10 – Adapter Diagnostics
// ===============================================================
export function adapterDiagnostics() {
  try {
    return {
      ok: true,
      time: Date.now(),
      adaptersLoaded: Object.keys(globalThis.AdapterStats || {}),
      realtime: globalThis.AdapterStats || {},
      s10Realtime: S10_AdapterRealtime || {},
      queryMemory: S10_QueryMemory?.patterns || {},
      userModel: {
        clicks: S10_UserModel?.clicks || {},
        selections: S10_UserModel?.selections || {},
      },
      note: "Herkül S10 Diagnostics aktif",
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      note: "S10 Diagnostics hata verdi",
    };
  }
}

// ======================================================================
// LEGACY + DEBUG PANEL UYUMLULUK KATMANI
// ======================================================================
export const providerStats =
  globalThis.S16_providerStats || globalThis.S10_providerStats || {};

export const lastFusionResult =
  globalThis.S10_lastFusionResult || globalThis.S16_lastFusionResult || [];

export const fusionHistory =
  globalThis.S10_lastFusionHistory || globalThis.S10_lastFusionResult || [];

export const lastQueries =
  globalThis.S10_QueryMemory?.lastQueries || globalThis.S16_lastQueries || [];

export const totalAdapterRuns =
  globalThis.S10_totalAdapterRuns || globalThis.S16_totalAdapterRuns || 0;

export function s10_fuseItems(items = []) {
  return s10_fuseItemsInternal(items);
}

export function totalAdapters() {
  try {
    if (
      globalThis.S10_AdapterRealtime &&
      typeof globalThis.S10_AdapterRealtime === "object"
    ) {
      const c = Object.keys(globalThis.S10_AdapterRealtime).length;
      if (c > 0) return c;
    }

    if (Array.isArray(globalThis.S10_Adapters)) {
      return globalThis.S10_Adapters.length;
    }

    return 0;
  } catch {
    return 0;
  }
}

// ============================================================================
//  EOF PATCH BLOCK REMOVED
//  - Runtime env-patched overrides are a production footgun.
//  - Keep patch history in git instead of dynamic module-scope rewrites.
// ============================================================================
