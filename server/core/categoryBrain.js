
// ===============================
// TEMEL SABİTLER
// ===============================

import fs from "fs";
import path from "path";

const BASE_CATEGORY = "product";

const WEIGHTS = {
  vision: 3,      // görsel sinyali
  query: 2,       // metin sinyali
  provider: 1.5,  // adapter/provider sinyali
};


// ===============================
// QUERY → CATEGORY MAP
// ===============================
const QUERY_MAP = {
  hotel: [
    "otel", "hotel","konaklama","pansiyon","rezervasyon",
    "tatil köyü","resort"
  ],
  flight: [
    "uçak","flight","uçuş","hava yolu","havayolu",
    "th y","thy","pegasus","sunexpress","anadolujet"
  ],
  car_rental: [
    "araç kirala","araba kirala","rent a car","oto kiralama",
    "garenta","circular","avec","enterprise","avis","budget"
  ],
  tour: [
    "tur "," tour","kültür turu","kapadokya","pamukkale",
    "tekne turu","boat tour","cruise","mavi yolculuk"
  ],
  insurance: [
    "sigorta","kasko","trafik sigortası","zorunlu trafik",
    "dask","tamamlayıcı sağlık","tss","özel sağlık",
    "seyahat sigortası"
  ],
  health: [
    "doktor","hastane","tahlil","tetkik","checkup","check-up",
    "mr ","m r ","tomografi","mhrs","enabız"
  ],
  estate: [
    "satılık","kiralık","emlak","konut","daire","arsa",
    "dükkan","ofis","villa","tapu"
  ],
  fashion: [
    "tshirt","tişört","gömlek","ayakkabı","spor ayakkabı",
    "sneaker","çanta","elbise","pantolon","etek","moda"
  ],
  food: [
    "yemek","restoran","paket servis","food","pizza","burger",
    "kebap","lahmacun","eve sipariş"
  ],
  office: [
    "ofis","kırtasiye","printer","yazıcı","fotokopi","toner",
    "kartuş","ofis sandalyesi","masa"
  ],
  motorcycle: [
    "kask","helmet","motor","motosiklet","egzoz","lastik","motorcu"
  ],
  fishing: [
    "olta","misina","makara","balık","zoka","lrf",
    "kamış","olta takımı"
  ],
  electronics: [
    "telefon","iphone","samsung","xiaomi","oppo","huawei",
    "laptop","bilgisayar","kulaklık","airpods","tablet",
    "tv ","televizyon","monitor","monitör"
  ],
  event: [
    "konser","festival","etkinlik","bilet","tiyatro",
    "stand up","stand-up"
  ],
  outdoor: [
    "kamp","çadır","kamp sandalyesi","outdoor","dağcılık",
    "trekking","kamp ocağı"
  ],
  lawyer: [
    "avukat","hukuk","boşanma","icra","tazminat",
    "ceza davası","iş davası","miras davası"
  ],
};

// ===============================
// PROVIDER → CATEGORY
// ===============================
const PROVIDER_KEYWORDS = {
  booking: ["hotel"],
  airbnb: ["hotel"],
  skyscanner: ["flight"],
  kiwik: ["flight"],
  googleplaces: ["location", "hotel", "food"],
  openstreetmap: ["location"],
  trendyol: ["product", "fashion"],
  hepsiburada: ["product", "electronics"],
  amazon: ["product", "electronics"],
  n11: ["product"],
  ciceksepeti: ["product","food"],
  getir: ["food","market"],
  yemeksepeti: ["food","market"],
  migros: ["market"],
  carrefoursa: ["market"],
  a101: ["market"],
  bim: ["market"],
  sok: ["market"],
  ofix: ["office"],
  avansas: ["office"],
  biletix: ["event"],
  passo: ["event"],
  mobilet: ["event"],
  etstur: ["hotel","tour"],
  tatilsepeti: ["hotel","tour"],
  jolly: ["hotel","tour"],
  garenta: ["car_rental"],
  circular: ["car_rental"],
  avec: ["car_rental"],
  enterprise: ["car_rental"],
  avis: ["car_rental"],
  budget: ["car_rental"],
};

