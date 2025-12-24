// ======================================================================
//   OPENFOODFACTS — S22 ULTRA TITAN EDITION
//   S15.9 tabanı %100 korunur → Üstüne S22 zekâ katmanı eklenir
//   - proxyFetchHTML fallback
//   - stableId
//   - S22 imageVariants
//   - categoryAI++
//   - qualityScore
//   - sanitizePrice / optimizePrice entegrasyonu
// ======================================================================

import fetch from "node-fetch";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { normalizeItemS200, stableIdS200, coerceItemsS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";
const PROVIDER_KEY = "openfoodfacts";
const DISCOVERY_SOURCE = true;

// ======================================================
// S15 SAFE FETCH (ESKİ KOD — SİLİNMİYOR)
// ======================================================
async function safeFetch(url, tries = 4) {
  let last = null;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "FindAllEasy/5.0 (OFF-S15 TITAN)",
          Accept: "application/json",
        },
        timeout: 9000,
      });

      if (res.status === 429) {
        const wait = Math.min(1500 * (i + 1), 6000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 350 * (i + 1) + Math.random() * 300));
    }
  }

  console.warn("⚠️ OFF safeFetch FAILED:", last?.message);
  return null;
}

// ======================================================
// S15 IMAGE VARIANTS (ESKİ KOD — SİLİNMİYOR)
// ======================================================
function buildImageVariantsLegacy(url) {
  if (!url) {
    return {
      image: null,
      imageOriginal: null,
      imageProxy: null,
      hasProxy: false,
    };
  }

  const encoded = encodeURIComponent(url);
  const proxy =
    process.env.FAE_IMAGE_PROXY ||
    process.env.FAE_PROXY_URL ||
    null;

  const proxyUrl = proxy ? `${proxy}?fmt=webp&url=${encoded}` : null;

  return {
    image: url,
    imageOriginal: url,
    imageProxy: proxyUrl,
    hasProxy: !!proxyUrl,
  };
}

// ======================================================
// S15 NORMALIZE HELPERS (ESKİ KOD — SİLİNMİYOR)
// ======================================================
function normalizePriceValue(str) {
  try {
    if (!str) return null;
    const cleaned = String(str)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function normalizeRating(grade) {
  if (!grade) return null;
  const g = String(grade).toLowerCase();
  const map = { a: 1, b: 0.9, c: 0.75, d: 0.55, e: 0.35 };
  return map[g] ?? null;
}

function cleanTitle(p, fallback = "Ürün") {
  return (
    p.product_name ||
    p.product_name_tr ||
    p.generic_name ||
    p.generic_name_tr ||
    p.brands ||
    fallback
  ).trim();
}

function normalizeCategory(catStr) {
  if (!catStr) return [];
  return String(catStr)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 1)
    .slice(0, 6);
}

function detectFlags(p) {
  const flags = [];
  if (p.labels_tags?.includes("en:organic")) flags.push("organic");
  if (p.labels_tags?.includes("en:gluten-free")) flags.push("gluten-free");
  if (p.labels_tags?.includes("en:vegan")) flags.push("vegan");
  if (p.labels_tags?.includes("en:vegetarian")) flags.push("vegetarian");
  if (p.nutriscore_grade === "a") flags.push("healthy-choice");
  return flags;
}

// ======================================================
// S15 NORMALIZE PRODUCT STRUCTURE (ESKİ KOD — SİLİNMİYOR)
// ======================================================
function normalizeOpenFoodItem(p, region = "TR") {
  const img =
    p.image_front_url ||
    p.image_url ||
    p.image_thumb_url ||
    null;

  return {
    id: stableIdS200(PROVIDER_KEY,
      p.url || (p.code ? `https://world.openfoodfacts.org/product/${p.code}` : ""),
      cleanTitle(p)
    ),
    title: cleanTitle(p),
    provider: "openfoodfacts",
    source: "openfoodfacts",
    region,

    rating: normalizeRating(p.nutriscore_grade),
    price: null,

    barcode: p.code || null,
    brand: p.brands || "",
    category: normalizeCategory(p.categories),

    flags: detectFlags(p),

    attributes: {
      quantity: p.quantity || null,
      packaging: p.packaging || null,
      labels: p.labels || null,
      allergens: p.allergens || null,
      ingredients: p.ingredients_text || null,
      countries: p.countries_tags || [],
    },

    ...buildImageVariantsLegacy(img),

    url:
      p.url ||
      (p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null),

    originUrl:
      p.url ||
      (p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null),

    finalUrl:
      p.url ||
      (p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null),

    deeplink:
      p.url ||
      (p.code
        ? `https://world.openfoodfacts.org/product/${p.code}`
        : null),

    raw: p,
  };
}

// ======================================================================
// 1) ESKİ SEARCH — SİLİNMİYOR
// ======================================================================
export async function searchOpenFoodFacts(query, region = "TR") {
  try {
    const q = encodeURIComponent(query);
    const url =
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}` +
      `&search_simple=1&action=process&json=1`;

    const json = await safeFetch(url);
    if (!json) return [];

    const items = Array.isArray(json.products)
      ? json.products.slice(0, 20)
      : [];

    return items.map((p) => normalizeOpenFoodItem(p, region));
  } catch (e) {
    console.warn("⚠️ OFF (old) hata:", e.message);
    return [];
  }
}

// ======================================================================
// 2) S15 HYBRID SEARCH (ESKİ) — SİLİNMİYOR
// ======================================================================
export async function searchWithOpenFoodFacts(query, region = "TR") {
  if (!query) return [];

  const isBarcode = /^\d{8,14}$/.test(query);

  if (isBarcode) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${query}.json`;
      const j = await safeFetch(url);
      if (j?.product) return [normalizeOpenFoodItem(j.product, region)];
    } catch {}
  }

  try {
    const q = encodeURIComponent(query);
    const url =
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}` +
      `&search_simple=1&action=process&json=1`;

    const j = await safeFetch(url);
    if (!j) return [];

    const items = Array.isArray(j.products)
      ? j.products.filter((p) => p.product_name || p.brands).slice(0, 25)
      : [];

    return items.map((p) => normalizeOpenFoodItem(p, region));
  } catch {
    return [];
  }
}

// ======================================================================
// 3) S15 FINAL MERGE — SİLİNMİYOR
// ======================================================================
export async function searchOpenFoodFactsFinal(query, region = "TR") {
  if (!query) return [];

  const results = [];
  const primary = await searchWithOpenFoodFacts(query, region);
  if (primary.length) results.push(...primary);

  const fallback = await searchOpenFoodFacts(query, region);
  if (fallback.length) results.push(...fallback);

  const seen = new Map();

  for (const x of results) {
    const key = String(x.barcode || x.id);
    if (!seen.has(key)) {
      seen.set(key, x);
      continue;
    }

    const existing = seen.get(key);
    if ((x.rating || 0) > (existing.rating || 0)) seen.set(key, x);
  }

  return [...seen.values()].slice(0, 30);
}

// ======================================================================
// ⭐⭐⭐ S22 ULTRA TITAN LAYER — YENİ NESİL GÜÇLENDİRME ⭐⭐⭐
// ======================================================================
function buildStableId(item, region) {
  const url = item?.url || item?.deeplink || (item?.barcode ? `https://world.openfoodfacts.org/product/${item.barcode}` : "");
  const title = item?.title || item?.brand || String(item?.barcode || "");
  return stableIdS200(PROVIDER_KEY, url, title);
}

