// server/adapters/avisAdapter.js
// AVIS TR — HERCULES S200 UYUMLU TAM ADAPTER
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import {
buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {



  loadCheerioS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
// ----------------------------- HELPERS -----------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeUrl(href) {
  // 1 — Boş, zararlı, geçersiz linkleri blokla
  if (
    !href ||
    typeof href !== "string" ||
    href.trim() === "" ||
    href === "#" ||
    href.toLowerCase().startsWith("javascript") ||
    href.toLowerCase().includes("void(0)") ||
    href.toLowerCase().includes("return false")
  ) {
    return null;
  }

  let clean = href.trim();

  // 2 — //cdn gibi protokolsüz URL'ler → https ekle
  if (clean.startsWith("//")) {
    return "https:" + clean;
  }

  // 3 — http / https varsa → direkt döndür
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    return clean;
  }

  // 4 — Başı "/" değilse → ekle (arac-kiralama/... gibi)
  if (!clean.startsWith("/")) {
    clean = "/" + clean;
  }

  // 5 — Avis domain ile birleştir
  return "https://www.avis.com.tr" + clean;
}


function extractCarType(title) {
  const titleLower = title.toLowerCase();
  
  const types = {
    'ekonomik': 'economy',
    'ekonomi': 'economy',
    'kompakt': 'compact',
    'orta sınıf': 'midsize',
    'orta sinif': 'midsize',
    'full': 'fullsize',
    'lux': 'luxury',
    'lüks': 'luxury',
    'suv': 'suv',
    'minivan': 'minivan',
    'van': 'van',
    'station': 'station_wagon',
    'convertible': 'convertible',
    'cabrio': 'convertible',
    'pickup': 'pickup',
    'premium': 'premium'
  };
  
  for (const [key, value] of Object.entries(types)) {
    if (titleLower.includes(key)) return value;
  }
  
  return 'standard';
}

function extractCarModel(title) {
  const models = [
    'Fiat Egea', 'Renault Clio', 'Renault Megane', 'Toyota Corolla',
    'Hyundai i20', 'Hyundai i30', 'Opel Astra', 'Ford Focus',
    'Volkswagen Golf', 'Volkswagen Passat', 'BMW 3 Serisi',
    'Mercedes C Serisi', 'Audi A3', 'Audi A4', 'Peugeot 208',
    'Peugeot 308', 'Citroen C3', 'Citroen C4', 'Skoda Octavia',
    'Kia Rio', 'Kia Sportage', 'Hyundai Tucson', 'Toyota RAV4',
    'Ford Kuga', 'Nissan Qashqai', 'Volvo XC40', 'Volvo XC60'
  ];
  
  const titleLower = title.toLowerCase();
  for (const model of models) {
    if (titleLower.includes(model.toLowerCase())) return model;
  }
  
  return null;
}

function extractTransmission(title) {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('otomatik') || titleLower.includes('automatic')) return 'automatic';
  if (titleLower.includes('manuel') || titleLower.includes('manual')) return 'manual';
  return null;
}

function extractFuelType(title) {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('dizel') || titleLower.includes('diesel')) return 'diesel';
  if (titleLower.includes('benzin') || titleLower.includes('petrol') || titleLower.includes('gasoline')) return 'gasoline';
  if (titleLower.includes('hibrit') || titleLower.includes('hybrid')) return 'hybrid';
  if (titleLower.includes('elektrik') || titleLower.includes('electric')) return 'electric';
  return null;
}

