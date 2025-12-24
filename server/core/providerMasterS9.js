// server/core/providerMasterS9.js
// ============================================================
// H E R K Ü L  S 9 / S 1 2 / S 1 5  —  PROVIDER MASTER TABLE
// ------------------------------------------------------------
// Amaç:
//   - Tüm provider'lar için TEK MERKEZ "gerçek kaynak"
//   - commissionEngine, affiliateEngine, adapterEngine, rewardEngine
//     hepsi buradan beslenecek.
// ------------------------------------------------------------
// NOT:
//   - Buradaki oranlar GERÇEK KOMİSYON DEĞİL, iç ranking için
//     normalize edilmiş "relative weight" değerleridir.
//   - Hiçbir yerde doğrudan kullanıcıya gösterilmez.
// ============================================================

import { getLearnedProviderPriority } from "./dynamicProviderPriority.js";

// Küçük helper: güvenli string
function safeStr(v) {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

// Provider türleri örnek:
//   - "marketplace"
//   - "fashion"
//   - "electronics"
//   - "travel"
//   - "flight"
//   - "hotel"
//   - "event"
//   - "estate"
//   - "food"
//   - "grocery"
//   - "rental"
//   - "services"
//   - "mixed"
//
// Tier (stratejik önem):
//   1 = çekirdek
//   2 = güçlü ama ikinci halka
//   3 = niş / destekleyici

// ============================================================
// ANA TABLO — PROVIDER_MASTER_S9
// ============================================================
export const PROVIDER_MASTER_S9 = {
  // =============================
  //  BIG4 + GLOBAL DEVLER
  // =============================
  amazon: {
    key: "amazon",
    displayName: "Amazon",
    mainDomain: "amazon.com",
    altDomains: ["amazon.com.tr", "smile.amazon.com"],
    countryFocus: ["GLOBAL", "TR"],
    type: "marketplace",
    tier: 1,
    verticals: ["product", "electronics", "fashion", "home", "office"],
    trustScore: 0.96, // 0..1
    rankingWeight: 4.8, // providerPriority ile senkron
    commission: {
      // İç model – relative
      baseRate: 0.04,
      maxRate: 0.08,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network", // direct | affiliate_network | unknown
      defaultNetwork: "amazon_associates",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 5,
    },
    caps: {
      maxSlotsPerPage: 6, // S9.2’de Big4 gecikmeli limit
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  trendyol: {
    key: "trendyol",
    displayName: "Trendyol",
    mainDomain: "trendyol.com",
    altDomains: ["www.trendyol.com"],
    countryFocus: ["TR"],
    type: "marketplace",
    tier: 1,
    verticals: ["product", "fashion", "electronics", "market"],
    trustScore: 0.94,
    rankingWeight: 4.7,
    commission: {
      baseRate: 0.035,
      maxRate: 0.07,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "ty_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 5,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 7, // Big4 +2
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  hepsiburada: {
    key: "hepsiburada",
    displayName: "Hepsiburada",
    mainDomain: "hepsiburada.com",
    altDomains: ["www.hepsiburada.com"],
    countryFocus: ["TR"],
    type: "marketplace",
    tier: 1,
    verticals: ["product", "electronics", "fashion", "home", "market"],
    trustScore: 0.9,
    rankingWeight: 4.5,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "hb_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 5,
      priorityGlobal: 2,
    },
    caps: {
      maxSlotsPerPage: 7,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  n11: {
    key: "n11",
    displayName: "n11",
    mainDomain: "n11.com",
    altDomains: ["www.n11.com"],
    countryFocus: ["TR"],
    type: "marketplace",
    tier: 1,
    verticals: ["product", "fashion", "electronics"],
    trustScore: 0.86,
    rankingWeight: 4.1,
    commission: {
      baseRate: 0.025,
      maxRate: 0.05,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "n11_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 7,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  aliexpress: {
    key: "aliexpress",
    displayName: "AliExpress",
    mainDomain: "aliexpress.com",
    altDomains: ["www.aliexpress.com"],
    countryFocus: ["GLOBAL"],
    type: "marketplace",
    tier: 2,
    verticals: ["product", "electronics", "fashion", "gadget"],
    trustScore: 0.8,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.05,
      maxRate: 0.08,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "aliexpress_portal",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 5,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  alibaba: {
    key: "alibaba",
    displayName: "Alibaba",
    mainDomain: "alibaba.com",
    altDomains: ["www.alibaba.com"],
    countryFocus: ["GLOBAL"],
    type: "b2b",
    tier: 2,
    verticals: ["product", "b2b", "wholesale"],
    trustScore: 0.82,
    rankingWeight: 3.7,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  "1688": {
    key: "1688",
    displayName: "1688",
    mainDomain: "1688.com",
    altDomains: [],
    countryFocus: ["CN"],
    type: "b2b",
    tier: 3,
    verticals: ["product", "b2b", "wholesale"],
    trustScore: 0.78,
    rankingWeight: 3.2,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 1,
      priorityGlobal: 2,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  ebay: {
    key: "ebay",
    displayName: "eBay",
    mainDomain: "ebay.com",
    altDomains: ["ebay.co.uk", "ebay.de", "ebay.fr"],
    countryFocus: ["GLOBAL"],
    type: "marketplace",
    tier: 2,
    verticals: ["product", "collectibles", "electronics"],
    trustScore: 0.83,
    rankingWeight: 3.6,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "ebay_partner_network",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  // =============================
  //  TR MARKET / GROCERY
  // =============================
  getir: {
    key: "getir",
    displayName: "Getir",
    mainDomain: "getir.com",
    altDomains: [],
    countryFocus: ["TR", "EU"],
    type: "grocery",
    tier: 2,
    verticals: ["food", "grocery", "market"],
    trustScore: 0.88,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.01,
      maxRate: 0.03,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  migros: {
    key: "migros",
    displayName: "Migros",
    mainDomain: "migros.com.tr",
    altDomains: [],
    countryFocus: ["TR"],
    type: "grocery",
    tier: 2,
    verticals: ["food", "grocery", "market"],
    trustScore: 0.9,
    rankingWeight: 4.0,
    commission: {
      baseRate: 0.01,
      maxRate: 0.02,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  carrefour: {
    key: "carrefour",
    displayName: "CarrefourSA",
    mainDomain: "carrefoursa.com",
    altDomains: ["carrefoursa.com.tr"],
    countryFocus: ["TR"],
    type: "grocery",
    tier: 2,
    verticals: ["food", "grocery", "market"],
    trustScore: 0.85,
    rankingWeight: 3.5,
    commission: {
      baseRate: 0.01,
      maxRate: 0.02,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  macrocenter: {
    key: "macrocenter",
    displayName: "Macrocenter",
    mainDomain: "macrocenter.com.tr",
    altDomains: [],
    countryFocus: ["TR"],
    type: "grocery",
    tier: 3,
    verticals: ["food", "grocery", "premium"],
    trustScore: 0.87,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  yemeksepeti: {
    key: "yemeksepeti",
    displayName: "Yemeksepeti",
    mainDomain: "yemeksepeti.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "food",
    tier: 2,
    verticals: ["food", "restaurant", "grocery"],
    trustScore: 0.89,
    rankingWeight: 3.8,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  // =============================
  //  MODA / FASHION DEVLERİ
  // =============================
  ciceksepeti: {
    key: "ciceksepeti",
    displayName: "ÇiçekSepeti",
    mainDomain: "ciceksepeti.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "marketplace",
    tier: 2,
    verticals: ["gift", "flower", "product", "market"],
    trustScore: 0.84,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0.025,
      maxRate: 0.05,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "ciceksepeti_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  zalando: {
    key: "zalando",
    displayName: "Zalando",
    mainDomain: "zalando.com",
    altDomains: [],
    countryFocus: ["EU"],
    type: "fashion",
    tier: 2,
    verticals: ["fashion", "shoes", "accessories"],
    trustScore: 0.87,
    rankingWeight: 3.8,
    commission: {
      baseRate: 0.04,
      maxRate: 0.08,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "zalando_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 1,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  shein: {
    key: "shein",
    displayName: "Shein",
    mainDomain: "shein.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 2,
    verticals: ["fashion"],
    trustScore: 0.75,
    rankingWeight: 3.2,
    commission: {
      baseRate: 0.06,
      maxRate: 0.10,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "shein_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  nike: {
    key: "nike",
    displayName: "Nike",
    mainDomain: "nike.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 2,
    verticals: ["fashion", "sports"],
    trustScore: 0.92,
    rankingWeight: 4.0,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "nike_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  adidas: {
    key: "adidas",
    displayName: "Adidas",
    mainDomain: "adidas.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 2,
    verticals: ["fashion", "sports"],
    trustScore: 0.91,
    rankingWeight: 4.0,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "adidas_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  puma: {
    key: "puma",
    displayName: "Puma",
    mainDomain: "puma.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 3,
    verticals: ["fashion", "sports"],
    trustScore: 0.85,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "puma_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  zara: {
    key: "zara",
    displayName: "Zara",
    mainDomain: "zara.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 2,
    verticals: ["fashion"],
    trustScore: 0.89,
    rankingWeight: 3.7,
    commission: {
      baseRate: 0.01,
      maxRate: 0.02,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  bershka: {
    key: "bershka",
    displayName: "Bershka",
    mainDomain: "bershka.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 3,
    verticals: ["fashion"],
    trustScore: 0.82,
    rankingWeight: 3.2,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  pullandbear: {
    key: "pullandbear",
    displayName: "Pull&Bear",
    mainDomain: "pullandbear.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "fashion",
    tier: 3,
    verticals: ["fashion"],
    trustScore: 0.82,
    rankingWeight: 3.2,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  // =============================
  //  ELEKTRONİK / TEKNOLOJİ
  // =============================
  mediamarkt: {
    key: "mediamarkt",
    displayName: "MediaMarkt",
    mainDomain: "mediamarkt.com.tr",
    altDomains: [],
    countryFocus: ["TR", "EU"],
    type: "electronics",
    tier: 2,
    verticals: ["electronics", "appliance"],
    trustScore: 0.88,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.015,
      maxRate: 0.03,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  teknosa: {
    key: "teknosa",
    displayName: "Teknosa",
    mainDomain: "teknosa.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "electronics",
    tier: 2,
    verticals: ["electronics", "appliance"],
    trustScore: 0.86,
    rankingWeight: 3.7,
    commission: {
      baseRate: 0.015,
      maxRate: 0.03,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  decathlon: {
    key: "decathlon",
    displayName: "Decathlon",
    mainDomain: "decathlon.com",
    altDomains: ["decathlon.com.tr"],
    countryFocus: ["GLOBAL", "TR"],
    type: "sports",
    tier: 2,
    verticals: ["sports", "outdoor", "fashion"],
    trustScore: 0.9,
    rankingWeight: 3.8,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "decathlon_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  ikea: {
    key: "ikea",
    displayName: "IKEA",
    mainDomain: "ikea.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "home",
    tier: 2,
    verticals: ["home", "furniture", "office"],
    trustScore: 0.93,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.01,
      maxRate: 0.03,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  // =============================
  //  TRAVEL / HOTEL / FLIGHT
  // =============================
  booking: {
    key: "booking",
    displayName: "Booking.com",
    mainDomain: "booking.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "hotel",
    tier: 1,
    verticals: ["hotel", "accommodation"],
    trustScore: 0.95,
    rankingWeight: 4.7,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "booking_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 5,
    },
    caps: {
      maxSlotsPerPage: 6,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: true,
    },
  },

  skyscanner: {
    key: "skyscanner",
    displayName: "Skyscanner",
    mainDomain: "skyscanner.com",
    altDomains: ["skyscanner.net"],
    countryFocus: ["GLOBAL"],
    type: "flight",
    tier: 1,
    verticals: ["flight"],
    trustScore: 0.94,
    rankingWeight: 4.5,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "skyscanner_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 5,
    },
    caps: {
      maxSlotsPerPage: 5,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: true,
    },
  },

  airbnb: {
    key: "airbnb",
    displayName: "Airbnb",
    mainDomain: "airbnb.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "hotel",
    tier: 1,
    verticals: ["accommodation"],
    trustScore: 0.92,
    rankingWeight: 4.4,
    commission: {
      baseRate: 0.01,
      maxRate: 0.02,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 5,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  agoda: {
    key: "agoda",
    displayName: "Agoda",
    mainDomain: "agoda.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "hotel",
    tier: 2,
    verticals: ["hotel"],
    trustScore: 0.88,
    rankingWeight: 3.8,
    commission: {
      baseRate: 0.04,
      maxRate: 0.08,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "agoda_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: true,
    },
  },

  trip: {
    key: "trip",
    displayName: "Trip.com",
    mainDomain: "trip.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "mixed",
    verticals: ["hotel", "flight"],
    tier: 2,
    trustScore: 0.86,
    rankingWeight: 3.7,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "trip_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: true,
    },
  },

  trivago: {
    key: "trivago",
    displayName: "Trivago",
    mainDomain: "trivago.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "hotel",
    tier: 2,
    verticals: ["hotel"],
    trustScore: 0.84,
    rankingWeight: 3.5,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: false,
      hasSubId: false,
      programType: "meta",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 2,
      priorityGlobal: 3,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  // Tur operatörleri (TR)
  tatilbudur: {
    key: "tatilbudur",
    displayName: "TatilBudur",
    mainDomain: "tatilbudur.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "hotel", "package"],
    trustScore: 0.87,
    rankingWeight: 3.6,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "tatilbudur_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  tatilsepeti: {
    key: "tatilsepeti",
    displayName: "TatilSepeti",
    mainDomain: "tatilsepeti.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "hotel", "package"],
    trustScore: 0.86,
    rankingWeight: 3.6,
    commission: {
      baseRate: 0.03,
      maxRate: 0.06,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "tatilsepeti_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  setur: {
    key: "setur",
    displayName: "Setur",
    mainDomain: "setur.com.tr",
    altDomains: [],
    countryFocus: ["TR"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "hotel"],
    trustScore: 0.9,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  jolly: {
    key: "jolly",
    displayName: "Jolly",
    mainDomain: "jollytur.com",
    altDomains: ["jollytur.com.tr"],
    countryFocus: ["TR"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "hotel"],
    trustScore: 0.86,
    rankingWeight: 3.5,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: false,
      hasSubId: false,
      programType: "unknown",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  mngtur: {
    key: "mngtur",
    displayName: "MNG Turizm",
    mainDomain: "mngtur.com.tr",
    altDomains: [],
    countryFocus: ["TR"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "hotel", "package"],
    trustScore: 0.84,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0.03,
      maxRate: 0.05,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "mngtur_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 3,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  getyourguide: {
    key: "getyourguide",
    displayName: "GetYourGuide",
    mainDomain: "getyourguide.com",
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "tour",
    tier: 2,
    verticals: ["tour", "activity"],
    trustScore: 0.9,
    rankingWeight: 3.9,
    commission: {
      baseRate: 0.05,
      maxRate: 0.08,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "gyg_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 4,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: true,
    },
  },

  // =============================
  //  EVENT / BİLET
  // =============================
  biletix: {
    key: "biletix",
    displayName: "Biletix",
    mainDomain: "biletix.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "event",
    tier: 2,
    verticals: ["event", "concert", "theatre"],
    trustScore: 0.9,
    rankingWeight: 3.8,
    commission: {
      baseRate: 0.02,
      maxRate: 0.04,
      hasDeepLink: false,
      hasSubId: false,
      programType: "ticket",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  passo: {
    key: "passo",
    displayName: "Passo",
    mainDomain: "passo.com.tr",
    altDomains: [],
    countryFocus: ["TR"],
    type: "event",
    tier: 2,
    verticals: ["event", "sport", "concert"],
    trustScore: 0.88,
    rankingWeight: 3.6,
    commission: {
      baseRate: 0.01,
      maxRate: 0.02,
      hasDeepLink: false,
      hasSubId: false,
      programType: "ticket",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 4,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  biletino: {
    key: "biletino",
    displayName: "Biletino",
    mainDomain: "biletino.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "event",
    tier: 2,
    verticals: ["event", "concert", "festival"],
    trustScore: 0.85,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0.03,
      maxRate: 0.05,
      hasDeepLink: true,
      hasSubId: true,
      programType: "affiliate_network",
      defaultNetwork: "biletino_affiliate",
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: true,
      supportsCashback: false,
    },
  },

  // =============================
  //  EMLAK / ESTATE
  // =============================
  sahibinden: {
    key: "sahibinden",
    displayName: "Sahibinden",
    mainDomain: "sahibinden.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "estate",
    tier: 1,
    verticals: ["estate", "vehicle", "classified"],
    trustScore: 0.93,
    rankingWeight: 4.4,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 5,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 8,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  emlakjet: {
    key: "emlakjet",
    displayName: "Emlakjet",
    mainDomain: "emlakjet.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "estate",
    tier: 2,
    verticals: ["estate"],
    trustScore: 0.86,
    rankingWeight: 3.5,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  zingat: {
    key: "zingat",
    displayName: "Zingat",
    mainDomain: "zingat.com",
    altDomains: [],
    countryFocus: ["TR"],
    type: "estate",
    tier: 2,
    verticals: ["estate"],
    trustScore: 0.84,
    rankingWeight: 3.4,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: true,
    },
    traffic: {
      priorityTR: 3,
      priorityGlobal: 0,
    },
    caps: {
      maxSlotsPerPage: 4,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },

  // =============================
  //  UNKNOWN / FALLBACK
  // =============================
  unknown: {
    key: "unknown",
    displayName: "Unknown",
    mainDomain: null,
    altDomains: [],
    countryFocus: ["GLOBAL"],
    type: "mixed",
    tier: 3,
    verticals: ["product"],
    trustScore: 0.4,
    rankingWeight: 1.0,
    commission: {
      baseRate: 0,
      maxRate: 0,
      hasDeepLink: false,
      hasSubId: false,
      programType: "none",
      defaultNetwork: null,
      isStable: false,
    },
    traffic: {
      priorityTR: 1,
      priorityGlobal: 1,
    },
    caps: {
      maxSlotsPerPage: 2,
    },
    flags: {
      supportsCoupons: false,
      supportsCashback: false,
    },
  },
};

// ============================================================
// S200 INTERNAL PROVIDERS PATCH (serpapi / googleplaces / osm vb.)
// ============================================================
try {
  const add = (key, entry) => {
    if (!PROVIDER_MASTER_S9[key]) PROVIDER_MASTER_S9[key] = entry;
  };

  add("serpapi", {
    key: "serpapi",
    displayName: "SerpAPI",
    type: "search",
    trustScore: 0.72,
    tier: 3,
    commission: false,
    domains: [],
    aliases: ["serp api", "serp"],
  });

  add("googleshopping", {
    key: "googleshopping",
    displayName: "Google Shopping",
    type: "search",
    trustScore: 0.76,
    tier: 3,
    commission: false,
    domains: ["shopping.google."],
    aliases: ["google shopping", "gshopping"],
  });

  add("googleplaces", {
    key: "googleplaces",
    displayName: "Google Places",
    type: "maps",
    trustScore: 0.78,
    tier: 3,
    commission: false,
    domains: ["google.com", "maps.google."],
    aliases: ["google places", "places"],
  });

  add("openstreetmap", {
    key: "openstreetmap",
    displayName: "OpenStreetMap",
    type: "maps",
    trustScore: 0.74,
    tier: 3,
    commission: false,
    domains: ["openstreetmap.org"],
    aliases: ["osm", "open street map"],
  });

  add("barcode", {
    key: "barcode",
    displayName: "Barcode",
    type: "utility",
    trustScore: 0.7,
    tier: 4,
    commission: false,
    domains: [],
    aliases: ["barkod", "ean", "upc"],
  });

  add("lawyer", {
    key: "lawyer",
    displayName: "Avukat",
    type: "service",
    trustScore: 0.7,
    tier: 4,
    commission: false,
    domains: [],
    aliases: ["avukat", "hukuk"],
  });

  add("market", {
    key: "market",
    displayName: "Market",
    type: "commerce",
    trustScore: 0.7,
    tier: 4,
    commission: false,
    domains: [],
    aliases: ["grocery", "supermarket"],
  });
} catch {}


// ============================================================
// HELPER FONKSİYONLAR (S9 CORE)
// ============================================================
export function normalizeProviderKeyS9(provider) {
  const raw = safeStr(provider).toLowerCase();
  if (!raw) return "unknown";

  // NEW S9 PATCH — adapter/scraper takısı temizleme
  const cleaned = raw
    .replace(/adapter|scraper|engine|client|api/gi, "")
    .replace(/www\./g, "")
    .replace(/\.com(\.tr)?/g, "")
    .trim();

  // Bundan sonra tüm eşleşmeler cleaned üzerinden
  const r = cleaned;

  if (r.includes("amazon")) return "amazon";
  if (r.includes("trendyol")) return "trendyol";
  if (r.includes("hepsiburada")) return "hepsiburada";
  if (r.includes("n11")) return "n11";

  if (r.includes("ciceksepeti")) return "ciceksepeti";
  if (r.includes("zalando")) return "zalando";
  if (r.includes("shein")) return "shein";

  if (r.includes("nike")) return "nike";
  if (r.includes("adidas")) return "adidas";
  if (r.includes("puma")) return "puma";

  if (r.includes("decathlon")) return "decathlon";
  if (r.includes("ikea")) return "ikea";
  if (r.includes("zara")) return "zara";

  if (r.includes("mediamarkt")) return "mediamarkt";
  if (r.includes("teknosa")) return "teknosa";

  if (r.includes("booking")) return "booking";
  if (r.includes("skyscanner")) return "skyscanner";
  if (r.includes("airbnb")) return "airbnb";
  if (r.includes("agoda")) return "agoda";

  if (r.includes("trip")) return "trip";
  if (r.includes("trivago")) return "trivago";

  if (r.includes("biletino")) return "biletino";
  if (r.includes("biletix")) return "biletix";
  if (r.includes("passo")) return "passo";
  if (r.includes("getyourguide")) return "getyourguide";

  if (r.includes("tatilbudur")) return "tatilbudur";
  if (r.includes("tatilsepeti")) return "tatilsepeti";
  if (r.includes("jolly")) return "jolly";
  if (r.includes("mngtur")) return "mngtur";
  if (r.includes("setur")) return "setur";

  if (r.includes("getir")) return "getir";
  if (r.includes("yemeksepeti")) return "yemeksepeti";
  if (r.includes("carrefour")) return "carrefour";
  if (r.includes("macrocenter")) return "macrocenter";
  if (r.includes("migros")) return "migros";

  if (r.includes("aliexpress")) return "aliexpress";
  if (r.includes("alibaba")) return "alibaba";
  if (r.includes("1688")) return "1688";
  if (r.includes("ebay")) return "ebay";

  // Eğer cleaned zaten key ise
  if (PROVIDER_MASTER_S9[r]) return r;

  return "unknown";
}

// meta çek
export function getProviderMetaS9(provider) {
  const key = normalizeProviderKeyS9(provider);
  return PROVIDER_MASTER_S9[key] || PROVIDER_MASTER_S9.unknown;
}

// sadece komisyon oranı (S9 için)
//   - default: baseRate
//   - eğer hiç yoksa 0
export function getProviderCommissionRateS9(provider) {
  const meta = getProviderMetaS9(provider);
  const r = meta?.commission?.baseRate;
  if (typeof r === "number" && Number.isFinite(r) && r > 0) return r;
  return 0;
}

// güven skorunu çek (0..1)
export function getProviderTrustScoreS9(provider) {
  const meta = getProviderMetaS9(provider);
  const t = meta?.trustScore;
  if (typeof t === "number" && t >= 0 && t <= 1) return t;
  return 0.4;
}

// ranking weight (providerPriority için)
//  default: 1
export function getProviderRankingWeightS9(provider) {
  const meta = getProviderMetaS9(provider);
  const w = meta?.rankingWeight;
  if (typeof w === "number" && Number.isFinite(w) && w > 0) return w;
  return 1;
}

// provider komisyonlu mu?
export function isCommissionableProviderS9(provider) {
  const meta = getProviderMetaS9(provider);
  const base = meta?.commission?.baseRate || 0;
  const max = meta?.commission?.maxRate || 0;
  return base > 0 || max > 0;
}

// affiliate link için kritik flag'ler
export function getProviderAffiliateCapabilitiesS9(provider) {
  const meta = getProviderMetaS9(provider);
  const c = meta?.commission || {};
  return {
    hasAffiliate: (c.baseRate || 0) > 0 || (c.maxRate || 0) > 0,
    hasDeepLink: !!c.hasDeepLink,
    hasSubId: !!c.hasSubId,
    programType: c.programType || "unknown",
    defaultNetwork: c.defaultNetwork || null,
  };
}

// Ülke / dikey bazlı basit öncelik (ileride AI ile güçlendirilebilir)
export function getProviderGeoPriorityS9(provider, region = "TR") {
  const meta = getProviderMetaS9(provider);
  const r = safeStr(region).toUpperCase();

  if (!meta.traffic) {
    return 1;
  }

  if (r === "TR") {
    return meta.traffic.priorityTR ?? 1;
  }

  return meta.traffic.priorityGlobal ?? 1;
}

// ============================================================================
//  S9 → S12 PROVIDER MASTER FUSION LAYER
//  (Eski S9 tablo KORUNUR, üstüne S12 intelligence eklenir)
// ============================================================================

// RevenueMemory ile lazy import — dosya eksikse sistem patlamasın
let _revenueEngineModule = null;

async function getProviderRevenueStatsSafe(provider) {
  try {
    if (!_revenueEngineModule) {
      _revenueEngineModule = await import("./revenueMemoryEngine.js");
    }
    const fn = _revenueEngineModule.getProviderRevenueStats;
    if (typeof fn === "function") {
      return await fn(provider);
    }
  } catch {
    // sessiz fallback
  }
  return null;
}

// ============================================================
// Gelişmiş domain extractor (S12)
// ============================================================
export function extractDomainS12(input) {
  if (!input) return "";

  let url = String(input).trim().toLowerCase();

  try {
    if (url.startsWith("http")) {
      const u = new URL(url);
      url = u.hostname;
    }
  } catch {
    // raw string olarak devam
  }

  url = url
    .replace(/^www\./, "")
    .replace(/^m\./, "")
    .replace(/^mobile\./, "")
    .replace(/\.co\./, ".com.");

  return url;
}

// ============================================================
// S12 normalize (domain intelligence + S9 fallback)
// ============================================================
export function normalizeProviderKeyS12(provider) {
  const dom = extractDomainS12(provider);
  if (!dom) return normalizeProviderKeyS9(provider);

  for (const [key, entry] of Object.entries(PROVIDER_MASTER_S9)) {
    if (!entry.mainDomain) continue;

    if (dom.includes(entry.mainDomain)) return key;

    if (Array.isArray(entry.altDomains)) {
      for (const d of entry.altDomains) {
        if (dom.includes(d)) return key;
      }
    }
  }

  // domain ile yakalayamazsak S9 text bazlı normalize
  return normalizeProviderKeyS9(provider);
}

// ============================================================
// S12 meta (S9 üzerinde gelişmiş yorum)
// ============================================================
export function getProviderMetaS12(provider) {
  const k = normalizeProviderKeyS12(provider);
  return PROVIDER_MASTER_S9[k] || PROVIDER_MASTER_S9.unknown;
}

// ============================================================
// S12 risk score (fraud + stability + affiliate health)
// 0..1 arası, 1 = düşük risk
// ============================================================
export function computeProviderRiskScoreS12(provider) {
  const m = getProviderMetaS12(provider);
  let score = 1;

  // affiliate stabil değilse ceza
  if (m.commission?.isStable === false) score -= 0.25;

  // program tipi bilinmiyorsa hafif ceza
  if (["unknown", "none"].includes(m.commission?.programType)) {
    score -= 0.1;
  }

  // düşük güven → ceza
  if ((m.trustScore || 0) < 0.7) score -= 0.2;

  return Math.max(0, score);
}

// ============================================================
// S12 RevenueMemory Fusion (trend + conversion + freshness)
// ============================================================
export async function computeProviderNeuroScoreS12(provider) {
  try {
    const stats = await getProviderRevenueStatsSafe(provider);
    return stats?.neuroScore || 0;
  } catch {
    return 0;
  }
}

// ============================================================
// S12 Global Provider Priority (TOTAL BRAIN)
// trust + commission + geo + rankingWeight + risk + neuro
// ============================================================
export async function computeProviderPriorityS12(provider, region = "TR") {
  const key = normalizeProviderKeyS12(provider);
  const m = getProviderMetaS12(key);

  const trust = m.trustScore || 0.5;
  const commission = getProviderCommissionRateS9(key); // 0..0.1 arası gibi
  const geo = getProviderGeoPriorityS9(key, region) / 5; // 0..1
  const baseWeight = getProviderRankingWeightS9(key) / 5; // 0..1

  const risk = computeProviderRiskScoreS12(key); // 0..1
  const neuro = await computeProviderNeuroScoreS12(key); // 0..1 bekleniyor

  // S12 ağırlıklı formül
  const score =
    trust * 0.32 +
    commission * 0.18 +
    geo * 0.12 +
    baseWeight * 0.18 +
    neuro * 0.15 +
    risk * 0.05;

  return score;
}

// ============================================================
// S12 item-level global sort
//  - items: vitrin sonuç listesi
//  - region: "TR" vs "GLOBAL"
//  Her item'a __providerScoreS12 ekler, ona göre sıralar.
// ============================================================
export async function sortByProviderPriorityS12(items, region = "TR") {
  if (!Array.isArray(items)) return [];

  const enriched = await Promise.all(
    items.map(async (item) => {
      const providerKey = normalizeProviderKeyS12(item.provider);
      const score = await computeProviderPriorityS12(providerKey, region);
      return { ...item, __providerScoreS12: score };
    })
  );

  return enriched.sort(
    (a, b) => (b.__providerScoreS12 || 0) - (a.__providerScoreS12 || 0)
  );
}

// ============================================================================
//  S15 — TOTAL PROVIDER PRIORITY ENGINE
//  Static (S9) + S12 (trust/commission/geo/neuro) + Dynamic click learning
// ============================================================================

export async function computeProviderTotalScoreS15(provider, opts = {}) {
  const { region = "TR" } = opts;
  const key = normalizeProviderKeyS12(provider);
  const meta = getProviderMetaS12(key);

  // S12 baz skoru (0..1 civarı kabul ediyoruz)
  const baseScoreRaw = await computeProviderPriorityS12(key, region);
  const baseScore = Math.min(1, Math.max(0, baseScoreRaw || 0));

  // Dinamik öğrenme: dynamicProviderPriority.json → 0..5 level
  let learnedScore = 0;
  try {
    const map = (typeof getLearnedProviderPriority === "function"
      ? getLearnedProviderPriority()
      : {}) || {};

    const normKey = normalizeProviderKeyS9(key);
    const level =
      typeof map[normKey] === "number"
        ? map[normKey]
        : typeof map[key] === "number"
        ? map[key]
        : 0;

    if (level > 0) {
      learnedScore = Math.min(1, Math.max(0, level / 5));
    }
  } catch {
    learnedScore = 0;
  }

  // Tier bazlı hafif boost
  let tierBoost = 0;
  if (meta?.tier === 1) tierBoost = 0.06;
  else if (meta?.tier === 2) tierBoost = 0.03;

  const trust = meta?.trustScore ?? 0.5;

  // Nihai skor
  const total =
    baseScore * 0.64 +
    learnedScore * 0.18 +
    tierBoost * 0.1 +
    trust * 0.08;

  return Math.min(1, Math.max(0, +total.toFixed(6)));
}

export async function sortByProviderPriorityS15(items, opts = {}) {
  const { region = "TR" } = opts;
  if (!Array.isArray(items)) return [];

  const enriched = await Promise.all(
    items.map(async (item) => {
      const prov = item.provider || item.source || "unknown";
      const score = await computeProviderTotalScoreS15(prov, { region });
      return {
        ...item,
        __providerScoreS15: score,
      };
    })
  );

  return enriched.sort(
    (a, b) => (b.__providerScoreS15 || 0) - (a.__providerScoreS15 || 0)
  );
}
export function providerPriority(provider) {
  try {
    const key = normalizeProviderKeyS9(provider);
    const meta = PROVIDER_MASTER_S9[key];

    if (!meta) return 1;

    const w = meta.rankingWeight;
    if (typeof w === "number" && w > 0) {
      return Math.min(5, Math.max(1, w));
    }

    return 1;
  } catch {
    return 1;
  }
}


// ============================================================
// S120 / TITAN — POLICY BOOST (S9 Score ile uyumlu)
// ============================================================
export function providerPolicyBoost(providerKey = "") {
  const p = String(providerKey).toLowerCase();

  if (p.includes("trendyol")) return 0.06;
  if (p.includes("hepsiburada")) return 0.05;
  if (p.includes("amazon")) return 0.04;
  if (p.includes("n11")) return 0.03;

  if (p.includes("aliexpress")) return 0.02;
  if (p.includes("getir")) return 0.015;
  if (p.includes("migros")) return 0.015;

  if (p.includes("booking")) return 0.03;
  if (p.includes("skyscanner")) return 0.03;
  if (p.includes("agoda")) return 0.025;

  if (p.includes("biletino")) return 0.02;
  if (p.includes("biletix")) return 0.015;
  if (p.includes("passo")) return 0.01;

  return 0;
}
// ============================================================
// LEGACY S9 — resolveProviderFromLinkS9
// Affiliate linklerinden provider çözmek için
// ============================================================
export function resolveProviderFromLinkS9(url = "") {
  const u = String(url).toLowerCase();

  if (u.includes("trendyol")) return "trendyol";
  if (u.includes("hepsiburada")) return "hepsiburada";
  if (u.includes("amazon")) return "amazon";
  if (u.includes("n11")) return "n11";

  if (u.includes("aliexpress")) return "aliexpress";
  if (u.includes("alibaba")) return "alibaba";

  if (u.includes("booking")) return "booking";
  if (u.includes("skyscanner")) return "skyscanner";
  if (u.includes("agoda")) return "agoda";
  if (u.includes("trip.com")) return "trip";

  if (u.includes("biletino")) return "biletino";
  if (u.includes("biletix")) return "biletix";
  if (u.includes("passo")) return "passo";

  return "unknown";
}

// ============================================================
// DEFAULT EXPORT
// ============================================================
export default {
  // S9 core
  PROVIDER_MASTER_S9,
  normalizeProviderKeyS9,
  getProviderMetaS9,
  getProviderCommissionRateS9,
  getProviderTrustScoreS9,
  getProviderRankingWeightS9,
  isCommissionableProviderS9,
  getProviderAffiliateCapabilitiesS9,
  getProviderGeoPriorityS9,

  // S12 fusion
  extractDomainS12,
  normalizeProviderKeyS12,
  getProviderMetaS12,
  computeProviderRiskScoreS12,
  computeProviderNeuroScoreS12,
  computeProviderPriorityS12,
  sortByProviderPriorityS12,

  // S15 total
  computeProviderTotalScoreS15,
  sortByProviderPriorityS15,

  // NEW S120 PATCHES
  providerPolicyBoost,
  resolveProviderFromLinkS9,
};
