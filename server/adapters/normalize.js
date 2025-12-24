import crypto from "crypto";

// ============================================================================
//  NORMALIZE ENGINE — S22 ULTRA TITAN
//  ZERO DELETE · ZERO DRIFT · FULL ADAPTER COMPATIBILITY
//  Her adapterdan çıkan item → tek bir çekirdek forma dönüştürülür
// ============================================================================

function stableIdDeterministic(providerKey, url, title) {
  const pk = String(providerKey || "unknown").trim() || "unknown";
  const base = `${pk}|${String(url || "")}|${String(title || "")}`;
  try {
    return pk + "_" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 18);
  } catch {
    // deterministic fallback (no random)
    const safe = (s) => String(s || "").replace(/[^a-z0-9]+/gi, "_");
    return safe(pk) + "_" + safe(url).slice(0, 12) + "_" + safe(title).slice(0, 12);
  }
}

export function normalizeAdapterItem(raw = {}) {
  // ---------------------------------------------------------
  // 1) PRICE NORMALIZATION
  // ---------------------------------------------------------
  const priceRaw =
    raw.price ??
    raw.finalPrice ??
    raw.amount ??
    raw.minPrice ??
    raw.maxPrice ??
    null;

  let price =
    priceRaw != null && !Number.isNaN(Number(priceRaw))
      ? Number(priceRaw)
      : null;

  // S200 contract: price<=0 => null
  if (price != null && price <= 0) price = null;

  // ---------------------------------------------------------
  // 2) RATING NORMALIZATION
  // ---------------------------------------------------------
  const ratingRaw =
    raw.rating ??
    raw.score ??
    raw.stars ??
    raw.reviewScore ??
    null;

  const rating =
    ratingRaw != null && !Number.isNaN(Number(ratingRaw))
      ? Number(ratingRaw)
      : null;

  // ---------------------------------------------------------
  // 3) COMMISSION
  // ---------------------------------------------------------
  const commissionRaw =
    raw.commissionRate ??
    raw.commission ??
    raw.affiliateCommission ??
    0;

  const commissionRate =
    commissionRaw != null && !Number.isNaN(Number(commissionRaw))
      ? Number(commissionRaw)
      : 0;

  const isAffiliate =
    Boolean(raw.isAffiliate || raw.affiliate || raw.partner) ||
    commissionRate > 0;

  // ---------------------------------------------------------
  // 4) PROVIDER + SOURCE
  // ---------------------------------------------------------
  const provider =
    raw.provider ||
    raw.source ||
    raw.vendor ||
    raw.platform ||
    raw.marketplace ||
    "unknown";

  // ---------------------------------------------------------
  // 5) CATEGORY (S22 requires this)
  // ---------------------------------------------------------
  const category =
    raw.category ||
    raw.categoryAI ||
    raw.type ||
    "product";

  // ---------------------------------------------------------
  // 6) REGION
  // ---------------------------------------------------------
  const region =
    raw.region ||
    raw.country ||
    "TR";

  // ---------------------------------------------------------
  // 7) IMAGE VARIANTS (S22 STANDARD)
  // ---------------------------------------------------------
  const image = raw.image || raw.imageOriginal || null;

  const imageOriginal =
    raw.imageOriginal || raw.image || null;

  const imageProxy = raw.imageProxy || null;

  const hasProxy = Boolean(raw.hasProxy);

  // ---------------------------------------------------------
  // 8) OPTIMIZED PRICE (S22)
  // ---------------------------------------------------------
  const optimizedPrice =
    raw.optimizedPrice ??
    raw.finalPrice ??
    price;

  // ---------------------------------------------------------
  // 9) VALIDATION FLAG (CRITICAL)
  // ---------------------------------------------------------
  const isValid = Boolean(
    raw.title &&
      (price === null || price > 0) &&
      provider &&
      raw.url
  );

  // ---------------------------------------------------------
  // 10) ID — LEAVE BUT ENSURE VALID
  // ---------------------------------------------------------
  const id =
    raw.id ||
    raw.sku ||
    raw.offerId ||
    raw.code ||
    stableIdDeterministic(provider, raw.affiliateUrl || raw.deeplink || raw.finalUrl || raw.originUrl || raw.url || raw.link || raw.deepLink || "", raw.title || "");

  // ---------------------------------------------------------
  // FINAL S22 NORMALIZED OBJECT
  // ---------------------------------------------------------
  return {
    id,
    title: raw.title || raw.name || raw.productName || "",

    provider,
    source: provider,

    price,
    optimizedPrice,
    currency: raw.currency || raw.ccy || "TRY",

    rating,
    commissionRate,
    isAffiliate,

    url:
      raw.affiliateUrl ||
      raw.deeplink ||
      raw.finalUrl ||
      raw.originUrl ||
      raw.url ||
      raw.link ||
      raw.deepLink ||
      null,

    region,
    category,

    image,
    imageOriginal,
    imageProxy,
    hasProxy,

    isValid,

    raw // raw data ALWAYS kept
  };
}
