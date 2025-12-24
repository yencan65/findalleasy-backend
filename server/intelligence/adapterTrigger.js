// BACKEND/intelligence/adapterTrigger.js
// Kümülatif öneri tiplerini (ör: "flight", "hotel", "accessory") mevcut adapter sonuçlarıyla eşleştirir.

/**
 * item'a basit tag seti ekler.
 * Provider + başlık üzerinden travel / product tipi tahmini yapar.
 */
function tagItem(item) {
  const title = (item?.title || "").toLowerCase();
  const provider = (item?.provider || "").toLowerCase();
  const tags = new Set();

  // Travel - otel
  if (
    /(otel|hotel|resort|pansiyon|konaklama)/.test(title) ||
    ["tatilbudur", "otelz", "booking", "airbnb"].includes(provider)
  ) {
    tags.add("hotel");
  }

  // Travel - uçak
  if (
    /(uçak|flight|bilet|uçuş|havayolu|hava yolu)/.test(title) ||
    ["skyscanner", "turna", "thy", "pegasus"].includes(provider)
  ) {
    tags.add("flight");
  }

  // Travel - araç kiralama / transfer
  if (
    /(araç kirala|araba kirala|rent a car|kiralık araç|transfer|taksi|taxi)/.test(
      title
    ) ||
    ["avis", "budget", "enterprise"].includes(provider)
  ) {
    tags.add("car_rental");
    tags.add("transfer");
  }

  // Food / restoran
  if (
    /(restoran|restaurant|cafe|pizza|burger|lahmacun|kebap|döner|yemek)/.test(
      title
    )
  ) {
    tags.add("restaurant");
    tags.add("food");
  }

  // Elektronik aksesuar
  if (
    /(kılıf|case|screen protector|ekran koruyucu|şarj|charger|powerbank|kulaklık|earphone|earbud)/.test(
      title
    )
  ) {
    tags.add("accessory");
    tags.add("electronics");
  }

  // Araç / oto
  if (
    /(lastik|tire|jant|akü|motor yağı|oil)/.test(title)
  ) {
    tags.add("automotive");
  }

  // Pet
  if (
    /(kedi|köpek|mama|pet|petshop|pet shop|cat|dog)/.test(title)
  ) {
    tags.add("pet");
  }

  return Array.from(tags);
}

/**
 * Kümülatif öneri kartını mevcut sonuçlardan seçer.
 * Ek adapter çağırmadan, zaten gelen sonuçlar içinden en mantıklılarını alır.
 */
export function buildSmartFromItems({
  items = [],
  best = null,
  analysis = null,
  suggestionTypes = [],
  maxItems = 8,
}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const bestId = best?.id;
  const enriched = items
    .filter((x) => x && x.id !== bestId)
    .map((item) => {
      const tags = tagItem(item);
      return { item, tags };
    });

  const picked = [];
  const usedIds = new Set();

  function pushIfGood(candidateList) {
    for (const c of candidateList) {
      const id = c.item?.id || c.item?.url;
      if (!id || usedIds.has(id)) continue;
      picked.push(c.item);
      usedIds.add(id);
      if (picked.length >= maxItems) return true;
    }
    return false;
  }

  // Her suggestionType için en ilgili birkaç item'i seç
  for (const type of suggestionTypes) {
    const candidates = enriched
      .map((e) => {
        const weight = e.tags.includes(type) ? 2 : e.tags.length ? 1 : 0;
        return {
          item: e.item,
          weight,
          rating: typeof e.item.rating === "number" ? e.item.rating : 0,
        };
      })
      .filter((c) => c.weight > 0)
      .sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return b.rating - a.rating;
      });

    if (candidates.length) {
      pushIfGood(candidates.slice(0, 3)); // her tipten max 3
      if (picked.length >= maxItems) break;
    }
  }

  // Hâlâ boşsa: generic iyi sonuçlardan doldur
  if (picked.length === 0) {
    const generic = enriched
      .map((e) => ({
        item: e.item,
        rating: typeof e.item.rating === "number" ? e.item.rating : 0,
      }))
      .sort((a, b) => b.rating - a.rating);

    pushIfGood(generic);
  }

  return picked.slice(0, maxItems);
}

export default {
  buildSmartFromItems,
};
