// server/core/normalizeEngine.js
// ============================================================================
//  FAE NORMALIZE ENGINE — S15.8 TITAN EDITION
//  ZERO-CRASH · ZERO-DRIFT · HIGH-CONSISTENCY · ADAPTER/ENGINE UYUMLU
//  DOMAIN AWARE: PRODUCT · TRAVEL · HOTEL · FLIGHT · ESTATE · FOOD · EVENT
//  COMMISSION-AWARE · TRUST-AWARE · PRICE-AWARE · PROVIDER-AWARE
// ============================================================================

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------
function safeNumber(value, fallback = null, { clampMin = null, clampMax = null } = {}) {
  try {
    if (typeof value === "number" && Number.isFinite(value)) {
      let n = value;
      if (clampMin != null && n < clampMin) n = clampMin;
      if (clampMax != null && n > clampMax) n = clampMax;
      return n;
    }
    if (value == null) return fallback;

    let str = String(value).trim();
    if (!str) return fallback;

    // Parantezli formatları, para sembollerini ve kur kısaltmalarını temizle
    str = str
      .replace(/[()]/g, "")
      .replace(/[₺€$£¥₹₽₼]/g, "")
      .replace(
        /\b(TL|TRY|YTL|USD|EUR|EURO|GBP|JPY|CNY|RUB|AZN|MANAT|USD\$|US\$)\b/gi,
        ""
      )
      // 1.234.567,89 → 1234567.89
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(/,/g, ".")
      // kalan saçma karakterleri at
      .replace(/[^\d.-]/g, "");

    // Birden fazla nokta varsa → son nokta ondalık, öncekileri kaldır
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      const parts = str.split(".");
      str = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
    }

    let n = Number(str);
    if (!Number.isFinite(n)) return fallback;

    // Absürt büyük değerleri (ör: 1e15) fallback'e çevir
    if (Math.abs(n) > 1e12) return fallback;

    if (clampMin != null && n < clampMin) n = clampMin;
    if (clampMax != null && n > clampMax) n = clampMax;

    return n;
  } catch {
    return fallback;
  }
}

function safeString(v, fallback = "") {
  if (v == null) return fallback;
  try {
    const s = String(v).trim();
    return s || fallback;
  } catch {
    return fallback;
  }
}

function safeLower(v, fallback = "") {
  return safeString(v, fallback).toLowerCase();
}

function safeArray(a) {
  return Array.isArray(a) ? a : [];
}

function logNormalize(tag, payload) {
  try {
    // DEBUG seviyesinde açılabilir:
    // if (process.env.FAE_NORMALIZE_DEBUG === "1") {
    //   console.log(`🔧 NORMALIZE:${tag}`, payload);
    // }
  } catch {
    /* log asla patlatmasın */
  }
}