// ===============================
// KANONİK MAP
// ===============================
const CANONICAL_MAP = {
  motorcycle: "product",
  fishing: "outdoor",
  outdoor: "product",
  cycling: "outdoor",
};

// ===============================
// Helper
// ===============================
function norm(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ===============================
// VISION
// ===============================
function fromVision(visionLabels = []) {
  const out = {};
  const labels = visionLabels.map((v) => norm(v));

  for (const t of labels) {
    if (t.includes("helmet") || t.includes("motorcycle") || t.includes("bike helmet")) out.motorcycle = true;
    if (t.includes("bike") || t.includes("bicycle")) out.cycling = true;
    if (t.includes("fish") || t.includes("fishing") || t.includes("rod")) out.fishing = true;
    if (t.includes("shoe") || t.includes("sneaker") || t.includes("footwear")) out.fashion = true;
    if (t.includes("food") || t.includes("meal") || t.includes("dish") || t.includes("restaurant")) out.food = true;
    if (t.includes("car")) out.car_rental = true;
    if (t.includes("hotel") || t.includes("bed") || t.includes("room")) out.hotel = true;
    if (t.includes("electronics") || t.includes("phone") || t.includes("laptop")) out.electronics = true;
    if (t.includes("tent") || t.includes("camp")) out.outdoor = true;
  }

  return out;
}

// ===============================
// QUERY
// ===============================
function fromQuery(query = "") {
  const t = norm(query);
  const out = {};

  for (const cat in QUERY_MAP) {
    for (const w of QUERY_MAP[cat]) {
      if (t.includes(w)) out[cat] = true;
    }
  }

  return out;
}

// ===============================
// PROVIDERS
// ===============================
function fromProviders(providers = []) {
  const out = {};
  const provs = providers.map((p) => norm(p));

  for (const p of provs) {
    for (const key in PROVIDER_KEYWORDS) {
      if (p.includes(key)) {
        PROVIDER_KEYWORDS[key].forEach((c) => (out[c] = true));
      }
    }
  }

  return out;
}

// ===============================
// SKOR
// ===============================
function computeScores({ query = "", providers = [], vision = [] }) {
  const q = fromQuery(query);
  const p = fromProviders(providers);
  const v = fromVision(vision);

  const scores = {};

  function add(dict, w) {
    for (const c in dict) scores[c] = (scores[c] || 0) + w;
  }

  const hasVision = Object.keys(v).length > 0;
  const visionWeight = hasVision ? WEIGHTS.vision : WEIGHTS.vision * 0.5;

  add(v, visionWeight);
  add(q, WEIGHTS.query);
  add(p, WEIGHTS.provider);

  scores[BASE_CATEGORY] = (scores[BASE_CATEGORY] || 0) + 0.25;

  const qn = norm(query);
  if (qn.includes("otel") && qn.includes("tur")) {
    if (scores.hotel) scores.hotel += 0.5;
    if (scores.tour) scores.tour += 0.3;
  }

  if (qn.includes("uçak") && qn.includes("otel")) {
    if (scores.flight) scores.flight += 0.4;
  }

  if (qn.includes("avukat") || qn.includes("hukuk")) {
    scores.lawyer = (scores.lawyer || 0) + 1.5;
  }

  return scores;
}

// ===============================
// KANONİKLEŞTİRME
// ===============================
function canonicalizeCategory(catRaw) {
  return CANONICAL_MAP[catRaw] || catRaw;
}

function sanitizeCategory(catRaw) {
  const canonical = canonicalizeCategory(catRaw);

  const allowed = new Set([
    "product","market","fashion","food","office","electronics",
    "location","flight","hotel","car_rental","tour","insurance",
    "health","estate","event","outdoor","lawyer"
  ]);

  return allowed.has(canonical) ? canonical : BASE_CATEGORY;
}

// ===============================
// ORIGINAL S4 FONKSİYON
// ===============================
export function inferCategory({ query = "", providers = [], vision = [] }) {
  const scores = computeScores({ query, providers, vision });
  const entries = Object.entries(scores);

  if (entries.length === 0) return BASE_CATEGORY;

  entries.sort((a, b) => b[1] - a[1]);

  const [bestCat] = entries[0];
  return sanitizeCategory(bestCat);
}

// ===============================
export function inferAllCategories({ query = "", providers = [], vision = [] }) {
  const scores = computeScores({ query, providers, vision });
  const aggregated = {};

  for (const [cat, score] of Object.entries(scores)) {
    const canon = canonicalizeCategory(cat);
    aggregated[canon] = (aggregated[canon] || 0) + score;
  }

  return aggregated;
}

// ------------------------------------------------------------
// ------------------------------------------------------------
// ------------------------------------------------------------
//              ↓↓↓  S12.8 ULTRA-LAYER EK BEYİN  ↓↓↓
// ------------------------------------------------------------
// ------------------------------------------------------------
// ------------------------------------------------------------

// BU NOKTADAN SONRAKİ HER ŞEY SENİN ORİJİNAL DOSYANA EKSTRA GÜÇ KATAN
// S12.8 NÖRAL KATMANLARIDIR. TEK SATIR SİLME YOK. SADECE EKLEME.

// ======================================================================
// YENİ 1 — Embedding similarity layer (opsiyonel)
// ======================================================================
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] ** 2;
    mb += b[i] ** 2;
  }
  const den = Math.sqrt(ma) * Math.sqrt(mb);
  return den ? dot / den : 0;
}

