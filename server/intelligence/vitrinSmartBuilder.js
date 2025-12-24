// BACKEND/intelligence/vitrinSmartBuilder.js
// Kümülatif 2. kart için beyin: query + intent + adapter sonuçlarından "smart" liste üretir.

import { analyzeQuery } from "./semanticCategoryEngine.js";
import { buildSuggestionTypes } from "./suggestionMatrix.js";
import { buildSmartFromItems } from "./adapterTrigger.js";

/**
 * buildSmartCard:
 *  - query, region: kullanıcı isteği
 *  - items: adapterEngine'den gelen normalize edilmiş sonuçlar
 *  - best: 1. kartta gösterilen şampiyon satıcı
 *  - adapterData: orijinal adapter cevabı (opsiyonel)
 */
export async function buildSmartCard({
  query = "",
  region = "TR",
  items = [],
  best = null,
  adapterData = null,
}) {
  try {
    const analysis = await analyzeQuery(query, region);
    const suggestionTypes = buildSuggestionTypes(analysis);

    const baseItems =
      Array.isArray(items) && items.length
        ? items
        : Array.isArray(adapterData?.items)
        ? adapterData.items
        : [];

    if (!baseItems.length) return [];

    const smart = buildSmartFromItems({
      items: baseItems,
      best,
      analysis,
      suggestionTypes,
      maxItems: 8,
    });

    return smart;
  } catch (err) {
    console.warn("⚠️ buildSmartCard hata:", err.message);
    const safe = Array.isArray(items) ? items : [];
    return safe.filter((x) => x && x !== best).slice(0, 6);
  }
}

export default {
  buildSmartCard,
};
