// ======================================================================
//  FAE INTENT ENGINE — S15 COSMIC-NEXUS FINAL MAX VERSION
//  81 IL + 973 ILÇE + GLOBAL ŞEHİR + BRAND + PRODUCT + TRAVEL + FOOD
//  ZERO DELETE · ZERO DRIFT · 25-LAYER HYBRID MODEL
// ======================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname ESM fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JSON’u Node’un kendi fs’iyle kesin yükle
const citiesTR = JSON.parse(
  fs.readFileSync(path.join(__dirname, "trCities.json"), "utf8")
);

// ======================================================================
//  S16 ASTRAL ADDON ENGINE — NON-DESTRUCTIVE LAYER
//  ZERO DELETE · ZERO DRIFT · WORKS ON TOP OF S15 ENGINE
// ======================================================================

// ------------------------------------------------------------
// 1) ASTRAL PHONETIC MAP (TR + EN Mobile Typos)
// ------------------------------------------------------------
const ASTRAL_PHONETIC_MAP = [
  ["ı", "i"], ["ğ", "g"], ["ş", "s"], ["ç", "c"], ["ö", "o"], ["ü", "u"],
  ["aa","a"],["ee","e"],["oo","o"],["ii","i"],
  ["ankra","ankara"],["istnbul","istanbul"],["izmur","izmir"],
  ["trabzn","trabzon"],["antlya","antalya"],["diyerbakir","diyarbakir"],
  ["bdrm","bodrum"],["alcti","alaçatı"],["cesme","çeşme"]
];

// normalize helper
function astralNormalize(text = "") {
  let t = String(text).toLowerCase();
  ASTRAL_PHONETIC_MAP.forEach(([src, dst]) => {
    t = t.replaceAll(src, dst);
  });
  return t;
}


// ------------------------------------------------------------
// 2) ASTRAL SEMANTIC SYNONYMS
// ------------------------------------------------------------
const ASTRAL_SEMANTIC = {
  food: [
    "mekan","kafe","kahvaltı","brunch","steakhouse","tatlıcı","pideci","balıkçı",
    "yeme içme","bar","pub","çorbacı","kebabçı"
  ],
  hotel: ["tatil","kalacak yer","gecelik","oda","residence","konaklama yeri"],
  flight: ["sefer","uçuş bilgisi","hava yolu şirketi","uçuş listesi"],
  product: ["ara","fiyat bak","incele","satın al","ürün bak"]
};


// ------------------------------------------------------------
// 3) ASTRAL LOCATION EXPANSION
// ------------------------------------------------------------
const ASTRAL_REGIONS = [
  "taksim","kadıköy","karaköy","ortaköy","beşiktaş","etiler",
  "alaçatı","çeşme","bodrum","marmaris","fethiye","didim",
  "sapanca","uludağ","erzurum palandöken","antalya lara","antalya konyaaltı"
];


// ------------------------------------------------------------
// 4) ASTRAL BRAND INTELLIGENCE
// ------------------------------------------------------------
const ASTRAL_BRANDS = [
  "iphone","samsung","xiaomi","ps5","playstation","dyson","arçelik","beko",
  "asus","lenovo","oppo","huawei","realme","casper","monster"
];


// ------------------------------------------------------------
// 5) ASTRAL MULTI-INTENT SHADOW LAYER
// ------------------------------------------------------------
// Tek intent döndürür ama gölge katman confidence'e katkı verir.
function astralShadowIntent(query) {
  const q = astralNormalize(query);

  const shadows = [];

  // category hints
  if (ASTRAL_SEMANTIC.food.some(s => q.includes(s))) shadows.push("food");
  if (ASTRAL_SEMANTIC.hotel.some(s => q.includes(s))) shadows.push("hotel");
  if (ASTRAL_SEMANTIC.flight.some(s => q.includes(s))) shadows.push("flight");
  if (ASTRAL_SEMANTIC.product.some(s => q.includes(s))) shadows.push("product");

  if (ASTRAL_REGIONS.some(r => q.includes(r))) shadows.push("hotel","food");
  if (ASTRAL_BRANDS.some(b => q.includes(b))) shadows.push("product");

  return Array.from(new Set(shadows));
}


// ------------------------------------------------------------
// 6) ASTRAL GRAVITY BOOST
// ------------------------------------------------------------
function astralGravity(intent, query) {
  const q = astralNormalize(query);
  let g = 0;

  // Location-based gravity
  if (ASTRAL_REGIONS.some(r => q.includes(r))) {
    if (intent === "hotel") g += 0.08;
    if (intent === "food") g += 0.06;
  }

  // Brand-based gravity
  if (ASTRAL_BRANDS.some(b => q.includes(b))) {
    if (intent === "product") g += 0.12;
  }

  // Semantic gravity
  Object.entries(ASTRAL_SEMANTIC).forEach(([key, arr]) => {
    if (arr.some(x => q.includes(x))) {
      if (intent === key) g += 0.07;
    }
  });

  return g;
}


// ------------------------------------------------------------
// 7) ASTRAL SENTIMENT WEIGHTING
// ------------------------------------------------------------
const ASTRAL_SENTIMENT = {
  hotel: ["kötü otel","iyi otel","güzel otel","harika otel","en iyi otel"],
  food: ["iyi restoran","güzel restoran","kötü restoran","mekan öner","iyi mekan"]
};

function astralSentimentBoost(intent, query) {
  const q = astralNormalize(query);
  let s = 0;

  Object.entries(ASTRAL_SENTIMENT).forEach(([k, arr]) => {
    if (intent === k && arr.some(x => q.includes(x))) {
      s += 0.10;
    }
  });

  return s;
}


// ------------------------------------------------------------
// 8) ASTRAL FUSION — OVERLAY SYSTEM
// ------------------------------------------------------------
// Bu fonksiyon orijinal matchIntent() çıktısını bozmadan güçlendirir.
// ZERO DELETE — sadece ek katman, override yok.

function astralEnhance(intent, query) {
  let bonus = 0;

  // gravity boost
  bonus += astralGravity(intent, query);

  // sentiment boost
  bonus += astralSentimentBoost(intent, query);

  // shadow intent contribution
  const shadows = astralShadowIntent(query);
  if (shadows.includes(intent)) bonus += 0.08;

  return bonus;
}

// ------------------------------------------------------------
// 9) ASTRAL PUBLIC HOOK
// ------------------------------------------------------------
// Orijinal detectIntent fonksiyonuna değmiyoruz.
// Sadece onun döndürdüğü confidence'ı ASTRAL boost ile büyütüyoruz.

export function ASTRAL_enhance_confidence(intent, query, baseScore) {
  const astralBoost = astralEnhance(intent, query);
  return Math.min(1, baseScore + astralBoost);
}

// ==========================
// 0-A) TÜRKİYE İL + İLÇE SETİ — S16 OFFICIAL
// ==========================

