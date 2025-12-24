// BACKEND/intelligence/suggestionMatrix.js
// Intent + kategori + alt kategori kombinasyonundan kümülatif öneri tipleri üretir.

// Öneri tipleri soyut id'lerdir; adapterTrigger bunları gerçek item'lara çevirecek.
export function buildSuggestionTypes(analysis) {
  const intent = analysis?.intent || "product";
  const category = analysis?.category || "product";
  const sub = analysis?.subCategory || null;

  // Travel / Seyahat
  if (category === "travel") {
    if (sub === "hotel" || intent === "hotel") {
      return [
        "flight",
        "car_rental",
        "transfer",
        "tour",
        "activity",
        "restaurant",
      ];
    }
    if (sub === "flight" || intent === "flight") {
      return [
        "hotel",
        "car_rental",
        "transfer",
        "tour",
        "activity",
      ];
    }
    if (sub === "car_rental" || intent === "car_rental") {
      return [
        "hotel",
        "flight",
        "insurance",
        "service",
      ];
    }
    // Genel travel
    return [
      "hotel",
      "flight",
      "car_rental",
      "tour",
      "activity",
    ];
  }

  // Yemek
  if (category === "food") {
    return [
      "restaurant",
      "delivery",
      "dessert",
      "drink",
    ];
  }

  // Konum odaklı
  if (category === "location") {
    return [
      "poi",
      "restaurant",
      "activity",
      "transport",
    ];
  }

  // Ürün odaklı – alt kategoriye göre
  if (category === "product") {
    if (sub === "electronics") {
      return [
        "case",
        "screen_protector",
        "charger",
        "earphones",
        "powerbank",
        "warranty",
        "repair_service",
      ];
    }
    if (sub === "fashion") {
      return [
        "accessory",
        "shoes",
        "bag",
        "care_product",
      ];
    }
    if (sub === "pet") {
      return [
        "pet_food",
        "pet_accessory",
        "pet_toy",
      ];
    }
    if (sub === "automotive") {
      return [
        "tire",
        "service",
        "oil",
        "accessory",
      ];
    }
    if (sub === "service") {
      return [
        "related_service",
        "tools",
        "material",
      ];
    }

    // Generic ürün – klasik cross sell
    return [
      "similar_product",
      "accessory",
      "bundle",
    ];
  }

  // Fallback: hiçbir şey anlamazsak bile generic cross-sell tipleri dön
  return [
    "similar_product",
    "accessory",
    "bundle",
  ];
}

export default {
  buildSuggestionTypes,
};
