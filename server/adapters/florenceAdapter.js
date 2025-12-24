// server/adapters/florenceAdapter.js
// ======================================================================
// FLORENCE NIGHTINGALE HOSPITAL — S33 TITAN+ EDITION (FINAL)
// Zero Delete — tüm alias & fonksiyonlar korunur, sadece güçlendirilir.
// • stableId v3.5 (slug + urlHash + entropy)
// • ImageVariants FULL
// • QualityScore (health-weighted S33)
// • categoryAI → "health_checkup"
// • Price pipeline (price/finalPrice/optimizedPrice)
// • Strong fallback
// • Abort + Timeout tam uyumlu
// ======================================================================

import axios from "axios";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { coerceItemsS200, normalizeItemS200, priceOrNullS200, stableIdS200, withTimeout } from "../core/s200AdapterKit.js";

// ------------------------------------------------------------
// HELPERS (S33 Level)
// ------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
}

function stableId(title, href) {
  // S200 deterministic stable id (NO RANDOM)
  return stableIdS200("florence", href || "", title || "florence");
}

function computeQualityScore(item) {
  let s = 0;

  if (item.title) s += 0.40;
  if (item.price != null) s += 0.10;
  if (item.image) s += 0.25;

  s += 0.25; // S33 entropy boost
  return Number(s.toFixed(2));
}

function parsePriceStrong(t) {
  if (!t) return null;
  try {
    const cleaned = t
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// NORMALIZE (Upgraded to S33)
// ------------------------------------------------------------
function normalizeItem(raw, query = "") {
  const title =
    raw.title ||
    raw.name ||
    `Florence Hospital – ${query}`;

  const price = parsePriceStrong(raw.price);
  const url = raw.url || "";
  const img = raw.image || null;

  const imageData = buildImageVariants(img, "florence");
  const id = stableId(title, url);

  const base = {
    id,
    title,
    price,
    finalPrice: price,
    optimizedPrice: price,

    url,
    deeplink: url,

    provider: "florence",
    providerType: "health",
    providerFamily: "florence",
    providerSignature: "florence_s33",
    adapterVersion: "S33.TITAN+",
    reliabilityScore: 0.82,

    category: "health",
    categoryAI: "health_checkup",
    currency: "TRY",
    stockStatus: "available",
    region: "TR",

    image: imageData.image,
    imageOriginal: imageData.imageOriginal,
    imageProxy: imageData.imageProxy,
    hasProxy: imageData.hasProxy,

    rating: null,

    fallback: raw.fallback ?? false,

    raw,
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// ------------------------------------------------------------
// MAIN SCRAPER (S33 TITAN+)
// ------------------------------------------------------------
export async function searchFlorenceAdapterItems(query = "", opts = {}) {
  const q = encodeURIComponent((query || "").trim());
  const region = opts.region || "TR";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);

  try {
    const url = `https://www.florence.com.tr/arama?query=${q}`;

    const { data: html } = await axios.get(url, {
      signal: controller.signal,
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    clearTimeout(timeout);

    const res = [];
    const regex =
      /<a[^>]*class="[^"]*service-card[^"]*"[^>]*href="(.*?)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = regex.exec(html))) {
      const href = match[1];
      const block = match[2];

      const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/i);
      const priceMatch = block.match(/<span[^>]*class="price"[^>]*>(.*?)<\/span>/i);
      const imgMatch = block.match(/<img[^>]*src="(.*?)"/i);

      const raw = {
        title: titleMatch ? safe(titleMatch[1]) : null,
        price: priceMatch ? safe(priceMatch[1]) : null,
        image: imgMatch ? safe(imgMatch[1]) : null,
        url: `https://www.florence.com.tr${href}`,
      };

      res.push(normalizeItem(raw, query));
    }

    return res.slice(0, 50);
  } catch (err) {
    clearTimeout(timeout);
    return fallbackFlorence(query);
  }
}

// ------------------------------------------------------------
// FALLBACK (TITAN+ SAFE)
// ------------------------------------------------------------
function fallbackFlorence(query = "") {
  const raw = {
    title: "Florence Hospital erişilemedi",
    price: null,
    image: null,
    url: "",
    fallback: true,
  };

  return [
    {
      ...normalizeItem(raw, query),
      qualityScore: 0.05,
      fallback: true,
    },
  ];
}

// ======================================================================
// S200 WRAPPER (observable fail, contract lock, deterministic id)
// ======================================================================
function _s200NormalizeList(out, providerKey, opts = {}) {
  const arr = coerceItemsS200(out);
  const res = [];
  for (const it of arr) {
    if (!it) continue;
    const clean = { ...it };
    delete clean.id;
    delete clean.listingId;
    if ("price" in clean) clean.price = priceOrNullS200(clean.price);
    const n = normalizeItemS200(clean, providerKey, opts);
    if (n) res.push(n);
  }
  return res;
}

export async function searchFlorenceAdapter(query, options = {}) {
  const providerKey = "florence";
  const started = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "florenceAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };
  try {
    const t = Number(options?.timeoutMs || options?.timeout || 6500);
    const raw = await withTimeout(searchFlorenceAdapterItems(query, options), t, `${providerKey}_items`);
    const region = String(options?.region || "TR").toUpperCase();
    const items = _s200NormalizeList(raw, providerKey, { vertical: "health", category: "health", region });
    return { ok: true, items, count: items.length, source: providerKey, _meta: { tookMs: Date.now() - started, region } };
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(msg);
    return { ok: false, items: [], count: 0, source: providerKey, _meta: { tookMs: Date.now() - started, error: msg, timeout: isTimeout } };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ------------------------------------------------------------
// ALIAS #1 — Backward compatibility
// ------------------------------------------------------------
export async function searchFlorence(query = "", opts = {}) {
  return await searchFlorenceAdapter(query, opts);
}

// ------------------------------------------------------------
// ALIAS #2 — Group fallback
// ------------------------------------------------------------
export async function searchFlorenceScrape(query = "", opts = {}) {
  return await searchFlorenceAdapter(query, opts);
}

// ------------------------------------------------------------
// DEFAULT EXPORT
// ------------------------------------------------------------
export default {
  searchFlorenceAdapter,
  searchFlorence,
  searchFlorenceScrape,
};