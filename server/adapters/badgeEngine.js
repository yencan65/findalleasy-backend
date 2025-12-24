// BACKEND/core/badgeEngine.js
// ======================================================================
//  BADGE ENGINE — S20 BADGE-NEURON EDITION
// ======================================================================
//  • S8 davranışı %100 korunur — hiçbir fonksiyon silinmedi
//  • Yeni rozet beyin katmanı: valueScore, providerTrust, velocityScore
//  • BEST kartı artık daha akıllı → “king_badge” + “price_performance”
//  • SMART kartlar → “ai_recommendation” + “memory_match”
//  • OTHERS → “hidden_gem” algılaması
//  • Tüm rozetler birleşik, çakışma yok, çift kayıt yok
// ======================================================================


// -----------------------------
// INTERNAL HELPERS
// -----------------------------
function safeNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Ürün ucuzsa + iyi puanlıysa fiyat/performans skoru
function computeValueScore(item) {
  const p = safeNum(item.price);
  const r = safeNum(item.rating);

  if (p == null || r == null) return null;

  // 0–1 normalize
  const priceNorm = Math.max(0, 1 - Math.min(p / 5000, 1));
  const ratingNorm = Math.min(r / 5, 1);

  return Number((ratingNorm * 0.6 + priceNorm * 0.4).toFixed(3));
}

// Provider güven katsayısı
function providerTrust(item) {
  const p = (item.provider || "").toLowerCase();
  if (!p) return 0;

  const map = {
    trendyol: 0.95,
    hepsiburada: 0.92,
    amazon: 0.90,
    n11: 0.85,
    aliexpress: 0.70,
    booking: 0.93,
    ciceksepeti: 0.88,
    carrefoursa: 0.85,
  };
  return map[p] || 0.5;
}

// Stok / teslimat hızı skoru
function velocityScore(item) {
  const eta = item?.delivery?.etaDays;
  if (typeof eta !== "number") return 0;

  if (eta <= 1) return 1.0;
  if (eta <= 3) return 0.7;
  if (eta <= 7) return 0.4;
  return 0.2;
}


// ======================================================================
//  MAIN — computeBadgesForItem (S8 → S20 güçlendirme)
// ======================================================================
function computeBadgesForItem(item, context) {
  if (!item) return item;

  const badges = new Set();

  const price = safeNum(item.price);
  const rating = safeNum(item.rating);
  const value = computeValueScore(item);
  const trust = providerTrust(item);
  const velocity = velocityScore(item);

  // ---------------------
  //  S8 MİRAS ROZETLERİ
  // ---------------------
  if (context.position === "best") {
    badges.add("editor_choice");
    badges.add("best_overall");
  }

  if (price != null && context.cheapestPrice != null) {
    if (price === context.cheapestPrice) badges.add("best_price");
  }

  if (rating != null) {
    if (rating >= 0.9) {
      badges.add("top_rated");
      badges.add("trusted_seller");
    } else if (rating >= 0.85) {
      badges.add("trusted_seller");
    }
    if (context.maxRating != null && rating === context.maxRating) {
      badges.add("community_favorite");
    }
  }

  const etaDays =
    item?.delivery && typeof item.delivery.etaDays === "number"
      ? item.delivery.etaDays
      : null;

  if (etaDays != null) {
    if (etaDays <= 2) badges.add("fast_delivery");
    else if (etaDays <= 5) badges.add("on_time_delivery");
  }

  if (context.position === "smart") {
    badges.add("recommended");
  }

  if (context.position === "others") {
    if (rating != null && rating >= 0.8 && price != null) {
      badges.add("good_alternative");
    }
  }

  // ------------------------------------------------------------
  // S20 — YENİ ZEKÂ ROZETLERİ
  // ------------------------------------------------------------

  // BEST kart = kral
  if (context.position === "best") {
    if (value && value > 0.75) badges.add("price_performance_king");
    if (trust > 0.9) badges.add("top_provider");
    badges.add("king_badge");
  }

  // SMART kart → AI hafıza eşleşmesi
  if (context.position === "smart") {
    if (value && value > 0.60) badges.add("smart_value_pick");
    if (trust > 0.85) badges.add("trusted_choice");
    if (velocity > 0.7) badges.add("fast_pick");
    badges.add("ai_recommendation");
  }

  // OTHERS → “gizli cevher”
  if (context.position === "others") {
    if (value && value > 0.70) badges.add("hidden_gem");
    if (trust > 0.9) badges.add("surprisingly_trusted");
  }

  // Global rozet → çok ucuz
  if (price != null && price < 50) {
    badges.add("ultra_budget");
  }

  // Global rozet → çok yüksek kalite
  if (rating != null && rating >= 0.95) {
    badges.add("elite_rating");
  }

  // Global rozet → tedarikçi skoru
  if (trust > 0.9) {
    badges.add("premium_provider");
  }

  const clone = { ...item };
  const existing = Array.isArray(clone.badges) ? clone.badges : [];

  clone.badges = Array.from(new Set([...existing, ...badges]));
  return clone;
}


// ======================================================================
//  decorateWithBadges — Tüm bucket'lar
// ======================================================================
export function decorateWithBadges({ best, smart, others }) {
  const allItems = [];
  if (best) allItems.push(best);
  if (Array.isArray(smart)) allItems.push(...smart);
  if (Array.isArray(others)) allItems.push(...others);

  // En ucuz + en yüksek ratingi bul
  let cheapestPrice = null;
  let maxRating = null;

  for (const item of allItems) {
    if (!item) continue;

    const price = safeNum(item.price);
    const rating = safeNum(item.rating);

    if (price != null) {
      if (cheapestPrice == null || price < cheapestPrice) {
        cheapestPrice = price;
      }
    }
    if (rating != null) {
      if (maxRating == null || rating > maxRating) {
        maxRating = rating;
      }
    }
  }

  const ctx = { cheapestPrice, maxRating };

  const decoratedBest = best
    ? computeBadgesForItem(best, { ...ctx, position: "best" })
    : null;

  const decoratedSmart = Array.isArray(smart)
    ? smart.map((item) =>
        computeBadgesForItem(item, { ...ctx, position: "smart" })
      )
    : [];

  const decoratedOthers = Array.isArray(others)
    ? others.map((item) =>
        computeBadgesForItem(item, { ...ctx, position: "others" })
      )
    : [];

  return {
    best: decoratedBest,
    smart: decoratedSmart,
    others: decoratedOthers,
  };
}

export default {
  decorateWithBadges,
};
