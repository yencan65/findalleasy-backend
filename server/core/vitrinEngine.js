// BACKEND/core/vitrinEngine.js
// FindAllEasy Vitrin Motoru — S21 GOD ENGINE · H E R K Ü L MODU
// ------------------------------------------------------------------
// KURALLAR:
// - Mevcut işlevler SİLİNMİYOR, sadece güçlendiriliyor.
// - BEST motoru: S10.5 + S11 + S11.2 + S11.3 → TEK S21 GOD BLOĞU
// - SMART / OTHERS hiçbir koşulda BEST’i geçemez (fiyat + kalite + güven).
// - Fusion, cache, mock, safe mode, providerLogo, metaScore, personalization,
//   commission ve badge motorları aynen korunur, sadece tek beyne bağlanır.
// ------------------------------------------------------------------

import stringSimilarity from "string-similarity";

// S35 GLOBAL PRICE NORMALIZER (harici normalizer dosyasından)
import { normalizeAdapterResultsS35 } from "./normalizerS35.js";
import { scoreAndFuseS200 } from "./scorerFusionS200.js";

import { getUserMemory, updateUserMemory } from "./learningMemory.js";

// 🔥 ANA MOTOR: S100 + S200 çekirdeği burada
import { runAdapters, runVitrineS40, s40_safeDetectIntent } from "./adapterEngine.js";

import {
  decorateResultsWithCommission,
  safeDecorateResultsWithCommission,
  providerPriority,
} from "./commissionEngine.js";

import { decorateWithBadges } from "./badgeEngine.js";
import { recordProviderClick } from "./providerLearning.js";

import {
  buildBestCardExplanation,
  buildSmartCardExplanation,
  buildOthersCardExplanation,
} from "../intelligence/explanationBuilder.js";

import { detectIntent } from "./intentEngine.js";
import { safeComputeFinalUserPrice } from "./priceEngine.js";
import { buildMemoryProfile, applyPersonalizationScore } from "./aiPipeline.js";
import { relatedMap } from "./relatedMap.js";

// ============================================================================
// STRICT NO_FAKE GUARDS (Mock/Stub rules)
// - FINDALLEASY_ALLOW_STUBS=0  => MOCK OFF
// - NODE_ENV=production        => MOCK OFF
// - Mock only if: FINDALLEASY_ALLOW_STUBS=1 && FINDALLEASY_MOCK_VITRIN=1 (and not prod)
// ============================================================================
function __envFlag(name, defVal = "0") {
  return String(process.env[name] ?? defVal) === "1";
}
function __isProdEnv() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}
function __allowStubs() {
  return __envFlag("FINDALLEASY_ALLOW_STUBS", "0");
}
function __allowMockVitrin() {
  return !__isProdEnv() && __allowStubs() && __envFlag("FINDALLEASY_MOCK_VITRIN", "0");
}
function __engineVariantKey() {
  return String(process.env.FINDALLEASY_ENGINE_VARIANT || "vitrin").trim().toLowerCase() || "vitrin";
}

// ---------------------------------------------------------
// 🧠 S200 BEST RELEVANCE GUARD (BEST_OVERALL hijyen)
// Amaç: Query “iphone 15” iken aksesuar/parça başlıkları best_overall olamasın.
// - Relevance: token overlap (hızlı)
// - Intent mismatch penalty: query aksesuar istemiyorsa, title aksesuar kokuyorsa sert ceza
// ---------------------------------------------------------
const S200_BEST_MIN_REL = Number(process.env.S200_BEST_MIN_REL || 0.34); // basic floor
const S200_PENALTY_WEAK_REL = Number(process.env.S200_PENALTY_WEAK_REL || 0.25);
const S200_PENALTY_ACCESSORY_MISMATCH = Number(process.env.S200_PENALTY_ACCESSORY_MISMATCH || 0.10);

const S200_ACCESSORY_HINTS = [
  // TR
  "kılıf","kapak","cam","film","koruyucu","ekran","batarya","şarj","sarj","adaptör","adaptor","kablo",
  "kasa","dolu kasa","çıkma","cikma","parça","parca","yedek","servis","tamir","onarım","onarim",
  "uyumlu","uygun","aparat","aksesuar",
  // EN (çöp provider başlıkları için)
  "case","cover","screen","protector","glass","battery","charger","cable","housing","spare","part","parts","compatible","for "
];

const S200_STOP = new Set([
  "ve","ile","icin","için","da","de","the","a","an","and","or","of","to","for","with"
]);

