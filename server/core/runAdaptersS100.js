// server/core/runAdaptersS100.js
// ======================================================================
//  FAE ADAPTER CORE — S100 CATEGORY KERNEL
//  - Intent → category + vertical
//  - Doğru adapter gruplarını seç
//  - safeRun + timeout + abort
//  - Fallback HER ZAMAN productAdapters
//  - BEST / SMART / OTHERS seçimi
// ======================================================================

import { detectIntent } from "./intentEngine.js";

// === GROUP IMPORTS ====================================================
import { productAdapters } from "../adapters/groups/productAdapters.js";
import { marketAdapters } from "../adapters/groups/marketAdapters.js";
import { fashionAdapters } from "../adapters/groups/fashionAdapters.js";
import { foodAdapters } from "../adapters/groups/foodAdapters.js";

import { tourAdapters } from "../adapters/groups/tourAdapters.js";
import { carRentalAdapters } from "../adapters/groups/carRentalAdapters.js";
import { spaWellnessAdapters } from "../adapters/groups/spaWellnessAdapters.js";
import { estateAdapters } from "../adapters/groups/estateAdapters.js";
import { eventAdapters } from "../adapters/groups/eventAdapters.js";

import { healthAdapters } from "../adapters/groups/healthAdapters.js";
import { checkupAdapters } from "../adapters/groups/checkupAdapters.js";
import { psychologistAdapters } from "../adapters/groups/psychologistAdapters.js";
import { insuranceAdapters } from "../adapters/groups/insuranceAdapters.js";
import { lawyerAdapters } from "../adapters/groups/lawyerAdapters.js";

import { rentalAdapters } from "../adapters/groups/rentalAdapters.js";
import { officeAdapters } from "../adapters/groups/officeAdapters.js";
import { educationAdapters } from "../adapters/groups/educationAdapters.js";
import { craftAdapters } from "../adapters/groups/craftAdapters.js";
import { foodAdapters as restaurantAdapters } from "../adapters/groups/foodAdapters.js";

// ======================================================================
//  UTILS
// ======================================================================

const DEFAULT_TIMEOUT_MS = 8000;

// küçük helper
function flat(arr) {
  return arr.reduce((acc, v) => acc.concat(v || []), []);
}

function uniqById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = it.id || it.deeplink || it.url;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

// Basit skor: fiyat + rating + provider weight
function scoreItem(it) {
  let score = 0;

  // fiyat düşükse ödüllendir
  if (typeof it.price === "number" && it.price > 0) {
    // 0–1 aralığına kaba normalize
    const p = it.price;
    score += 1000 / (1 + p); // fiyat arttıkça düşsün
  }

  // rating ekle
  if (typeof it.rating === "number" && it.rating > 0) {
    score += it.rating * 50;
  }

  // provider bonus (çok kaba ama yeter)
  const prov = String(it.provider || "").toLowerCase();
  if (prov.includes("trendyol")) score *= 1.03;
  if (prov.includes("hepsiburada")) score *= 1.03;
  if (prov.includes("amazon")) score *= 1.02;

  return score;
}

// ======================================================================
//  INTENT → CATEGORY / VERTICAL MAP
// ======================================================================

function mapIntentToCategory(intentRaw, query) {
  const q = String(query || "").toLowerCase();
  const base = String(intentRaw || "").toLowerCase();

  // Hard override’lar
  if (q.includes("otel") || q.includes("hotel")) return "hotel";
  if (q.includes("uçuş") || q.includes("flight") || q.includes("bilet"))
    return "flight";
  if (q.includes("araba kirala") || q.includes("oto kirala"))
    return "car_rental";
  if (q.includes("balon turu") || q.includes("kapadokya") || q.includes("tour"))
    return "tour";
  if (q.includes("psikolog") || q.includes("psycholog")) return "psychologist";
  if (q.includes("sigorta")) return "insurance";
  if (q.includes("avukat") || q.includes("lawyer")) return "lawyer";
  if (q.includes("diyetisyen") || q.includes("doktor") || q.includes("hastane"))
    return "health";
  if (q.includes("spa") || q.includes("masaj") || q.includes("hamam"))
    return "spa";
  if (q.includes("kiralık") || q.includes("rent a car")) return "car_rental";
  if (q.includes("kiralık daire") || q.includes("satılık daire"))
    return "estate";
  if (q.includes("biletix") || q.includes("etkinlik")) return "event";
  if (q.includes("kurs") || q.includes("eğitim")) return "education";

  // IntentEngine'den gelen
  if (base === "travel" || base === "tour") return "tour";
  if (base === "hotel") return "hotel";
  if (base === "food") return "food";
  if (base === "estate") return "estate";
  if (base === "health") return "health";
  if (base === "psychologist") return "psychologist";
  if (base === "insurance") return "insurance";
  if (base === "lawyer") return "lawyer";

  // DEFAULT → product (senin istediğin)
  return "product";
}

// ======================================================================
//  CATEGORY → ADAPTER GRUPLARI
// ======================================================================