// Modern il listesi (JSON'dan)
const CITIES_TR = citiesTR.map((x) => x.il.toLowerCase());

// Modern ilçe listesi (JSON'dan)
const DISTRICTS_TR = Array.from(
  new Set(
    citiesTR.flatMap((x) =>
      x.ilceleri.map((y) => String(y).toLowerCase().trim())
    )
  )
);

// ==========================
// 0-B) LEGACY BLOK — ZERO DELETE
// ==========================
{
  // Eski sabit şehir listesi (kullanılmıyor, ama korunuyor)
  const LEGACY_CITIES_TR = [
    "adana","adiyaman","afyon","agri","amasya","ankara","antalya","artvin",
    "aydin","balikesir","bilecik","bingol","bitlis","bolu","burdur","bursa",
    "canakkale","cankiri","corum","denizli","diyarbakir","edirne","elazig",
    "erzincan","erzurum","eskisehir","gaziantep","giresun","gumushane",
    "hakkari","hatay","igdir","isparta","istanbul","izmir","kahramanmaras",
    "karabuk","karaman","kars","kastamonu","kayseri","kirikkale","kirklareli",
    "kirsehir","kilis","kocaeli","konya","kutahya","malatya","manisa","mardin",
    "mersin","mugla","mus","nevsehir","nigde","ordu","osmaniye","rize",
    "sakarya","samsun","siirt","sinop","sivas","sanliurfa","sirnak",
    "tekirdag","tokat","trabzon","tunceli","usak","van","yalova","yozgat",
    "zonguldak"
  ];

  // Eski ilçe listesi (kullanılmıyor, ama korunuyor)
  const DISTRICTS_TR_LEGACY = citiesTR.flatMap((x) =>
    x.ilceleri.map((y) => String(y).toLowerCase().trim())
  );

  // ZERO DELETE → orijinal mantık korunuyor
}

// ---------------------------------------------------------------
// (ORİJİNAL BLOK — SİLİNMİYOR, SADECE NOT EDİLMİŞ)
// ---------------------------------------------------------------
// // const DISTRICTS_TR = ilceler.map(...)
// // Artık modern DISTRICTS_TR kullanılıyor, bu nedenle LEGACY içine alındı.
// ---------------------------------------------------------------


// ===============================================================
// 1) GLOBAL ŞEHİRLER
// ===============================================================
const GLOBAL_CITIES = [
  "paris",
  "londra",
  "berlin",
  "amsterdam",
  "roma",
  "madrid",
  "new york",
  "moscow",
  "dubai",
  "singapore",
  "vienna",
  "zurich",
  "prague",
  "budapest",
  "doha",
  "bali",
  "tokyo",
  "osaka",
  "seoul",
  "los angeles",
  "san francisco",
  "brussels"
];

// ===============================================================
// 2) ŞEHİR + İLÇE REGEX (FULL POWER, ESCAPE GÜÇLENDİRME)
// ===============================================================
const CITY_REGEX = new RegExp(
  [...CITIES_TR, ...DISTRICTS_TR, ...GLOBAL_CITIES]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // regex escape
    .join("|"),
  "i"
);

// ===============================================================
// 3) INTENT KELİME SETLERİ
// ===============================================================
const INTENTS = {
  hotel: [
    "otel",
    "hotel",
    "resort",
    "pansiyon",
    "konaklama",
    "bungalov",
    "butik otel",
    "villa otel",
    "tatil köyü",
    "spa otel",
    "gecelik",
    "gecelemek",
    "suite",
    "room" // ZERO DELETE: ama aşağıda özel case ile yumuşatılacak
  ],

  flight: [
    "uçak",
    "flight",
    "uçuş",
    "hava yolu",
    "uçak bileti",
    "thy",
    "pegasus",
    "sunexpress",
    "anadolujet",
    "direkt uçuş",
    "aktarmasız",
    "bilet al",
    "airways",
    "airline"
  ],

  car_rental: [
    "araç kirala",
    "rent a car",
    "araba kirala",
    "kiralık araç",
    "oto kiralama",
    "car rental",
    "otomobil kiralama"
  ],

  tour: [
    "tur",
    "tour",
    "tekne turu",
    "günübirlik",
    "excursion",
    "boat tour",
    "rafting",
    "gemi turu",
    "city tour",
    "kapadokya",
    "pamukkale"
  ],

  food: [
    "yemek",
    "burger",
    "pizza",
    "kebap",
    "döner",
    "lahmacun",
    "cafe",
    "restoran",
    "paket servis",
    "fast food"
  ],

  event: [
    "konser",
    "festival",
    "etkinlik",
    "tiyatro",
    "sinema",
    "biletix",
    "biletino",
    "opera",
    "stand up",
    "konser bilet"
  ],

  estate: ["satılık", "kiralık", "ev", "daire", "villa", "arsa", "konut", "emlak", "gayrimenkul"],

  lawyer: [
    "avukat",
    "hukuk",
    "boşanma",
    "icra",
    "tazminat",
    "dava",
    "ceza hukuku",
    "iş hukuku",
    "ticaret hukuku",
    "hukuki danışmanlık"
  ],

  health: [
    "doktor",
    "hastane",
    "klinik",
    "muayene",
    "poliklinik",
    "mhrs",
    "tahlil",
    "tetkik",
    "aile hekimi"
  ],

  product: [
    "telefon",
    "laptop",
    "kulaklık",
    "ipad",
    "samsung",
    "iphone",
    "tv",
    "ekran kartı",
    "klavye",
    "mouse",
    "alışveriş",
    "fiyat",
    "indirim",
    "kargo",
    "amazon",
    "trendyol",
    "hepsiburada",
    "n11",
    "çiçeksepeti",
    "ürün"
  ],

  location: ["yakınımda", "near me", "nerede", "lokasyon", "adres", "konum", "harita", "map"]
};

// ===============================================================
// S200/S300 — EXTRA INTENTS PATCH (sigorta / psikolog vb.)
// (Sözleşme: intent → group mapping tek beyin)
// ===============================================================

// health'e servis anahtarları ekle (psikolog, terapist vs)
try {
  if (Array.isArray(INTENTS.health)) {
    const extraHealth = [
      "psikolog",
      "psikiyatrist",
      "terapist",
      "terapi",
      "diyetisyen",
      "fizyoterapist",
      "diş",
      "dişçi",
      "randevu",
      "online terapi",
    ];
    for (const k of extraHealth) {
      if (!INTENTS.health.includes(k)) INTENTS.health.push(k);
    }
  }
} catch {}

// insurance intent (sigorta) — product'a düşmesin
try {
  if (!INTENTS.insurance) {
    INTENTS.insurance = [
      "sigorta",
      "kasko",
      "dask",
      "trafik sigortası",
      "tamamlayıcı sağlık",
      "özel sağlık sigortası",
      "hayat sigortası",
      "konut sigortası",
      "poliçe",
      "acente",
      "sigortam",
    ];
  }
} catch {}


