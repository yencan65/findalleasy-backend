// server/utils/priceFixer.js
// ===============================================================
// FindAllEasy — PRICE FIXER (S200 HARDENED)
// ZERO-CRASH • ZERO-LIE • "0 TL" bug'ını öldürür
//
// Amaç:
// - Adapterlardan gelen price/finalPrice/optimizedPrice her formatta parse edilsin
// - Parse edilemeyen fiyat 0'a zorlanmasın (null dönsün)
// - Item bazlı optimizePrice(...) çağrılarıyla uyumlu kalsın
// ===============================================================

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// "3.250.000,00" • "3,250,000.00" • "3250000" • "36.899 TL"
export function parsePriceAny(v) {
  try {
    if (v == null) return null;
    if (isFiniteNumber(v)) return v;

    let s = String(v).trim();
    if (!s) return null;

    // currency temizle
    s = s
      .replace(/\s+/g, "")
      .replace(/₺|TL|TRY|try|tl/gi, "")
      .replace(/[^\d.,-]/g, "");

    // negatif fiyat istemiyoruz (hatalı parse)
    if (s.startsWith("-")) s = s.slice(1);

    if (!s) return null;

    // hem , hem . varsa: son görülen ayırıcı decimal kabul
    if (s.includes(",") && s.includes(".")) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");

      if (lastComma > lastDot) {
        // "3.250.000,00" -> "3250000.00"
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        // "3,250,000.00" -> "3250000.00"
        s = s.replace(/,/g, "");
      }
    } else if (s.includes(",")) {
      // "36,899" mı "36.899,00" mı? — TR’de genelde binlik
      const parts = s.split(",");
      if (parts[1] && parts[1].length === 2) {
        s = s.replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (s.includes(".")) {
      const parts = s.split(".");
      // "36.899" (binlik) ise
      if (parts[1] && parts[1].length !== 2) s = s.replace(/\./g, "");
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return null;

    // absürt fiyatları (ör: 15) iPhone için bile 15 TL olabilir ama çok uçuk filtre istemiyoruz.
    return n;
  } catch {
    return null;
  }
}

export function detectCurrencyFromText(v) {
  try {
    const s = String(v || "");
    if (/₺|TL|TRY/i.test(s)) return "TRY";
    if (/\$|USD/i.test(s)) return "USD";
    if (/€|EUR/i.test(s)) return "EUR";
    return null;
  } catch {
    return null;
  }
}

// ===============================================================
// optimizePrice(valueOrItem, context)
// - Eğer number/string verilirse number|null döner
// - Eğer object item verilirse item'i güçlendirip geri döner
// ===============================================================
export function optimizePrice(valueOrItem, context = {}) {
  try {
    // 1) primitive => number|null
    if (
      typeof valueOrItem === "number" ||
      typeof valueOrItem === "string" ||
      valueOrItem == null
    ) {
      const n = parsePriceAny(valueOrItem);
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
    }

    // 2) object item => mutate + return
    const item = valueOrItem || {};
    const provider = String(context?.provider || item.provider || item.providerKey || item.source || "unknown");
    const category = String(context?.category || item.category || item.vertical || "unknown");

    const candidates = [
      item.optimizedPrice,
      item.finalPrice,
      item.price,
      item.amount,
      item.rawPrice,
      item.raw?.price,
      item.raw?.finalPrice,
      item.raw?.amount,
      item.minPrice,
      item.maxPrice
    ];

    let parsed = null;
    for (const c of candidates) {
      parsed = parsePriceAny(c);
      if (parsed != null) break;
    }

    // Title/desc içinden yakala (son çare)
    if (parsed == null) {
      const t = `${item.title || ""} ${item.name || ""} ${item.description || ""}`;
      const m = String(t).match(/(\d{1,3}([.,]\d{3})+|\d{4,})([.,]\d{2})?\s*(₺|TL|TRY)?/i);
      if (m && m[1]) parsed = parsePriceAny(m[0]);
    }

    // 0'a düşürme yok — parse yoksa null kalsın
    if (parsed == null) {
      // var olan değerleri 0'lama, sadece işaretle
      item.price = item.price ?? null;
      item.finalPrice = item.finalPrice ?? null;
      item.optimizedPrice = item.optimizedPrice ?? null;

      if (process.env.DEBUG_PRICE_FIXER === "1") {
        console.warn("PRICE:SANITIZE_FAIL", {
          original: candidates.find((x) => x != null),
          optimized: null,
          context: { provider, category },
        });
      }
      return item;
    }

    // Çok küçük negatif/absürt değerleri korumak yerine null yapmayalım; sadece clamp min 0
    const safe = (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0)
    ? parsed
    : null; // S200 contract: price<=0 => null
    if (item.price == null) item.price = safe;
    if (item.finalPrice == null) item.finalPrice = safe;
    item.optimizedPrice = safe;

    const cur =
      item.currency ||
      detectCurrencyFromText(candidates.find((x) => typeof x === "string")) ||
      detectCurrencyFromText(item.title) ||
      "TRY";
    item.currency = String(cur || "TRY");

    return item;
  } catch (e) {
    // Asla crash yok
    try {
      if (process.env.DEBUG_PRICE_FIXER === "1") {
        console.warn("PRICE:FIXER_CRASH", e?.message || e);
      }
    } catch {}
    return valueOrItem;
  }
}

// ===============================================================
// autoInjectPrice(item) — var olan sistemi bozmadan "price yok" sorununu azaltır.
// Not: Burada uydurma fiyat yok; sadece title/desc içinden yakalarsa ekler.
// ===============================================================
export function autoInjectPrice(item, context = {}) {
  try {
    if (!item || typeof item !== "object") return item;

    const hasAny =
      parsePriceAny(item.optimizedPrice) != null ||
      parsePriceAny(item.finalPrice) != null ||
      parsePriceAny(item.price) != null;

    if (hasAny) return optimizePrice(item, context);

    const t = `${item.title || ""} ${item.name || ""} ${item.description || ""}`;
    const m = String(t).match(/(\d{1,3}([.,]\d{3})+|\d{4,})([.,]\d{2})?\s*(₺|TL|TRY)?/i);

    if (!m) {
      item.price = item.price ?? null;
      item.finalPrice = item.finalPrice ?? null;
      item.optimizedPrice = item.optimizedPrice ?? null;
      return item;
    }

    const parsed = parsePriceAny(m[0]);
    if (parsed == null || parsed <= 0) return item;

    item.price = parsed;
    item.finalPrice = parsed;
    item.optimizedPrice = parsed;
    item.currency = item.currency || detectCurrencyFromText(m[0]) || "TRY";
    return item;
  } catch {
    return item;
  }
}

export default {
  parsePriceAny,
  detectCurrencyFromText,
  optimizePrice,
  autoInjectPrice,
};
