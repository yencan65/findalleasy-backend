// BACKEND/core/badgeEngine.js
// ======================================================================
//  FAE BADGE ENGINE — S14 ULTRA · S200 SAFE
//  Ürün kartlarına rozet ekleyen multi-sinyal beyin:
//  - Fiyat, puan, teslimat
//  - Komisyon / reward potansiyeli (commissionMeta)
//  - Güven / kalite skorları
//  - Kategori & sağlayıcı sinyalleri
//  ZERO-DELETE · ZERO-CRASH · BACKWARD-COMPATIBLE
// ======================================================================

// ================================================
// 🧩 BASE SCORE FIXER — önce tanımlı olmalı
// ================================================
export function ensureDefaultScores(item) {
  if (!item || typeof item !== "object") return item;

  const hasTrust =
    typeof item.trustScore === "number" && item.trustScore > 0;

  const hasQuality =
    typeof item.qualityScore5 === "number" && item.qualityScore5 > 0;

  const trust = hasTrust ? item.trustScore : 0.75;
  const q5 = hasQuality ? item.qualityScore5 : 4.0;

  // Rating’i stabil hale getir (değiştirme, sadece default ver)
  let rating = item.rating;
  if (typeof rating !== "number" || rating < 0) {
    rating = null;
  }

  return {
    ...item,
    trustScore: trust,
    qualityScore5: q5,
    rating,
  };
}

// ================================================
// 🔎 HELPER: güvenli sayı
// ================================================
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ================================================
// 🔎 HELPER: kategori key
// ================================================
function normalizeCategory(cat) {
  if (!cat) return "product";
  return String(cat).toLowerCase().trim();
}

// ================================================
// 🔎 HELPER: provider key
// ================================================
function normalizeProvider(p) {
  if (!p) return "unknown";
  return String(p)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/^www\./, "")
    .replace(/scraper|adapter|client|engine/g, "")
    .replace(/\.com(\.tr)?|\.net|\.org|\.io|\.co/g, "")
    .trim() || "unknown";
}

// ================================================
// 🔎 HELPER: title text
// ================================================
function titleIncludes(item, needles = []) {
  const t = String(item?.title || "").toLowerCase();
  if (!t) return false;
  return needles.some((w) => t.includes(w));
}