let CATEGORY_EMBEDDINGS = {}; // dışarıdan yüklenebilir

export function setCategoryEmbeddings(map) {
  CATEGORY_EMBEDDINGS = map || {};
}

// ======================================================================
// YENİ 2 — Softmax normalizasyon katmanı
// ======================================================================
function softmax(scores) {
  const max = Math.max(...Object.values(scores));
  const tmp = {};
  let sum = 0;
  for (const k in scores) {
    tmp[k] = Math.exp(scores[k] - max);
    sum += tmp[k];
  }
  const out = {};
  for (const k in tmp) out[k] = tmp[k] / sum;
  return out;
}

// ======================================================================
// YENİ 3 — Confidence engine: 
// düşük eminlikte “product” fallback penalty
// ======================================================================
function applyConfidence(scores) {
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const max = Math.max(...Object.values(scores));
  const confidence = max / total; // 0.25–0.95

  if (confidence < 0.22) {
    scores.product = (scores.product || 0) + 0.5;
  }
  if (confidence < 0.16) {
    scores.product = (scores.product || 0) + 0.5;
  }
  return scores;
}

// ======================================================================
// YENİ 4 — Co-occurrence learning
// ======================================================================
let COOC = {}; // category → diğer kategori → ağırlık

export function learnCooccurrence(catA, catB) {
  if (!catA || !catB || catA === catB) return;
  COOC[catA] = COOC[catA] || {};
  COOC[catB] = COOC[catB] || {};
  COOC[catA][catB] = (COOC[catA][catB] || 0) + 1;
  COOC[catB][catA] = (COOC[catB][catA] || 0) + 1;
}

function applyCooccurrence(scores) {
  for (const c in scores) {
    if (!COOC[c]) continue;
    for (const d in COOC[c]) {
      scores[d] = (scores[d] || 0) + COOC[c][d] * 0.01;
    }
  }
  return scores;
}

// ======================================================================
// YENİ 5 — Full fusion override (S4 → S12.8)
// ======================================================================
export function inferCategoryS12Fusion({ query = "", providers = [], vision = [], embedding = null }) {
  const base = computeScores({ query, providers, vision });

  let fused = { ...base };

  // embedding varsa → embedding similarity boost
  if (embedding && CATEGORY_EMBEDDINGS) {
    for (const cat in CATEGORY_EMBEDDINGS) {
      const sim = cosine(embedding, CATEGORY_EMBEDDINGS[cat]);
      fused[cat] = (fused[cat] || 0) + sim * 3.5;
    }
  }

  fused = applyCooccurrence(fused);
  fused = applyConfidence(fused);

  const probs = softmax(fused);
  const winner = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];

  return sanitizeCategory(winner || BASE_CATEGORY);
}