function categoryAI(item) {
  const t = `${item.title} ${item.brand}`.toLowerCase();

  if (/organic|bio/.test(t)) return "organic_food";
  if (/milk|süt|yoğurt|cheese|dairy/.test(t)) return "dairy";
  if (/çikolata|snack|bar/.test(t)) return "snack";
  if (/drink|juice|meyve suyu|cola|soda/.test(t)) return "drink";
  if (/meat|et|tavuk|protein/.test(t)) return "protein";
  if (/bread|ekmek/.test(t)) return "bakery";

  return "food";
}

function qualityScore(item) {
  let score = 0;

  if (item.rating) score += item.rating * 2;
  if (item.flags?.includes("organic")) score += 0.4;
  if (item.flags?.includes("healthy-choice")) score += 0.6;

  if (item.brand) score += 0.2;

  return Number(score.toFixed(2));
}

function enhanceS22(item, region) {
  const s = { ...item };

  s.id = buildStableId(item, region);

  // price pipeline
  s.optimizedPrice = optimizePrice(
    { price: sanitizePrice(item.price) },
    { provider: "openfoodfacts" }
  );

  // category
  s.categoryS22 = categoryAI(item);

  // quality
  s.qualityScore = qualityScore(item);

  // improve imageVariants
  const img = item.imageOriginal || item.image || null;
  if (img) {
    const variants = buildImageVariants(img);
    s.image = variants.image;
    s.imageOriginal = variants.imageOriginal;
    s.imageProxy = variants.imageProxy;
    s.hasProxy = variants.hasProxy;
  }

  return s;
}

// ======================================================================
// 🎯 S22 FINAL EXPORT — Engine tarafından çağrılacak olan
// ======================================================================
export async function searchOpenFoodFactsS22(query, region = "TR") {
  const q = String(query || "").trim();
  if (!q) return { ok: false, items: [], count: 0, source: PROVIDER_KEY, _meta: { error: "empty_query", region } };

  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    adapter: "searchOpenFoodFactsS22",
    group: "food",
    metaUrl: import.meta?.url,
  };

  const startedAt = Date.now();

  try {
    const base = await withTimeout(searchOpenFoodFactsFinal(q, region), 6500, "openfoodfacts final");
    const enhanced = (Array.isArray(base) ? base : []).map((x) => enhanceS22(x, region));

    const items = enhanced
      .map((x) => {
        const raw = {
          ...x,
          provider: PROVIDER_KEY,
          source: PROVIDER_KEY,
          region,
          // discovery sources: force price null + affiliate OFF
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          affiliateUrl: null,
          url: x.url || x.deeplink || x.originUrl || x.finalUrl || null,
          originUrl: x.originUrl || x.url || x.deeplink || null,
          finalUrl: x.finalUrl || x.url || x.deeplink || null,
        };
        return normalizeItemS200(raw, PROVIDER_KEY, { vertical: "food", category: "food", discovery: true });
      })
      .filter(Boolean);

    return {
      ok: items.length > 0,
      items,
      count: items.length,
      source: PROVIDER_KEY,
      _meta: {
        region,
        discovery: true,
        tookMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    const isTimeout = err instanceof TimeoutError || /timed out/i.test(err?.message || "");
    return {
      ok: false,
      items: [],
      count: 0,
      source: PROVIDER_KEY,
      _meta: {
        region,
        discovery: true,
        timeout: isTimeout,
        error: err?.message || String(err),
        tookMs: Date.now() - startedAt,
      },
    };
  }
}

// ======================================================================
export async function searchOpenFoodFactsS22Array(query, region = "TR") {
  const res = await searchOpenFoodFactsS22(query, region);
  return res?.items || [];
}

export default {
  searchOpenFoodFacts,
  searchWithOpenFoodFoodFacts: searchWithOpenFoodFacts,
  searchOpenFoodFactsFinal,
  searchOpenFoodFactsS22,
};