// INTENTS helper — hotel için "room" kelimesini tek başına sayma
function intentHasKeyword(intentKey, query) {
  const keys = INTENTS[intentKey] || [];
  return keys.some((k) => {
    if (intentKey === "hotel" && k === "room") {
      // "room" tek başına sinyal sayılmıyor
      return false;
    }
    return query.includes(k);
  });
}

// ===============================================================
// 4) REGEX MODELLERİ
// ===============================================================
const DESTINATION_REGEX =
  /\b([a-zğüşöç ]+)\s*(→|-|den|dan|from|to|->|=>|⇒)\s*([a-zğüşöç ]+)\b/i;

const BRAND_REGEX =
  /(iphone|samsung|xiaomi|macbook|huawei|lenovo|asus|oppo|ps5|airpods|playstation|dyson)/i;

// ===============================================================
// S100 — HARD PRODUCT OVERRIDE (FIXED VERSION)
// ===============================================================
const HARD_PRODUCT_KEYWORDS = [
  "iphone",
  "ipad",
  "macbook",
  "airpods",
  "galaxy",
  "note",
  "pixel",
  "playstation",
  "ps5",
  "xbox",
  "dyson",
  "robot süpürge",
  "kulaklık",
  "monitor",
  "ekran kartı",
];

// ===============================================================
// BRAND + CITY COLLISION FIX — CRITICAL
// ===============================================================
function hardCityBrandFix(query) {
  const q = String(query || "").toLowerCase();

  if (!(BRAND_REGEX.test(q) && CITY_REGEX.test(q))) return null;

  // Ürün bağlamı → product
  if (
    /(fiyat|alışveriş|satın al|urun|ürün|karşılaştır|karşılaştırma)/.test(q)
  ) {
    return "product";
  }

  // Hotel bağlamı
  if (/(otel|hotel|tatil|gecelik|pansiyon|resort)/.test(q)) {
    return "hotel";
  }

  // Tour bağlamı
  if (/(tur|excursion|boat tour|tekne|tekne turu)/.test(q)) {
    return "tour";
  }

  return null;
}

function forceProductIntent(query, baseIntent) {
  const q = String(query || "").toLowerCase();

  // 0 — Product ise dokunma
  if (baseIntent === "product") return "product";

  // Brand + travel kelimesi → product'a zorlanmaz
  if (BRAND_REGEX.test(q) && /(otel|hotel|tatil|gecelik|pansiyon)/.test(q)) {
    return baseIntent;
  }

  // 1 — Brand → ürün
  if (BRAND_REGEX.test(q)) return "product";

  // 2 — Sert kelime listesi
  if (HARD_PRODUCT_KEYWORDS.some((k) => q.includes(k))) {
    return "product";
  }

  // 3 — Model tespiti
  const modelNumber = /\b(11|12|13|14|15|16)\b/.test(q);
  const seriesHint = /(pro\s*max|promax|pro|max|mini|plus)/.test(q);
  const hasStorage = /\b(64\s?gb|128\s?gb|256\s?gb|512\s?gb|1\s?tb)\b/.test(q);

  if (modelNumber && BRAND_REGEX.test(q)) return "product";
  if (modelNumber && seriesHint) return "product";
  if (modelNumber && hasStorage) return "product";

  return baseIntent;
}

const EMOJI_FOOD = /🍔|🍕|🍟|🍣|🥩|🌮|🍜|🍝|🥗/;
const EMOJI_TRAVEL = /✈️|🛫|🛬|🏨|🌍|🗺️/;

// ===============================================================
// 5) STOPWORDS
// ===============================================================
const STOPWORDS = [
  "en iyi",
  "en ucuz",
  "yakın",
  "iyi",
  "uygun",
  "nerede",
  "hangi",
  "fiyat",
  "şöyle",
  "şuraya",
  "lazım",
  "acil",
  "bana",
  "iste",
  "bi"
];

// ===============================================================
// 6) CLEAN QUERY
// ===============================================================
function cleanQuery(q) {
  let t = String(q || "").toLowerCase();
  STOPWORDS.forEach((sw) => {
    t = t.replace(sw, "");
  });
  return t.replace(/\s+/g, " ").trim();
}

function detectCity(q) {
  const text = String(q || "").toLowerCase();

  // 1) Önce büyük şehir → en güçlü sinyal
  for (const c of CITIES_TR) {
    if (text.includes(c)) return c;
  }

  // 2) Sonra ilçe → daha lokal sinyal
  for (const d of DISTRICTS_TR) {
    if (text.includes(d)) return d;
  }

  // 3) Global şehirler
  for (const g of GLOBAL_CITIES) {
    if (text.includes(g)) return g;
  }

  return null;
}


// ===============================================================
// 8) TOKEN DENSITY
// ===============================================================
function neuralDensity(q) {
  const words = String(q || "")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return 0;
  return Math.min(1, words.length / 12);
}

// ===============================================================
// 9) DESTINATION GRAVITY
// ===============================================================
function destinationGravity(q) {
  return DESTINATION_REGEX.test(String(q || "").toLowerCase()) ? 0.25 : 0;
}

// ===============================================================
// 10) DOMAIN INTENT
// ===============================================================
function domainIntent(q) {
  const t = String(q || "").toLowerCase();
  if (t.includes("booking.com")) return "hotel";
  if (t.includes("airbnb")) return "hotel";
  if (t.includes("skyscanner")) return "flight";
  if (t.includes("biletix") || t.includes("biletino")) return "event";
  if (t.includes("trendyol") || t.includes("hepsiburada") || t.includes("amazon"))
    return "product";
  if (/(sigorta|kasko|dask|trafik sigort|poliçe|sigortam)/.test(t)) return "insurance";
  return null;
}

// ===============================================================
// 11) AMBIGUITY FIXER
// ===============================================================
function resolveAmbiguity(intent, q) {
  const t = String(q || "").toLowerCase();
  if (intent === "hotel" && t.includes("uçak")) return "flight";
  if (intent === "product" && t.includes("otel")) return "hotel";
  if (intent === "location" && t.includes("restoran")) return "food";
  return intent;
}

// ===============================================================
// S100 AMBIGUITY FIX (GLOBAL HELPER)
// ===============================================================
function fixProductAmbiguity(intent, q) {
  const text = String(q || "").toLowerCase().trim();

  if (intent === "product" && /(otel|hotel|tatil|pansiyon)/.test(text)) {
    return "hotel";
  }
  if (intent === "product" && /(kapadokya|bodrum|marmaris|fethiye)/.test(text)) {
    return "hotel";
  }

  // ✅ Education guard: "ingilizce kursu" gibi aramalar product'a düşmesin
  if (intent === "product" && /(kurs|kursu|course|lesson|eğitim|egitim|ders|bootcamp|sertifika|udemy|coursera)/.test(text)) {
    return "education";
  }

  return intent;
}