// ================================================
// 🔥 1) Tek ürün için badge hesaplama motoru
// ================================================
function computeBadgesForItem(item, context = {}) {
  if (!item || typeof item !== "object") return item;

  const badges = new Set();

  const price =
    typeof item.price === "number" && item.price > 0 ? item.price : null;

  const rating =
    typeof item.rating === "number" && item.rating >= 0
      ? item.rating
      : null;

  const etaDays =
    item?.delivery && typeof item.delivery.etaDays === "number"
      ? item.delivery.etaDays
      : null;

  const trustScore =
    typeof item.trustScore === "number" ? item.trustScore : 0.75;

  const qualityScore5 =
    typeof item.qualityScore5 === "number" ? item.qualityScore5 : 4.0;

  const category = normalizeCategory(
    item.category || item.commissionMeta?.categoryKey
  );

  const providerKey = normalizeProvider(
    item.provider || item.commissionMeta?.providerKey
  );

  // Komisyon / reward sinyalleri
  const cm = item.commissionMeta || {};
  const commissionRate = safeNumber(
    cm.finalRate ?? cm.platformRate ?? 0,
    0
  ); // 0–0.45
  const commissionAmount = safeNumber(
    cm.commissionAmount,
    price && commissionRate ? price * commissionRate : 0
  );
  const providerPriorityScore = safeNumber(
    cm.providerPriorityScore,
    0
  );

  const {
    cheapestPrice = null,
    maxRating = null,
    maxCommissionRate = null,
    maxReward = null,
    maxTrust = null,
    minEtaDays = null,
    // opsiyonel kullanıcı bağlamı:
    userClicks = 0,
    memoryProfile = null,
  } = context;

  // ===================================================================
  //  A) BEST karta özel rozetler
  // ===================================================================
  if (context.position === "best") {
    badges.add("editor_choice");
    badges.add("best_overall");
  }

  // ===================================================================
  //  B) Fiyat bazlı rozetler
  // ===================================================================
  if (price != null && cheapestPrice != null) {
    if (price === cheapestPrice) {
      badges.add("best_price");
    } else if (price <= cheapestPrice * 1.05) {
      badges.add("near_best_price");
    } else if (price >= cheapestPrice * 1.6) {
      badges.add("premium_choice");
    }
  }

  // Çok ucuz ise ama rating düşükse → dikkat
  if (price != null && rating != null) {
    if (price < (cheapestPrice || price) * 0.85 && rating < 4.0) {
      badges.add("price_suspicious");
    }
  }

  // ===================================================================
  //  C) Rating & güven rozetleri
  // ===================================================================
  if (rating != null) {
    if (rating >= 4.9) {
      badges.add("top_rated");
      badges.add("community_favorite");
      badges.add("trusted_seller");
    } else if (rating >= 4.7) {
      badges.add("top_rated");
      badges.add("trusted_seller");
    } else if (rating >= 4.3) {
      badges.add("trusted_seller");
    } else if (rating <= 3.5) {
      badges.add("low_rating_warning");
    }

    if (maxRating != null && rating === maxRating) {
      badges.add("highest_rated");
    }
  }

  if (trustScore >= 0.9) {
    badges.add("super_trusted");
  } else if (trustScore >= 0.8) {
    badges.add("high_trust");
  } else if (trustScore <= 0.6) {
    badges.add("low_trust_warning");
  }

  if (maxTrust != null && trustScore === maxTrust && trustScore >= 0.85) {
    badges.add("most_trusted_in_list");
  }

  // ===================================================================
  //  D) Teslimat rozetleri
  // ===================================================================
  if (etaDays != null) {
    if (etaDays <= 1) {
      badges.add("same_day_or_next_day");
      badges.add("fast_delivery");
    } else if (etaDays <= 3) {
      badges.add("fast_delivery");
    } else if (etaDays <= 7) {
      badges.add("on_time_delivery");
    } else {
      badges.add("slow_delivery");
    }

    if (minEtaDays != null && etaDays === minEtaDays) {
      badges.add("fastest_delivery");
    }
  }

  // ===================================================================
  //  E) Smart / Others bucket rozetleri
  // ===================================================================
  if (context.position === "smart") {
    badges.add("recommended");
    if (rating != null && rating >= 4.3 && price != null && cheapestPrice != null) {
      if (price <= cheapestPrice * 1.2) {
        badges.add("smart_value_pick");
      }
    }
  }

  if (context.position === "others") {
    if (rating != null && rating >= 4.0 && price != null) {
      badges.add("good_alternative");
    }
  }

  // ===================================================================
  //  F) Komisyon / reward / partner rozetleri
  // ===================================================================
  if (commissionRate > 0) {
    badges.add("commission_partner");
  }

  if (commissionRate >= 0.15) {
    badges.add("high_commission_rate");
  } else if (commissionRate >= 0.08) {
    badges.add("medium_commission_rate");
  }

  if (commissionAmount >= 20) {
    badges.add("high_reward_potential");
  } else if (commissionAmount >= 5) {
    badges.add("reward_potential");
  }

  if (providerPriorityScore >= 4.5) {
    badges.add("priority_partner");
  } else if (providerPriorityScore >= 3.5) {
    badges.add("preferred_partner");
  }

  // ===================================================================
  //  G) Kategori bazlı rozetler
  // ===================================================================
  if (category === "hotel" || category === "flight" || category === "tour") {
    badges.add("best_for_travel");
  }

  if (category === "electronics") {
    if (qualityScore5 >= 4.5 && rating != null && rating >= 4.5) {
      badges.add("performance_choice");
    }
  }

  if (category === "fashion") {
    badges.add("style_pick");
  }

  if (category === "food" || category === "market") {
    if (titleIncludes(item, ["organik", "organic", "bio"])) {
      badges.add("eco_choice");
    }
  }

  if (category === "outdoor" || category === "fishing") {
    badges.add("outdoor_lover");
  }

  if (category === "lawyer") {
    badges.add("professional_service");
  }

  // ===================================================================
  //  H) Kullanıcı davranışına göre rozetler (opsiyonel sinyal)
  // ===================================================================
  const ps = memoryProfile?.priceSensitivity;
  if (typeof ps === "number") {
    if (ps < 0.95 && price != null && cheapestPrice != null) {
      if (price <= cheapestPrice * 1.1) {
        badges.add("best_for_savers");
      }
    } else if (ps > 1.18 && price != null) {
      if (price >= (cheapestPrice || price) * 1.3) {
        badges.add("best_for_premium_seekers");
      }
    }
  }

  if (userClicks > 30 && rating != null && rating >= 4.5) {
    badges.add("data_backed_choice");
  }

  // ===================================================================
  //  I) Metin bazlı ek rozetler
  // ===================================================================
  if (titleIncludes(item, ["yeni model", "2025", "new model", "latest"])) {
    badges.add("new_release");
  }

  if (titleIncludes(item, ["indirim", "kampanya", "discount", "%"])) {
    badges.add("promotion");
  }

  // ===================================================================
  //  J) Final birleşme
  // ===================================================================
  const clone = { ...item };
  const existing = Array.isArray(clone.badges) ? clone.badges : [];
  clone.badges = Array.from(new Set([...existing, ...badges]));

  return clone;
}

