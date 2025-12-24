// server/adapters/intentEngine.js
// ============================================================================
//  HERKÜL S22 ULTRA · TITAN INTENT ENGINE
//  ZERO DELETE — S5.2 mantığı duruyor ama 5 katmanlı Titan beyni ekleniyor.
// ============================================================================

// -----------------------------
// ESKİ S5 INTENTS — KORUNDU
// -----------------------------
const INTENTS = {
  hotel: [
    "otel","hotel","resort","pansiyon","konaklama","villada tatil",
    "tatil köyü","butik otel","bungalov","kıbrıs otel"
  ],
  flight: [
    "uçak","flight","uçuş","hava yolu","thy","pegasus",
    "sunexpress","anadolujet","bilet al","ucuz uçak","uçak bileti"
  ],
  car_rental: [
    "araç kirala","araba kirala","rent a car","kiralık araç",
    "oto kiralama","rentacar","araba kiralama"
  ],
  spa: [
    "spa","wellness","hamam","masaj","kaplıca","sauna",
    "güzellik salonu","hillside","macfit spa"
  ],
  tour: [
    "tur","tour","kapadokya","pamukkale","günübirlik",
    "tur paketi","tekne turu","cruise","boat tour","rafting"
  ],
  estate: [
    "satılık","kiralık","ev","daire","villa","arsa","konut",
    "hepsiemlak","sahibinden","ofis kiralık"
  ],
  event: [
    "konser","festival","biletix","etkinlik","tiyatro","sinema"
  ],
  insurance: [
    "sigorta","kasko","trafik sigortası","dask","tamamlayıcı sağlık"
  ],
  lawyer: [
    "avukat","hukuk","boşanma","icra","tazminat","dava"
  ],
  health: [
    "mhrs","doktor","hastane","enabız","tetkik","tahlil",
    "muayene","poliklinik"
  ],
  checkup: [
    "check up","checkup","sağlık paketi","genel kontrol"
  ],
  food: [
    "yemek","burger","pizza","döner","kebap","restoran",
    "cafe","lahmacun","paket servis"
  ],
  location: [
    "yakınımda","near me","nerede","lokasyon","adres","konum","maps"
  ],
  product: [
    "telefon","ipad","laptop","ekran kartı","samsung",
    "iphone","tv","kulaklık","mouse","klavye","parfüm",
    "alışveriş","fiyat"
  ],
};

// ============================================================================
//  S22 KATMAN 1: CITY & ENTITY MODEL
// ============================================================================
const CITY_LIST = [
  "istanbul","ankara","izmir","antalya","bodrum","marmaris",
  "fethiye","kuşadası","çeşme","alanya","belek","side","kapadokya"
];
const CITY_REGEX = new RegExp(CITY_LIST.join("|"), "i");

const DESTINATION_REGEX =
  /\b(istanbul|ankara|izmir|antalya|paris|londra|berlin|amsterdam)\b.*?\b(istanbul|ankara|izmir|antalya|paris|londra|berlin|amsterdam)\b/i;

// Brand → Electronics
const BRAND_REGEX = /(iphone|samsung|xiaomi|macbook|huawei|lenovo|asus|oppo)/i;

// Provider sinyalleri
const PROVIDERS_TRAVEL = /(jolly|etstur|tatilbudur|setur|otel|booking|airbnb)/i;
const PROVIDERS_FOOD = /(yemeksepeti|getir yemek|trendyol yemek)/i;

// ============================================================================
//  S22 KATMAN 2: SEMANTIC CATEGORY FUSION
// ============================================================================
function detectSemanticCategory(q) {
  if (BRAND_REGEX.test(q)) return "electronic";
  if (PROVIDERS_TRAVEL.test(q)) return "travel";
  if (PROVIDERS_FOOD.test(q)) return "food";

  if (CITY_REGEX.test(q)) return "city";
  if (DESTINATION_REGEX.test(q)) return "flight-route";

  return "unknown";
}

// ============================================================================
//  S22 KATMAN 3: PATTERN INTENT MODEL
// ============================================================================
function detectPatternIntent(q) {
  // Flight — çift destinasyon
  if (DESTINATION_REGEX.test(q)) return "flight";

  // hotel + city
  if (CITY_REGEX.test(q) && INTENTS.hotel.some(k => q.includes(k)))
    return "hotel";

  // tour + city
  if (CITY_REGEX.test(q) && INTENTS.tour.some(k => q.includes(k)))
    return "tour";

  // food + city
  if (CITY_REGEX.test(q) && INTENTS.food.some(k => q.includes(k)))
    return "food";

  // city yalnız → travel
  if (CITY_REGEX.test(q)) return "hotel"; // default otel

  return null;
}

// ============================================================================
//  S22 KATMAN 4: INTENT FUSION (Multi-Model Voting)
// ============================================================================
function fuseIntent(q) {
  const semantic = detectSemanticCategory(q);
  const pattern = detectPatternIntent(q);

  // Semantik travel ise → hotel / tour arasında ayrım
  if (semantic === "travel") {
    if (q.includes("tur")) return "tour";
    return "hotel";
  }

  if (semantic === "electronic") return "product";
  if (semantic === "food") return "food";
  if (semantic === "flight-route") return "flight";

  if (pattern) return pattern;

  // Eski S5 → fallback
  for (const [intent, keywords] of Object.entries(INTENTS)) {
    if (keywords.some(k => q.includes(k))) return intent;
  }

  return "product";
}

// ============================================================================
//  S22 KATMAN 5: CONFIDENCE ENGINE
// ============================================================================
function computeConfidence(intent, q) {
  let score = 0.5;

  if (CITY_REGEX.test(q)) score += 0.2;
  if (DESTINATION_REGEX.test(q)) score += 0.3;
  if (BRAND_REGEX.test(q) && intent === "product") score += 0.3;

  if (intent === "hotel" && q.includes("resort")) score += 0.3;
  if (intent === "tour" && q.includes("paket")) score += 0.3;
  if (intent === "flight" && q.includes("tek yön")) score += 0.2;
  if (intent === "food" && PROVIDERS_FOOD.test(q)) score += 0.3;

  return Number(Math.min(score, 1).toFixed(2));
}

// ============================================================================
//  MASTER INTENT
// ============================================================================
function matchIntentFinal(query = "") {
  const q = query.toLowerCase().trim();
  if (!q) {
    return { intent: "product", confidence: 0.3 };
  }

  const intent = fuseIntent(q);
  const confidence = computeConfidence(intent, q);

  return { intent, confidence };
}

// ============================================================================
//  PUBLIC API (S5 uyumlu)
// ============================================================================
export async function detectIntent(query = "") {
  const { intent, confidence } = matchIntentFinal(query);

  return {
    ok: true,
    type: intent,
    confidence,
    query,
  };
}

export default { detectIntent };