// ===============================================================
// S100 — DEVICE MODEL FORCE MAP
// ===============================================================
const DEVICE_MODEL_PATTERNS = [
  /\biphone\s*\d{1,2}\s*(pro\s*max|promax|pro|max)?\b/i,
  /\biphone\s*(pro\s*max|promax|pro|max)\b/i,
  /\bgalaxy\s*s\d{1,2}\s*(ultra|plus)?\b/i,
  /\bs\d{2}\s*ultra\b/i,
  /\bmacbook\s*(air|pro)?\b/i,
  /\b(ps5|playstation 5)\b/i,
  /\b(xbox\s*series\s*(x|s))\b/i,
];

function forceDeviceProductIntent(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return false;

  // Marka ismi varsa zaten %99 ürün
  if (BRAND_REGEX.test(q)) return true;

  // Model pattern’lerinden biri tutuyorsa kesin ürün
  return DEVICE_MODEL_PATTERNS.some((re) => re.test(q));
}

// ===============================================================
// 12) INTENT CORE — S15 MULTI-LAYER
// ===============================================================
function matchIntent(input) {
  const raw = String(input || "").toLowerCase().trim();
  const query = cleanQuery(raw);

  // BRAND + CITY çakışma düzeltmesi
  const bc = hardCityBrandFix(raw);
  if (bc) return bc;

  // S100 — Cihaz model pattern’leri → ZORUNLU product
  if (forceDeviceProductIntent(raw)) {
    return "product";
  }

  // Rota → flight
  if (DESTINATION_REGEX.test(raw)) return "flight";

  // Şehir / ilçe
  const city = detectCity(raw);
  if (city) {
    if (intentHasKeyword("food", query)) return "food";
    if (intentHasKeyword("hotel", query)) return "hotel";
    if (intentHasKeyword("tour", query)) return "tour";
    // şehir var ama anahtar yoksa default: hotel
    return "hotel";
  }

  // domain → direkt
  const dom = domainIntent(raw);
  if (dom) return dom;

  // emoji shortcut
  if (EMOJI_FOOD.test(raw)) return "food";
  if (EMOJI_TRAVEL.test(raw)) return "hotel";

  // brand
  if (BRAND_REGEX.test(query)) return "product";

  // keyword setleri
  for (const [intent, keys] of Object.entries(INTENTS)) {
    const hit = keys.some((k) => {
      if (intent === "hotel" && k === "room") {
        // "room" tek başına sinyal sayılmıyor
        return false;
      }
      return query.includes(k);
    });

    if (hit) {
      return resolveAmbiguity(intent, raw);
    }
  }

  // Son çare: yine product
  return "product";
}

// ===============================================================
// 13) CONFIDENCE SCORE
// ===============================================================
function scoreConfidence(query, intent) {
  const q = String(query || "").toLowerCase();
  let score = 0.35;

  if (INTENTS[intent]) {
    INTENTS[intent].forEach((k) => {
      if (intent === "hotel" && k === "room") {
        return; // "room" sinyaline ekstra skor verme
      }
      if (q.includes(k)) score += 0.07;
    });
  }

  if (detectCity(q)) score += 0.12;
  if (BRAND_REGEX.test(q)) score += 0.12;

  score += neuralDensity(q) * 0.15;
  score += destinationGravity(q);

  if (EMOJI_FOOD.test(q) && intent === "food") score += 0.2;
  if (EMOJI_TRAVEL.test(q) && (intent === "hotel" || intent === "flight"))
    score += 0.18;

  return Math.min(1, score);
}

// ===============================================================
// 15) S17 NEBULA — CONTEXT-ROUTE INTENT LAYER
// ===============================================================
function buildContextSnapshot(query) {
  const q = String(query || "").toLowerCase().trim();
  const city = detectCity(q);
  const hasBrand = BRAND_REGEX.test(q);
  const hasRoute = DESTINATION_REGEX.test(q);
  const tokens = q.split(/\s+/).filter(Boolean);

  const buckets = {};
  for (const [intent, keys] of Object.entries(INTENTS)) {
    buckets[intent] = keys.some((k) => {
      if (intent === "hotel" && k === "room") return false;
      return q.includes(k);
    });
  }

  return {
    raw: q,
    city,
    hasBrand,
    hasRoute,
    tokens,
    length: tokens.length,
    buckets
  };
}

function nebulaRouteIntent(ctx) {
  if (!ctx) {
    return { route: null, domain: null, tags: [] };
  }

  const { raw, city, hasRoute, buckets } = ctx;
  const tags = [];

  let domain = null;
  if (buckets.hotel || buckets.tour || buckets.flight) domain = "travel";
  else if (buckets.product) domain = "commerce";
  else if (buckets.lawyer) domain = "legal";
  else if (buckets.health) domain = "health";
  else if (buckets.food) domain = "food";
  else if (buckets.estate) domain = "estate";

  if (hasRoute) tags.push("route");
  if (city) tags.push(`city:${city}`);
  if (ctx.hasBrand) tags.push("brand-query");

  if (raw.includes("yakınımda") || raw.includes("near me")) {
    tags.push("nearby");
  }

  const route = hasRoute ? "point-to-point" : city ? "single-city" : null;

  return {
    route,
    domain,
    tags: Array.from(new Set(tags))
  };
}

// ===============================================================
// 16) S18 OMNI-VECTOR — MULTI-TOPIC BLENDING
// ===============================================================
function omniVectorBlend(query) {
  const q = String(query || "").toLowerCase();
  const weights = {};
  let total = 0;

  for (const [intent, keys] of Object.entries(INTENTS)) {
    let w = 0;
    keys.forEach((k) => {
      if (intent === "hotel" && k === "room") return;
      if (q.includes(k)) w += 1;
    });
    if (w > 0) {
      weights[intent] = w;
      total += w;
    }
  }

  if (total === 0) {
    return {
      primary: null,
      vector: {},
      entropy: 0
    };
  }

  const vector = {};
  Object.entries(weights).forEach(([intent, w]) => {
    vector[intent] = w / total;
  });

  let primary = null;
  let maxVal = -Infinity;
  Object.entries(vector).forEach(([intent, v]) => {
    if (v > maxVal) {
      maxVal = v;
      primary = intent;
    }
  });

  let entropy = 0;
  Object.values(vector).forEach((p) => {
    if (!p) return;
    entropy += -p * Math.log(p);
  });

  return {
    primary,
    vector,
    entropy
  };
}