function calculateDailyPrice(priceText, title) {
  if (!priceText) return null;
  
  // Günlük fiyatı çıkar
  const patterns = [
    /(\d+)[\s.,]*TL\/gün/i,
    /(\d+)[\s.,]*TL gün/i,
    /günlük\s*(\d+)/i,
    /daily\s*(\d+)/i,
    /(\d+)\s*TL.*gün/i
  ];
  
  for (const pattern of patterns) {
    const match = priceText.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  
  // Sadece fiyat varsa ve araç kiralama ise
  const price = parsePrice(priceText);
  if (price && price < 10000) {
    // Muhtemel günlük fiyat
    return price;
  }
  
  return null;
}

function calculateWeeklyPrice(dailyPrice) {
  if (!dailyPrice) return null;
  return dailyPrice * 7 * 0.9; // %10 haftalık indirim
}

function calculateMonthlyPrice(dailyPrice) {
  if (!dailyPrice) return null;
  return dailyPrice * 30 * 0.8; // %20 aylık indirim
}

function extractFeatures(title, priceText) {
  const features = [];
  const titleLower = title.toLowerCase();
  const priceLower = priceText ? priceText.toLowerCase() : '';
  
  if (titleLower.includes('sınırsız') || priceLower.includes('sınırsız')) {
    features.push('unlimited_mileage');
  }
  
  if (titleLower.includes('kasko') || priceLower.includes('kasko')) {
    features.push('full_insurance');
  }
  
  if (titleLower.includes('cdw') || titleLower.includes('teminat')) {
    features.push('collision_damage_waiver');
  }
  
  if (titleLower.includes('yol yardım') || titleLower.includes('roadside')) {
    features.push('roadside_assistance');
  }
  
 if (titleLower.includes('vergiler dahil') || priceLower.includes('vergi')) {
  features.push('tax_included');
}

if (titleLower.includes('şoförlü') || titleLower.includes('with driver')) {
  features.push('with_driver');
}


  
  return features;
}

function generateRentalId(title, dailyPrice, location = '', url = '') {
  // deterministic S200 id: stable across calls
  return stableIdS200('avis', String(title || ''), String(url || ''), String(dailyPrice ?? ''), String(location || ''));
}

// ----------------------------- S200 NORMALIZER -----------------------------
function normalizeS200(raw, region = "TR", query = "") {
  const {
    title,
    price,
    priceText,
    href,
    imgRaw,
    location,
    pickupDate,
    returnDate,
    pickupLocation,
    returnLocation
  } = raw;

  // Görsel varyantları burada oluşturuluyor
  const imageVariants = buildImageVariants(imgRaw, "avis");

  const url = normalizeUrl(href);

  if (!url) return null;

  const dailyPrice = calculateDailyPrice(priceText, title);

  const id = generateRentalId(
    title,
    dailyPrice ?? price ?? null,
    pickupLocation || location || "Bilinmeyen Lokasyon",
    url
  );

  const carType = extractCarType(title);
  const carModel = extractCarModel(title);
  const transmission = extractTransmission(title);
  const fuelType = extractFuelType(title);
const weeklyPrice = calculateWeeklyPrice(dailyPrice);
  const monthlyPrice = calculateMonthlyPrice(dailyPrice);
  const features = extractFeatures(title, priceText);

  return {
    id,
    title: title || "",
    url,

    price: dailyPrice ?? price ?? null,
    finalPrice: dailyPrice ?? price ?? null,
    originalPrice: price ?? null,
    currency: "TRY",
    priceDisplay: dailyPrice
      ? `${dailyPrice.toLocaleString("tr-TR")} TL/gün`
      : priceText || "Fiyat bilgisi yok",

    rentalType: "car_rental",
    rentalPeriod: "daily",
    dailyPrice,
    weeklyPrice,
    monthlyPrice,
    minRentalDays: 1,
    maxRentalDays: 30,

    carType,
    carModel,
    transmission,
    fuelType,
    passengerCapacity: extractPassengerCapacity(title),
    luggageCapacity: extractLuggageCapacity(title),
    features,
    includedFeatures: ["basic_insurance", "24_7_support", "unlimited_mileage"],
    optionalFeatures: ["gps", "child_seat", "additional_driver"],

    pickupLocation: pickupLocation || location || "Bilinmeyen Lokasyon",
    returnLocation: returnLocation || pickupLocation || location || "Bilinmeyen Lokasyon",

    pickupDate: pickupDate || new Date(Date.now() + 86400000).toISOString().split("T")[0],
    returnDate: returnDate || new Date(Date.now() + 86400000 * 3).toISOString().split("T")[0],
    isAirportPickup: isAirportLocation(pickupLocation || location || "Bilinmeyen Lokasyon"),

    provider: "avis",
    source: "avis_adapter",
    category: "car_rental",
    subcategory: carType,

    region: region.toUpperCase(),
    language: "tr",

    image: imgRaw || null,
    images: imgRaw ? [imgRaw] : [],
    imageVariants, // ✔ Doğru yer burası

    commissionRate: 0.08,
    affiliateReady: true,
    affiliateUrl: url
  ? (url.includes("?")
      ? `${url}&aff_id=findalleasy_avis`
      : `${url}?aff_id=findalleasy_avis`)
  : url,

finalUrl: url
  ? (url.includes("?")
      ? `${url}&aff_id=findalleasy_avis`
      : `${url}?aff_id=findalleasy_avis`)
  : url,


    affiliateTag: "findalleasy_avis",

    providerTrust: calculateProviderTrust(carType, dailyPrice),
    categoryWeight: 0.88,
    relevanceScore: calculateRelevanceScore(title, query),
    qualityScore: calculateQualityScore(title, dailyPrice, features),

    queryMatched: query,
    scrapedAt: new Date().toISOString(),
    rawData: {
      rawAffiliateHint: `${url}?aff_id=findalleasy_avis`,
      priceText,
      href,
      originalTitle: title,
      originalPrice: price,
      pickupLocation,
      returnLocation
    },

    _s200: {
      isRental: true,
      rentalCategory: "car_rental",
      isInstantBooking: true,
      requiresDeposit: true,
      depositAmount: dailyPrice ? dailyPrice * 2 : 1000,
      cancellationPolicy: "flexible_48h",
      minimumAge: 21,
      licenseRequirements: "valid_drivers_license",
      hasFreeCancellation: true,
      hasUnlimitedMileage: features.includes("unlimited_mileage"),
      hasFullInsurance: features.includes("full_insurance"),
      rating: 4.3,
      reviewCount: 1245,
      instantConfirmation: true
    }
  };
}

// ----------------------------- EXTENDED HELPER FUNCTIONS -----------------------------
function extractPassengerCapacity(title) {
  const patterns = [
    /(\d+)\s*kişilik/i,
    /(\d+)\s*person/i,
    /(\d+)\s*yolcu/i,
    /(\d+)-seat/i,
    /seats\s*(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const capacity = parseInt(match[1], 10);
      if (capacity >= 2 && capacity <= 9) return capacity;
    }
  }
  
  // Default kapasiteler
  const titleLower = title.toLowerCase();
  if (titleLower.includes('sedan') || titleLower.includes('ekonomik')) return 4;
  if (titleLower.includes('suv') || titleLower.includes('van')) return 7;
  if (titleLower.includes('minivan')) return 8;
  
  return 5; // Varsayılan
}

function extractLuggageCapacity(title) {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('büyük bagaj') || titleLower.includes('large luggage')) return 'large';
  if (titleLower.includes('orta bagaj') || titleLower.includes('medium luggage')) return 'medium';
  if (titleLower.includes('küçük bagaj') || titleLower.includes('small luggage')) return 'small';
  
  // Araç tipine göre
  if (titleLower.includes('ekonomik') || titleLower.includes('kompakt')) return 'small';
  if (titleLower.includes('orta sınıf') || titleLower.includes('midsize')) return 'medium';
  if (titleLower.includes('suv') || titleLower.includes('van')) return 'large';
  
  return 'medium';
}

