// server/utils/resultCleaner.js
// ============================================================================
// RESULT CLEANER — S200/S22 COMPAT (ZERO DELETE)
// - ZERO DELETE: cleanByCategory export’u korunur.
// - S200 uyum: input array veya {ok,items,count,source,_meta} olabilir.
// - Wrapper gelirse wrapper korunur, sadece items filtrelenir + count güncellenir.
// ============================================================================

export function cleanByCategory(items = [], category = "product") {
  // Accept both array and S200 wrapper
  const isWrapper =
    items && !Array.isArray(items) && typeof items === "object" && Array.isArray(items.items);

  const arr = isWrapper ? items.items : items;

  if (!Array.isArray(arr)) return isWrapper ? { ...items, items: [], count: 0 } : [];

  const out = [];
  const target = String(category || "product").toLowerCase().trim();

  for (const item of arr) {
    if (!item || !item.title) continue;

    const title = String(item.title).toLowerCase();
    const providerKey = String(item.providerKey || item.provider || "").toLowerCase();
    const adapterCategory = String(item.category || "").toLowerCase();

    // 1) ADAPTER CATEGORY WINS
    if (adapterCategory && adapterCategory === target) {
      out.push(item);
      continue;
    }

    // 2) PROVIDER PRIORITY MAP (providerKey-aware)
    const PROVIDER_MAP = {
      hotel: ["booking", "otelz", "odamax", "agoda", "expedia", "airbnb", "tripadvisor"],
      flight: [
        "skyscanner", "turna", "obilet", "googleflights", "turkishairlines",
        "pegasus", "sunexpress", "thy"
      ],
      car_rental: [
        "rentgo", "enterprise", "garenta", "circular", "avec",
        "budget", "avis", "otorento", "otomerkezi", "sixt", "alamo"
      ],
      event: ["passo", "biletino", "biletix", "mobilet"],
      food: ["yemeksepeti", "getir", "trendyolyemek"],
      electronics: ["trendyol", "hepsiburada", "n11", "amazon", "a101", "teknosa", "vatan"],
      market: ["rossmann", "watsons", "migros", "carrefoursa", "sok", "a101", "bim"],
    };

    if (PROVIDER_MAP[target]?.includes(providerKey)) {
      out.push(item);
      continue;
    }

    // 3) TEXT-AI (regex)
    if (target === "flight") {
      if (/\buçak|flight|havayolu|hava yolu|thy|pegasus|sunexpress|airport\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    if (target === "hotel") {
      if (/\bhotel|otel|konaklama|resort|pansiyon|bungalow|apart\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    if (target === "car_rental") {
      if (/\brent\b|\bkiral\b|\bcar rental\b|\baraç kiralama\b|\bkira\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    if (target === "electronics") {
      if (/\biphone|samsung|xiaomi|macbook|ipad|tablet|laptop|kulak|tv|televizyon\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    if (target === "food") {
      if (/\brestoran|restaurant|cafe|pizza|yemek|burger|kahve|fast food\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    if (target === "event") {
      if (/\bkonser|festival|event|tiyatro|gösteri|show|stand up|caz\b/.test(title)) {
        out.push(item);
        continue;
      }
    }

    // 4) PRODUCT SAFE MODE
    if (target === "product") {
      if (!/\bhotel|otel|uçak|flight|havayolu|festival|konser|tiyatro|rent|kirala\b/.test(title)) {
        out.push(item);
        continue;
      }
    }
  }

  if (isWrapper) {
    const before = arr.length;
    const meta = items._meta && typeof items._meta === "object" ? items._meta : {};
    return {
      ...items,
      items: out,
      count: out.length,
      _meta: {
        ...meta,
        cleanedByCategory: target,
        cleanedBeforeCount: before,
        cleanedAfterCount: out.length,
      },
    };
  }

  return out;
}

// ============================================================================
// FALLBACK TEXT INFER (S7 uyumu için bırakıldı — ZERO DELETE kuralı)
// ============================================================================

function inferByText(t) {
  if (!t) return "product";

  const x = t.toLowerCase();

  if (/\buçak|flight|havayolu|thy|pegasus\b/.test(x)) return "flight";
  if (/\bhotel|otel|resort|konaklama\b/.test(x)) return "hotel";
  if (/\brent|kirala|car rental|araç kiralama\b/.test(x)) return "car_rental";
  if (/\biphone|samsung|laptop|tablet|kulak|tv\b/.test(x)) return "electronics";
  if (/\brestoran|restaurant|cafe|yemek|pizza|burger\b/.test(x)) return "food";
  if (/\bkonser|festival|event|tiyatro\b/.test(x)) return "event";

  return "product";
}