// ===============================================================
// 17) S19 QUANTUM-CHAIN — MULTI-INTENT → VITRIN PIPELINE
// ===============================================================
function quantumChain(baseIntent, omni, nebulaInfo) {
  const chains = [];
  const reasons = [];

  if (!omni || !nebulaInfo) {
    if (baseIntent) {
      chains.push(`${baseIntent}_default`);
      reasons.push("fallback: base intent only");
    }
    return { chains: Array.from(new Set(chains)), reasons };
  }

  const vector = omni.vector || {};
  const domain = nebulaInfo.domain;

  if (domain === "travel") {
    if (vector.hotel && vector.hotel >= 0.25) {
      chains.push("travel_hotel");
      reasons.push("travel domain + hotel vector");
    }
    if (vector.flight && vector.flight >= 0.25) {
      chains.push("travel_flight");
      reasons.push("travel domain + flight vector");
    }
    if (vector.tour && vector.tour >= 0.2) {
      chains.push("travel_tour");
      reasons.push("travel domain + tour vector");
    }
  }

  if (vector.product && vector.product >= 0.3) {
    chains.push("commerce_product");
    reasons.push("strong product vector");
  }

  if (vector.food && vector.food >= 0.3) {
    chains.push("food_venue");
    reasons.push("strong food vector");
  }

  if (domain === "legal") {
    chains.push("legal_lawyer");
    reasons.push("legal domain");
  }

  if (domain === "health") {
    chains.push("health_doctor");
    reasons.push("health domain");
  }

  if (domain === "estate") {
    chains.push("estate_property");
    reasons.push("estate domain");
  }

  if (!chains.length && baseIntent) {
    chains.push(`${baseIntent}_default`);
    reasons.push("fallback from base intent");
  }

  return {
    chains: Array.from(new Set(chains)),
    reasons
  };
}

// ===============================================================
// 18) S20 ASTROPREDICT — LLM-SİZ PREDICTION ENGINE
// ===============================================================
function astroPredict(query, ctx, omni) {
  const q = String(query || "").toLowerCase().trim();
  const tokens = (ctx && ctx.tokens) || q.split(/\s+/).filter(Boolean);

  let mode = "search";
  if (q.startsWith("nedir") || q.includes("ne demek") || q.includes("açıklama")) {
    mode = "explain";
  } else if (q.endsWith("?") || q.includes(" mi ") || q.includes(" mı ")) {
    mode = "qa";
  }

  let urgency = 0;
  if (q.includes("acil") || q.includes("hemen") || q.includes("bugün")) urgency += 0.6;
  if (q.includes("şimdi") || q.includes("en kısa") || q.includes("acilen")) urgency += 0.3;
  urgency = Math.min(1, urgency);

  let priceFocus = 0.5;
  if (
    q.includes("en ucuz") ||
    q.includes("ucuz") ||
    q.includes("fiyat karşılaştır") ||
    q.includes("fiyat karşılaştırma") ||
    q.includes("karşılaştır")
  ) {
    priceFocus = 0.9;
  } else if (
    q.includes("lüks") ||
    q.includes("en iyi") ||
    q.includes("premium") ||
    q.includes("vip")
  ) {
    priceFocus = 0.2;
  }

  const vector = omni && omni.vector ? omni.vector : {};
  const isMultiTopic =
    omni && omni.entropy > 0.15 && Object.keys(vector).length > 1;

  return {
    mode,
    urgency,
    priceFocus,
    isMultiTopic,
    tokenCount: tokens.length
  };
}

// ===============================================================
// 19) S21 CITY-BRAIN — ŞEHİR / BÖLGE PROFİLİ
// ===============================================================
function cityBrainLayer(query, ctx, nebulaInfo) {
  const q = String(query || "").toLowerCase();
  const city = (ctx && ctx.city) || detectCity(q);

  const hasRegionHint = ASTRAL_REGIONS.some((r) => q.includes(r));
  const domain = nebulaInfo ? nebulaInfo.domain : null;

  let cityType = null;
  if (!city && !hasRegionHint) {
    cityType = null;
  } else if (q.includes("merkez") || q.includes("downtown")) {
    cityType = "central";
  } else if (q.includes("sahil") || q.includes("plaj") || q.includes("beach")) {
    cityType = "coastal";
  } else if (q.includes("dağ") || q.includes("kayak") || q.includes("pist")) {
    cityType = "mountain";
  } else {
    cityType = "generic";
  }

  const travelBias =
    domain === "travel" || hasRegionHint || /otel|hotel|tatil|tur/.test(q);

  return {
    city: city,
    cityType,
    hasRegionHint,
    travelBias
  };
}

// ===============================================================
// 20) S22 POI & VENUE CLASSIFIER
// ===============================================================
const POI_KEYWORDS = {
  beach: ["plaj", "beach club", "kumsal", "deniz kenarı"],
  cafe: ["kafe", "kahve", "coffee shop", "3. nesil kahve", "starbucks"],
  bar: ["bar", "pub", "bira", "cocktail", "kokteyl", "meyhane"],
  spa: ["spa", "hamam", "masaj", "wellness", "termal", "kaplıca"],
  adventure: ["atv", "safari", "rafting", "zipline", "doğa yürüyüşü", "trekking"]
};

function poiVenueClassifier(query, ctx, nebulaInfo, omni) {
  const q = String(query || "").toLowerCase();
  const hits = [];
  Object.entries(POI_KEYWORDS).forEach(([key, arr]) => {
    if (arr.some((k) => q.includes(k))) hits.push(key);
  });

  const domain = nebulaInfo ? nebulaInfo.domain : null;
  const isTravelish = domain === "travel" || (omni && omni.vector && omni.vector.hotel);

  return {
    poiTags: Array.from(new Set(hits)),
    isTravelish
  };
}

// ===============================================================
// 21) S23 COMMERCE-DEEP — PRODUCT ALT KATEGORİLERİ
// ===============================================================
const COMMERCE_FAMILIES = {
  electronics: [
    "telefon",
    "iphone",
    "samsung",
    "laptop",
    "macbook",
    "ekran kartı",
    "monitor",
    "kulaklık",
    "ps5",
    "playstation",
    "xbox",
    "mouse",
    "klavye",
    "tablet",
    "ipad"
  ],
  fashion: [
    "elbise",
    "ayakkabı",
    "sneaker",
    "gömlek",
    "pantolon",
    "çanta",
    "mont",
    "ceket",
    "tshirt",
    "etek"
  ],
  home: [
    "koltuk",
    "yatak",
    "dolap",
    "masa",
    "sandalyе",
    "perde",
    "halı",
    "battaniye",
    "mutfak seti"
  ],
  market: [
    "market alışverişi",
    "gıda",
    "süt",
    "peynir",
    "ekmek",
    "yağ",
    "şeker",
    "kahve",
    "çay"
  ],
  beauty: [
    "parfüm",
    "makyaj",
    "fondöten",
    "rimel",
    "ruj",
    "cilt bakımı",
    "krem",
    "şampuan"
  ]
};