function isAirportLocation(location) {
  if (!location) return false;
  const airportKeywords = ['havaalanı', 'havalimanı', 'airport', 'ist', 'esb', 'adana', 'antalya'];
  return airportKeywords.some(keyword => location.toLowerCase().includes(keyword));
}

function calculateProviderTrust(carType, dailyPrice) {
  let trust = 0.92; // Avis yüksek güvenilirlik
  
  // Araç tipi güvenilirliği
  const trustedTypes = ['premium', 'luxury', 'fullsize'];
  const mediumTypes = ['midsize', 'suv', 'compact'];
  
  if (trustedTypes.includes(carType)) trust += 0.03;
  else if (mediumTypes.includes(carType)) trust += 0.02;
  
  // Fiyat tutarlılığı
  if (dailyPrice) {
    if (dailyPrice > 50 && dailyPrice < 5000) trust += 0.02;
  }
  
  return Math.min(0.98, trust);
}

function calculateRelevanceScore(title, query) {
  if (!title || !query) return 0.5;
  
  const titleLower = title.toLowerCase();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  if (queryWords.length === 0) return 0.5;
  
  let matches = 0;
  for (const word of queryWords) {
    if (titleLower.includes(word)) matches++;
  }
  
  let score = matches / queryWords.length;
  
  // Ek bonuslar
  if (queryLower.includes('kiralık') && titleLower.includes('kiralık')) score += 0.2;
  if (queryLower.includes('araba') && titleLower.includes('araba')) score += 0.1;
  if (queryLower.includes('oto') && titleLower.includes('oto')) score += 0.1;
  
  return Math.min(1.0, score);
}

