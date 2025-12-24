// server/core/normalizerS35.js
// ======================================================================
//  S35 GLOBAL PRICE NORMALIZER — S200 FUSION EDITION
//  • optimizePrice + autoInjectPrice → fiyatı temizler + eksik fiyat türetir
//  • AdapterEngine S200 ile tam uyumlu
//  • items[] ve {items:[]} yapılarını otomatik çözer
//  • provider-aware + context-aware çalışır
//  • item'ı asla öldürmez
//  • PATCH: 0/negatif → null, string fiyat parse, raw→price köprüsü
// ======================================================================

import { optimizePrice, autoInjectPrice } from "../utils/priceFixer.js";

// -------------------------------------------------------------
// HELPERS (ZERO-DELETE / additive)
// -------------------------------------------------------------
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const clampPos = (n) => (isNum(n) && n > 0 ? n : null);

function parsePriceLike(v) {
  try {
    if (v == null) return null;
    if (isNum(v)) return v > 0 ? v : null;

    const s0 = String(v).trim();
    if (!s0) return null;

    // "₺ 12.999,90" / "12.999 TL" / "12,999.90" / "12999" → 12999.90
    const s = s0
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[^\d.,]/g, "")
      .trim();

    if (!s) return null;

    let cleaned = s;
    const hasDot = cleaned.includes(".");
    const hasComma = cleaned.includes(",");

    if (hasDot && hasComma) {
      const lastDot = cleaned.lastIndexOf(".");
      const lastComma = cleaned.lastIndexOf(",");
      const dec = lastDot > lastComma ? "." : ",";
      const thou = dec === "." ? "," : ".";
      cleaned = cleaned.split(thou).join("");
      cleaned = cleaned.replace(dec, ".");
    } else if (hasComma && !hasDot) {
      const parts = cleaned.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        cleaned = parts[0].split(".").join("") + "." + parts[1];
      } else {
        cleaned = cleaned.split(",").join("");
      }
    } else if (hasDot && !hasComma) {
      const parts = cleaned.split(".");
      if (parts.length === 2 && parts[1].length <= 2) {
        cleaned = parts[0].split(",").join("") + "." + parts[1];
      } else {
        cleaned = cleaned.split(".").join("");
      }
    }

    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pickPriceFromItem(it) {
  if (!it || typeof it !== "object") return null;

  // 1) direct numeric fields first
  const direct = [
    it.optimizedPrice,
    it.finalUserPrice,
    it.finalPrice,
    it.price,
    it.userPrice,
    it.salePrice,
    it.discountedPrice,
    it.currentPrice,
    it.priceValue,
    it.amount,
    it.total,
  ];
  for (const v of direct) {
    const p = parsePriceLike(v);
    if (p != null) return p;
  }

  // 2) common text-ish fields
  const textual = [it.priceText, it.priceLabel, it.priceHint, it.subtitle, it.badgeText];
  for (const v of textual) {
    const p = parsePriceLike(v);
    if (p != null) return p;
  }

  // 3) raw nested fields
  const r = it.raw && typeof it.raw === "object" ? it.raw : null;
  if (r) {
    const rawCandidates = [
      r.optimizedPrice,
      r.finalUserPrice,
      r.finalPrice,
      r.price,
      r.salePrice,
      r.discountedPrice,
      r.currentPrice,
      r.amount,
      r.total,
      r.priceText,
      r.priceHint,
      r.fiyat,
      r.tutar,
      r.ucret,
    ];
    for (const v of rawCandidates) {
      const p = parsePriceLike(v);
      if (p != null) return p;
    }
  }

  return null;
}

function forceContract(it) {
  if (!it || typeof it !== "object") return it;

  const picked = pickPriceFromItem(it); // may be null
  const out = { ...it };

  // url fallback (S200 safety)
  out.url = out.url || out.finalUrl || out.originUrl || out.deeplink || out.link || out.href || "";

  // clamp existing, then fill missing with picked (do NOT overwrite valid fields)
  out.price = clampPos(out.price) ?? picked ?? null;
  out.finalPrice = clampPos(out.finalPrice) ?? picked ?? null;
  out.optimizedPrice = clampPos(out.optimizedPrice) ?? picked ?? null;

  if (out.finalUserPrice != null) out.finalUserPrice = clampPos(parsePriceLike(out.finalUserPrice));

  // never keep 0 / negative
  if (out.price != null && out.price <= 0) out.price = null;
  if (out.finalPrice != null && out.finalPrice <= 0) out.finalPrice = null;
  if (out.optimizedPrice != null && out.optimizedPrice <= 0) out.optimizedPrice = null;

  return out;
}

/**
 * S35 normalizer — S200 motor ile %100 uyumludur.
 * Hem array input, hem object input destekler.
 * item’ı öldürmez, fiyatı düzeltir, eksikse türetir.
 */
export function normalizeAdapterResultsS35(raw = [], context = {}) {
  try {
    // -------------------------------------------------------------
    // 1) Eğer S200 motorundan gelen standart object yapıysa:
    //    { ok, items, best, ... }
    // -------------------------------------------------------------
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const arr = Array.isArray(raw.items) ? raw.items : [];
      const fixed = arr.map((it) => normalizeItemS35(it, context));
      return { ...raw, items: fixed };
    }

    // -------------------------------------------------------------
    // 2) Düz array input (S200 adapter çıktılarının %80'i)
    // -------------------------------------------------------------
    if (Array.isArray(raw)) {
      return raw.map((it) => normalizeItemS35(it, context));
    }

    return raw;
  } catch (err) {
    console.warn("S35 normalize global error:", err?.message || err);
    return raw;
  }
}

/**
 * Tek bir item'i S35 mantığı ile normalize eder.
 * optimizePrice → temiz fiyat
 * autoInjectPrice → eksik fiyatı türet
 */
function normalizeItemS35(item, context = {}) {
  if (!item || typeof item !== "object") return item;

  // 0) raw/text → price köprüsü (optimizePrice 0 üretimini azaltır)
  let fixed = forceContract(item);

  try {
    fixed = optimizePrice(fixed, context);
  } catch (err) {
    console.warn("S35 optimizePrice hata:", err?.message || err);
  }

  try {
    fixed = autoInjectPrice(fixed, context);
  } catch (err) {
    console.warn("S35 autoInjectPrice hata:", err?.message || err);
  }

  // 3) final clamp + contract
  fixed = forceContract(fixed);

  return fixed;
}

export default {
  normalizeAdapterResultsS35,
};