function commerceDeepClassifier(query) {
  const q = String(query || "").toLowerCase();
  const matches = [];
  Object.entries(COMMERCE_FAMILIES).forEach(([family, arr]) => {
    if (arr.some((k) => q.includes(k))) {
      matches.push(family);
    }
  });

  const primary = matches[0] || null;
  return {
    primary,
    families: Array.from(new Set(matches))
  };
}

// ===============================================================
// 22) S24 QUALITY-GUARD — LOW / HIGH SIGNAL TESPİTİ
// ===============================================================
function qualityGuard(query, intent, omni) {
  const q = String(query || "").toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const len = tokens.length;

  let level = "normal";
  const reasons = [];

  if (len <= 1) {
    level = "low";
    reasons.push("too_few_tokens");
  }
  if (len > 18) {
    level = "noisy";
    reasons.push("too_many_tokens");
  }

  if (omni && omni.entropy > 0.8) {
    level = "ambiguous";
    reasons.push("high_entropy_multi_topic");
  }

  if (!/[a-zğüşöçıö]/.test(q)) {
    level = "low";
    reasons.push("no_alpha_content");
  }

  if (!intent) {
    level = "low";
    reasons.push("no_intent_detected");
  }

  return {
    level,
    reasons: Array.from(new Set(reasons)),
    tokenCount: len
  };
}

// ===============================================================
// 23) S25 CONSENSUS — ÖZET KARAR KATI
// ===============================================================
function consensusSummary(payload) {
  const {
    intent,
    baseScore,
    astralScore,
    nebula,
    omni,
    astro,
    cityBrain,
    poi,
    commerce,
    quality
  } = payload;

  const flags = [];

  if (nebula && nebula.domain) flags.push(`domain:${nebula.domain}`);
  if (nebula && nebula.route) flags.push(`route:${nebula.route}`);
  if (astro && astro.mode) flags.push(`mode:${astro.mode}`);
  if (cityBrain && cityBrain.travelBias) flags.push("travel-bias");
  if (poi && poi.poiTags && poi.poiTags.length) {
    poi.poiTags.forEach((t) => flags.push(`poi:${t}`));
  }
  if (commerce && commerce.primary) {
    flags.push(`commerce:${commerce.primary}`);
  }
  if (quality && quality.level) {
    flags.push(`quality:${quality.level}`);
  }

  const finalScore = astralScore;
  const confidenceBand =
    finalScore >= 0.8 ? "high" : finalScore >= 0.55 ? "medium" : "low";

  return {
    intent,
    finalScore,
    confidenceBand,
    flags: Array.from(new Set(flags))
  };
}

// ===============================================================
// 24) S25 COSMIC INTENT ENGINE — INTERNAL CORE
// ===============================================================
async function baseDetectIntent(query = "") {
  // S15 çekirdeği
  const rawIntent = matchIntent(query);

  // S100: ürün lehine zorunlu düzeltme (force)
  const forcedIntent = forceProductIntent(query, rawIntent);

  // S100 Ambiguity Fix (otel/tur bağlamında yanlış product override'ını geri al)
  const intent = fixProductAmbiguity(forcedIntent, query);

  // S15 confidence
  const baseScore = scoreConfidence(query, intent);

  // S16 astral boost
  const astralScore = ASTRAL_enhance_confidence(intent, query, baseScore);

  // S17–S25 katmanları
  const contextSnapshot = buildContextSnapshot(query);         // S17
  const nebula = nebulaRouteIntent(contextSnapshot);           // S17
  const omni = omniVectorBlend(query);                         // S18
  const quantum = quantumChain(intent, omni, nebula);          // S19
  const astro = astroPredict(query, contextSnapshot, omni);    // S20
  const cityBrain = cityBrainLayer(query, contextSnapshot, nebula); // S21
  const poi = poiVenueClassifier(query, contextSnapshot, nebula, omni); // S22
  const commerce = commerceDeepClassifier(query);              // S23
  const quality = qualityGuard(query, intent, omni);           // S24

  const consensus = consensusSummary({
    intent,
    baseScore,
    astralScore,
    nebula,
    omni,
    astro,
    cityBrain,
    poi,
    commerce,
    quality
  });                                                          // S25

  return {
    ok: true,
    type: intent,
    confidence: astralScore,

    query,
    engine: "FAE-S25-COSMIC",

    baseConfidence: baseScore,
    astralConfidence: astralScore,

    nebulaContext: nebula,
    omniVector: omni,
    quantumChain: quantum,
    astroPredict: astro,
    cityBrain,
    poi,
    commerce,
    quality,
    consensus
  };
}


// ======================================================================
//  S26–S30 TITAN FUSION LAYER
//  ZERO DELETE · ZERO DRIFT · NEURAL SCORER + PROFILE + PERSONA ROUTING
// ======================================================================

// 1) INTENTS SAFE MAP (Override yok, sadece birleşik gölge katman)
const INTENTS_SAFE = (() => {
  const base = typeof INTENTS !== "undefined" ? INTENTS : {};
  try {
    return JSON.parse(JSON.stringify(base));
  } catch {
    return base || {};
  }
})();

// 2) Titan Confidence Normalizer
function titanNormalizeScore(x) {
  if (x == null || Number.isNaN(Number(x))) return 0.0;
  return Math.max(0, Math.min(1, Number(x)));
}

// ======================================================================
//  S27 — LLM-free Neural Scorer
//  • Gerçek NN yok; ama NN tarzı feature weight + logistic scoring
// ======================================================================
function titanBuildNeuralFeatures(query, finalIntent, basePayload) {
  const q = String(query || "").toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const len = tokens.length;

  const hasCity =
    !!(basePayload && basePayload.nebulaContext && basePayload.nebulaContext.city);
  const baseScore = titanNormalizeScore(basePayload?.baseConfidence);
  const astral = titanNormalizeScore(basePayload?.astralConfidence);
  const consensusScore = titanNormalizeScore(basePayload?.consensus?.finalScore);

  const entropy = basePayload?.omniVector?.entropy ?? 0;
  const multiTopic = basePayload?.omniVector?.vector
    ? Object.keys(basePayload.omniVector.vector).length > 1
    : false;

  const qualityLevel = basePayload?.quality?.level || "normal";
  const qualityPenalty =
    qualityLevel === "low"
      ? -0.25
      : qualityLevel === "noisy"
      ? -0.18
      : qualityLevel === "ambiguous"
      ? -0.12
      : 0;

  const features = {
    tokenCount: len,
    hasCity,
    baseScore,
    astral,
    consensusScore,
    entropy,
    multiTopic,
    qualityLevel,
    qualityPenalty,
  };

  return features;
}