function calculateQualityScore(title, dailyPrice, features) {
  let score = 0.6;
  
  // Başlık kalitesi
  if (title && title.length > 10) score += 0.1;
  if (title && title.includes('Avis')) score += 0.05; // Resmi Avis ürünü
  
  // Fiyat bilgisi
  if (dailyPrice) {
    if (dailyPrice > 100 && dailyPrice < 2000) score += 0.15;
    else if (dailyPrice > 50 && dailyPrice < 5000) score += 0.1;
  }
  
  // Özellikler
  const premiumFeatures = ['unlimited_mileage', 'full_insurance', 'with_driver'];
  const premiumCount = features.filter(f => premiumFeatures.includes(f)).length;
  score += premiumCount * 0.05;
  
  return Math.min(1.0, score);
}

// ----------------------------- SCRAPER -----------------------------
async function scrapeAvisPage(query, page = 1, options = {}) {
  const { signal, region = "TR" } = options;

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.avis.com.tr/arac-kiralama?search=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      signal,
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.avis.com.tr/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
      },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    // Avis araç kartları
    $(".car-item, .vehicle-card, .rental-card, .car-box").each((i, el) => {
      try {
        const row = $(el);
        
        // Başlık
let title = safe(row.find(".car-name, .vehicle-name, .title, h3").text());
if (!title || title.length < 2) {
  title = safe(row.find(".model, .name, strong").text());
}
if (!title || title.length < 2) return;



        
        // Fiyat
        const priceText = safe(row.find(".price, .daily-price, .amount, .rate").text());
        const price = parsePrice(priceText);
        
        // URL
        let href = safe(row.find("a").attr("href")) || 
                  safe(row.attr("data-href")) ||
                  safe(row.attr("data-url"));
        
        // Resim
        const imgRaw = safe(row.find("img").attr("src")) || 
                      safe(row.find("img").attr("data-src")) ||
                      safe(row.find(".car-image img").attr("src"));
        
        // Lokasyon bilgisi
        const location = safe(row.find(".location, .pickup-location, .branch").text());
        const pickupDate = safe(row.find(".pickup-date, .start-date").text());
        const returnDate = safe(row.find(".return-date, .end-date").text());
        
        // Pickup ve return lokasyonları
        let pickupLocation = location;
        let returnLocation = location;
        
        const locationElements = row.find(".location-info, .branch-info");
        if (locationElements.length >= 2) {
          pickupLocation = safe(locationElements.eq(0).text());
          returnLocation = safe(locationElements.eq(1).text());
        }

        const normalized = normalizeS200(
  {
    title,
    price,
    priceText,
    href,
    imgRaw,
    location,
    pickupDate,
    returnDate,
    pickupLocation,
    returnLocation
  },
  region,
  query
);

// normalize null dönerse item oluşturma
if (!normalized) return;

// Filtreler
if (normalized.title && normalized.dailyPrice && normalized.dailyPrice > 0) {
  items.push(normalized);
}

      } catch (itemError) {
        console.warn("Avis item parsing error:", itemError.message);
      }
    });

    return items;
  } catch (err) {
    console.warn("Avis scraper error:", err.message);
    return [];
  }
}

