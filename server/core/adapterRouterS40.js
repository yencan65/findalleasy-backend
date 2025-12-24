// server/core/adapterRouterS40.js
// ============================================================
//  S40 ROUTER — Vitrin için tek giriş noktası
//  - ZERO DELETE: Eski runAdapters beyni aynen kullanılıyor.
//  - S40 safe intent + kategori ipucu
//  - B seçeneği: Çoklu kategori + C seçeneği: Zorunlu product fallback
// ============================================================

import {
  s40_safeDetectIntent,
  s40_mapIntentToCategory,
  runAdapters,
} from "./adapterEngine.js";

// Opsiyonel: global override için (admin panelde açarsın istersen)
export const S40_ROUTER_FLAGS = {
  forceCategory: null, // örn: "product" / "hotel" / "tour"
  disableSafeIntent: false,
};

// Vitrin tarafından kullanılan ana fonksiyon
export async function runAdaptersS40(query, opts = {}) {
  const q = String(query || "").trim();
  const region =
    typeof opts.region === "string" && opts.region.length <= 10
      ? opts.region
      : "TR";

  if (!q) {
    return {
      ok: false,
      category: "unknown",
      items: [],
      best: null,
      smart: [],
      others: [],
      _meta: {
        query: "",
        region,
        s40Category: "unknown",
        totalRawAdapters: 0,
        totalItemsAfterMerge: 0,
      },
    };
  }

  // ========================================================
  // 1) S40 SAFE INTENT → CATEGORY
  // ========================================================
  let primaryIntentCategory = "product";

  if (!S40_ROUTER_FLAGS.disableSafeIntent) {
    try {
      const rawIntent = s40_safeDetectIntent(q); // categoryBrain S100 ile uyumlu mini beyin
      primaryIntentCategory = s40_mapIntentToCategory(rawIntent);
    } catch {
      primaryIntentCategory = "product";
    }
  }

  // Manuel override (admin flag)
  if (typeof S40_ROUTER_FLAGS.forceCategory === "string") {
    primaryIntentCategory = S40_ROUTER_FLAGS.forceCategory.toLowerCase();
  }

  // ========================================================
  // 2) categoryHint hazırlama (S100 B seçeneği ile uyumlu)
  //    - primaryIntentCategory → S100’e ipucu
  //    - frontend’ten gelen categoryHint varsa ikisini harmanlıyoruz
  // ========================================================
  let categoryHint = null;

  if (typeof opts.categoryHint === "string" && opts.categoryHint.trim()) {
    // Hem intent kategorisini hem frontend ipucunu S100’e yediriyoruz
    const hintSet = new Set([
      primaryIntentCategory,
      opts.categoryHint.toLowerCase().trim(),
    ]);

    // "unknown" / "misc" çöplüğünü temizle
    hintSet.delete("");
    hintSet.delete("unknown");
    hintSet.delete("misc");

    // S100 inferCategoryS100 zaten çoklu kategori dönebiliyor,
    // biz `categoryHint` içini çoklu signalle hazırlıyoruz:
    categoryHint = Array.from(hintSet).join(",");
  } else {
    categoryHint = primaryIntentCategory;
  }

  // ========================================================
  // 3) ANA MOTOR ÇAĞRISI
  //    - runAdapters = dev beyin (S8 → S9 → S10 → S100 → S200)
  //    - productAdapters fallback C seçeneği zaten bunun içinde
  // ========================================================
  let result;
  try {
    result = await runAdapters(q, region, {
  categoryHint,
  visionLabels: opts.visionLabels || [],
  embedding: opts.embedding || null,
  source: opts.source || "text",
  qrPayload: opts.qrPayload || null,
});

  } catch (err) {
    console.warn("runAdaptersS40 hata:", err?.message || err);

    return {
      ok: false,
      category: primaryIntentCategory || "product",
      items: [],
      best: null,
      smart: [],
      others: [],
      _meta: {
        query: q,
        region,
        s40Category: primaryIntentCategory || "product",
        totalRawAdapters: 0,
        totalItemsAfterMerge: 0,
        error: err?.message || String(err),
      },
    };
  }

  if (!result || !result.ok) {
    return {
      ok: false,
      category: result?.category || primaryIntentCategory || "product",
      items: result?.items || [],
      best: result?.best || null,
      smart: result?.smart || [],
      others: result?.others || [],
      _meta: {
        ...(result?._meta || {}),
        query: q,
        region,
        s40Category: primaryIntentCategory || "product",
      },
    };
  }

  // Kategori field’ını S40 ile uyumlu hale getir
  const finalCategory =
    result.category || primaryIntentCategory || "product";

  return {
    ...result,
    category: finalCategory,
    _meta: {
      ...(result._meta || {}),
      query: q,
      region,
      s40Category: primaryIntentCategory || "product",
    },
  };
}
