// server/core/commissionRates.js
// TAM DÜZGÜN, BİRLEŞTİRİLMİŞ, HATASIZ SÜRÜM

export const platformCommission = {
  trendyol: 0.05,
  hepsiburada: 0.05,
  amazon: 0.04,

  aliexpress: 0.03,
  etsy: 0.04,
  zalando: 0.06,
  mediamarkt: 0.05,

  ubisoft: 0.13,
  ciceksepeti: 0.03,

  tatilbudur: 0.04,
  otelz: 0.04,
  booking: 0.05,
  skyscanner: 0.04,

  unknown: 0.04
};

export const categoryMultiplier = {
  gaming: 1.4,
  books: 0.9,
  pet: 1.1,

  // Genel kategoriler
  hotel: 1.15,
  flight: 1.10,
  car_rental: 1.08,
  tour: 1.12,
  real_estate: 1.20,
  fashion: 1.05,
  electronics: 1.0,
  grocery: 0.95,
  food: 0.90,
  health: 1.10,

  unknown: 1.0
};

// Zaman faktörü (günün saatine göre küçük dinamizm)
export function timeFactor() {
  const h = new Date().getHours();
  if (h >= 7 && h <= 11) return 1.05; // sabah canlı trafik
  if (h >= 18 && h <= 23) return 1.10; // akşam prime time
  return 1.0;
}

// Kullanıcı davranışı (tıklama → indirim artışı)
export function behaviorFactor(clicks = 0) {
  if (clicks > 10) return 1.15;
  if (clicks > 5) return 1.10;
  if (clicks > 2) return 1.05;
  return 1.0;
}

// Adaptör skorlaması için static provider önceliği
export const providerPriority = {
  trendyol: 5,
  hepsiburada: 5,
  amazon: 4,
  aliexpress: 4,
  etsy: 3,
  zalando: 4,
  mediamarkt: 4,
  ciceksepeti: 3,
  tatilbudur: 4,
  otelz: 4,
  booking: 5,
  skyscanner: 4,

  ubisoft: 3,

  unknown: 1
};

export default {
  platformCommission,
  categoryMultiplier,
  timeFactor,
  behaviorFactor,
  providerPriority
};
