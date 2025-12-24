// ============================================================================
//  FAE PRICE ENGINE — S1000 → S200 FUSION EDITION
//  ✔ TR/EN tüm price formatlarını çözer
//  ✔ S200 AdapterEngine SAFE protokolüne %100 uyumlu
//  ✔ null → undefined (item ASLA ölmez)
//  ✔ sanitize sadece normalize eder (kararı S200 verir)
// ============================================================================

export function sanitizePrice(input, ctx = {}) {
  if (input == null) return null;

  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? input : null;
  }

  let s = String(input).trim();
  if (!s) return null;

  // NBSP / narrow NBSP → space
  s = s.replace(/\u00a0|\u202f/g, " ");

  // 1) first "number-looking" chunk (prefix/suffix text doesn't matter)
  const m = s.match(/-?\d[\d.\s]*\d(?:[.,]\d{1,2})?/);
  if (!m) return null;

  let num = m[0].replace(/\s+/g, "");

  // 2) decimal separator decision
  const lastComma = num.lastIndexOf(",");
  const lastDot = num.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // 94.249,00 -> comma decimal
      num = num.replace(/\./g, "").replace(",", ".");
    } else {
      // 94,249.00 -> dot decimal
      num = num.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    const decimals = (num.split(",")[1] || "");
    if (decimals.length > 0 && decimals.length <= 2) {
      num = num.replace(/\./g, "").replace(",", ".");
    } else {
      num = num.replace(/,/g, "");
    }
  } else if (lastDot > -1) {
    const parts = num.split(".");
    if (parts.length > 2) {
      const last = parts[parts.length - 1];
      if (last.length === 3) num = parts.join("");
      else num = parts.slice(0, -1).join("") + "." + last;
    } else if (parts.length === 2 && parts[1].length === 3) {
      num = parts.join("");
    }
  }

  const out = Number.parseFloat(num);
  if (!Number.isFinite(out) || out <= 0) {
    if (ctx?.debug) {
      console.warn("PRICE:S200_SANITIZE_FAIL_SAFE", { original: s, extracted: m[0], normalized: num });
    }
    return null;
  }
  return out;
}