function titanNeuralScore(query, finalIntent, basePayload) {
  const f = titanBuildNeuralFeatures(query, finalIntent, basePayload);

  // “Fake NN” — lineer kombinasyon + sigmoid
  let z = 0;

  z += f.baseScore * 1.2;
  z += f.astral * 1.0;
  z += f.consensusScore * 0.8;

  if (f.hasCity) z += 0.25;

  // Orta uzunluk (3–10 token) bonus
  if (f.tokenCount >= 3 && f.tokenCount <= 10) z += 0.2;
  if (f.tokenCount === 1) z -= 0.25;
  if (f.tokenCount > 16) z -= 0.15;

  // Entropy azsa daha net niyet
  z += (0.5 - Math.min(f.entropy, 1)) * 0.15;

  // Quality guard penalty
  z += f.qualityPenalty;

  // Basit sigmoid
  const neuralScoreRaw = 1 / (1 + Math.exp(-z));
  const neuralScore = titanNormalizeScore(neuralScoreRaw);

  return {
    neuralScore,
    features: f,
  };
}

// ======================================================================
//  S28 — User Profile Adaptive Intent
// ======================================================================
function titanApplyUserProfile(baseIntent, userProfile, neuralScoreObj) {
  if (!userProfile) {
    return {
      intent: baseIntent,
      profileBias: 0,
      appliedRules: [],
    };
  }

  const appliedRules = [];
  let intent = baseIntent;
  let bias = 0;

  const favorites = userProfile.favoriteIntents || [];
  const blocked = userProfile.blockedIntents || [];
  const vertical = userProfile.preferredVertical || null;
  const priceSensitivity = userProfile.priceSensitivity || "normal";

  // 1) Blocked intents → fallback product
  if (blocked.includes(intent)) {
    appliedRules.push(`blocked:${intent}`);
    intent = "product";
    bias -= 0.25;
  }

  // 2) Favorite intents → hafif bias
  if (favorites.includes(intent)) {
    appliedRules.push(`favorite:${intent}`);
    bias += 0.15;
  }

  // 3) Vertical bazlı yumuşak yönlendirme (travel/commerce/food etc.)
  if (vertical === "travel") {
    if (["hotel", "tour", "flight"].includes(intent)) {
      bias += 0.1;
      appliedRules.push("vertical:travel-match");
    }
  } else if (vertical === "commerce") {
    if (intent === "product") {
      bias += 0.1;
      appliedRules.push("vertical:commerce-match");
    }
  } else if (vertical === "food") {
    if (intent === "food") {
      bias += 0.1;
      appliedRules.push("vertical:food-match");
    }
  }

  // 4) Price sensitivity → intent düzeyinde değil, sadece routing’e bilgi
  if (priceSensitivity === "budget") {
    appliedRules.push("price:budget");
  } else if (priceSensitivity === "premium") {
    appliedRules.push("price:premium");
  } else {
    appliedRules.push("price:normal");
  }

  // 5) Home city + travel intent → travel tarafını güçlendir
  if (userProfile.homeCity) {
    if (["hotel", "tour", "flight", "food"].includes(intent)) {
      bias += 0.05;
      appliedRules.push("homeCity:travel-bias");
    }
  }

  const neuralScore = neuralScoreObj?.neuralScore ?? 0.5;

  return {
    intent,
    profileBias: bias,
    effectiveScore: titanNormalizeScore(neuralScore + bias * 0.3),
    appliedRules,
  };
}

// ======================================================================
//  S30 — Persona-based Intent Routing
// ======================================================================
function titanPersonaRouting(intent, userProfile, basePayload, neuralScoreObj) {
  const persona = userProfile?.persona || null;
  const tags = userProfile?.tags || [];

  const routingHints = [];
  const reasons = [];

  // Persona → routing
  switch (persona) {
    case "luxury_traveler":
      if (["hotel", "tour"].includes(intent)) {
        routingHints.push("prefer-premium", "prefer-high-rating");
        reasons.push("persona:luxury_traveler");
      }
      break;
    case "budget_hunter":
      routingHints.push("prefer-low-price", "prefer-discount");
      reasons.push("persona:budget_hunter");
      break;
    case "foodie":
      if (intent === "food") {
        routingHints.push("prefer-rated-restaurants", "prefer-local-gems");
        reasons.push("persona:foodie");
      }
      break;
    case "tech_nerd":
      if (intent === "product") {
        routingHints.push("prefer-latest-models", "prefer-tech-brands");
        reasons.push("persona:tech_nerd");
      }
      break;
    case "family":
      if (["hotel", "tour", "food"].includes(intent)) {
        routingHints.push("prefer-family-friendly", "prefer-safe");
        reasons.push("persona:family");
      }
      break;
    default:
      break;
  }

  // User tags
  if (tags.includes("nearby-first")) {
    routingHints.push("boost-nearby");
    reasons.push("tag:nearby-first");
  }
  if (tags.includes("no-flight")) {
    routingHints.push("demote-flight");
    reasons.push("tag:no-flight");
  }
  if (tags.includes("local-only")) {
    routingHints.push("prefer-local-providers");
    reasons.push("tag:local-only");
  }

  // Neural score alapján ufak routing
  const neuralScore = neuralScoreObj?.neuralScore ?? 0.5;
  if (neuralScore < 0.4) {
    routingHints.push("low-confidence-fallback");
    reasons.push("low-neural-score");
  } else if (neuralScore > 0.8) {
    routingHints.push("high-confidence-boost");
    reasons.push("high-neural-score");
  }

  return {
    persona,
    routingHints: Array.from(new Set(routingHints)),
    reasons: Array.from(new Set(reasons)),
  };
}

// ======================================================================
//  S26 BASE — Titan Final Intent Selector
// ======================================================================
function titanSelectFinalIntent(baseIntent, omni, nebula, commerce, poi) {
  const votes = {};

  const push = (i, w = 1) => {
    if (!i) return;
    votes[i] = (votes[i] || 0) + w;
  };

  // Base intent has weight 1.0
  push(baseIntent, 1.0);

  // Omni vector contributes proportional weights
  if (omni && omni.vector) {
    for (const [intent, val] of Object.entries(omni.vector)) {
      push(intent, val * 0.8);
    }
  }

  // Nebula domain → strong hint
  if (nebula && nebula.domain) {
    const domain = nebula.domain;
    if (domain === "travel") {
      push("hotel", 0.6);
      push("tour", 0.4);
      push("flight", 0.4);
    } else if (domain === "commerce") {
      push("product", 0.7);
    } else if (domain === "food") {
      push("food", 0.7);
    } else if (domain === "legal") {
      push("lawyer", 0.7);
    } else if (domain === "health") {
      push("health", 0.7);
    } else if (domain === "estate") {
      push("estate", 0.7);
    }
  }

  // Commerce deep
  if (commerce && commerce.primary) {
    push("product", 0.6);
  }

  // POI tags
  if (poi && poi.poiTags && poi.poiTags.length) {
    if (poi.poiTags.includes("beach")) push("hotel", 0.4);
    if (poi.poiTags.includes("spa")) push("hotel", 0.3);
    if (poi.poiTags.includes("adventure")) push("tour", 0.4);
    if (poi.poiTags.includes("cafe") || poi.poiTags.includes("bar"))
      push("food", 0.4);
  }

  // Winner selection
  let best = baseIntent;
  let bestScore = -Infinity;
  for (const [intent, score] of Object.entries(votes)) {
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }

  return best;
}