// ======================================================================
// YENİ 6 — inferAllCategories genişletilmiş
// ======================================================================
export function inferAllCategoriesS12({ query = "", providers = [], vision = [], embedding = null }) {
  const base = computeScores({ query, providers, vision });

  let fused = { ...base };
  if (embedding && CATEGORY_EMBEDDINGS) {
    for (const cat in CATEGORY_EMBEDDINGS) {
      const sim = cosine(embedding, CATEGORY_EMBEDDINGS[cat]);
      fused[cat] = (fused[cat] || 0) + sim * 3.5;
    }
  }

  fused = applyCooccurrence(fused);
  fused = applyConfidence(fused);

  const probs = softmax(fused);

  const out = {};
  for (const c in probs) {
    const canon = canonicalizeCategory(c);
    out[canon] = probs[c];
  }

  return out;
}

export function inferCategoryS100({ query = "", providers = [], vision = [], embedding = null }) {

  // 1) Önce S12 Fusion veya S4 Base (hangisini kullanıyorsan)
  let rawCat = null;

  try {
    rawCat = inferCategoryS12Fusion({ query, providers, vision, embedding });
  } catch {
    rawCat = inferCategory({ query, providers, vision });
  }

  const q = String(query || "").toLowerCase().trim();

  // ------------------------------------------------------------
  // A) Güçlü kategoriler (kesin sinyaller)
  // ------------------------------------------------------------
  const STRONG = ["flight", "hotel", "car_rental", "tour", "lawyer", "estate", "health", "checkup"];

  if (STRONG.includes(rawCat)) {
    return rawCat;
  }

  // ------------------------------------------------------------
  // B) Electronics → Product grubunda kalmalı
  // ------------------------------------------------------------
  if (rawCat === "electronics") {
    return "product";
  }

  // ------------------------------------------------------------
  // C) Food / Grocery yan sinyal → Product’a zorla
  // ------------------------------------------------------------
  const FOOD_HINT = /\b(yemek|pizza|burger|lahmacun|kebap|döner|restoran|cafe)\b/;
  if (rawCat === "food" || rawCat === "grocery") {
    if (!FOOD_HINT.test(q)) return "product";
  }

  // ------------------------------------------------------------
  // D) Office → çok özel bir kategori, varsayılan product
  // ------------------------------------------------------------
  if (rawCat === "office") return "product";

  // ------------------------------------------------------------
  // E) Event → Sadece gerçekten etkinlik varsa kalsın
  // ------------------------------------------------------------
  const EVENT_HINT = /\b(konser|festival|tiyatro|etkinlik|stand ?up|bilet)\b/;
  if (rawCat === "event" && !EVENT_HINT.test(q)) {
    return "product";
  }

  // ------------------------------------------------------------
  // F) Outdoor → Ana kategori değil, product’a katılır
  // ------------------------------------------------------------
  if (rawCat === "outdoor") {
    return "product";
  }

  // ------------------------------------------------------------
  // G) Market → Çok geniş, default product
  // ------------------------------------------------------------
  if (rawCat === "market") {
    return "product";
  }

  // ------------------------------------------------------------
  // H) Fashion → Ürün kategorisi olduğu için product'a bağlanır
  // ------------------------------------------------------------
  if (rawCat === "fashion") {
    return "product";
  }

  // ------------------------------------------------------------
  // I) Location → Asla ana kategori olamaz
  // ------------------------------------------------------------
  if (rawCat === "location") {
    return "product";
  }

  // ------------------------------------------------------------
  // J) Sinyal zayıfsa fallback: PRODUCT
  // ------------------------------------------------------------
  if (!rawCat || rawCat === "" || rawCat === undefined || rawCat === null) {
    return "product";
  }

  // ------------------------------------------------------------
  // K) Son kontrol → Geri kalanlar product'a zorlanır
  // ------------------------------------------------------------
  const ALLOWED = new Set([
    "flight", "hotel", "car_rental", "tour",
    "lawyer", "estate", "health", "checkup",
    "product"
  ]);

  if (!ALLOWED.has(rawCat)) {
    return "product";
  }

  return rawCat;
}



// 2) Alternatif isimli export (import { detectCategoryS100 } ...) için
export const detectCategoryS100 = inferCategoryS100;