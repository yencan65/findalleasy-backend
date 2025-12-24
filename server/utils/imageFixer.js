// ============================================================================
//  FAE IMAGE FIXER — S200 ADAPTER-ENGINE COMPAT FINAL
//  - Hiçbir ürünü öldürmez
//  - image, imageOriginal, imageProxy, hasProxy alanlarını garanti eder
//  - AdapterEngine S200 normalizeItem() ile %100 uyumludur
// ============================================================================

// PROXY BASE auto detect
const RAW_PROXY_BASE =
  process.env.IMG_PROXY_BASE ||
  process.env.IMAGE_PROXY_BASE ||
  process.env.IMGPROXY_BASE ||
  "";

const PROXY_BASE = RAW_PROXY_BASE ? RAW_PROXY_BASE.replace(/\/+$/, "") : "";

// -------------------------------------------
// Safe helper
// -------------------------------------------
function safe(v) {
  if (v == null) return "";
  return String(v).trim();
}

// -------------------------------------------
// normalizeImageUrl — MUTLAK URL üretir
// S200 motoru: imageOriginal her durumda geçerli olmalı
// -------------------------------------------
export function normalizeImageUrl(url) {
  let u = safe(url);
  if (!u) return null;

  // data URL → dokunma
  if (u.startsWith("data:")) return u;

  // "/xyz.jpg" → https: prefix
  if (u.startsWith("/")) return "https:" + u;

  // "//xyz.jpg" → https: prefix
  if (u.startsWith("//")) return "https:" + u;

  // http/https → olduğu gibi dön
  return u;
}

// -------------------------------------------
// proxyImage — S200: proxy varsa kullan, yoksa original döner
// -------------------------------------------
export function proxyImage(url, provider = "generic") {
  const normalized = normalizeImageUrl(url);
  if (!normalized) return null;

  // Proxy yok → original kullan
  if (!PROXY_BASE) return normalized;

  const encodedUrl = encodeURIComponent(normalized);
  const prov = encodeURIComponent(String(provider || "generic").toLowerCase());

  return `${PROXY_BASE}/img?url=${encodedUrl}&provider=${prov}`;
}

// -------------------------------------------
// buildImageVariants — S200 normalizeItem() ile birebir uyumlu
// -------------------------------------------
export function buildImageVariants(url, provider = "generic") {
  const original = normalizeImageUrl(url);

  // ORIGINAL yoksa bile NULL item döndürmeyiz (S200 item must survive)
  if (!original) {
    return {
      image: null,
      imageOriginal: null,
      imageProxy: null,
      hasProxy: false,
    };
  }

  const proxied = proxyImage(original, provider);

  return {
    image: proxied || original,
    imageOriginal: original,
    imageProxy: proxied || null,
    hasProxy: !!proxied && proxied !== original,
  };
}

// -------------------------------------------
// S200 COMPAT: normalizeItemImage()
// AdapterEngine her item için bunu otomatik uygular
// -------------------------------------------
export function normalizeItemImage(item = {}, provider = "generic") {
  if (!item || typeof item !== "object") return item;

  const url =
    item.image ||
    item.img ||
    item.thumbnail ||
    item.picture ||
    item.imageUrl ||
    item.images?.[0] ||
    item.raw?.image ||
    null;

  const variants = buildImageVariants(url, provider);

  return {
    ...item,
    image: variants.image,
    imageOriginal: variants.imageOriginal,
    imageProxy: variants.imageProxy,
    hasProxy: variants.hasProxy,
  };
}

// Export block
export default {
  normalizeImageUrl,
  proxyImage,
  buildImageVariants,
  normalizeItemImage,
};
