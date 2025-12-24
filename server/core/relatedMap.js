// BACKEND/core/relatedMap.js
// =====================================================================
//   FindAllEasy — RELATED MAP (S15 ULTRA OMEGA EDITION)
//   SmartCard • IntentBrain • Cross-Domain Category Links
//   ZERO-DELETE: Eski tüm kategoriler KORUNDU + gelişmiş bağlar eklendi
//   • SuperClusters
//   • CrossDomainLinks
//   • Auto-Fallback Generator
// =====================================================================

export const relatedMap = {
  // ================================================================
  // GENEL - DEFAULT
  // ================================================================
  general: [
    "product",
    "electronics",
    "fashion",
    "home",
    "hotel",
    "tour",
    "flight",
    "car_rental",
    "food",
    "event",
  ],

  product: ["product", "electronics", "fashion", "home", "market"],
  unknown: ["product", "electronics"],

  // ================================================================
  // SUPER CLUSTER: ELECTRONICS
  // ================================================================
  electronics: [
    "electronics",
    "phone",
    "smartphone",
    "laptop",
    "tablet",
    "computer",
    "monitor",
    "tv",
    "console",
    "camera",
    "audio",
    "accessory",
    "gaming",        // S15 ek
    "smart_home",    // S15 ek
  ],

  phone: ["phone", "smartphone", "electronics", "accessory"],
  smartphone: ["smartphone", "phone", "electronics", "accessory"],
  laptop: ["laptop", "computer", "electronics", "accessory"],
  tablet: ["tablet", "electronics", "phone"],
  computer: ["computer", "laptop", "electronics"],
  monitor: ["monitor", "computer", "electronics"],
  tv: ["tv", "electronics", "audio"],
  console: ["console", "gaming", "electronics"],
  gaming: ["gaming", "console", "electronics", "pc_game", "vr"],

  pc_game: ["pc_game", "gaming", "console"],
  vr: ["vr", "gaming", "electronics"],

  camera: ["camera", "electronics", "accessory"],
  audio: ["audio", "headphone", "speaker", "electronics"],
  headphone: ["headphone", "audio", "electronics", "accessory"],
  speaker: ["speaker", "audio", "electronics"],
  accessory: ["accessory", "phone", "smartphone", "laptop", "electronics"],

  smart_home: ["smart_home", "electronics", "appliance"],

  // ================================================================
  // FASHION
  // ================================================================
  fashion: ["fashion", "clothing", "shoes", "accessory", "sportswear"],
  clothing: ["clothing", "fashion", "accessory"],
  shoes: ["shoes", "fashion", "sportswear"],
  sportswear: ["sportswear", "fashion", "clothing"],
  accessory_fashion: ["accessory", "fashion", "clothing"],
  beauty: ["beauty", "cosmetics", "personal_care"],
  cosmetics: ["cosmetics", "beauty", "personal_care"],
  personal_care: ["personal_care", "beauty", "cosmetics"],

  // ================================================================
  // HOME / LIFESTYLE
  // ================================================================
  home: [
    "home",
    "furniture",
    "decoration",
    "kitchen",
    "appliance",
    "cleaning",
    "smart_home",
  ],
  furniture: ["furniture", "home", "decoration"],
  decoration: ["decoration", "home", "furniture"],
  kitchen: ["kitchen", "home", "appliance"],
  appliance: ["appliance", "home", "electronics"],
  cleaning: ["cleaning", "home", "market"],

  // ================================================================
  // MARKET / FOOD
  // ================================================================
  market: ["market", "food", "supermarket", "drink", "snack"],
  food: ["food", "restaurant", "market"],
  supermarket: ["supermarket", "market", "food"],
  restaurant: ["restaurant", "food", "cafe"],
  cafe: ["cafe", "restaurant", "food"],
  drink: ["drink", "market", "food"],
  snack: ["snack", "market", "food"],

  // ================================================================
  // BABY / TOY / BOOK
  // ================================================================
  baby: ["baby", "toy", "kids"],
  kids: ["kids", "baby", "toy"],
  toy: ["toy", "kids", "baby"],
  book: ["book", "stationery", "office"],
  stationery: ["stationery", "office", "book"],
  office: ["office", "stationery", "electronics"],

  // ================================================================
  // SPORT
  // ================================================================
  sport: ["sport", "outdoor", "fitness"],
  outdoor: ["outdoor", "camping", "sport"],
  camping: ["camping", "outdoor"],
  fitness: ["fitness", "sport"],

  // ================================================================
  // AUTOMOTIVE
  // ================================================================
  auto: ["auto", "tire", "auto_part"],
  tire: ["tire", "auto", "auto_part"],
  auto_part: ["auto_part", "auto"],

  // ================================================================
  // TOURISM — ACCOMMODATION
  // ================================================================
  hotel: ["hotel", "resort", "spa", "pansiyon", "hostel", "villa"],
  resort: ["resort", "hotel", "spa"],
  spa: ["spa", "hotel", "resort"],
  pansiyon: ["pansiyon", "hotel", "hostel"],
  hostel: ["hostel", "pansiyon", "hotel"],
  villa: ["villa", "hotel", "resort"],

  // ================================================================
  // TOURISM — TRAVEL
  // ================================================================
  flight: ["flight", "hotel", "tour", "car_rental"],
  tour: ["tour", "hotel", "flight", "activity"],
  car_rental: ["car_rental", "transfer", "tour"],
  transfer: ["transfer", "car_rental", "tour"],
  bus: ["bus", "tour", "transfer"],
  train: ["train", "tour", "transfer"],

  // ================================================================
  // EVENTS / TICKETS
  // ================================================================
  event: ["event", "concert", "festival", "theater", "cinema", "activity"],
  concert: ["concert", "event", "festival"],
  festival: ["festival", "concert", "event"],
  theater: ["theater", "event"],
  cinema: ["cinema", "event"],
  museum: ["museum", "event", "activity"],
  activity: ["activity", "tour", "event", "gaming"], // gaming bağlantısı eklendi

  // ================================================================
  // SERVICES
  // ================================================================
  service: ["service", "lawyer", "doctor", "cleaning_service"],
  lawyer: ["lawyer", "service"],
  doctor: ["doctor", "service"],
  cleaning_service: ["cleaning_service", "service", "cleaning"],
  plumber: ["plumber", "service"],
  electrician: ["electrician", "service"],
};

// =====================================================================
//  S15 AUTO-FALLBACK ENGINE
//  Eğer ilgili kategori map'te yoksa otomatik yakın alan üretir.
// =====================================================================
export function getRelatedCategoriesS15(category) {
  const key = String(category || "").toLowerCase();

  if (relatedMap[key]) return relatedMap[key];

  // AUTO-SEMANTIC FALLBACK
  if (key.includes("hotel")) return relatedMap.hotel;
  if (key.includes("shop")) return relatedMap.market;
  if (key.includes("game")) return relatedMap.gaming;
  if (key.includes("phone")) return relatedMap.phone;
  if (key.includes("event")) return relatedMap.event;
  if (key.includes("food")) return relatedMap.food;

  // Default fallback
  return relatedMap.general;
}

// =====================================================================
// DEFAULT EXPORT
// =====================================================================
export default {
  relatedMap,
  getRelatedCategoriesS15,
};