function pickGroupsForCategory(category) {
  const cat = String(category || "product");

  // her durumda global fallback: productAdapters
  const fallback = [productAdapters];

  switch (cat) {
    case "product":
      return {
        category: "product",
        groups: [productAdapters, marketAdapters, fashionAdapters, foodAdapters],
        fallback,
      };

    case "tour":
      return {
        category: "tour",
        groups: [tourAdapters, eventAdapters],
        fallback,
      };

    case "hotel":
      return {
        category: "hotel",
        groups: [tourAdapters, estateAdapters],
        fallback,
      };

    case "car_rental":
      return {
        category: "car_rental",
        groups: [carRentalAdapters],
        fallback,
      };

    case "spa":
      return {
        category: "spa",
        groups: [spaWellnessAdapters, tourAdapters],
        fallback,
      };

    case "estate":
      return {
        category: "estate",
        groups: [estateAdapters, rentalAdapters],
        fallback,
      };

    case "event":
      return {
        category: "event",
        groups: [eventAdapters],
        fallback,
      };

    case "health":
      return {
        category: "health",
        groups: [healthAdapters, checkupAdapters],
        fallback,
      };

    case "psychologist":
      return {
        category: "psychologist",
        groups: [psychologistAdapters, healthAdapters],
        fallback,
      };

    case "insurance":
      return {
        category: "insurance",
        groups: [insuranceAdapters],
        fallback,
      };

    case "lawyer":
      return {
        category: "lawyer",
        groups: [lawyerAdapters],
        fallback,
      };

    case "education":
      return {
        category: "education",
        groups: [educationAdapters],
        fallback,
      };

    case "office":
      return {
        category: "office",
        groups: [officeAdapters, craftAdapters],
        fallback,
      };

    default:
      return {
        category: "product",
        groups: [productAdapters, marketAdapters],
        fallback,
      };
  }
}

// ======================================================================
//  ADAPTER ÇALIŞTIRMA — SAFE LAYER
// ======================================================================

async function safeRunAdapter(adapter, query, region) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const startedAt = Date.now();
  try {
    const fn =
      adapter.run ||
      adapter.search ||
      adapter.fn ||
      adapter.adapterFn ||
      null;

    if (!fn) {
      console.warn("S100: Adapter fn yok:", adapter.id || adapter.name);
      return [];
    }

    const res = await fn(query, {
      region,
      signal: controller.signal,
    });

    const duration = Date.now() - startedAt;
    if (duration > 3000) {
      console.log(
        `🐢 Yavaş adapter: ${adapter.id || adapter.name} (${duration}ms)`
      );
    }

    if (!res) return [];
    if (Array.isArray(res)) return res;

    // bazı adapterler { items: [] } döndürebilir
    if (Array.isArray(res.items)) return res.items;
    return [];
  } catch (err) {
    const duration = Date.now() - startedAt;
    console.warn(
      `❌ Adapter hata: ${adapter.id || adapter.name} (${duration}ms):`,
      err?.message || err
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================================
//  PUBLIC API — S100 RUN
// ======================================================================

export async function runAdaptersS100({
  query,
  region = "TR",
  userId = null,
} = {}) {
  const q = String(query || "").trim();
  if (!q) {
    return {
      query: q,
      region,
      category: "product",
      items: [],
      best: null,
      smart: [],
      others: [],
      intent: null,
    };
  }

  // 1) Intent + kategori
  let intentInfo = null;
  try {
    intentInfo = await detectIntent(q, region);
  } catch (err) {
    console.warn("S100: detectIntent hata, fallback product:", err?.message);
  }

  const intentName =
    intentInfo?.intent ||
    intentInfo?.type ||
    intentInfo?.category ||
    "product";

  const category = mapIntentToCategory(intentName, q);
  const plan = pickGroupsForCategory(category);

  // 2) Adapter listesi
  const primaryAdapters = flat(plan.groups);
  const fallbackAdapters = flat(plan.fallback);

  const allAdapters =
    primaryAdapters.length > 0
      ? primaryAdapters.concat(fallbackAdapters)
      : fallbackAdapters;

  // 3) Paralel çalıştır
  const allResults = await Promise.all(
    allAdapters.map((ad) => safeRunAdapter(ad, q, region))
  );

  // 4) Flatten + temizle
  let merged = flat(allResults);

  // fiyat / görsel / url hiç olmayan çöpleri at
  merged = merged.filter((it) => {
    const hasPrice = typeof it.price === "number" && it.price > 0;
    const hasImg = !!(it.image || it.imageOriginal || it.imageProxy);
    const hasUrl = !!(it.deeplink || it.url);
    return hasPrice || hasImg || hasUrl;
  });

  if (!merged.length) {
    console.log("S100: Hiç sonuç yok, sadece productAdapters fallback denenecek.");
    const fallbackOnly = flat(
      await Promise.all(
        fallbackAdapters.map((ad) => safeRunAdapter(ad, q, region))
      )
    );
    merged = fallbackOnly;
  }

  // 5) Dedupe + skorla
  const unique = uniqById(merged).map((it) => ({
    ...it,
    _score: scoreItem(it),
  }));

  // skor sıralama
  unique.sort((a, b) => (b._score || 0) - (a._score || 0));

  const best = unique[0] || null;
  const smart = unique.slice(1, 4); // en iyi 3 alternatif
  const others = unique.slice(4, 25); // vitrin için kalabalık havuz

  return {
    query: q,
    region,
    intent: intentName,
    category: plan.category,
    items: unique,
    best,
    smart,
    others,
  };
}