// Stabil hash (id üretim için)
function stableHash(str, prefix = "id") {
  try {
    const s = String(str || "").trim();
    if (!s) {
      return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    }
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    const safe = (hash >>> 0).toString(36);
    return `${prefix}_${safe}`;
  } catch {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---------------------------------------------------------------------------
// PRICE PARSER (ESKİ İSİM KORUNUYOR)
// ---------------------------------------------------------------------------
export function parsePriceToNumber(rawPrice) {
  // Basit value ise direkt
  const direct = safeNumber(rawPrice, null);
  if (direct !== null) return direct;

  // Nesne geldiğinde tipik alanlara bak
  if (rawPrice && typeof rawPrice === "object") {
    for (const key of ["value", "amount", "priceValue", "cost", "total", "price"]) {
      const n = safeNumber(rawPrice[key], null);
      if (n !== null) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ROOT DOMAIN
// ---------------------------------------------------------------------------
function extractRootDomain(str) {
  try {
    let domain = String(str || "")
      .replace(/https?:\/\//i, "")
      .replace(/^www\./i, "")
      .trim()
      .toLowerCase();

    if (!domain) return str;

    domain = domain.split("?")[0].split("#")[0].split("/")[0];

    const parts = domain.split(".");
    // subdomain+domain+ext → domain+ext
    if (parts.length > 2) {
      while (parts.length > 2) parts.shift();
    }
    return parts.join(".");
  } catch {
    return str;
  }
}

// ---------------------------------------------------------------------------
// PROVIDER NORMALIZER (MEGA MAP) — normalizeProvider
// ---------------------------------------------------------------------------
export function normalizeProvider(rawProvider, fallback = "unknown") {
  if (!rawProvider && fallback) rawProvider = fallback;

  let p = safeString(rawProvider || fallback || "unknown", "unknown")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/adapter|scraper|engine|client|api|official/gi, "")
    .trim();

  if (!p) return "unknown";

  // Domain ise kök domain çek
  if (p.includes("http") || p.includes(".")) {
    const root = extractRootDomain(p);
    if (root && root !== p) {
      p = root;
    }
  }

  const providerMap = {
    // travel
    booking: "booking",
    "booking.com": "booking",
    skyscanner: "skyscanner",
    "skyscanner.com": "skyscanner",
    "skyscanner.net": "skyscanner",
    turna: "turna",
    tatilbudur: "tatilbudur",
    tatilsepeti: "tatilsepeti",
    etstur: "etstur",
    "tatil.com": "tatil",
    trip: "trip",
    "trip.com": "trip",
    airbnb: "airbnb",
    agoda: "agoda",
    expedia: "expedia",
    trivago: "trivago",
    odamax: "odamax",
    otelz: "otelz",
    mngtur: "mngtur",

    // core TR marketplaces
    trendyol: "trendyol",
    "trendyol.com": "trendyol",
    hepsiburada: "hepsiburada",
    "hepsiburada.com": "hepsiburada",
    amazon: "amazon",
    "amazon.com": "amazon",
    "amazon.com.tr": "amazon",
    n11: "n11",
    "n11.com": "n11",
    ciceksepeti: "ciceksepeti",
    "ciceksepeti.com": "ciceksepeti",

    // grocery / quick commerce
    migros: "migros",
    "migros.com.tr": "migros",
    macrocenter: "macrocenter",
    "macrocenter.com.tr": "macrocenter",
    getir: "getir",
    "getir.com": "getir",
    yemeksepeti: "yemeksepeti",
    "yemeksepeti.com": "yemeksepeti",
    banabi: "banabi",
    a101: "a101",
    bim: "bim",
    şok: "sok",
    sok: "sok",
    carrefour: "carrefour",
    "carrefoursa.com": "carrefour",
    metro: "metro",

    // fashion / e-ticaret
    gardrops: "gardrops",
    morhipo: "morhipo",
    lcwaikiki: "lcwaikiki",
    "lcw.com": "lcwaikiki",
    defacto: "defacto",
    koton: "koton",
    mavi: "mavi",
    flo: "flo",
    pttavm: "pttavm",
    akakce: "akakce",
    "akakce.com": "akakce",
    cimri: "cimri",
    "cimri.com": "cimri",
    mediamarkt: "mediamarkt",
    teknosa: "teknosa",
    vatan: "vatan",
    zara: "zara",
    bershka: "bershka",
    pullandbear: "pullandbear",
    nike: "nike",
    adidas: "adidas",
    puma: "puma",
    zalando: "zalando",
    shein: "shein",
    decathlon: "decathlon",
    ikea: "ikea",

    // classifieds / estate
    letgo: "letgo",
    sahibinden: "sahibinden",
    "sahibinden.com": "sahibinden",
    emlakjet: "emlakjet",
    zingat: "zingat",

    // ticket / events
    biletix: "biletix",
    passo: "passo",
    biletino: "biletino",
    getyourguide: "getyourguide",

    // professions / services
    avukat: "lawyer",
    lawyer: "lawyer",
    "lawyer.com": "lawyer",
    doktor: "doctor",
    doctor: "doctor",
    medical: "medical",
    hospital: "medical",
    klinik: "medical",
    clinic: "medical",

    // search/meta
    googleplaces: "googleplaces",
    "google places": "googleplaces",
    "google.com/maps": "googleplaces",
    "maps.google.com": "googleplaces",
    osm: "osm",
    openstreetmap: "osm",
    serpapi: "serpapi",
    google_shopping: "google_shopping",

    // education
    kurs: "education",
    egitim: "education",
    eğitim: "education",
    bootcamp: "education",
  };

  // Kök domain bazlı
  if (p.includes(".")) {
    const root = extractRootDomain(p);
    if (providerMap[root]) return providerMap[root];
  }

  // Direkt eşleşme
  if (providerMap[p]) return providerMap[p];

  // İçerik bazlı esnek eşleşme
  for (const [key, val] of Object.entries(providerMap)) {
    if (p.includes(key) || key.includes(p)) return val;
  }

  return p || "unknown";
}

// ---------------------------------------------------------------------------
// RATING NORMALIZE — normalizeRating
// ---------------------------------------------------------------------------
export function normalizeRating(rawRating, fallback = null) {
  const r = safeNumber(rawRating, null);
  if (r == null) return fallback;

  // 0–10 ölçeği
  if (r > 5 && r <= 10) return +(r / 2).toFixed(2);

  // % bazlı skor
  if (r > 10 && r <= 100) return +(r / 20).toFixed(2);

  // 100+'lerde saçma skor → 5’e kırp
  if (r > 100) return 5;

  if (r < 0) return fallback;
  if (r > 5) return 5;

  return +r.toFixed(2);
}

// ---------------------------------------------------------------------------
// ID NORMALIZER — normalizeId
// ---------------------------------------------------------------------------
export function normalizeId(raw, fallback = "") {
  try {
    if (raw) {
      const s = String(raw).trim().replace(/\s+/g, "-");
      // Alfanumerik + - _
      if (s.length >= 6 && /^[a-zA-Z0-9-_]+$/.test(s)) return s;
    }

    if (fallback) {
      const base = String(fallback)
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-_]/g, "");
      if (base.length >= 6) return base;
    }

    return `id_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(
      36
    )}`;
  } catch {
    return `id_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---------------------------------------------------------------------------
// CURRENCY NORMALIZER — normalizeCurrency
// ---------------------------------------------------------------------------
export function normalizeCurrency(raw, fallback = "TRY") {
  if (!raw) return fallback;

  const s = safeString(raw)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const currencyMap = {
    TL: "TRY",
    TRY: "TRY",
    YTL: "TRY",
    "₺": "TRY",

    USD: "USD",
    "US$": "USD",
    "$": "USD",

    EUR: "EUR",
    "€": "EUR",

    GBP: "GBP",
    "£": "GBP",

    JPY: "JPY",
    "¥": "JPY",
    CNY: "CNY",
    RUB: "RUB",
    AZN: "AZN",
  };

  if (currencyMap[s]) return currencyMap[s];

  for (const [key, val] of Object.entries(currencyMap)) {
    if (s.includes(key)) return val;
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// DELIVERY SAFE
// ---------------------------------------------------------------------------
function extractDeliveryInfo(item) {
  try {
    const d =
      item.delivery ||
      item.shipping ||
      item.dispatch ||
      item.logistics ||
      item.cargo ||
      {};

    return {
      delivery: {
        etaDays: safeNumber(
          d.etaDays || d.days || d.estimatedDays || d.deliveryDays,
          null
        ),
        cost: safeNumber(d.cost || d.price || d.fee || d.shippingPrice, 0, {
          clampMin: 0,
        }),
        free: Boolean(
          d.free || d.freeShipping || d.cost === 0 || d.price === 0
        ),
        provider: d.provider || d.company || d.carrier || null,
      },
    };
  } catch {
    return {
      delivery: {
        etaDays: null,
        cost: null,
        free: false,
        provider: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// CATEGORY DETECTION (MEGA)
// ---------------------------------------------------------------------------
function detectCategoryFromData(item) {
  const t =
    `${item.title || ""} ${item.description || ""} ${item.category || ""} ${
      item.tags || ""
    } ${item.breadcrumb || ""}`
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const map = {
    electronics:
      /(telefon|iphone|samsung|xiaomi|laptop|notebook|tablet|kulakl[kıi]k|headset|playstation|ps5|xbox|monitor|ekran kart[ıi]|elektronik)/,
    flight:
      /(uçak|ucak|flight|bilet|havayolu|hava yolu|pegasus|thy|turkish airlines|sunexpress|anadolujet)/,
    hotel:
      /(otel|hotel|konaklama|pansiyon|resort|apart|hostel|bungalov|butik otel)/,
    car_rental:
      /(ara[çc] kirala|araba kirala|car rental|rent a car|kiralama)/,
    food:
      /(pizza|yemek|restaurant|restoran|kahve|coffee|burger|d[öo]ner|lahmacun|kebap|cafe|lokanta)/,
    fashion:
      /(giyim|ayakkab[ıi]|elbise|pantolon|mont|tshirt|ti[sş]ört|etek|sweatshirt|canta|çanta|aksesuar|g[öo]mlek)/,
    book: /(kitap|roman|book|novel|k[ıi]tap)/,
    travel: /(tur|tour|tatil|rezervasyon|gezi paketi|paket tur|cruise|gemi turu)/,
    health:
      /(hastane|hastanesi|doktor|t[ıi]p merkezi|medical|clinic|klinik|sa[ğg]l[ıi]k)/,
    checkup: /(check-up|checkup|sa[ğg]l[ıi]k paketi|check up)/,
    education:
      /(kurs|e[ğg]itim|bootcamp|sertifika|kolej|university|üniversite|lise|online ders)/,
    market:
      /(market|migros|macrocenter|a101|b[ıi]m|\b[sş]ok\b|carrefour|gross|hipermarket|süpermarket|supermarket)/,
    estate:
      /(daire|villa|rezidans|residence|sat[ıi]l[ıi]k|kiral[ıi]k|emlak|arsa|dükkan|is yeri|i[şs] yeri|ofis)/,
    event:
      /(konser|festival|tiyatro|stand-?up|etkinlik|g[öo]steri|gala|party|dj set|sahne|biletix|biletino|passo)/,
    lawyer:
      /(avukat|hukuk b[üu]rosu|law office|lawyer|attorney|b[ou]şanma davas[ıi]|tazminat davas[ıi])/,
    insurance:
      /(sigorta|kasko|trafik sigortas[ıi]|dask|tamamlayıcı sa[ğg]l[ıi]k|health insurance)/,
    price_compare:
      /(akakce|cimri|fiyat kar[sş][ıi]la[sş]t[ıi]r|kar[sş][ıi]la[sş]t[ıi]rma sitesi)/,
  };

  for (const [cat, regex] of Object.entries(map)) {
    if (regex.test(t)) return cat;
  }

  return "product";
}

// ---------------------------------------------------------------------------
// IMAGE VARIANTS (opsiyonel ama kartlar için faydalı)
// ---------------------------------------------------------------------------
function buildImageVariants(image) {
  const url = safeString(image, "");
  if (!url) {
    return {
      image: null,
      imageOriginal: null,
      imageProxy: null,
      hasProxy: false,
    };
  }

  // Eğer zaten proxy ise (img-proxy, cloudflare vb.) tekrar sarmalama
  if (/\/img-proxy\?url=/.test(url) || /\/cdn\/proxy\//.test(url)) {
    return {
      image: url,
      imageOriginal: url,
      imageProxy: url,
      hasProxy: true,
    };
  }

  const encoded = encodeURIComponent(url);
  const proxy = `/img-proxy?url=${encoded}`;

  return {
    image: url,
    imageOriginal: url,
    imageProxy: proxy,
    hasProxy: true,
  };
}

// ---------------------------------------------------------------------------
// ADAPTER ITEM NORMALIZE — normalizeAdapterItem
// ---------------------------------------------------------------------------
export function normalizeAdapterItem(raw = {}) {
  const item = raw || {};

  // Fiyat alanları
  const priceRaw =
    item.price ??
    item.finalPrice ??
    item.amount ??
    item.minPrice ??
    item.maxPrice ??
    item.currentPrice ??
    item.discountedPrice ??
    item.salePrice ??
    null;

  const price = parsePriceToNumber(priceRaw);

  // Rating alanları
  const ratingRaw =
    item.rating ??
    item.score ??
    item.stars ??
    item.reviewScore ??
    item.customerRating ??
    item.qualityScore ??
    0;

  const rating = normalizeRating(ratingRaw, 0);

  // Komisyon alanları (S15: oranları normalize et → 0–1)
  const commissionRaw =
    item.commissionRate ??
    item.commission ??
    item.affiliateCommission ??
    item.partnerCommission ??
    0;

  let commissionRate = safeNumber(commissionRaw, 0, { clampMin: 0 });
  if (commissionRate != null) {
    if (commissionRate > 1 && commissionRate <= 100) {
      // % değer → 0–1
      commissionRate = commissionRate / 100;
    }
    commissionRate = Math.min(1, Math.max(0, commissionRate));
  } else {
    commissionRate = 0;
  }

  const isAffiliate =
    Boolean(
      item.isAffiliate ||
        item.affiliate ||
        item.partner ||
        item.sponsored ||
        item.isSponsored
    ) || commissionRate > 0;

  const category = item.category || detectCategoryFromData(item);
  const delivery = extractDeliveryInfo(item);

  const providerRaw =
    item.source ||
    item.vendor ||
    item.platform ||
    item.marketplace ||
    item.store ||
    item.provider ||
    "unknown";

  const provider = normalizeProvider(providerRaw);

  const images = buildImageVariants(
    item.image || item.imageUrl || item.thumbnail
  );

  const idBase =
    item.id ||
    item.sku ||
    item.offerId ||
    item.productId ||
    (item.url
      ? item.url.replace(/[^a-zA-Z0-9]/g, "").slice(-24)
      : null) ||
    `id_${Math.random().toString(36).slice(2, 10)}`;

  const id = normalizeId(idBase);

  return {
    id,
    title: item.title || item.name || item.productName || item.description || "",
    provider,
    source: provider,

    price,
    originalPrice: parsePriceToNumber(item.originalPrice || item.listPrice),
    currency: normalizeCurrency(item.currency || item.ccy || "TRY"),

    rating,
    reviewCount: safeNumber(item.reviewCount || item.numReviews, 0, {
      clampMin: 0,
    }),

    commissionRate,
    isAffiliate,

    url: item.url || item.link || item.deepLink || item.productUrl || null,
    ...images,

    category,
    ...delivery,

    region: item.region || item.country || item.location || null,
    raw: item,
  };
}

// ---------------------------------------------------------------------------
// PRICE ANALYSIS
// ---------------------------------------------------------------------------
function analyzePricing(item, basePrice, optPrice) {
  const r = {
    discountAmount: null,
    discountPercentage: null,
    hasDiscount: false,
    isPriceReasonable: null,
  };

  if (basePrice != null && optPrice != null && basePrice > 0) {
    const disc = basePrice - optPrice;
    if (disc > 0) {
      r.discountAmount = disc;
      r.discountPercentage = +((disc / basePrice) * 100).toFixed(1);
      r.hasDiscount = true;
    }
  }

  if (optPrice != null) {
    r.isPriceReasonable =
      optPrice > 0 && optPrice < 1_000_000 && basePrice != null
        ? optPrice >= basePrice * 0.3 && optPrice <= basePrice * 3
        : optPrice > 0 && optPrice < 1_000_000;
  }

  return r;
}

// ---------------------------------------------------------------------------
// normalizeItemBase — adapter sonrası kart öncesi ortak normalize
// ---------------------------------------------------------------------------
export function normalizeItemBase(raw, defaults = {}) {
  const item = raw || {};

  const provider = normalizeProvider(
    defaults.provider || item.provider || item.source
  );

  const basePrice = parsePriceToNumber(item.price);
  const optPrice = parsePriceToNumber(
    item.optimizedPrice != null ? item.optimizedPrice : item.price
  );

  const rating =
    normalizeRating(
      item.rating || item.score || item.stars || item.reviewScore,
      null
    ) ?? null;

  const currency = normalizeCurrency(item.currency || defaults.currency, "TRY");

  const id = normalizeId(
    item.id,
    `${provider}-${(item.sku ||
      item.barcode ||
      item.url ||
      item.title ||
      "x"
    )
      .toString()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "")}`
  );

  const priceAnalysis = analyzePricing(item, basePrice, optPrice);
  const images = buildImageVariants(
    item.image || item.imageUrl || item.thumbnail
  );

  return {
    ...item,
    id,
    provider,

    price: basePrice,
    optimizedPrice: optPrice ?? basePrice ?? null,
    originalPrice: parsePriceToNumber(item.originalPrice || item.listPrice),

    ...priceAnalysis,

    rating,
    reviewCount: safeNumber(item.reviewCount || item.numReviews, 0, {
      clampMin: 0,
    }),
    currency,

    lastUpdated: item.lastUpdated || item.updatedAt || new Date().toISOString(),
    availability:
      typeof item.availability === "boolean"
        ? item.availability
        : item.inStock !== false,

    ...images,
  };
}

// ---------------------------------------------------------------------------
// TRUST SCORE (0–1)
// ---------------------------------------------------------------------------
function calculateTrustScore(item) {
  if (
    typeof item.trustScore === "number" &&
    Number.isFinite(item.trustScore) &&
    item.trustScore > 0
  ) {
    return Math.min(1, Math.max(0.1, item.trustScore));
  }

  let s = 0.5;

  const trusted = [
    "booking",
    "skyscanner",
    "trendyol",
    "hepsiburada",
    "amazon",
    "n11",
    "ciceksepeti",
    "sahibinden",
    "googleplaces",
  ];
  if (trusted.includes(item.provider)) s += 0.2;

  if (item.rating >= 4.5) s += 0.18;
  else if (item.rating >= 4.0) s += 0.15;
  else if (item.rating >= 3.0) s += 0.1;

  if (item.reviewCount > 1000) s += 0.1;
  else if (item.reviewCount > 100) s += 0.07;
  else if (item.reviewCount > 10) s += 0.04;

  if (item.isPriceReasonable !== false) s += 0.05;

  if (item.isAffiliate) s += 0.02;

  return Math.min(1, Math.max(0.1, +s.toFixed(4)));
}

// ---------------------------------------------------------------------------
// QUALITY SCORE (0–1) + 1–5 skala
// ---------------------------------------------------------------------------
function calculateQualityScore(item) {
  if (
    typeof item.qualityScore === "number" &&
    item.qualityScore >= 0 &&
    item.qualityScore <= 1
  ) {
    return item.qualityScore;
  }

  let s = 0.55;

  s += (item.trustScore || 0.5) * 0.4;
  s += item.rating ? (item.rating / 5) * 0.3 : 0;

  if (item.delivery) {
    if (item.delivery.free) s += 0.08;
    if (
      item.delivery.etaDays !== null &&
      item.delivery.etaDays !== undefined &&
      item.delivery.etaDays <= 3
    )
      s += 0.07;
  }

  if (item.hasDiscount) s += 0.08;

  if (item.isAffiliate) s += 0.02;

  return Math.min(1, Math.max(0.1, +s.toFixed(4)));
}

// ---------------------------------------------------------------------------
// FINAL CARD NORMALIZE — normalizeFinalCardItem
// ---------------------------------------------------------------------------
export function normalizeFinalCardItem(card) {
  if (!card) return null;

  const normalized = normalizeItemBase(card, {
    provider: card.provider || card.source,
    currency: card.currency || "TRY",
  });

  const trustScore = calculateTrustScore(normalized);
  const qualityScore = calculateQualityScore({ ...normalized, trustScore });
  const qualityScore5 = +(1 + qualityScore * 4).toFixed(2);

  return {
    ...normalized,
    trustScore,
    qualityScore,
    qualityScore5,
    normalizedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// BATCH NORMALIZE — normalizeItemsBatch
// ---------------------------------------------------------------------------
export function normalizeItemsBatch(items = [], options = {}) {
  if (!Array.isArray(items)) return [];

  const {
    strictMode = false,
    validatePrices = true,
    defaultCurrency = "TRY",
    minPrice = 0,
    maxItems = null,
    trustThreshold = 0, // 0 → devre dışı
  } = options;

  const out = [];
  const seen = new Set(); // id bazlı
  const seenUrl = new Set(); // url+provider bazlı

  for (const item of items) {
    if (maxItems != null && out.length >= maxItems) break;

    try {
      if (!item || typeof item !== "object") continue;

      const n = strictMode
        ? normalizeFinalCardItem(item)
        : normalizeAdapterItem(item);

      if (!n || !n.id) continue;

      // Dublike id
      if (seen.has(n.id)) continue;

      // URL + provider bazlı dedupe
      const urlKey = n.url ? `${n.provider || "x"}|${n.url}` : null;
      if (urlKey && seenUrl.has(urlKey)) continue;

      if (validatePrices && n.price != null && n.price < minPrice) continue;

      if (!n.currency) n.currency = defaultCurrency;

      // trustThreshold aktifse düşük güvenlileri at
      if (trustThreshold > 0 && typeof n.trustScore === "number") {
        if (n.trustScore < trustThreshold) {
          continue;
        }
      }

      seen.add(n.id);
      if (urlKey) seenUrl.add(urlKey);

      out.push(n);
    } catch (err) {
      logNormalize("BATCH_ITEM_ERROR", { error: err?.message });
      continue;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// METRICS — getNormalizationMetrics
// ---------------------------------------------------------------------------
export function getNormalizationMetrics(items = []) {
  const normalized = normalizeItemsBatch(items, {
    strictMode: false,
    validatePrices: false,
  });

  const metrics = {
    totalInput: items.length,
    totalOutput: normalized.length,
    successRate: items.length > 0 ? (normalized.length / items.length) * 100 : 0,

    priceStats: {
      withPrice: normalized.filter((x) => x.price != null).length,
      withDiscount: normalized.filter((x) => x.hasDiscount).length,
      avgPrice: null,
      minPrice: null,
      maxPrice: null,
    },

    providerDistribution: {},
    categoryDistribution: {},
  };

  const prices = normalized
    .map((x) => x.price)
    .filter((p) => typeof p === "number" && Number.isFinite(p));

  if (prices.length) {
    const sum = prices.reduce((a, b) => a + b, 0);
    metrics.priceStats.avgPrice = sum / prices.length;
    metrics.priceStats.minPrice = Math.min(...prices);
    metrics.priceStats.maxPrice = Math.max(...prices);
  }

  normalized.forEach((x) => {
    const p = x.provider || "unknown";
    metrics.providerDistribution[p] =
      (metrics.providerDistribution[p] || 0) + 1;

    const c = x.category || "unknown";
    metrics.categoryDistribution[c] =
      (metrics.categoryDistribution[c] || 0) + 1;
  });

  return metrics;
}

// ---------------------------------------------------------------------------
// DEFAULT EXPORT – mevcut import tarzını bozmamak için
// ---------------------------------------------------------------------------
export default {
  parsePriceToNumber,
  normalizeProvider,
  normalizeRating,
  normalizeId,
  normalizeCurrency,
  normalizeAdapterItem,
  normalizeItemBase,
  normalizeFinalCardItem,
  normalizeItemsBatch,
  getNormalizationMetrics,
};