// ================================================
// 🔥 2) Üç bucket için toplu rozet motoru
//    (best hem tek obje hem array olabilir)
//    S200 UYUMLU: sadece BEST kart olsa da sorunsuz
// ================================================
export function decorateWithBadges(buckets = {}, globalCtx = {}) {
  let best;
  let smart;
  let others;

  // S200 uyumu:
  // - Sadece tek item → best
  // - Dizi verilirse → [0] best, geri kalanı smart
  // - Vitrin sonucu verilirse (items + best) → klasik best/smart/others çıkar
  if (Array.isArray(buckets)) {
    best = buckets[0] || null;
    smart = buckets.slice(1);
    others = [];
  } else if (buckets && typeof buckets === "object") {
    // AdapterEngine / VitrinEngine sonucu olabilir
    if (
      !Object.prototype.hasOwnProperty.call(buckets, "best") &&
      !Object.prototype.hasOwnProperty.call(buckets, "smart") &&
      !Object.prototype.hasOwnProperty.call(buckets, "others")
    ) {
      // tam vitrin sonucu: { items, best?, smart?, others? }
      const rawBest =
        buckets.best ??
        (Array.isArray(buckets.items) ? buckets.items[0] : null) ??
        null;

      const rawSmart = Array.isArray(buckets.smart)
        ? buckets.smart
        : Array.isArray(buckets.items)
        ? buckets.items.slice(rawBest ? 1 : 0)
        : [];

      best = rawBest;
      smart = rawSmart;
      others = Array.isArray(buckets.others) ? buckets.others : [];
    } else {
      // klasik API: { best, smart, others }
      best = buckets.best ?? null;
      smart = Array.isArray(buckets.smart) ? buckets.smart : [];
      others = Array.isArray(buckets.others) ? buckets.others : [];
    }
  } else {
    // saçma bir şey geldiyse → best = null
    best = null;
    smart = [];
    others = [];
  }

  // best hem tek obje hem array gelebilir → normalize et
  const bestArray = Array.isArray(best)
    ? best.filter(Boolean)
    : best
    ? [best]
    : [];

  const smartArray = Array.isArray(smart) ? smart.filter(Boolean) : [];
  const othersArray = Array.isArray(others) ? others.filter(Boolean) : [];

  // Default skorlar
  const bestNorm = bestArray.map(ensureDefaultScores);
  const smartNorm = smartArray.map(ensureDefaultScores);
  const othersNorm = othersArray.map(ensureDefaultScores);

  const allItems = [...bestNorm, ...smartNorm, ...othersNorm];

  if (!allItems.length) {
    // hiçbir ürün yoksa, orijinal şekli koru
    return {
      best,
      smart: smartArray,
      others: othersArray,
    };
  }

  // En ucuz & max rating & komisyon & trust & eta bul
  let cheapestPrice = null;
  let maxRating = null;
  let maxCommissionRate = null;
  let maxReward = null;
  let maxTrust = null;
  let minEtaDays = null;

  for (const item of allItems) {
    if (!item) continue;

    const price =
      typeof item.price === "number" && item.price > 0 ? item.price : null;

    const rating =
      typeof item.rating === "number" && item.rating >= 0
        ? item.rating
        : null;

    const etaDays =
      item?.delivery && typeof item.delivery.etaDays === "number"
        ? item.delivery.etaDays
        : null;

    const trust =
      typeof item.trustScore === "number" ? item.trustScore : null;

    const cm = item.commissionMeta || {};
    const commissionRate = safeNumber(
      cm.finalRate ?? cm.platformRate ?? 0,
      0
    );
    const commissionAmount = safeNumber(
      cm.commissionAmount,
      price && commissionRate ? price * commissionRate : 0
    );

    if (price != null && (cheapestPrice == null || price < cheapestPrice)) {
      cheapestPrice = price;
    }

    if (rating != null && (maxRating == null || rating > maxRating)) {
      maxRating = rating;
    }

    if (
      commissionRate != null &&
      (maxCommissionRate == null || commissionRate > maxCommissionRate)
    ) {
      maxCommissionRate = commissionRate;
    }

    if (
      commissionAmount != null &&
      (maxReward == null || commissionAmount > maxReward)
    ) {
      maxReward = commissionAmount;
    }

    if (trust != null && (maxTrust == null || trust > maxTrust)) {
      maxTrust = trust;
    }

    if (etaDays != null && (minEtaDays == null || etaDays < minEtaDays)) {
      minEtaDays = etaDays;
    }
  }

  const contextBase = {
    cheapestPrice,
    maxRating,
    maxCommissionRate,
    maxReward,
    maxTrust,
    minEtaDays,
    userClicks: globalCtx.userClicks || 0,
    memoryProfile: globalCtx.memoryProfile || null,
  };

  const decoratedBestArray = bestNorm.map((item) =>
    computeBadgesForItem(item, { ...contextBase, position: "best" })
  );

  const decoratedSmart = smartNorm.map((item) =>
    computeBadgesForItem(item, { ...contextBase, position: "smart" })
  );

  const decoratedOthers = othersNorm.map((item) =>
    computeBadgesForItem(item, { ...contextBase, position: "others" })
  );

  // ÇIKIŞTA: best'in orijinal tipini koru (array ise array, obje ise obje)
  const decoratedBest = Array.isArray(best)
    ? decoratedBestArray
    : decoratedBestArray[0] || null;

  return {
    best: decoratedBest,
    smart: decoratedSmart,
    others: decoratedOthers,
  };
}