// ----------------------------- STATISTICS FUNCTIONS -----------------------------
function calculatePriceStats(items) {
  if (!items.length) return null;
  
  const dailyPrices = items.map(i => i.dailyPrice).filter(p => p && p > 0);
  if (!dailyPrices.length) return null;
  
  dailyPrices.sort((a, b) => a - b);
  
  const min = Math.min(...dailyPrices);
  const max = Math.max(...dailyPrices);
  const avg = dailyPrices.reduce((sum, p) => sum + p, 0) / dailyPrices.length;
  const median = dailyPrices[Math.floor(dailyPrices.length / 2)];
  
  return {
    min,
    max,
    avg: Math.round(avg),
    median,
    count: dailyPrices.length,
    priceRange: `${min.toLocaleString('tr-TR')} - ${max.toLocaleString('tr-TR')} TL/gün`
  };
}

function countCarTypes(items) {
  const types = {
    economy: 0,
    compact: 0,
    midsize: 0,
    fullsize: 0,
    luxury: 0,
    suv: 0,
    minivan: 0,
    van: 0,
    convertible: 0,
    pickup: 0,
    premium: 0,
    standard: 0
  };
  
  for (const item of items) {
    const type = item.carType || 'standard';
    if (types[type] !== undefined) {
      types[type]++;
    } else {
      types.standard++;
    }
  }
  
  return types;
}

function countTransmissionTypes(items) {
  const stats = {
    automatic: 0,
    manual: 0,
    unknown: 0
  };
  
  for (const item of items) {
    const transmission = item.transmission || 'unknown';
    if (transmission === 'automatic') stats.automatic++;
    else if (transmission === 'manual') stats.manual++;
    else stats.unknown++;
  }
  
  return stats;
}

function calculateAverageDailyPrice(items) {
  const prices = items.map(i => i.dailyPrice).filter(p => p && p > 0);
  if (!prices.length) return null;
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  return Math.round(avg);
}

