// BACKEND/intelligence/queryClassifier.js
// Kullanıcı sorgusunu (query) temel intent + kategoriye çeviren hafif beyin.
// Türkçe + İngilizce anahtar kelimeler için mevcut intentEngine'i kullanır.

import { detectIntent } from "../core/intentEngine.js";

/**
 * classifyQuery:
 *  - query: orijinal metin
 *  - intent: "hotel" | "flight" | "car_rental" | "food" | "location" | "product"
 *  - category: "travel" | "food" | "location" | "product"
 */
export async function classifyQuery(query = "") {
  const base = await detectIntent(query || "");

  const intent = base?.type || "product";
  const q = (base?.query || query || "").trim();
  let category = "product";

  if (["hotel", "flight", "car_rental"].includes(intent)) {
    category = "travel";
  } else if (intent === "food") {
    category = "food";
  } else if (intent === "location") {
    category = "location";
  }

  // Çok primitif güven skoru – ileride kullanıcı davranışıyla güçlendirilebilir
  let confidence = 0.6;
  if (q.length > 2) confidence = 0.8;
  if (["travel", "food", "location"].includes(category)) confidence += 0.1;
  if (confidence > 0.95) confidence = 0.95;

  return {
    ok: true,
    query: q,
    intent,
    category,
    confidence,
  };
}

export default {
  classifyQuery,
};