export default {
  decorateWithBadges,
};

// ================================================
// 🔥 3) SAFE WRAPPER — backend hiç çökmesin
// ================================================
export function safeDecorateWithBadges(cards, contextBase = {}) {
  try {
    if (!cards || typeof cards !== "object") {
      return { best: null, smart: [], others: [] };
    }

    const best = cards.best ?? null;
    const smart = Array.isArray(cards.smart) ? cards.smart : [];
    const others = Array.isArray(cards.others) ? cards.others : [];

    const decorated = decorateWithBadges({ best, smart, others }, contextBase);

    return {
      best: decorated?.best || null,
      smart: Array.isArray(decorated?.smart) ? decorated.smart : [],
      others: Array.isArray(decorated?.others) ? decorated.others : [],
    };
  } catch (err) {
    console.error("⚠️ safeDecorateWithBadges error:", err);

    return {
      best: cards?.best || null,
      smart: Array.isArray(cards?.smart) ? cards.smart : [],
      others: Array.isArray(cards?.others) ? cards.others : [],
    };
  }
}

export const BadgeEngineSafe = {
  safeDecorateWithBadges,
};

// ================================================
// ❗️ 4) ensureDefaultScores duplicate için güvenli alias
// ================================================
export function ensureDefaultScores__DUP(item) {
  return ensureDefaultScores(item);
}
