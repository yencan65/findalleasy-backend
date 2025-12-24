// BACKEND/intelligence/semanticCategoryEngine.js
// Sorguyu daha ayrıntılı analiz eder: intent + kategori + alt kategori + slot.

import { classifyQuery } from "./queryClassifier.js";

const ELECTRONICS_KEYWORDS = [
  "telefon", "iphone", "samsung", "xiaomi", "huawei", "oppo", "vivo",
  "smartphone", "phone", "android", "ios",
  "laptop", "notebook", "macbook", "bilgisayar", "pc",
  "tablet", "ipad",
  "airpods", "kulaklık", "earbuds", "headphone", "watch", "akıllı saat",
];

const FASHION_KEYWORDS = [
  "elbise", "gömlek", "pantolon", "ayakkabı", "çanta", "tshirt", "t-shirt",
  "sneaker", "dress", "jeans", "coat", "jacket", "kazak", "etek", "shoe",
];

const PET_KEYWORDS = [
  "kedi", "köpek", "balık", "kuş", "mama", "kafes", "petshop",
  "cat", "dog", "fish", "bird", "pet food", "pet shop",
];

const AUTO_KEYWORDS = [
  "lastik", "jant", "akü", "motor yağı", "castrol", "shell",
  "oto yedek parça", "oto aksesuar", "araba parçası",
  "tire", "oil", "car part", "auto parts",
];

const SERVICE_KEYWORDS = [
  "usta", "tamir", "montaj", "kurulum", "tesisat", "boya", "badana",
  "repair", "installation", "service", "plumber", "electrician",
];

// Küçük yardımcı – çok dilli keyword eşleştirici
function includesAny(text, list) {
  const t = (text || "").toLowerCase();
  return list.some((k) => t.includes(k.toLowerCase()));
}

export async function analyzeQuery(query = "", region = "TR") {
  const base = await classifyQuery(query);
  const q = base.query || query || "";
  const text = q.toLowerCase();

  let subCategory = null;
  let slot = "generic";

  if (base.category === "travel") {
    if (includesAny(text, ["otel", "hotel", "resort", "pansiyon"])) {
      subCategory = "hotel";
      slot = "stay";
    } else if (includesAny(text, ["uçak", "flight", "bilet", "uçuş"])) {
      subCategory = "flight";
      slot = "transport";
    } else if (includesAny(text, ["araç kirala", "araba kirala", "rent a car", "car rental"])) {
      subCategory = "car_rental";
      slot = "transport";
    } else {
      subCategory = base.intent === "flight" || base.intent === "car_rental"
        ? base.intent
        : "travel_generic";
    }
  } else if (base.category === "food") {
    subCategory = "food";
    slot = "eat";
  } else if (base.category === "location") {
    subCategory = "location";
    slot = "poi"; // point of interest
  } else if (base.category === "product") {
    if (includesAny(text, ELECTRONICS_KEYWORDS)) {
      subCategory = "electronics";
      slot = "device";
    } else if (includesAny(text, FASHION_KEYWORDS)) {
      subCategory = "fashion";
      slot = "clothing";
    } else if (includesAny(text, PET_KEYWORDS)) {
      subCategory = "pet";
      slot = "pet";
    } else if (includesAny(text, AUTO_KEYWORDS)) {
      subCategory = "automotive";
      slot = "auto";
    } else if (includesAny(text, SERVICE_KEYWORDS)) {
      subCategory = "service";
      slot = "service";
    } else {
      subCategory = "generic_product";
      slot = "product";
    }
  } else {
    // Bilinmeyen durum – ürün gibi davran
    subCategory = "generic_product";
    slot = "product";
  }

  return {
    ...base,
    region,
    subCategory,
    slot,
  };
}

export default {
  analyzeQuery,
};
