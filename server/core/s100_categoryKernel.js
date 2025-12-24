// ============================================================================
// S100 CATEGORY KERNEL — MULTI-CATEGORY + HARD FALLBACK ENGINE
// Amaç: 173+ adapter arasında hangi grupların devreye gireceğini SEÇMEK.
// Sonuç: Motor boğulmaz, ürün/hizmet kesin çıkar.
// ============================================================================

import stringSimilarity from "string-similarity";

const GROUP_MAP = {
  product: [
    "ürün", "elektronik", "beyaz eşya", "telefon", "bilgisayar",
    "ütü", "kıyafet", "ayakkabı", "aksesuar", "market", "alışveriş"
  ],

  fashion: [
    "giyim", "moda", "elbise", "pantolon", "mont", "ayakkabı", "çanta"
  ],

  food: [
    "yemek", "restoran", "lokanta", "kurye", "getir", "yeme içme"
  ],

  travel: [
    "otel", "hotel", "uçuş", "uçak", "bilet", "seyahat", "booking",
    "gezi", "tatil", "villa", "pansiyon"
  ],

  car_rental: [
    "araç", "oto", "araba", "rent a car", "kiralık", "car rental"
  ],

  estate: [
    "satılık", "kiralık", "daire", "ev", "emlak", "arsa"
  ],

  event: [
    "etkinlik", "konser", "tiyatro", "festival", "bilet"
  ],

  health: [
    "hastane", "checkup", "check-up", "muayene", "tahlil", "göz", "diyet"
  ],

  education: [
    "kurs", "egitim", "sertifika", "üniversite", "yazılım kursu"
  ]
};

// ============================================================================
// 1) Temel kategori tahmini (çoklu eşleşme destekli)
// ============================================================================
export function s100_detectCategories(query) {
  const q = String(query || "").toLowerCase().trim();

  const scores = [];

  for (const [group, keywords] of Object.entries(GROUP_MAP)) {
    let maxScore = 0;

    for (const kw of keywords) {
      const ratio = stringSimilarity.compareTwoStrings(q, kw);
      if (ratio > maxScore) maxScore = ratio;

      if (q.includes(kw)) maxScore = Math.max(maxScore, 0.9);
    }

    if (maxScore >= 0.38) {
      scores.push({ group, score: maxScore });
    }
  }

  // Eğer hiçbir kategori net çıkmadıysa → product fallback
  if (scores.length === 0) {
    return [{ group: "product", score: 1 }];
  }

  // Çoklu kategori: skora göre sıralayıp dön
  return scores.sort((a, b) => b.score - a.score);
}

// ============================================================================
// 2) Adapter gruplarını seçen final fonksiyon
// ============================================================================
export function s100_resolveAdapterGroups(query) {
  const cats = s100_detectCategories(query);
  const primary = cats[0]?.group || "product";

  // ÜRÜN fallback HER ZAMAN açık
  const result = new Set(["product"]);

  // Primary kategori daima eklenir
  result.add(primary);

  // Ek kategori eşleşmeleri de eklenir (motor B seçeneği tamam)
  cats.forEach(c => result.add(c.group));

  return Array.from(result);
}
