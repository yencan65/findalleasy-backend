// core/priceEngine.js
// ===================================================================
//  F A E   S15.9 — TITAN-OMEGA PRICE ENGINE
//  ZERO-CRASH · ZERO-BUG · ZERO-DRIFT · ZERO-ABSURD
//  memoryProfile-aware · commission-aware · jittered-parse
//  TR/EU/US tüm formatları ayrım yapmadan çözer
//  Çift normalize + anti-float-drift
// ===================================================================


// ===========================================================
// Helpers
// ===========================================================
function isValidNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function logPrice(tag, payload) {
  try {
    console.log(`💵 PRICE:${tag}`, payload);
  } catch {
    /* sessiz geç */
  }
}


// ===========================================================
// UNIVERSAL NUMBER PARSER — S15 (TR/EU/US/Hybrid)
// ===========================================================
function parseLooseNumber(raw) {
  if (isValidNumber(raw)) return raw;
  if (raw == null) return null;

  let s = String(raw).trim();
  if (!s) return null;

  // Para sembolleri, birim, boşluk enjekte eden saçmalıkların tamamını temizle
  s = s
    .replace(/[^\d.,-]/g, "")   // rakam, nokta, virgül, - hariç hepsini at
    .replace(/--+/g, "-");

  if (!s) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  let out = s;

  // TR formatı: 1.234,56 → 1234.56
  if (hasDot && hasComma) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");

    if (lastComma > lastDot) {
      out = s.replace(/\./g, "").replace(",", ".");
    } else {
      // "1,234.56" → 1234.56
      out = s.replace(/,/g, "");
    }
  }

  // Sadece virgül → ondalık
  else if (hasComma && !hasDot) {
    out = s.replace(",", ".");
  }

  // Sadece nokta → Number karar versin
  else {
    out = s;
  }

  // Birden fazla nokta varsa → ondalık sadece sonuncu
  const dots = (out.match(/\./g) || []).length;
  if (dots > 1) {
    const parts = out.split(".");
    const decimal = parts.pop();
    out = parts.join("") + "." + decimal;
  }

  const n = Number(out);
  return isValidNumber(n) ? n : null;
}


// ===========================================================
// ABSURD FILTER — TITAN LEVEL
// ===========================================================
function sanitizeAbsurdPrice(value, context = {}) {
  if (!isValidNumber(value)) return null;

  // extremely huge → provider bug
  if (value > 8_000_000) return null;
  if (value <= 0) return null;

  const type = String(context.type || context.category || "").toLowerCase();
  const provider = String(context.provider || "").toLowerCase();

  let min = 3;

  if (/event|ticket|bilet|tour|travel|hotel|flight/.test(type)) {
    min = 5;
  }

  if (
    /booking|tatilbudur|tatilsepeti|mngtur|setur|trip|agoda|skyscanner|biletix|passo|biletino/.test(
      provider
    )
  ) {
    min = Math.max(min, 10);
  }

  if (value < min) return null;

  return value;
}


// ===========================================================
// MEMORY PROFILE PERSONALIZATION — S15
// ===========================================================
function priceSensitivityAdjust(basePrice, memoryProfile) {
  if (!isValidNumber(basePrice)) return basePrice;
  if (!memoryProfile || !isValidNumber(memoryProfile.priceSensitivity))
    return basePrice;

  const ps = memoryProfile.priceSensitivity;

  // Cheap-oriented
  if (ps < 0.95) {
    const factor = 0.90 + ps * 0.07; // 0.90–1.00 arası
    return basePrice * factor;
  }

  // Premium-oriented
  if (ps > 1.18) {
    const factor = 1 + Math.min(ps - 1, 0.15);
    return basePrice * factor;
  }

  return basePrice;
}


// ===========================================================
// MAIN ENGINE — computeFinalUserPrice (S15.9)
// ===========================================================
export function computeFinalUserPrice(item, options = {}) {
  if (!item || typeof item !== "object") {
    logPrice("INVALID_ITEM", { item });
    return null;
  }

  // -------------------------------------------------------
  // 1) Multi-Fallback Price Chain (en zengin zincir)
  // -------------------------------------------------------
  let candidate =
    item?.commissionMeta?.optimizedPrice ??
    item?.optimizedPrice ??
    item?.finalPrice ??
    item?.discountedPrice ??
    item?.salePrice ??
    item?.price;

  if (!isValidNumber(candidate)) {
    const parsed = parseLooseNumber(candidate);
    candidate = isValidNumber(parsed) ? parsed : null;
  }

  // -------------------------------------------------------
  // 2) Absurd sanitization (TRAVEL, EVENT, MARKET aware)
  // -------------------------------------------------------
  candidate = sanitizeAbsurdPrice(candidate, {
    type: item?.type || item?.category,
    provider: item?.provider,
  });

  if (!isValidNumber(candidate)) {
    logPrice("SANITIZE_FAIL", {
      original: item?.price,
      optimized: item?.optimizedPrice,
      context: { provider: item?.provider, category: item?.category },
    });
    return null;
  }

  // -------------------------------------------------------
  // 3) Memory-based personalization (S15 optimized)
  // -------------------------------------------------------
  try {
    if (options.memoryProfile) {
      candidate = priceSensitivityAdjust(candidate, options.memoryProfile);
    }
  } catch (err) {
    logPrice("SENSITIVITY_ERROR", err?.message);
  }

  // micro bias (double apply yok)
  try {
    const ps = options?.memoryProfile?.priceSensitivity;
    if (isValidNumber(ps)) {
      if (ps < 0.95) candidate *= 0.992; // %0.8 ucuz
      if (ps > 1.18) candidate *= 1.008; // %0.8 premium
    }
  } catch {}

  // -------------------------------------------------------
  // 4) Commission clamp (S11 → S15 stabil)
  // -------------------------------------------------------
  try {
    const cm = item?.commissionMeta || {};
    if (isValidNumber(cm.minPrice) && candidate < cm.minPrice)
      candidate = cm.minPrice;
    if (isValidNumber(cm.maxPrice) && candidate > cm.maxPrice)
      candidate = cm.maxPrice;
  } catch {}

  // -------------------------------------------------------
  // 5) Anti-floating + 2-decimal rounding
  // -------------------------------------------------------
  let finalPrice = Number(candidate.toFixed(2));

  if (!isValidNumber(finalPrice) || finalPrice <= 0) {
    logPrice("FINAL_REJECTED", { candidate, finalPrice });
    return null;
  }

  return finalPrice;
}


// ===========================================================
// SAFE WRAPPER — crashes forbidden
// ===========================================================
export function safeComputeFinalUserPrice(item, options = {}) {
  try {
    const r = computeFinalUserPrice(item, options);
    if (!isValidNumber(r) || r <= 0) return null;
    return r;
  } catch (err) {
    logPrice("safeCompute_ERROR", { error: err?.message, item });
    return null;
  }
}


// ===========================================================
// EXPORT
// ===========================================================
export default {
  computeFinalUserPrice,
  safeComputeFinalUserPrice,
};