function _escRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _normTr(s) {
  return String(s || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9ğüşöçıİ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _tokens(s) {
  const t = _normTr(s).split(" ").filter(Boolean);
  return t.filter((x) => x.length > 1 && !S200_STOP.has(x));
}

function _hasAccessoryHint(text) {
  const s = _normTr(text);
  if (!s) return false;

  for (const h of S200_ACCESSORY_HINTS) {
    const hn = _normTr(h);
    if (!hn) continue;

    // "for " gibi boundary hassas kelimeler: token olarak yakala
    if (hn === "for") {
      if (/\bfor\b/.test(s)) return true;
      continue;
    }

    // Çok kelimeli hint: substring yeterli
    if (hn.includes(" ")) {
      if (s.includes(hn)) return true;
      continue;
    }

    // Tek kelime: kök + ekleri yakala (kılıfı/kılıflar vs.)
    const re = new RegExp(`\\b${_escRe(hn)}\\w*`, "i");
    if (re.test(s)) return true;
  }

  return false;
}

function _relevanceScore(query, title) {
  const q = _tokens(query);
  if (!q.length) return 0;

  const t = new Set(_tokens(title));
  let hit = 0;
  for (const tok of q) if (t.has(tok)) hit++;

  // overlap ratio
  return hit / q.length;
}

/**
 * returns { rel, penalty, flags }
 * penalty in (0..1]
 */
function _bestRelevancePenalty(query, title) {
  const rel = _relevanceScore(query, title);

  const qAccessory = _hasAccessoryHint(query);
  const tAccessory = _hasAccessoryHint(title);

  let penalty = 1;

  // weak relevance floor
  if (rel < S200_BEST_MIN_REL) penalty *= S200_PENALTY_WEAK_REL;

  // intent mismatch: query aksesuar istemiyor ama title aksesuar/parça kokuyor
  if (!qAccessory && tAccessory) penalty *= S200_PENALTY_ACCESSORY_MISMATCH;

  return {
    rel,
    penalty,
    flags: {
      weakRel: rel < S200_BEST_MIN_REL,
      accessoryMismatch: !qAccessory && tAccessory,
    },
  };
}

// ---------------------------------------------------------
// 🔒 S21 SAFE NORMALIZER — Kart için minimum alan garantisi
// ---------------------------------------------------------
function s21_sanitizeItem(item = {}) {
  // ---------------------------------------------
  // S21 Ultra: fiyat/rating/trust string → number
  // Amaç: "priced item yok → MOCK" durumunu bitirmek
  // ---------------------------------------------
  const safeStr = (v) => (v == null ? "" : String(v)).trim();

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // Çok agresif ama güvenli: her türlü sayı formatını parse etmeye çalışır
  function parsePriceStrong(v) {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
    if (v == null) return null;

    let s = String(v)
      .replace(/\s+/g, "")
      .replace(/₺|TL|tl|try|TRY/gi, "")
      .replace(/[^\d.,-]/g, "");

    // Negatif fiyat istemiyoruz
    s = s.replace(/^-+/, "");
    if (!s) return null;

    // Hem virgül hem nokta varsa → son görülen ayırıcıyı "decimal" kabul et
    if (s.includes(",") && s.includes(".")) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma > lastDot) {
        // 1.234.567,89 → 1234567.89
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        // 1,234,567.89 → 1234567.89
        s = s.replace(/,/g, "");
      }
    } else if (s.includes(",")) {
      const parts = s.split(",");
      // 12,34 → 12.34 (decimal)
      if (parts[1] && parts[1].length === 2) s = s.replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (s.includes(".")) {
      const parts = s.split(".");
      // 1.234.567 (binlik) → 1234567
      if (!parts[1] || parts[1].length !== 2) s = s.replace(/\./g, "");
    }

    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function parseNumLoose(v) {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
    if (v == null) return null;

    // "4,3" gibi değerleri de yakala
    const s = String(v).trim();
    if (!s) return null;

    // fiyat parserı plain sayıyı da çözüyor
    return parsePriceStrong(s);
  }

  const providerKey = safeStr(item.providerKey || item.provider || "unknown").toLowerCase();
  const providerFamily = providerKey.split("_")[0];

  // Fiyat: mümkün olan her alandan topla
  const rawPrice =
    item.price ??
    item.finalPrice ??
    item.optimizedPrice ??
    item.amount ??
    item.minPrice ??
    item.maxPrice ??
    item.priceText ??
    item.priceStr ??
    item.priceString ??
    item.raw?.price ??
    item.raw?.fiyat ??
    item.raw?.amount ??
    item.raw?.salePrice ??
    item.raw?.finalPrice ??
    item.raw?.currentPrice ??
    item.raw?.priceText ??
    item.raw?.price_str;

  const priceN = parsePriceStrong(rawPrice);
  // S200 contract: >0 değilse null (0 YASAK)
  const price = typeof priceN === "number" && Number.isFinite(priceN) && priceN > 0 ? priceN : null;
  const ratingN = parseNumLoose(item.rating ?? item.stars ?? item.score);
  const rating = isValidNumber(ratingN) ? clamp(ratingN, 0, 5) : 0;

  let trustN = parseNumLoose(item.trustScore ?? item.trust ?? item.trust_score);
  // 67 → 0.67 gibi percent geldi ise normalize et
  if (isValidNumber(trustN) && trustN > 1 && trustN <= 100) trustN = trustN / 100;

  // trustScore yoksa provider taban güven puanı ver (boş item'ı çöpe atmamak için)
  const trustFallback = getProviderTrust(providerFamily || providerKey);
  const trustScore = isValidNumber(trustN) ? clamp(trustN, 0, 1) : trustFallback;

  const reviewCountN = parseNumLoose(item.reviewCount ?? item.reviews ?? item.review_count);
  const reviewCount = Number.isFinite(reviewCountN) && reviewCountN >= 0 ? Math.floor(reviewCountN) : 0;

  const url = safeStr(
    item.url ||
      item.finalUrl ||
      item.originUrl ||
      item.deeplink ||
      item.affiliateUrl ||
      item.mapsUrl ||
      item.placeUrl ||
      item.website ||
      item.raw?.url ||
      item.raw?.finalUrl ||
      item.raw?.originUrl ||
      item.raw?.deeplink ||
      item.raw?.mapsUrl ||
      item.raw?.website ||
      ""
  );

  // provider: unknown kalamaz
  let provider = safeStr(item.provider || providerFamily || providerKey || "unknown").toLowerCase();
  if (!provider || provider === "unknown") provider = providerFamily || providerKey || "generic";
  if (!provider || provider === "unknown") provider = "generic";

  return {
    ...item,
    title: safeStr(item.title || item.name || item.query || ""),
    url,
    image: safeStr(item.image || item.img || item.thumbnail || ""),
    price,
    currency: safeStr(item.currency || "TRY") || "TRY",
    rating,
    trustScore,
    reviewCount,
    provider,
    providerKey,
    providerFamily,
    category: safeStr(item.category || item.vertical || "mixed"),
  };
}

// ---------------------------------------------------------
// 🔥 Küçük yardımcılar
// ---------------------------------------------------------
function isValidNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// tek fiyat kaynağı: finalUserPrice > price > null
function getItemPrice(it) {
  // Price can arrive in different fields depending on adapter / fusion stage.
  // We normalize here so product-best selection doesn't accidentally pick "no-price" cards.
  const v =
    it?.finalUserPrice ??
    it?.optimizedPrice ??
    it?.finalPrice ??
    it?.final_price ??
    it?.price ??
    it?.rawPrice ??
    it?.raw_price ??
    null;

  let n = null;
  if (typeof v === "number") {
    n = v;
  } else if (v !== null && v !== undefined) {
    const s = String(v).replace(/[^0-9.,]/g, "").replace(",", ".");
    const x = Number(s);
    if (Number.isFinite(x)) n = x;
  }

  if (isValidNumber(n) && n > 0) return n;
  return null;
}


function asArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function getProviderTrust(providerKey) {
  const keyRaw = String(providerKey || "unknown").toLowerCase().trim();
  const key = keyRaw.replace(/[^a-z0-9_]/g, "");

  // Unknown/generic provider → düşük baz güven (yoksa çöp provider'lar şişer)
  if (!key || key === "unknown" || key === "generic") return 0.62;

  const prioRaw = providerPriority?.[key] ?? providerPriority?.unknown ?? 2; // 1..5 (unknown default düşük)
  const prio = Math.max(1, Math.min(5, prioRaw));

  // 0.62..0.95 arası ölçekle (0.8 default gibi saçma yüksek olmasın)
  const min = 0.62;
  const max = 0.95;
  return min + ((prio - 1) / 4) * (max - min);
}

function computePriceNorm(priceRaw) {
  if (!isValidNumber(priceRaw)) return 0;
  const price = Math.max(0, priceRaw);
  return 1 / (price + 1);
}

function computeFinalScore(item) {
  const pers = item.qualityScorePersonal || item.qualityScore || 0;
  const qual = item.qualityScore || 0;

  const p = getItemPrice(item);
  const price = isValidNumber(p) ? p : Infinity;

  const priceNorm = computePriceNorm(price);

  // Pers > Qual > Price
  return pers * 0.5 + qual * 0.3 + priceNorm * 0.2;
}

// ---------------------------------------------------------
// 🧠 BEST RELEVANCE GUARD — backward-compat wrappers
// (S21 çağrı noktaları kırılmasın diye __s21_* isimlerini koruyoruz.)
// ---------------------------------------------------------
function __s21_bestRelevancePenalty(query, title) {
  return _bestRelevancePenalty(query, title);
}

function __s21_preferNonMismatch(cands, query) {
  if (!Array.isArray(cands) || !cands.length) return cands || [];
  const q = String(query || "").trim();
  if (!q) return cands;

  const nonMismatch = cands.filter(
    (it) => !__s21_bestRelevancePenalty(q, it?.title || "").flags.accessoryMismatch
  );

  // yeterli alternatif varsa mismatch’leri dışarı at
  if (nonMismatch.length >= 2) return nonMismatch;
  return cands;
}

// ---------------------------------------------------------
// 🔥 S11 — FULL PROVIDER LOGO DICTIONARY (100+ provider)
// ---------------------------------------------------------
const providerLogos = {
  // 🇹🇷 Büyük Türk Pazarları
  trendyol: "/logos/trendyol.svg",
  ty: "/logos/trendyol.svg",

  hepsiburada: "/logos/hepsiburada.svg",
  hb: "/logos/hepsiburada.svg",

  n11: "/logos/n11.svg",
  n11com: "/logos/n11.svg",

  ciceksepeti: "/logos/ciceksepeti.svg",
  cicek: "/logos/ciceksepeti.svg",
  cs: "/logos/ciceksepeti.svg",

  akakce: "/logos/akakce.svg",
  gittigidiyor: "/logos/gittigidiyor.svg",

  // 🇹🇷 Yemek / Market
  getir: "/logos/getir.svg",
  getirbuyuk: "/logos/getir.svg",
  yemeksepeti: "/logos/yemeksepeti.svg",
  banabi: "/logos/getir.svg",
  trendyolgo: "/logos/trendyol.svg",

  // 🇹🇷 Araç / Hizmet
  armut: "/logos/armut.svg",
  arabam: "/logos/arabam.svg",
  sahibinden: "/logos/sahibinden.svg",

  // 🇹🇷 Tur / Bilet
  biletix: "/logos/biletix.svg",
  passo: "/logos/passo.svg",
  biletino: "/logos/biletino.svg",
  mngtur: "/logos/mngtur.svg",
  etstur: "/logos/etstur.svg",

  // 🌍 Global Marketplaces
  amazon: "/logos/amazon.svg",
  amazontr: "/logos/amazon.svg",
  aliexpress: "/logos/aliexpress.svg",
  ebay: "/logos/ebay.svg",
  etsy: "/logos/etsy.svg",
  allegro: "/logos/allegro.svg",
  walmart: "/logos/walmart.svg",
  bestbuy: "/logos/bestbuy.svg",
  target: "/logos/target.svg",

  // 🌍 Otel / Uçak
  booking: "/logos/booking.svg",
  bookingcom: "/logos/booking.svg",

  agoda: "/logos/agoda.svg",
  trivago: "/logos/trivago.svg",
  hotels: "/logos/hotels.svg",

  skyscanner: "/logos/skyscanner.svg",
  kiwi: "/logos/kiwi.svg",

  turkishairlines: "/logos/turkishairlines.svg",
  thy: "/logos/turkishairlines.svg",
  pegasus: "/logos/pegasus.svg",

  // 🌍 Tur / Etkinlik
  tripadvisor: "/logos/tripadvisor.svg",
  viator: "/logos/viator.svg",

  // 🌍 Moda / Spor
  zara: "/logos/zara.svg",
  hm: "/logos/hm.svg",
  lcw: "/logos/lcw.svg",
  defacto: "/logos/defacto.svg",
  koton: "/logos/koton.svg",
  adidas: "/logos/adidas.svg",
  nike: "/logos/nike.svg",
  decathlon: "/logos/decathlon.svg",

  // 🌍 Teknoloji
  google: "/logos/google.svg",
  serpapi: "/logos/google.svg",

  // Harita
  osm: "/logos/osm.svg",
  openstreetmap: "/logos/osm.svg",

  // Fallback
  default: "/logos/default.svg",
};

// ---------------------------------------------------------
// 🔥 S11 — ULTRA PROVIDER LOGO INJECTION ENGINE
// ---------------------------------------------------------
function injectProviderLogo(item) {
  if (!item) return item;

  const keys = Object.keys(providerLogos);

  let raw = String(item.provider || item.adapterSource || "")
    .toLowerCase()
    .trim()
    .replace("www.", "");

  if (!raw && item.url) {
    raw = item.url.replace(/^https?:\/\//, "").split("/")[0];
  }

  const key = raw
    .replace(".com", "")
    .replace(".tr", "")
    .replace(".net", "")
    .replace(".org", "")
    .replace(/[^a-z0-9]/g, "");

  if (providerLogos[key]) return { ...item, providerLogo: providerLogos[key] };

  const soft = keys.find((k) => key.includes(k));
  if (soft) return { ...item, providerLogo: providerLogos[soft] };

  if (item.url) {
    let domain = item.url
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .replace("www.", "");

    domain = domain
      .replace(".com", "")
      .replace(".tr", "")
      .replace(/[^a-z0-9]/g, "");

    const domainMatch = keys.find((k) => domain.includes(k));
    if (domainMatch) return { ...item, providerLogo: providerLogos[domainMatch] };
  }

  try {
    const similarity = keys
      .map((k) => ({ k, score: stringSimilarity.compareTwoStrings(key, k) }))
      .sort((a, b) => b.score - a.score);

    if (similarity[0]?.score >= 0.42) {
      return { ...item, providerLogo: providerLogos[similarity[0].k] };
    }
  } catch {}

  return { ...item, providerLogo: providerLogos.default };
}

// ---------------------------------------------------------
// 🔥 Vitrin Cache (S8.4 → userId dahil)
// ---------------------------------------------------------
const vitrinCache = new Map();
const VITRIN_CACHE_TTL_MS = 15 * 60_000;

function getCachedVitrin(query, region, userId = null, category = null, variant = null) {
  const qk = (String(query ?? "").trim().toLowerCase() || "null").slice(0, 300);
  const rk = (String(region ?? "global").trim().toLowerCase() || "global").slice(0, 40);
  const uk = userId ? String(userId).slice(0, 64) : "anon";
  const ck = (String(category ?? "any").trim().toLowerCase() || "any").slice(0, 40);
  const vk = (String(variant ?? __engineVariantKey()).trim().toLowerCase() || __engineVariantKey()).slice(0, 40);
  const key = `${qk}:${rk}:${ck}:${vk}:${uk}`;

  const entry = vitrinCache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.time > VITRIN_CACHE_TTL_MS) {
    vitrinCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedVitrin(query, region, userId = null, payload, category = null, variant = null) {
  const qk = (String(query ?? "").trim().toLowerCase() || "null").slice(0, 300);
  const rk = (String(region ?? "global").trim().toLowerCase() || "global").slice(0, 40);
  const uk = userId ? String(userId).slice(0, 64) : "anon";
  const ck = (String(category ?? "any").trim().toLowerCase() || "any").slice(0, 40);
  const vk = (String(variant ?? __engineVariantKey()).trim().toLowerCase() || __engineVariantKey()).slice(0, 40);
  const key = `${qk}:${rk}:${ck}:${vk}:${uk}`;
  vitrinCache.set(key, { data: payload, time: Date.now() });
}

// ---------------------------------------------------------
// 🔥 Kategori Normalize (S120-safe)
// ---------------------------------------------------------
function normalizeCategory(item, categoryHint = null) {
  if (categoryHint) {
    const rawCat =
      (typeof categoryHint === "object" && categoryHint !== null
        ? categoryHint.raw ||
          categoryHint.norm ||
          categoryHint.category ||
          categoryHint.type ||
          categoryHint.name
        : categoryHint) || "";

    const norm = String(rawCat).toLowerCase().trim();
    if (norm && norm !== "genel" && norm !== "unknown") return norm;
  }

  const t = (item?.title || "").toLowerCase();

  if (item?.category && item.category !== "unknown") return item.category;

  if (/(\bgb\b|\btl\b|\binç\b|laptop|telefon|tablet|kulaklık)/.test(t)) return "electronics";
  if (/uçak|flight|hava yolu|airline|bilet/.test(t)) return "flight";
  if (/otel|hotel|resort|pansiyon|spa/.test(t)) return "hotel";
  if (/araç kiralama|rent a car|car rental/.test(t)) return "car_rental";
  if (/tur|tour|tatil paketi/.test(t)) return "tour";
  if (/yemek|food|restaurant|lokanta/.test(t)) return "food";

  return "product";
}

// ---------------------------------------------------------
// 🔥 ETA Tahmini (S8.4 AI ETA Estimator)
// ---------------------------------------------------------
function inferEtaFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();

  if (
    t.includes("aynı gün") ||
    t.includes("same day") ||
    t.includes("hemen teslim") ||
    t.includes("anında teslim") ||
    t.includes("jet") ||
    t.includes("express")
  ) return 0;

  if (t.includes("ertesi gün") || t.includes("1 günde") || t.includes("1-2 gün") || t.includes("hızlı kargo"))
    return 1;

  if (t.includes("2-3 gün") || t.includes("standart kargo") || t.includes("3 gün içinde")) return 3;

  if (t.includes("4-7 gün") || t.includes("5-7 gün") || t.includes("7 iş günü")) return 6;

  return null;
}

function inferEtaDays(item) {
  const category = String(item?.category || "").toLowerCase();
  const provider = String(item?.provider || "").toLowerCase();
  const text = [item?.title, item?.description, item?.subtitle, item?.badgeText, item?.shippingText]
    .filter(Boolean)
    .join(" ");

  if (["hotel", "flight", "event", "tour"].includes(category) || provider.includes("bilet") || provider.includes("booking") || provider.includes("skyscanner"))
    return 0;

  if (["food", "market"].includes(category) || provider.includes("yemeksepeti") || provider.includes("getir") || provider.includes("banabi"))
    return 0;

  const etaFromText = inferEtaFromText(text);
  if (etaFromText != null) return etaFromText;

  return null;
}

// ---------------------------------------------------------
// 🔥 Meta Skorları (trust + speed + quality)
// ---------------------------------------------------------
function attachMetaScores(item) {
  if (!item || typeof item !== "object") return item;

  const providerKey = String(item.provider || "unknown").toLowerCase();
  const baseTrust = getProviderTrust(providerKey);

  const ratingNorm =
    typeof item.rating === "number" && item.rating > 0 ? Math.min(1, item.rating / 5) : 0.5;

  const trustScore = Math.min(1, baseTrust * 0.6 + ratingNorm * 0.4);

  let speedScore = 3;
  const etaRaw = item?.delivery?.etaDays ?? item?.raw?.delivery?.etaDays ?? item?.raw?.etaDays ?? null;
  const eta = isValidNumber(etaRaw) ? etaRaw : inferEtaDays(item);

  if (typeof eta === "number" && eta >= 0) {
    if (eta === 0) speedScore = 5;
    else if (eta <= 2) speedScore = 4;
    else if (eta <= 4) speedScore = 3;
    else if (eta <= 6) speedScore = 2;
    else speedScore = 1;
  }

  const speedNorm = speedScore / 5;
  const qualityScore = Number((trustScore * 0.7 + speedNorm * 0.3).toFixed(4));
  const qualityScore5 = Number((1 + qualityScore * 4).toFixed(2));

  return { ...item, trustScore, speedScore, qualityScore, qualityScore5 };
}

// ---------------------------------------------------------
// 🔥 Aynı Ürün Kontrolü
// ---------------------------------------------------------
function isSameProduct(itemA, itemB) {
  if (!itemA || !itemB) return false;

  if (itemA.category && itemB.category && itemA.category !== itemB.category) return false;

  if (itemA.id && itemB.id && itemA.id === itemB.id) return true;
  if (itemA.url && itemB.url && itemA.url === itemB.url) return true;

  const t1 = String(itemA.title || "").toLowerCase().trim();
  const t2 = String(itemB.title || "").toLowerCase().trim();

  if (!t1 || !t2) return false;
  if (t1 === t2) return true;

  try {
    const sim = stringSimilarity.compareTwoStrings(t1, t2);
    if (sim >= 0.55) return true;
  } catch {}

  const w1 = t1.split(/\s+/g).filter((w) => w.length > 2);
  const w2 = t2.split(/\s+/g).filter((w) => w.length > 2);
  if (w1.filter((w) => w2.includes(w)).length >= 2) return true;

  const nums1 = t1.match(/\b\d+\b/g) || [];
  const nums2 = t2.match(/\b\d+\b/g) || [];
  if (nums1.some((n) => nums2.includes(n))) return true;

  const knownBrands = [
    "apple","samsung","xiaomi","huawei","lenovo","sony","lg","philips","bosch","beko",
    "arçelik","asus","hp","oppo","casper","monster","dell","acer","vestel",
  ];
  const brand1 = knownBrands.find((b) => t1.includes(b));
  const brand2 = knownBrands.find((b) => t2.includes(b));
  if (brand1 && brand2 && brand1 === brand2) return true;

  const hospitalityWords = ["hotel", "otel", "resort", "pansiyon", "spa", "suites"];
  const hw1 = hospitalityWords.some((w) => t1.includes(w));
  const hw2 = hospitalityWords.some((w) => t2.includes(w));
  if (hw1 && hw2) return true;

  const cities = ["bodrum","antalya","didim","marmaris","istanbul","izmir","ankara"];
  const city1 = cities.find((c) => t1.includes(c));
  const city2 = cities.find((c) => t2.includes(c));
  if (city1 && city2 && city1 === city2) return true;

  return false;
}

// ---------------------------------------------------------
// 🔥 Benzer Ürün Kontrolü (Fallback)
// ---------------------------------------------------------
function isSimilarProduct(itemA, itemB, similarityThreshold = 0.35) {
  if (!itemA || !itemB) return false;
  if (!itemA.category || !itemB.category) return false;
  if (itemA.category !== itemB.category) return false;

  const titleA = String(itemA.title || "").toLowerCase();
  const titleB = String(itemB.title || "").toLowerCase();
  if (!titleA || !titleB) return false;

  try {
    return stringSimilarity.compareTwoStrings(titleA, titleB) >= similarityThreshold;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------
// 🔥 Komisyonu güvenli uygulama helper’ı
// ---------------------------------------------------------
function applyCommissionLayer(items, context) {
  if (!Array.isArray(items) || !items.length) return [];

  const STAMP = "__commissionDecorated";
  const isStamped = (it) => !!(it && typeof it === "object" && it[STAMP] === true);

  // ✅ idempotent: ikinci kez decorate tamamen no-op
  if (items.every(isStamped)) return items;

  const stampAll = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((it) => {
        if (!it || typeof it !== "object") return it;
        if (it[STAMP] === true) return it;
        return { ...it, [STAMP]: true };
      })
      .filter(Boolean);

  // Try safe decorator first
  if (typeof safeDecorateResultsWithCommission === "function") {
    try {
      const out = safeDecorateResultsWithCommission(items, context);
      if (Array.isArray(out)) return stampAll(out);
    } catch (e) {
      console.warn("⚠️ safeDecorateResultsWithCommission hata:", e?.message || String(e));
      // no stamp here → ileride tekrar denenebilsin
    }
  }

  // Fallback decorator
  if (typeof decorateResultsWithCommission === "function") {
    try {
      const out = decorateResultsWithCommission(items, context);
      if (Array.isArray(out)) return stampAll(out);
    } catch (e) {
      console.warn("⚠️ decorateResultsWithCommission hata:", e?.message || String(e));
      // no stamp here → ileride tekrar denenebilsin
    }
  }

  // hiç decorate olmadı: orijinal dön (stamp yok)
  return items;
}

// ---------------------------------------------------------
// 🔥 Fiyat hook’u — finalUserPrice alanını ekle
// ---------------------------------------------------------
function attachFinalUserPrice(item, { memoryProfile } = {}) {
  if (!item || typeof item !== "object") return item;

  try {
    const finalUserPrice = safeComputeFinalUserPrice
      ? safeComputeFinalUserPrice(item, { memoryProfile })
      : null;

    return { ...item, finalUserPrice: isValidNumber(finalUserPrice) ? finalUserPrice : null };
  } catch {
    return { ...item, finalUserPrice: null };
  }
}

// ---------------------------------------------------------
// 🔥 Intent’i güvenli almak (S40 + S15 hibrit)
// ---------------------------------------------------------
function safeDetectIntent(query) {
  const q = query || "";

  try {
    if (typeof s40_safeDetectIntent === "function") {
      const advanced = s40_safeDetectIntent(q);
      if (advanced) return advanced;
    }
  } catch (e) {
    console.warn("⚠️ s40_safeDetectIntent hata:", e.message);
  }

  if (!detectIntent) return null;
  try {
    return detectIntent(q);
  } catch (e) {
    console.warn("⚠️ detectIntent hata:", e.message);
    return null;
  }
}

// ---------------------------------------------------------
// 🔥 S8.4 — Kategoriye göre fiyat toleransı
// ---------------------------------------------------------
const categoryPriceTolerance = {
  electronics: 1.4,
  flight: 2.2,
  hotel: 1.9,
  car_rental: 1.6,
  fashion: 1.5,
  tour: 2.0,
  event: 1.5,
  food: 1.5,
  product: 1.4,
  general: 1.4,
};

// ---------------------------------------------------------
// 🔥 S8.4 — SMART için dinamik related kategori çözümü
// ---------------------------------------------------------
function resolveRelatedCategories(mainCategory, intent, query) {
  const base = relatedMap?.[mainCategory] || ["product", "electronics"];
  const extra = new Set(base);

  const q = String(query || "").toLowerCase();
  const intentType = intent?.type || intent?.category || "";

  if (q.includes("otel") || q.includes("hotel") || intentType === "hotel") {
    extra.add("hotel");
    extra.add("tour");
  }

  if (q.includes("uçak") || q.includes("flight") || q.includes("bilet")) {
    extra.add("flight");
    extra.add("hotel");
  }

  if (q.includes("tur") || q.includes("tour") || q.includes("tatil")) {
    extra.add("tour");
    extra.add("hotel");
  }

  if (q.includes("konser") || q.includes("festival") || q.includes("tiyatro") || intentType === "event") {
    extra.add("event");
    extra.add("hotel");
  }

  if (q.includes("yemek") || q.includes("restaurant") || q.includes("lokanta") || q.includes("cafe")) {
    extra.add("food");
  }

  if (q.includes("elbise") || q.includes("ayakkabı") || q.includes("giyim") || intentType === "fashion") {
    extra.add("fashion");
    extra.add("product");
  }

  return Array.from(extra);
}

// ---------------------------------------------------------
// 🔥 S10.5 — Adaptive Price Intelligence (helper)
// ---------------------------------------------------------
function applyPricePreferenceFactor(item, memoryObj) {
  if (!memoryObj) return 1.0;
  const profile = memoryObj?.priceProfile || "balanced";
  if (profile === "cheap") return 1.3;
  if (profile === "premium") return 0.8;
  return 1.0;
}

// ---------------------------------------------------------
// 🔥 S21 GOD ENGINE — BEST MOTORU (S10.5 + S11 + S11.2 + S11.3)
// ---------------------------------------------------------
function s21SelectBest(finalPool, uniqueItems, groupA, groupB, memory, query = "") {
  if (!finalPool || finalPool.length === 0) {
    return {
      BEST: null,
      bestFinal: null,
      globalBest: null,
      strictBest: null,
      ordered: [],
      meta: { reason: "empty_finalPool" },
    };
  }

  const qStr = String(query || "");

  const minPrice =
    finalPool.length > 0
      ? finalPool.reduce((m, it) => {
          const p = getItemPrice(it);
          return isValidNumber(p) && p < m ? p : m;
        }, Infinity)
      : Infinity;

  let globalBest = null;
  let globalScore = -Infinity;
  let globalBestRel = null;

  for (const it of finalPool) {
    if (!it) continue;

    const baseScore = computeFinalScore(it);

    let pricePenalty = 1.0;
    const p = getItemPrice(it);
    if (isValidNumber(p) && isValidNumber(minPrice) && minPrice > 0) {
      const ratio = p / minPrice;
      if (ratio > 1.5) pricePenalty = 0.6;
      else if (ratio > 1.3) pricePenalty = 0.8;
    }

    const hasCommission = (it?.commissionMeta?.platformRate || 0) > 0;
    const commissionBoost = hasCommission ? 1.03 : 1.0;

    // ✅ RELEVANCE + ACCESSORY MISMATCH PENALTY (BEST GUARD)
    const relPack = qStr ? _bestRelevancePenalty(qStr, it?.title || "") : { rel: 0, penalty: 1, flags: {} };

    // skorunu kır
    const effectiveScore =
      baseScore *
      commissionBoost *
      pricePenalty *
      applyPricePreferenceFactor(it, memory) *
      (relPack?.penalty || 1);

    // debug meta (UI badge/uyarı için)
    try {
      it._meta = it._meta || {};
      it._meta.relevance = relPack?.rel ?? null;
      it._meta.relevancePenalty = relPack?.penalty ?? null;
      it._meta.relevanceFlags = relPack?.flags ?? null;
    } catch {}

    if (effectiveScore > globalScore) {
      globalScore = effectiveScore;
      globalBest = it;
      globalBestRel = relPack;
    }
  }

  const ordered = groupA.length ? [...groupA, ...groupB] : [...groupB];

  let strictBest = null;
  let BEST = globalBest || ordered[0] || finalPool[0] || uniqueItems[0] || null;

  // triple winner: max rating + max trust + min price (±1%)
  let scoredCandidates = finalPool.filter(
    (it) =>
      isValidNumber(getItemPrice(it)) &&
      getItemPrice(it) > 0 &&
      typeof it.rating === "number" &&
      typeof it.trustScore === "number"
  );

  // ✅ if alternatives exist, avoid accessory-mismatch candidates in strict/hard paths
  scoredCandidates = __s21_preferNonMismatch(scoredCandidates, qStr);

  if (scoredCandidates.length) {
    const maxRating = Math.max(...scoredCandidates.map((it) => it.rating || 0));
    const maxTrust = Math.max(...scoredCandidates.map((it) => it.trustScore || 0));
    const minPriceStrict = Math.min(...scoredCandidates.map((it) => getItemPrice(it) || Infinity));
    const priceTolerance = minPriceStrict * 1.01;

    const tripleWinners = scoredCandidates.filter(
      (it) =>
        it.rating >= maxRating &&
        it.trustScore >= maxTrust &&
        (getItemPrice(it) || Infinity) <= priceTolerance
    );

    if (tripleWinners.length) {
      strictBest =
        tripleWinners.find((it) => (it?.commissionMeta?.platformRate || 0) > 0) || tripleWinners[0];
    }

    BEST = strictBest || globalBest || ordered[0] || finalPool[0] || uniqueItems[0] || BEST;
  }

  // hard override: (max rating & max trust & min price) from full pool
  if (BEST && finalPool.length > 0) {
    const rMax = Math.max(...finalPool.map((x) => x.rating || 0));
    const tMax = Math.max(...finalPool.map((x) => x.trustScore || 0));
    const pMin = Math.min(...finalPool.map((x) => getItemPrice(x) || Infinity));

    let hardCandidates = finalPool.filter(
      (x) =>
        (x.rating || 0) >= rMax &&
        (x.trustScore || 0) >= tMax &&
        (getItemPrice(x) || Infinity) <= pMin * 1.01
    );

    hardCandidates = __s21_preferNonMismatch(hardCandidates, qStr);

    if (hardCandidates.length) {
      // if multiple, prefer highest relevance penalty first, then commission
      if (qStr) {
        let bestP = -Infinity;
        for (const x of hardCandidates) {
          const p = __s21_bestRelevancePenalty(qStr, x?.title || "")?.penalty ?? 1;
          if (p > bestP) bestP = p;
        }
        const top = hardCandidates.filter(
          (x) => (__s21_bestRelevancePenalty(qStr, x?.title || "")?.penalty ?? 1) >= bestP - 1e-9
        );
        BEST = top.find((x) => (x?.commissionMeta?.platformRate || 0) > 0) || top[0];
      } else {
        BEST =
          hardCandidates.find((x) => (x?.commissionMeta?.platformRate || 0) > 0) || hardCandidates[0];
      }
    }
  }

  const bestRel = BEST && qStr ? _bestRelevancePenalty(qStr, BEST?.title || "") : null;

  // Best'e de meta yaz (UI'da uyarı basmak için)
  if (BEST) {
    try {
      BEST._meta = BEST._meta || {};
      BEST._meta.relevance = bestRel?.rel ?? null;
      BEST._meta.relevancePenalty = bestRel?.penalty ?? null;
      BEST._meta.relevanceFlags = bestRel?.flags ?? null;
    } catch {}
  }

  console.log("🏆 S21 GOD BEST:", {
    title: BEST?.title,
    price: BEST?.price,
    rating: BEST?.rating,
    trustScore: BEST?.trustScore,
    relevance: bestRel?.rel ?? null,
    relPenalty: bestRel?.penalty ?? null,
    relFlags: bestRel?.flags ?? null,
  });

  return {
    BEST,
    bestFinal: BEST,
    globalBest,
    strictBest,
    ordered,
    meta: { minPrice, globalScore, globalBestRel, bestRel },
  };
}

// ---------------------------------------------------------
// 🔥 S100 — Garbage Hard Filter (Fusion → Normalize sonrası)
// ---------------------------------------------------------
function s100_isGarbageItem(item) {
  if (!item) return true;

  const p = item.price ?? item.rawPrice ?? item.finalPrice;
  const provider = String(item.provider || "").toLowerCase();
  const title = String(item.title || "").toLowerCase();

  const hasAnyPrice = p !== null && p !== undefined && p !== 0;
  const hasAnyImage = !!(item.image || item.imageUrl || item.imageProxy);

  if (!hasAnyPrice && !hasAnyImage && (!provider || provider === "unknown")) return true;

  if (!hasAnyPrice && !hasAnyImage && title && !/[0-9]/.test(title) && title.length < 6) return true;

  return false;
}

// ---------------------------------------------------------
// 🧩 Vitrine Context Normalize
// Route bazen 4. parametreye (categoryHint yerine) context objesi yolluyor:
//   { intent, preferredType, clientIp, sessionId, splitUserId, ... }
// ZERO-DELETE: eski imza korunur; burada sadece sağlamlaştırıyoruz.
// ---------------------------------------------------------
function normalizeVitrinContext(categoryHint = null) {
  const ctx = {
    intent: null,
    preferredType: null,
    clientIp: null,
    sessionId: "",
    splitUserId: null,
    splitVariant: null,
  };

  // default categoryHint
  let cat = categoryHint;

  if (categoryHint && typeof categoryHint === "object" && !Array.isArray(categoryHint)) {
    // context fields
    ctx.intent = categoryHint.intent || null;
    ctx.preferredType = categoryHint.preferredType || categoryHint.preferred || null;
    ctx.clientIp = categoryHint.clientIp || categoryHint.ip || null;
    ctx.sessionId = categoryHint.sessionId || categoryHint.session || "";
    ctx.splitUserId = categoryHint.splitUserId || categoryHint.userId || null;
    ctx.splitVariant = categoryHint.splitVariant || null;

    // actual category hint extraction
    cat =
      categoryHint.categoryHint ||
      categoryHint.category ||
      categoryHint.cat ||
      categoryHint.type ||
      categoryHint.preferredType ||
      null;
  }

  if (typeof cat === "string") cat = cat.trim();
  if (!cat || typeof cat !== "string") cat = null;

  return { categoryHint: cat, ctx };
}

// ---------------------------------------------------------
// 🔥 Ana Motor — buildDynamicVitrin
// ---------------------------------------------------------
export async function buildDynamicVitrin(query = "", region = "TR", userId = null, categoryHint = null) {
  // Route bazen categoryHint yerine context objesi gönderiyor → burada normalize ediyoruz.
  const { categoryHint: __catHint, ctx: __ctx } = normalizeVitrinContext(categoryHint);

  const sessionId = String(__ctx?.sessionId || "");
  const splitUserId = __ctx?.splitUserId || null;

  // deterministik split + user memory için tek bir "effective" kimlik
  userId = userId || splitUserId || null;

  // gerçek categoryHint (string) yoksa null'a çek
  categoryHint = __catHint || (typeof categoryHint === "string" ? String(categoryHint).trim() : null);

  const intent = __ctx?.intent || safeDetectIntent(query);
  const categoryKey = String(categoryHint || "any").trim().toLowerCase() || "any";
  const engineVariantKey = __engineVariantKey();
  const busyKey = `${String(query ?? "").trim().toLowerCase()}:${String(intent || "default").trim().toLowerCase()}:${String(region || "global").trim().toLowerCase()}:${categoryKey}:${engineVariantKey}:${userId || sessionId || "anon"}`;

  if (!global.__vitrinBusyMap) global.__vitrinBusyMap = new Map();

  // ==================================================
  // 1) CACHE
  // ==================================================
  const cached = getCachedVitrin(query, region, userId, categoryHint, __engineVariantKey());
  if (cached) {
    console.log("⚡ Cache hit:", query, region, userId || "anon");
    return cached;
  }

  // ==================================================
  // 2) BUSY LOCK
  // ==================================================
  if (global.__vitrinBusyMap.get(busyKey)) {
    return {
      ok: true,
      cached: false,
      pending: true,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      _meta: { warning: "busy_lock" },
    };
  }

  global.__vitrinBusyMap.set(busyKey, true);

  try {
    // ==================================================
    // 3) USER MEMORY
    // ==================================================
    let memory = null;
    let userClicks = 0;

    if (userId) {
      try {
        memory = await getUserMemory(userId);
        userClicks = memory?.clicks || 0;
      } catch (e) {
        console.warn("⚠️ getUserMemory hata:", e.message);
        memory = null;
        userClicks = 0;
      }
    }

    // ==================================================
    // 4) ADAPTER ENGINE
    // ==================================================
    let adapterData = null;
    try {
      // ✅ Route/client kaynak ipucu (text/voice/camera/qr/...) — intent + adapter öncelikleri için
      const srcRaw = String(
        __ctx?.source || __ctx?.querySource || __ctx?.inputSource || ""
      )
        .trim()
        .toLowerCase();

      let source = srcRaw || "text";
      if (["camera", "image", "photo", "vision"].includes(source)) source = "vision";
      if (["qr", "barcode", "ean", "upc"].includes(source)) source = "barcode";

      const visionLabelsClean = Array.isArray(__ctx?.visionLabels)
        ? __ctx.visionLabels
            .filter(Boolean)
            .map((x) => String(x).trim())
            .filter((x) => x)
            .slice(0, 12)
        : [];

      const qrPayload = __ctx?.qrPayload || null;

      adapterData = await runVitrineS40(query, {
        region,
        source,
        visionLabels: visionLabelsClean,
        qrPayload,
        embedding: null,
        userProfile: memory || null,
        categoryHint,

        // ✅ deterministik split seed’i için route’dan gelen değerler
        userId: userId || "",
        sessionId: sessionId || "",
      });
    } catch (err) {
      console.warn("⚠️ runVitrineS40 hata:", err.message);
      return await buildMockVitrin(query, region, userClicks, intent, categoryHint, null);
    }

    if (!adapterData || !adapterData.ok) {
      return await buildMockVitrin(query, region, userClicks, intent, categoryHint, null);
    }

    // ==================================================
    // 5) ITEM HAVUZU
    // ==================================================
    let allItems = Array.isArray(adapterData.items) ? adapterData.items : [];
    if (!allItems.length) {
      allItems = [...asArray(adapterData.best), ...asArray(adapterData.smart), ...asArray(adapterData.others)];
    }

    if (!allItems.length) {
      return await buildMockVitrin(query, region, userClicks, intent, categoryHint, null);
    }

    // ==================================================
    // 6) SANITIZE + META + PERSONALIZATION
    // ==================================================
    // S200 contract: title + url zorunlu (boş item UI'ı kirletmesin)
    const normalizedItems = allItems
      .map((raw) => s21_sanitizeItem(raw))
      .filter((it) => it && it.title && it.url && it.url !== "#");

    if (!normalizedItems.length) {
      return await buildMockVitrin(query, region, userClicks, intent, categoryHint, null);
    }

    const enriched = normalizedItems.map((item) =>
      injectProviderLogo(
        attachMetaScores({
          ...item,
          category: normalizeCategory(item, categoryHint || adapterData.category),
        })
      )
    );

    let memoryProfile = null;
    try {
      if (memory) memoryProfile = buildMemoryProfile(memory);
    } catch {
      memoryProfile = null;
    }

    // finalUserPrice BEST seçiminden önce hazır olmalı (yoksa skor yalan)
    const personalized = enriched.map((it) =>
      attachFinalUserPrice(applyPersonalizationScore(it, memoryProfile), { memoryProfile })
    );

    // ==================================================
    // 7) UNIQUE (2-pass) + FUSION
    // ==================================================
    const primaryUnique = [];
    const seen = new Map();

    for (const it of personalized) {
      if (!it || !it.title) continue;
      const key = `${it.id || it.url || it.title}_${it.provider || "unknown"}`;
      if (!seen.has(key)) {
        seen.set(key, true);
        primaryUnique.push(it);
      }
    }

    // --------------------------------------------------
    // 6.9) S35 EARLY NORMALIZATION (pre-fusion / pre-ultra-dedupe)
    //  - Fiyat parse/geçişi ultra-dedupe öncesi yapılmalı
    //  - PRICE:SANITIZE_FAIL spam’ini ve "₺0" drift’ini azaltır
    // --------------------------------------------------
    let primaryUniqueFixed = primaryUnique;
    try {
      const pre = normalizeAdapterResultsS35(primaryUnique, { query, intent, region, stage: "pre-fusion" });
      if (Array.isArray(pre) && pre.length) primaryUniqueFixed = pre;
    } catch (e) {
      console.warn("⚠️ S35 (fusion öncesi) hata:", e?.message || String(e));
    }

    const finalUnique = [];
    const seenUltra = new Map();

    for (const it of primaryUniqueFixed) {
      const p = getItemPrice(it);
      const pKey = isValidNumber(p) && p > 0 ? Math.round(p) : "na";
      const keyUltra = `${it.provider}_${String(it.title || "").toLowerCase()}_${pKey}`;
      if (!seenUltra.has(keyUltra)) {
        seenUltra.set(keyUltra, true);
        finalUnique.push(it);
      }
    }

    // Fusion groups by normalized title (first 6 tokens)
    const fusionGroups = new Map();

    for (const item of finalUnique) {
      const cleanTitle = String(item.title || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "");

      const fusionKey = cleanTitle
        .replace(/\b(beyaz|siyah|white|black|blue|mavi|kırmızı)\b/g, "")
        .replace(/\b(\d+gb|\d+g|\d+tb)\b/g, "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 6)
        .join(" ");

      if (!fusionGroups.has(fusionKey)) fusionGroups.set(fusionKey, []);
      fusionGroups.get(fusionKey).push({
        ...item,
        fusionSource: item.adapterSource || item.provider || "unknown",
      });
    }

    const fusedItems = [];
    for (const [, group] of fusionGroups.entries()) {
      if (group.length === 1) {
        fusedItems.push(group[0]);
        continue;
      }

      // pick best by user price (or price)
      const bestByPrice = [...group].sort((a, b) => (getItemPrice(a) ?? 999999) - (getItemPrice(b) ?? 999999))[0];

      fusedItems.push(bestByPrice);
    }

    console.log(`🔗 S10.3 Fusion aktif → ${fusedItems.length} ürün grubu`);

    if (!fusedItems.length) {
      if (__allowMockVitrin()) return await buildMockVitrin(query, region, userClicks, intent, categoryHint, memoryProfile);
      return buildEmptyVitrin(query, region, categoryHint, "NO_RESULTS", true, null);
    }

    let uniqueItems = fusedItems;

    // Optional S35 post-fusion normalization
    try {
      uniqueItems = normalizeAdapterResultsS35(uniqueItems, { query, intent, region, stage: "post-fusion" });
    } catch (e) {
      console.warn("⚠️ S35 (fusion sonrası) hata:", e.message);
    }

    // local guard filters (S100 may already run in adapterEngine, still safe)
    uniqueItems = uniqueItems.filter((it) => !s100_isGarbageItem(it));

    uniqueItems = uniqueItems.filter((it) => {
      const t = String(it.title || "").toLowerCase();
      if (t.includes("erişilemedi")) return false;
      if (!it.rating && !it.trustScore && !getItemPrice(it)) return false;
      return true;
    });

    if (!uniqueItems.length) {
      if (__allowMockVitrin()) return await buildMockVitrin(query, region, userClicks, intent, categoryHint, memoryProfile);
      return buildEmptyVitrin(query, region, categoryHint, "NO_RESULTS", true, null);
    }

    // ==================================================
    // 7.6) S200 Scorer + Fusion (deterministic rank + light dedupe)
    // ==================================================
    try {
      const gk = String(
        intent?.group ||
          intent?.preferredType ||
          intent?.type ||
          intent?.category ||
          categoryHint ||
          adapterData?.category ||
          "product"
      )
        .toLowerCase()
        .trim();

      uniqueItems = await scoreAndFuseS200(uniqueItems, { query, group: gk || "product", region });
    } catch (e) {
      console.warn("⚠️ scoreAndFuseS200 hata:", e?.message || String(e));
    }

    // ==================================================
    // 7.7) COMMISSION INJECTION (BEST seçiminden ÖNCE şart)
    // ==================================================
    uniqueItems = applyCommissionLayer(uniqueItems, { query, region, userClicks, userId, sessionId });
    // Komisyon url değiştirdiyse tekrar sanitize edelim (sözleşme garanti)
    uniqueItems = uniqueItems.map((x) => s21_sanitizeItem(x)).filter((x) => x && x.title && x.url && x.url !== "#");
    // finalUserPrice yeniden hesaplanabilir (idempotent)
    uniqueItems = uniqueItems.map((x) => attachFinalUserPrice(x, { memoryProfile }));

    console.log(`📊 ${uniqueItems.length} unique item işleniyor (Kişisel zeka aktif)`);

    // ==================================================
    // 8) MAIN CATEGORY + POOL FILTERING
    // ==================================================
    let mainCategoryRaw = categoryHint || adapterData.category || "general";
    if (typeof mainCategoryRaw === "object" && mainCategoryRaw !== null) {
      mainCategoryRaw =
        mainCategoryRaw.raw ||
        mainCategoryRaw.norm ||
        mainCategoryRaw.category ||
        mainCategoryRaw.type ||
        mainCategoryRaw.name ||
        "general";
    }
    const mainCategory = String(mainCategoryRaw || "general").toLowerCase();

    const pricedItems = uniqueItems.filter((it) => (getItemPrice(it) || 0) > 0);
    const candidates = pricedItems.length > 0 ? pricedItems.slice() : uniqueItems.slice();

    const safePrices = candidates.map((x) => {
      const p = getItemPrice(x);
      return p && isValidNumber(p) ? p : 0;
    });
    const sumPrice = safePrices.reduce((s, p) => s + p, 0);
    const avgPrice = sumPrice / (safePrices.length || 1);

    const filtered = candidates.filter((it) => {
      const qualityOK = (it.qualityScore || 0) >= 0.55;
      const p = getItemPrice(it);
      const basePrice = isValidNumber(p) ? p : Infinity;
      const catKey = String(it.category || mainCategory || "general").toLowerCase();
      const mult = categoryPriceTolerance[catKey] || categoryPriceTolerance.general;
      const priceOK = basePrice <= avgPrice * mult;
      return qualityOK && priceOK;
    });

    let finalPool = filtered.length ? filtered : candidates;

    const intentType = (intent && (intent.type || intent.category)) || mainCategory;
    const isProductIntent = intentType === "product" || ["electronics", "product", "fashion"].includes(mainCategory);

    
if (isProductIntent) {
      // ✅ ÜRÜN ise fiyat zorunlu: fiyat yoksa kart göstermeyiz (alakasız/boş kart yerine)
      const pricedOnly = finalPool.filter((it) => (getItemPrice(it) || 0) > 0);

      if (!pricedOnly.length) {
        // ürün niyeti var ama fiyatlı sonuç yok → boş vitrin (yanlış kart göstermekten iyidir)
        if (__allowMockVitrin()) return await buildMockVitrin(query, region, userClicks, intent, categoryHint, memoryProfile);
        return buildEmptyVitrin(query, region, categoryHint, "NO_PRICED_RESULTS", true, null);
      }

      finalPool = pricedOnly;

      // provider + product-like güçlendirme (varsa)
      const strongPool = finalPool.filter((it) => {
        const cat = String(it.category || mainCategory || "").toLowerCase();
        const hasPrice = (getItemPrice(it) || 0) > 0;
        const hasProvider = !!it.provider && it.provider !== "unknown";
        const isProductLike =
          ["electronics", "product", "fashion"].includes(cat) ||
          ["electronics", "product", "fashion"].includes(mainCategory);
        return hasPrice && hasProvider && isProductLike;
      });

      if (strongPool.length) finalPool = strongPool;
    } else {
      // ✅ HİZMET ise: fiyat opsiyonel ama güven/sağlayıcı skoru zorunlu (yoksa uydurma yok)
      finalPool = finalPool
        .map((it) => {
          try {
            if (!it) return it;
            const out = { ...it };

            // providerScore -> trustScore köprüle (UI trust gösteriyor)
            const ts = typeof out.trustScore === "number" ? out.trustScore : null;
            const ps = typeof out.providerScore === "number" ? out.providerScore : null;

            if (ts == null && ps != null) out.trustScore = Math.min(1, Math.max(0, ps));
            if (ts == null && ps == null) {
              // qualityScore (0..1) veya qualityScore5 (0..5) varsa trust'a çevir
              if (typeof out.qualityScore === "number")
                out.trustScore = Math.min(1, Math.max(0, out.qualityScore));
              else if (typeof out.qualityScore5 === "number")
                out.trustScore = Math.min(1, Math.max(0, out.qualityScore5 / 5));
            }

            return out;
          } catch {
            return it;
          }
        })
        .filter((it) => {
          if (!it) return false;
          const hasPrice = (getItemPrice(it) || 0) > 0;
          const hasTrust = typeof it.trustScore === "number" && it.trustScore > 0;
          const hasRating = typeof it.rating === "number" && it.rating > 0;
          return hasPrice || hasTrust || hasRating;
        });
    }

    // ==================================================
    // 9) BEST SELECTION (S21) (S21)
    // ==================================================
    const groupA = finalPool.filter((it) => (it?.commissionMeta?.platformRate || 0) > 0);
    const groupB = finalPool.filter((it) => (it?.commissionMeta?.platformRate || 0) === 0);

    groupA.sort((a, b) => {
      const sA = computeFinalScore(a) * applyPricePreferenceFactor(a, memory);
      const sB = computeFinalScore(b) * applyPricePreferenceFactor(b, memory);
      return sB - sA;
    });

    groupB.sort((a, b) => {
      const sA = computeFinalScore(a) * applyPricePreferenceFactor(a, memory);
      const sB = computeFinalScore(b) * applyPricePreferenceFactor(b, memory);
      return sB - sA;
    });

    // ✅ query param eklendi (backward compatible)
    const { BEST, bestFinal, globalBest, strictBest, meta: bestMeta } = s21SelectBest(
      finalPool,
      uniqueItems,
      groupA,
      groupB,
      memory,
      query
    );

    if (!bestFinal || !BEST) {
      if (__allowMockVitrin()) return await buildMockVitrin(query, region, userClicks, intent, categoryHint, memoryProfile);
      return buildEmptyVitrin(query, region, categoryHint, "NO_RESULTS", true, null);
    }

    // SMART LIMIT: hiçbir koşulda BEST’i geçemez (komisyon dahil)
    const baseBestScore = bestFinal?.qualityScorePersonal ?? bestFinal?.qualityScore ?? 0.6;
    const BEST_SCORE_LIMIT =
      baseBestScore * ((bestFinal?.commissionMeta?.platformRate || 0) > 0 ? 1.1 : 1);

    // ==================================================
    // 10) SMART / OTHERS
    // ==================================================
    const relatedCategories = resolveRelatedCategories(mainCategory, intent, query);

    function contextSmartBoost(item, queryStr, intentObj) {
      const t = String(item.title || "").toLowerCase();
      const q = String(queryStr || "").toLowerCase();

      if (q.includes("macbook") || q.includes("laptop")) {
        if (t.includes("kılıf") || t.includes("stand") || t.includes("ssd") || t.includes("cooler")) return 1.5;
      }

      if (q.includes("iphone") || q.includes("samsung")) {
        if (t.includes("kılıf") || t.includes("powerbank") || t.includes("cam")) return 1.4;
      }

      if (intentObj?.category === "hotel") {
        if (item.category === "flight") return 1.6;
        if (item.category === "car_rental") return 1.4;
        if (item.category === "tour") return 1.3;
      }

      if (intentObj?.category === "flight") {
        if (item.category === "hotel") return 1.5;
      }

      return 1.0;
    }

    let smartCandidates = uniqueItems.filter((it) => {
      if (!it) return false;
      if (it === BEST) return false;

      if ((BEST.id && it.id === BEST.id) || (BEST.url && it.url === BEST.url) || it.title === BEST.title) return false;

      return relatedCategories.includes(it.category);
    });

    // HARD CAP: smart score BEST’i geçmesin
    smartCandidates = smartCandidates.map((it) => {
      const baseQ = Math.max(it.qualityScorePersonal ?? it.qualityScore ?? 0, 0.3);
      const comm = (it?.commissionMeta?.platformRate || 0) > 0 ? 1.1 : 1;
      const effective = baseQ * comm;

      if (effective > BEST_SCORE_LIMIT) {
        const limited = BEST_SCORE_LIMIT / comm - 0.01;
        return { ...it, qualityScore: limited, qualityScorePersonal: limited };
      }

      return it;
    });

    smartCandidates.sort((a, b) => {
      const boostA = contextSmartBoost(a, query, intent);
      const boostB = contextSmartBoost(b, query, intent);

      const scoreA = (a.qualityScorePersonal || a.qualityScore || 0) * boostA;
      const scoreB = (b.qualityScorePersonal || b.qualityScore || 0) * boostB;

      return scoreB - scoreA;
    });

    if (smartCandidates.length < 4) {
      const extra = uniqueItems
        .filter((it) => !smartCandidates.includes(it) && it !== BEST)
        .sort((a, b) => {
          const qA = a.qualityScorePersonal || a.qualityScore || 0;
          const qB = b.qualityScorePersonal || b.qualityScore || 0;
          return qB - qA;
        });

      smartCandidates = [...smartCandidates, ...extra].slice(0, 4);
    } else {
      smartCandidates = smartCandidates.slice(0, 4);
    }

    // OTHERS: hesaplanır gibi yap (mevcut fonksiyon korunuyor), ama finalde kapalı
    let otherCandidates = uniqueItems.filter((it) => {
      if (!BEST) return false;
      if (it === BEST) return false;
      if (smartCandidates.includes(it)) return false;
      if (it.category !== BEST.category) return false;

      const same = isSameProduct(it, BEST);
      const similar = isSimilarProduct(it, BEST);

      const titleWords = String(BEST.title || "").toLowerCase().split(/\s+/g);
      const itWords = String(it.title || "").toLowerCase().split(/\s+/g);
      const intersect = itWords.filter((w) => titleWords.includes(w)).length;

      if (!same && !similar && intersect < 2) return false;
      return true;
    });

    otherCandidates.sort((a, b) => {
      const qA = a.qualityScorePersonal || a.qualityScore || 0;
      const qB = b.qualityScorePersonal || b.qualityScore || 0;
      return qB - qA;
    });

    otherCandidates = otherCandidates.slice(0, 10);

    otherCandidates = otherCandidates.filter((it) => {
      const pBest = getItemPrice(BEST) || Infinity;
      const pIt = getItemPrice(it) || Infinity;
      const qBest = BEST.qualityScore || 0;
      const qIt = it.qualityScore || 0;

      if (pIt <= pBest) return false;
      if (qIt >= qBest) return false;
      return true;
    });

    // ==================================================
    // 11) COMMISSION + EXPLANATION + FINAL PRICE
    // ==================================================
    // zaten 7.7'de enjekte edildi; burada tekrar çağırmak idempotent (safety)
    const decoratedSmart = applyCommissionLayer([...smartCandidates], { query, region, userClicks, userId, sessionId });
    const decoratedOthers = applyCommissionLayer([...otherCandidates], { query, region, userClicks, userId, sessionId });

    let explainedBest = null;
    let explainedSmart = [];
    let explainedOthers = [];

    try {
      explainedBest = bestFinal
        ? { ...bestFinal, description: buildBestCardExplanation([bestFinal], query, intent) }
        : null;

      explainedSmart = decoratedSmart.map((it) => ({
        ...it,
        description: buildSmartCardExplanation([it], query, intent),
      }));

      explainedOthers = decoratedOthers.map((it) => ({
        ...it,
        description: buildOthersCardExplanation([it], query, intent),
      }));
    } catch (e) {
      console.warn("⚠️ Açıklama hatası:", e.message);
      explainedBest = bestFinal;
      explainedSmart = decoratedSmart;
      explainedOthers = decoratedOthers;
    }

    explainedBest = explainedBest ? attachFinalUserPrice(explainedBest, { memoryProfile }) : null;
    explainedSmart = explainedSmart.map((it) => attachFinalUserPrice(it, { memoryProfile }));
    explainedOthers = explainedOthers.map((it) => attachFinalUserPrice(it, { memoryProfile }));

    // 🔒 OTHERS tamamen KAPALI (UI + engine)
    explainedOthers = [];

    let withBadges = { best: explainedBest, smart: explainedSmart, others: explainedOthers };

    // provider logo inject (again for safety)
    withBadges.best = withBadges.best ? injectProviderLogo(withBadges.best) : null;
    withBadges.smart = Array.isArray(withBadges.smart) ? withBadges.smart.map(injectProviderLogo) : [];
    withBadges.others = Array.isArray(withBadges.others) ? withBadges.others.map(injectProviderLogo) : [];

    if (withBadges.best) withBadges.best.cardType = "main";
    if (Array.isArray(withBadges.smart)) {
      withBadges.smart = withBadges.smart.filter((it) => {
        if (!withBadges.best) return true;
        if (isSameProduct(withBadges.best, it)) return false;
        return true;
      });

      withBadges.smart = withBadges.smart.map((it) => ({ ...it, cardType: "complementary" }));
    }

    try {
      withBadges = decorateWithBadges(withBadges);
    } catch (e) {
      console.warn("⚠️ Rozet ekleme hatası:", e.message);
    }

    try {
      if (withBadges.best?.provider) await recordProviderClick(withBadges.best.provider);
    } catch (e) {
      console.warn("⚠️ recordProviderClick hata:", e.message);
    }

    try {
      if (userId && withBadges.best?.provider) await updateUserMemory(userId, query, withBadges.best.provider);
    } catch (e) {
      console.warn("⚠️ updateUserMemory hata:", e.message);
    }

    // ==================================================
    // 12) FINAL FORMAT + CACHE GUARD
    // ==================================================
    const resultMeta = {
      category: mainCategory,
      totalItems: uniqueItems.length,
      query,
      personalizedProfile: memoryProfile || null,
      sameProductCount: otherCandidates.filter((it) => isSameProduct(it, BEST)).length,
      similarProductCount: otherCandidates.filter((it) => !isSameProduct(it, BEST) && isSimilarProduct(it, BEST)).length,
      sonoAI: {
        autoExplainBest: withBadges.best?.description || null,
        intent,
      },
      s21: {
        globalBestTitle: globalBest?.title || null,
        strictBestTitle: strictBest?.title || null,
        relevance: bestMeta?.bestRel || null,
        globalBestRelevance: bestMeta?.globalBestRel || null,
      },
    };

    const formatted = {
      ok: true,
      query,
      category: mainCategory,
      best: withBadges.best ? { ...withBadges.best } : null,
      best_list: withBadges.best ? [{ ...withBadges.best }] : [],
      smart: Array.isArray(withBadges.smart) ? withBadges.smart : [],
      others: [], // OTHERS KAPALI
      _meta: resultMeta,
    };

    // BEST ↔ BEST_LIST tutarlılığı
    if (!formatted.best && formatted.best_list.length > 0) formatted.best = formatted.best_list[0];
    if (formatted.best && formatted.best_list.length === 0) formatted.best_list = [formatted.best];

    // SMART / OTHERS schema guarantee
    if (!Array.isArray(formatted.smart)) formatted.smart = [];
    if (!Array.isArray(formatted.others)) formatted.others = [];

    // ✅ Boş data cache’lenmesin (senin ekrandaki “cache hit ama boş” olayını keser)
    const hasContent = !!formatted.best || (Array.isArray(formatted.smart) && formatted.smart.length > 0);
    if (hasContent) setCachedVitrin(query, region, userId, formatted, categoryHint, __engineVariantKey());

    return formatted;
  } catch (err) {
    console.error("❌ vitrinEngine hata:", err);
    return {
      ok: false,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      error: err?.message || "engine-failure",
    };
  } finally {
    // 🔓 LOCK HER DURUMDA KAPANIR
    try {
      global.__vitrinBusyMap?.delete?.(busyKey);
    } catch {}
  }
}

// ---------------------------------------------------------
// 🔥 MOCK fallback
// ---------------------------------------------------------

function buildEmptyVitrin(query, region, categoryHint, reason = "NO_RESULTS", ok = true, _error = null) {
  const safeRegion = String(region || "TR").slice(0, 10);
  const category = categoryHint || "product";
  const meta = { source: "empty-product", reason, region: safeRegion, category, engineVariant: __engineVariantKey() };
  if (_error) meta.error = String(_error?.message || _error);
  return {
    ok: !!ok,
    query,
    category,
    best: null,
    best_list: [],
    smart: [],
    others: [],
    _meta: meta,
  };
}

async function buildMockVitrin(query, region, userClicks, intent, categoryHint, memoryProfile = null) {
  if (!__allowMockVitrin()) {
    return buildEmptyVitrin(query, region, categoryHint, "MOCK_BLOCKED", true, null);
  }
  console.warn("⚠️ MOCK vitrin aktif.");

  const safeRegion = String(region || "TR").slice(0, 10);
  const intentTypeRaw = (intent && (intent.finalIntent || intent.type)) || intent || null;
  const intentType = typeof intentTypeRaw === "string" ? intentTypeRaw : null;

  const cat = String(categoryHint || "").toLowerCase();
  const q = String(query || "").toLowerCase();

  const isProductLike =
    intentType === "product" ||
    cat === "product" ||
    cat === "electronics" ||
    /iphone|samsung|xiaomi|macbook|laptop|ps5|playstation|xbox|ekran kartı|kulaklık|tablet|ipad/.test(q);

  // Ürün aramasında “ok:true ama bomboş” UI’ı öldürür.
  // Burada ok:true kalsın (mevcut davranış korunuyor) ama _meta ile açıkça işaretle.
  if (isProductLike) {
    return {
      ok: true,
      query,
      category: categoryHint || "product",
      best: null,
      best_list: [],
      smart: [],
      others: [],
      _meta: {
        source: "empty-product",
        engineVersion: "S21",
        warning: "no_results_product",
        sonoAI: { autoExplainBest: null, intent },
      },
    };
  }

  const mockItemsBase = [
    { id: "mock-1", title: `Otel - ${safeRegion}`, provider: "booking", price: 1800, rating: 4.6, category: "hotel", url: "#" },
    { id: "mock-2", title: "Araç Kiralama", provider: "armut", price: 950, rating: 4.3, category: "car_rental", url: "#" },
    { id: "mock-3", title: "Uçak Bileti", provider: "skyscanner", price: 2100, rating: 4.4, category: "flight", url: "#" },
  ];

  try {
    const mockItems = mockItemsBase.map((x) =>
      attachMetaScores({ ...x, category: normalizeCategory(x, categoryHint) })
    );

    mockItems.sort((a, b) => (a.price || 0) - (b.price || 0));

    const best = mockItems[0];
    const smartRaw = mockItems.slice(1, 3);
    const othersRaw = mockItems.slice(3);

    const allItems = [best, ...smartRaw, ...othersRaw];

    const withCommission = applyCommissionLayer(allItems, { query, region: safeRegion, userClicks });

    const bestFinal = withCommission[0] || best;
    const smartFinal = withCommission.slice(1, 1 + smartRaw.length) || smartRaw;
    const othersFinal = withCommission.slice(1 + smartRaw.length) || othersRaw;

    let explainedBest = null;
    let explainedSmart = [];
    let explainedOthers = [];

    try {
      explainedBest = bestFinal
        ? { ...bestFinal, description: buildBestCardExplanation([bestFinal], query, intent) }
        : null;

      explainedSmart = smartFinal.map((it) => ({
        ...it,
        description: buildSmartCardExplanation([it], query, intent),
      }));

      explainedOthers = othersFinal.map((it) => ({
        ...it,
        description: buildOthersCardExplanation([it], query, intent),
      }));
    } catch (e) {
      console.warn("⚠️ Mock açıklama hatası:", e.message);
      explainedBest = bestFinal;
      explainedSmart = smartFinal;
      explainedOthers = othersFinal;
    }

    explainedBest = explainedBest ? attachFinalUserPrice(explainedBest, { memoryProfile }) : null;
    explainedSmart = explainedSmart.map((it) => attachFinalUserPrice(it, { memoryProfile }));

    // 🔒 OTHERS tamamen KAPALI
    explainedOthers = [];

    let withBadges = { best: explainedBest, smart: explainedSmart, others: explainedOthers };

    try {
      withBadges = decorateWithBadges(withBadges);
    } catch (e) {
      console.warn("⚠️ Mock rozet hatası:", e.message);
    }

    const formatted = {
      ok: true,
      query,
      category: categoryHint || (best ? best.category : "general"),
      best: withBadges.best ? { ...withBadges.best } : null,
      best_list: withBadges.best ? [{ ...withBadges.best }] : [],
      smart: Array.isArray(withBadges.smart) ? withBadges.smart : [],
      others: [],
      _meta: {
        source: "mock",
        engineVersion: "S21",
        sonoAI: { autoExplainBest: withBadges.best?.description || null, intent },
      },
    };

    // Mock cache: sadece içerik varsa
    const hasContent = !!formatted.best || (Array.isArray(formatted.smart) && formatted.smart.length > 0);
    if (hasContent) setCachedVitrin(query, region, null, formatted, categoryHint, __engineVariantKey());

    return formatted;
  } catch (err) {
    console.error("❌ Mock vitrin hatası:", err.message);
    return { ok: false, best: null, best_list: [], smart: [], others: [], error: "Mock vitrin oluşturulamadı" };
  }
}

// ---------------------------------------------------------
// 🔥 SAFE VERSION
// ---------------------------------------------------------
export async function buildDynamicVitrinSafe(query, region = "TR", userId = null, categoryHint = null) {
  try {
    return await buildDynamicVitrin(query, region, userId, categoryHint);
  } catch (err) {
    console.error("❌ buildDynamicVitrinSafe hata:", err.message);

    const intent = safeDetectIntent(query);

    const fallback = await buildMockVitrin(query, region, 0, intent, categoryHint, null);

    return {
      ok: false,
      ...fallback,
      _meta: {
        ...(fallback._meta || {}),
        fallback: "mock",
        error: err?.message,
      },
    };
  }
}
