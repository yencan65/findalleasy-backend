// ============================================================================
// FAE AFFILIATE ENGINE — S100 SAFE EDITION
// - ZERO DELETE: Eski davranışı korur, sadece güçlendirir
// - Provider normalizasyonu
// - Çift soru işareti / & sorunları engellenir
// - subid / clickid desteği
// - URL validity garanti edilir
// ============================================================================

function safe(v) {
  return v ? String(v).trim() : "";
}

// ------------------------------------------------------------
// URL temizleyici (çift ?? engelle)
// ------------------------------------------------------------
function appendParam(url, key, value) {
  if (!url) return url;
  const u = new URL(url, "https://dummy-base.com");

  if (value !== null && value !== undefined) {
    u.searchParams.set(key, value);
  }

  // dummy base kalksın
  return u.href.replace("https://dummy-base.com", "");
}

// ------------------------------------------------------------
// Provider normalize
// ------------------------------------------------------------
function normalizeProvider(p) {
  if (!p) return "unknown";
  p = p.toLowerCase().trim();

  if (p.includes("trendyol")) return "trendyol";
  if (p.includes("hepsiburada")) return "hepsiburada";
  if (p.includes("amazon")) return "amazon";
  if (p.includes("n11")) return "n11";
  if (p.includes("aliexpress")) return "aliexpress";
  if (p.includes("booking")) return "booking";
  if (p.includes("skyscanner")) return "skyscanner";
  if (p.includes("getir")) return "getir";
  if (p.includes("ciceksepeti")) return "ciceksepeti";

  return p;
}

// ------------------------------------------------------------
// ANA FONKSİYON — buildAffiliateLink(provider, deeplink, ctx)
// ctx.subid → click tracking
// ctx.userId → kişisel subid oluşturmak için
// ------------------------------------------------------------
export function buildAffiliateLink(provider, deeplink, ctx = {}) {
  const prov = normalizeProvider(provider);
  let url = safe(deeplink);

  if (!url) return deeplink;

  const subid =
    ctx.subid ||
    `fae_${prov}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // ----------------------------------------------------------
  // 1) TRENDYOL (gerçek DeepLink formatı)
  // ----------------------------------------------------------
  if (prov === "trendyol") {
    // Örn: https://ty.gl/xxxxx?afad_id=123&af_click_id=...
    url = appendParam(url, "ty_source", "findalleasy");
    url = appendParam(url, "aff_sub", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 2) HEPSIBURADA — gerçek aff formatına uygun
  // ----------------------------------------------------------
  if (prov === "hepsiburada") {
    url = appendParam(url, "aff_id", process.env.HEPSIBURADA_AFF_ID || "fae");
    url = appendParam(url, "aff_sub", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 3) AMAZON (hoplink model)
  // ----------------------------------------------------------
  if (prov === "amazon") {
    url = appendParam(url, "tag", process.env.AMAZON_TAG || "findalleasy-21");
    url = appendParam(url, "linkCode", "ll1");
    url = appendParam(url, "psc", "1");
    return url;
  }

  // ----------------------------------------------------------
  // 4) BOOKING — doğrulanmış partner formatı
  // ----------------------------------------------------------
  if (prov === "booking") {
    url = appendParam(url, "aid", process.env.BOOKING_AID || "999999");
    url = appendParam(url, "label", "findalleasy");
    url = appendParam(url, "sid", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 5) SK Y S C A N N E R — gerçek partner formatı
  // ----------------------------------------------------------
  if (prov === "skyscanner") {
    url = appendParam(url, "associateId", process.env.SKYSCANNER_ID || "fae");
    url = appendParam(url, "subid", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 6) N11
  // ----------------------------------------------------------
  if (prov === "n11") {
    url = appendParam(url, "affiliateId", process.env.N11_AFF_ID || "fae");
    url = appendParam(url, "subId", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 7) ALİEXPRESS
  // ----------------------------------------------------------
  if (prov === "aliexpress") {
    url = appendParam(url, "aff_fcid", process.env.ALI_FCID || "fae");
    url = appendParam(url, "aff_fsk", subid);
    return url;
  }

  // ----------------------------------------------------------
  // 8) FALLBACK — sadece subid ekle
  // ----------------------------------------------------------
  return appendParam(url, "subid", subid);
}