const ORIGINAL_detectIntent = baseDetectIntent;

// ===============================
// S200 → Vision / QR / Embedding Boost
// ===============================

// ============================================================
// S30 FINAL OUTPUT + S300 NORMALIZER (ADAPTER ENGINE COMPATIBLE)
// ============================================================
export async function detectIntent_TITAN(input = {}) {
  // BACKCOMPAT: bazı yerler detectIntent(queryString) çağırıyor → burada yakalıyoruz
  if (typeof input === "string") {
    input = { query: input };
  } else if (input && typeof input === "object" && input.query == null) {
    // bazı caller’lar text alanı gönderiyor olabilir
    if (typeof input.text === "string") input.query = input.text;
    if (typeof input.q === "string") input.query = input.q;
  }
  const {
    query = "",
    source = "text",
    visionLabels = [],
    qrPayload = null,
    embedding = null,
    userProfile = null
  } = input || {};

  // 1 — Vision boost
  if (source === "vision" && visionLabels.length) {
    const vq = visionLabels.join(" ").toLowerCase();
    if (/(phone|laptop|keyboard|monitor|tv|pc|computer|mouse|bag|shoe)/.test(vq)) {
      return {
        raw: query,
        norm: query.toLowerCase(),
        type: "product",
        category: "product",
        finalIntent: "product",
        confidence: 0.92,
        location: detectCity(query),
        brand: null,
        sub: null,
        source,
        visionLabels
      };
    }
  }

  // 2 — QR boost
  if (source === "qr" && qrPayload) {
    return {
      raw: query,
      norm: query.toLowerCase(),
      type: "product",
      category: "product",
      finalIntent: "product",
      confidence: 0.95,
      location: detectCity(query),
      brand: null,
      sub: null,
      source,
      qrPayload
    };
  }

  // 3 — S25 Cosmic çekirdeği
  const base = await ORIGINAL_detectIntent(query);

  const baseIntent = base.type;
  const { astralConfidence, nebulaContext: nebula, omniVector: omni, commerce, poi } = base;

  // 4 — S26 Titan final intent seçimi
  const titanIntent = titanSelectFinalIntent(baseIntent, omni, nebula, commerce, poi);

  // 5 — Neural scorer
  const neural = titanNeuralScore(query, titanIntent, base);

  // 6 — User profile
  const profileAdapt = titanApplyUserProfile(titanIntent, userProfile, neural);

  // 7 — Persona routing
  const personaRouting = titanPersonaRouting(profileAdapt.intent, userProfile, base, neural);

  // 8 — Final confidence
  const finalConfidence = titanNormalizeScore(profileAdapt.effectiveScore ?? astralConfidence);
  const finalIntent = profileAdapt.intent || titanIntent;

  // 9 — S300: AdapterEngine uyumlu normalize
  return normalizeFinalIntentOutput(
    {
      finalIntent,
      type: finalIntent,
      confidence: finalConfidence,
      commerce
    },
    query
  );
}


// ============================================================
// S200/S300 — INTENT → ADAPTER GROUP (TEK BEYİN)
// ============================================================
const INTENT_ALIAS_S200 = Object.freeze({
  // Keep legacy aliases but make the final group explicit/stable.
  commerce: "product",
  legal: "lawyer",
  grocery: "market",
  market: "market",

  // travel intents
  travel: "travel",
  trip: "travel",
  vacation: "travel",
  holiday: "travel",
  accommodation: "hotel",

  // vehicles
  vehicle: "vehicle_sale",
  vehiclesale: "vehicle_sale",
  vehicle_sale: "vehicle_sale",
  vehicleSale: "vehicle_sale",
  car: "vehicle_sale",

  // car rental
  car_rental: "car_rental",
  carrental: "car_rental",
  carRental: "car_rental",

  // rental / repair (intent üretimi farklı olabilir)
  rent: "rental",
  rental: "rental",
  repair: "repair",
  usta: "repair",
 tamir: "repair",

// psychology / mental health
psychology: "psychology",
psychologist: "psychology",
mental_health: "psychology",
therapy: "psychology",
therapist: "psychology",
psikolog: "psychology",
psikoloji: "psychology",
terapi: "psychology",
terapist: "psychology",
psikiyatrist: "psychology",
psikoterapi: "psychology",
});


const INTENT_TO_GROUP_S200 = Object.freeze({
  // core commerce
  product: "product",
  market: "market",
  fashion: "fashion",
  food: "food",

  // travel
  travel: "travel",
  hotel: "hotel",
  flight: "flight",
  tour: "tour",
  event: "event",
  car_rental: "car_rental",

  // services
  rental: "rental",
  estate: "estate",
  insurance: "insurance",
 health: "health",
psychology: "psychology",
checkup: "checkup",
  education: "education",
  spa: "spa",
  office: "office",
  craft: "craft",
  repair: "repair",
  lawyer: "lawyer",

  // misc
  location: "location",
  vehicle_sale: "vehicle_sale",
});

const PSYCHOLOGY_QUERY_REGEX_S200 =
  /(psikolog|psikiyatrist|terapist|terapi|psikoterapi|psikoloji|mental\s*health|depresyon|anksiyete|panik|travma|stres|kayg[ıi]|çift\s*terapisi|aile\s*terapisi|ili[şs]ki\s*terapisi)/i;

export function resolveAdapterGroupS200(intent = "", query = "") {
  const q = String(query || "");
  if (q && PSYCHOLOGY_QUERY_REGEX_S200.test(q)) return "psychology";

  const raw = String(intent || "").toLowerCase().trim();
  const aliased = INTENT_ALIAS_S200[raw] || raw;
  return INTENT_TO_GROUP_S200[aliased] || "product";
}


// ============================================================
// S300 — FINAL NORMALIZER (ADAPTER ENGINE COMPATIBLE VERSION)
// ============================================================
function normalizeFinalIntentOutput(payload = {}, query = "") {
  const raw = String(query || "").trim();
  const norm = raw.toLowerCase();

  const type = payload.finalIntent || payload.type || "product";

  const location = detectCity(raw);

  const brandMatch = raw.match(BRAND_REGEX);
  const brand = brandMatch ? brandMatch[1].toLowerCase() : null;

  const sub = payload.commerce?.primary || null;

  return {
    raw,
    norm,
    type,
    category: type,
    finalIntent: type,
    group: resolveAdapterGroupS200(type, raw),
    confidence: payload.confidence || 0.5,
    location,
    brand,
    sub
  };
}

// ============================================================
// EXPORTS — ESM UYUMLU TEK EXPORT BLOĞU
// ============================================================
export default detectIntent_TITAN;
export const detectIntent = detectIntent_TITAN;