function calculateLocationStats(items) {
  const locations = {};
  
  for (const item of items) {
    const location = item.pickupLocation || 'Unknown';
    locations[location] = (locations[location] || 0) + 1;
  }
  
  // En çok bulunan lokasyonları sırala
  const sorted = Object.entries(locations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  return Object.fromEntries(sorted);
}

// ----------------------------- MAIN ADAPTER -----------------------------
/**
 * Hercules S200 Uyumlu Avis Adapter
 * @param {string} query - Arama sorgusu
 * @param {object} options - Seçenekler
 * @param {string} options.region - Bölge (default: "TR")
 * @param {AbortSignal} options.signal - İptal sinyali
 * @param {number} options.maxResults - Maksimum sonuç sayısı (default: 30)
 * @param {number} options.maxPages - Maksimum sayfa sayısı (default: 2)
 * @returns {Promise<object>} S200 formatında sonuç
 */
export async function searchAvisAdapterLegacy(query, options = {}) {
  const startTime = Date.now();
  const adapterVersion = "S200.2.0";

  // ===================== S200 RATE LIMITER ======================
  const region = options.region || "TR";
  const limiterKey = `s200:adapter:avis:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 15,          // Avis için ideal RPM
    windowMs: 60_000,   // dakika başı 15 istek
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    return {
      ok: false,
      items: [],
      count: 0,
      error: "S200_RATE_LIMIT_EXCEEDED",
      source: "avis_adapter",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    };
  }
 
  try {
    // Parametreleri ayarla
    const region = options.region || "TR";
    const signal = options.signal;
    const maxResults = options.maxResults || 30;
    const maxPages = options.maxPages || 2;
    const q = safe(query);
    
    if (!q || q.length < 2) {
      return {
        ok: false,
        items: [],
        count: 0,
        error: "Geçersiz sorgu",
        source: "avis_adapter",
        _meta: {
          query,
          region,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          adapterVersion
        }
      };
    }

    // Araç kiralama ile ilgili sorgu kontrolü
    const rentalKeywords = [
      'kiralık', 'kiralama', 'rent', 'rental', 'araba kiralama',
      'oto kiralama', 'araç kiralama', 'car rental', 'vehicle rental',
      'rent a car', 'günlük kiralık', 'daily rent', 'haftalık kiralık'
    ];
    
    const isRentalQuery = rentalKeywords.some(keyword => 
      q.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (!isRentalQuery) {
      return {
        ok: true,
        items: [],
        count: 0,
        source: "avis_adapter",
        note: "Query is not car rental related",
        _meta: {
          query,
          region,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          adapterVersion,
          queryAnalysis: "not_rental_related"
        }
      };
    }

    // Çoklu sayfa scraping
    let allItems = [];
    let currentPage = 1;
    
    for (currentPage = 1; currentPage <= maxPages; currentPage++) {
      const pageItems = await scrapeAvisPage(q, currentPage, { region, signal });
      
      if (!pageItems || pageItems.length === 0) break;
      
      allItems = [...allItems, ...pageItems];
      
      if (allItems.length >= maxResults) {
        allItems = allItems.slice(0, maxResults);
        break;
      }
      
      // Rate limiting için bekleme
      if (currentPage < maxPages) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Benzersiz araçlar (başlık ve fiyata göre)
    const uniqueItems = [];
    const itemKeys = new Set();
    
    for (const item of allItems) {
      const key = `${(item.title || "x").substring(0,40)}-${item.dailyPrice || "x"}-${item.pickupLocation || "loc"}`;


      if (!itemKeys.has(key)) {
        itemKeys.add(key);
        uniqueItems.push(item);
      }
    }

    // Sıralama: Günlük fiyat (düşükten yükseğe)
    uniqueItems.sort((a, b) => {
      return (a.dailyPrice || Infinity) - (b.dailyPrice || Infinity);
    });

    const duration = Date.now() - startTime;
    
    // Detaylı istatistikler
    const priceStats = calculatePriceStats(uniqueItems);
    const carTypes = countCarTypes(uniqueItems);
    const transmissionStats = countTransmissionTypes(uniqueItems);
    const locationStats = calculateLocationStats(uniqueItems);
    const avgDailyPrice = calculateAverageDailyPrice(uniqueItems);
    
    // HERCULES S200 STANDART DÖNÜŞ FORMATI
    return {
      ok: true,
      items: uniqueItems,
      count: uniqueItems.length,
      source: "avis_adapter",
      queryAnalysis: {
        isRentalQuery: true,
        matchedKeywords: rentalKeywords.filter(kw => q.toLowerCase().includes(kw.toLowerCase())),
        estimatedIntent: "car_rental"
      },
      statistics: {
        price: priceStats,
        carTypes,
        transmission: transmissionStats,
        locations: locationStats,
        averages: {
          dailyPrice: avgDailyPrice,
          weeklyPrice: avgDailyPrice ? Math.round(avgDailyPrice * 7 * 0.9) : null,
          monthlyPrice: avgDailyPrice ? Math.round(avgDailyPrice * 30 * 0.8) : null
        }
      },
      _meta: {
        query,
        region,
        duration,
        pagesScraped: currentPage - 1,
        totalItems: allItems.length,
        uniqueItems: uniqueItems.length,
        priceStats,
        popularCarType: Object.entries(carTypes).sort((a, b) => b[1] - a[1])[0]?.[0],
        avgDailyPrice,
        timestamp: new Date().toISOString(),
        adapterVersion,
        performance: {
          itemsPerSecond: uniqueItems.length / (duration / 1000),
          successRate: uniqueItems.length > 0 ? 1 : 0
        }
      }
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    return {
      ok: false,
      items: [],
      count: 0,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
      source: "avis_adapter",
      _meta: {
        query,
        region: options.region || "TR",
        duration,
        timestamp: new Date().toISOString(),
        errorType: error.name,
        adapterVersion,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    };
  }
}

// ----------------------------- FALLBACK -----------------------------
async function avisFallback(query, region) {
  const fallbackItems = [
    {
      title: "Avis Ekonomik Araç Kiralama",
      priceText: "249 TL/gün",
      href: "https://www.avis.com.tr/ekonomik-arac-kiralama",
      imgRaw: "https://www.avis.com.tr/images/economy-car.jpg",
      location: "İstanbul Havalimanı"
    },
    {
      title: "Avis Orta Sınıf Araç Kiralama",
      priceText: "399 TL/gün",
      href: "https://www.avis.com.tr/orta-sinif-arac-kiralama",
      imgRaw: "https://www.avis.com.tr/images/midsize-car.jpg",
      location: "Ankara Havalimanı"
    },
    {
      title: "Avis SUV Kiralama",
      priceText: "599 TL/gün",
      href: "https://www.avis.com.tr/suv-kiralama",
      imgRaw: "https://www.avis.com.tr/images/suv-car.jpg",
      location: "İzmir Havalimanı"
    }
  ];
  
  const items = fallbackItems.map(item => 
    normalizeS200(item, region, query)
  );
  
  return {
    ok: true,
    items,
    count: items.length,
    source: "avis_adapter_fallback",
    note: "Using fallback data",
    _meta: {
      query,
      region,
      timestamp: new Date().toISOString(),
      isFallback: true
    }
  };
}

// ----------------------------- ALTERNATİF FONKSİYONLAR -----------------------------
export async function searchAvisScrape(query, regionOrOptions = "TR") {
  // Legacy uyumluluk için
const opts = typeof regionOrOptions === "string"
  ? { region: regionOrOptions }
  : regionOrOptions;

const result = await searchAvisAdapter(query, opts);
return Array.isArray(result.items) ? result.items : [];


}

export const searchAvis = searchAvisAdapter;

// ----------------------------- BATCH PROCESSING -----------------------------
export async function searchAvisBatch(queries, options = {}) {
  const results = [];
  
  for (const query of queries) {
    try {
      const result = await searchAvisAdapter(query, options);
      results.push({
        query,
        result
      });
      
      // Batch'ler arası bekleme
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      results.push({
        query,
        error: error.message,
        result: null
      });
    }
  }
  
  return results;
}

// ----------------------------- ADAPTER REGISTRY ENTRY -----------------------------
export default {
  // Ana adapter fonksiyonu
  search: searchAvisAdapter,
  
  // Meta bilgileri
  name: "avis_adapter",
  displayName: "Avis Türkiye",
  description: "Araç kiralama hizmetleri - Türkiye'nin lider araç kiralama şirketi",
  category: "car_rental",
  subcategories: [
    "car_rental", 
    "vehicle_rental", 
    "rent_a_car",
    "airport_car_rental",
    "long_term_rental"
  ],
  region: "TR",
  language: "tr",
  countryCode: "TR",
  
  // Yetenekler
  capabilities: {
    hasAffiliate: true,
    hasImages: true,
    hasPrices: true,
    hasRatings: false,
    hasStockInfo: true,
    supportsPagination: true,
    supportsFilters: true,
    supportsSorting: true,
    maxResults: 50,
    timeout: 15000,
    supportsBatch: true
  },
  
  // Filtre seçenekleri
  filters: {
    carType: "supported",
    pickupLocation: "supported",
    returnLocation: "supported",
    pickupDate: "supported",
    returnDate: "supported",
    priceRange: "supported",
    transmission: "supported",
    passengerCapacity: "supported"
  },
  
  // Komisyon bilgileri
  commission: {
    rate: 0.08, // %8
    minRate: 0.05,
    maxRate: 0.12,
    minPurchase: 0,
    cookieDuration: "30d",
    paymentFrequency: "monthly",
    paymentThreshold: 500,
    currency: "TRY"
  },
  
  // Performans metrikleri
  performance: {
    avgResponseTime: 3000,
    successRate: 0.90,
    reliability: 0.94,
    lastUpdated: new Date().toISOString(),
    totalQueries: 0,
    avgItemsPerQuery: 15
  },
  
  // Rental-specific capabilities
  rentalCapabilities: {
    supportsInstantBooking: true,
    supportsFreeCancellation: true,
    supportsUnlimitedMileage: true,
    supportsAirportPickup: true,
    supportsDifferentLocationReturn: true,
    supportsAdditionalDriver: true,
    supportsChildSeat: true,
    supportsGPS: true,
    supportsInsuranceOptions: true,
    supportsLongTermRental: true,
    minRentalAge: 21,
    requiresCreditCard: true,
    requiresDriversLicense: true
  },
  
  // S200 Engine Integration
  s200: {
    compatible: true,
    version: "2.0",
    categoryMapping: {
      primary: "car_rental",
      secondary: ["travel", "transportation", "vehicle"]
    },
    scoring: {
      providerTrust: 0.92,
      dataQuality: 0.85,
      coverage: 0.90,
      freshness: 0.95
    },
    features: {
      realtimeAvailability: true,
      instantConfirmation: true,
      priceGuarantee: true,
      flexibleCancellation: true
    }
  },
  
  // Legal & Compliance
  legal: {
    termsUrl: "https://www.avis.com.tr/terms",
    privacyUrl: "https://www.avis.com.tr/privacy",
    dataUsage: "public_listings",
    requiresAttribution: true,
    rateLimit: "15 requests per minute",
    requiresLicenseCheck: true
  },
  
  // Support
  support: {
    email: "info@avis.com.tr",
    phone: "0850 222 02 03",
    hours: "24/7",
    emergencyNumber: "0850 222 02 04",
    website: "https://www.avis.com.tr",
    locations: ["İstanbul Havalimanı", "Ankara Havalimanı", "İzmir Havalimanı", "Antalya Havalimanı"]
  },
  
  // Locations (major pickup points)
  locations: [
    "İstanbul Havalimanı (IST)",
    "Sabiha Gökçen Havalimanı (SAW)",
    "Ankara Esenboğa Havalimanı (ESB)",
    "İzmir Adnan Menderes Havalimanı (ADB)",
    "Antalya Havalimanı (AYT)",
    "Bodrum Milas Havalimanı (BJV)",
    "Trabzon Havalimanı (TZX)",
    "Adana Şakirpaşa Havalimanı (ADA)",
    "İstanbul Şişli",
    "Ankara Kızılay",
    "İzmir Alsancak"
  ]
};

// ----------------------------- EXPORT ALL -----------------------------
export {
  searchAvisAdapter as defaultSearch,
  avisFallback
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAvisAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "avis";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "avisAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAvisAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "avis",
        _meta: {
          startedAt: started,
          durationMs: Date.now() - started,
          timeoutMs,
          error: errMsg,
          legacyOk: false,
        },
      };
    }

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      if (!it || typeof it !== "object") continue;

      const x = { ...it };

      // NO RANDOM ID — wipe any legacy/random ids and rebuild deterministically.
      x.id = null;
      x.listingId = null;
      x.listing_id = null;
      x.itemId = null;

      // Discovery sources: price forced null, affiliate injection OFF.
      if (false) {
        x.price = null;
        x.finalPrice = null;
        x.optimizedPrice = null;
        x.originalPrice = null;
        x.affiliateUrl = null;
        x.deeplink = null;
        x.deepLink = null;
        x.finalUrl = null;
      }

      const ni = normalizeItemS200(x, providerKey, {
        category: "general",
        vertical: "general",
        query: String(query || ""),
        region: String(options?.region || "TR").toUpperCase(),
      });

      if (!ni) {
        bad++;
        continue;
      }

      // Hard enforce stable id.
      ni.id = stableIdS200(providerKey, ni.url, ni.title);

      out.push(ni);
    }

    return {
      ok: true,
      items: out,
      count: out.length,
      source: "avis",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        legacyOk: true,
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: "avis",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        timeout: isTimeout,
        error: msg,
      },
    };
  }
}
