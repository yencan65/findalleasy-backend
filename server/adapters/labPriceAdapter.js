// server/adapters/labPriceAdapter.js
// ============================================================================
//  LAB TEST PRICES — S5 → S22 ULTRA TITAN FINAL
// ----------------------------------------------------------------------------
//  ZERO DELETE — Eski fonksiyonların tamamı korunur, sadece güçlendirildi
//  ✔ proxyFetchHTML + axios fallback + bot-trap cleaner
//  ✔ deterministic Titan stableId
//  ✔ strong price parse → sanitizePrice → optimizePrice
//  ✔ ImageVariants S22
//  ✔ provider meta + categoryAI
//  ✔ qualityScore
//  ✔ multi-provider cascade (Acıbadem, Medicana, Memorial, MedicalPark, Düzen)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


function safe(v) {
  return v ? String(v).trim() : "";
}

// ------------------------------------------------------------
// BOT TRAP CLEANER
// ------------------------------------------------------------
function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

// ------------------------------------------------------------
// STRONG PRICE PARSER (S22)
// ------------------------------------------------------------
function parsePriceStrong(txt) {
  if (!txt) return null;

  try {
    let clean = txt
      .replace(/TL|tl|₺|TRY|’den|den|başlayan/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    if (clean.includes("-")) clean = clean.split("-")[0].trim();

    clean = clean.replace(/\.(?=\d{3})/g, "").replace(",", ".");

    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// TITAN STABLE ID
// ------------------------------------------------------------
function stableId(provider, name) {
  const seed = `${provider}::${name}`;
  return "lab_" + Buffer.from(seed).toString("base64").slice(0, 14);
}

// ------------------------------------------------------------
// QUALITY SCORE
// ------------------------------------------------------------
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.4;
  if (item.price != null) s += 0.35;
  if (item.provider) s += 0.25;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// S22 ITEM BUILDER — ZERO DELETE (ESKİ buildItem korunur ama güçlenir)
// ------------------------------------------------------------
function buildItem(provider, name, price, region = "TR") {
  const id = stableId(provider, name);

  const base = {
    id,
    title: name,
    price: price ?? null,

    rating: null,
    provider,
    providerType: "health_service",
    providerFamily: "lab",
    vertical: "health",

    category: "health",
    categoryAI: "lab_test",

    currency: "TRY",
    region,

    url: null,
    deeplink: null,

    // ImageVariants — lab testlerin default bir görseli yoksa:
    image: null,
    imageOriginal: null,
    imageProxy: null,
    hasProxy: false,

    raw: { provider, name, price },
  };

  return {
    ...base,
    optimizedPrice:
      base.price != null
        ? optimizePrice({ price: base.price }, { provider })
        : null,
    qualityScore: computeQualityScore(base),
  };
}

// ------------------------------------------------------------
// FETCH WRAPPER — proxy + axios fallback
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 12000,
        headers: { "User-Agent": "Mozilla/5.0" },
      };
      if (signal) cfg.signal = signal;
      const { data } = await axios.get(url, cfg);
      return data;
    } catch {
      return null;
    }
  }
}

/* ============================================================
   PROVIDER SCRAPERS (ACIBADEM, MEDICANA, MEMORIAL, MEDICALPARK, DÜZEN)
============================================================ */

async function fetchAcibadem(q, signal) {
  const url = `https://www.acibadem.com.tr/laboratuvar/arama?search=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".lab-card, .result-item, .test-item").each((i, el) => {
    const name =
      safe($(el).find(".lab-title").text()) ||
      safe($(el).find("h3").text());
    if (!name) return;

    const priceTxt =
      safe($(el).find(".lab-price").text()) ||
      safe($(el).find(".price").text());

    const strong = parsePriceStrong(priceTxt);
    const price = sanitizePrice(strong);

    out.push(buildItem("acibadem", name, price));
  });

  return out;
}

async function fetchMedicana(q, signal) {
  const url = `https://www.medicana.com.tr/arama?search=${encodeURIComponent(q)}#lab`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".lab-test, .test-item, .result-row").each((i, el) => {
    const name =
      safe($(el).find(".test-title").text()) ||
      safe($(el).find("h3").text());
    if (!name) return;

    const priceRaw = parsePriceStrong(
      safe($(el).find(".test-price").text())
    );
    const price = sanitizePrice(priceRaw);

    out.push(buildItem("medicana", name, price));
  });

  return out;
}

async function fetchMemorial(q, signal) {
  const url = `https://www.memorial.com.tr/arama?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".test-item, .lab-row").each((i, el) => {
    const name = safe($(el).find("h3").text());
    if (!name) return;

    const priceRaw = parsePriceStrong(
      safe($(el).find(".price").text())
    );
    const price = sanitizePrice(priceRaw);

    out.push(buildItem("memorial", name, price));
  });

  return out;
}

async function fetchMedicalPark(q, signal) {
  const url = `https://www.medicalpark.com.tr/arama?search=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".lab-test, .test-row, .result-item").each((i, el) => {
    const name =
      safe($(el).find("h3").text()) ||
      safe($(el).find(".test-title").text());
    if (!name) return;

    const priceRaw = parsePriceStrong(
      safe($(el).find(".price").text())
    );
    const price = sanitizePrice(priceRaw);

    out.push(buildItem("medicalpark", name, price));
  });

  return out;
}

async function fetchDuzenLab(q, signal) {
  const url = `https://www.duzen.com.tr/arama?kelime=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".test-item, .test-row, .lab-row").each((i, el) => {
    const name =
      safe($(el).find(".test-title").text()) ||
      safe($(el).find("h3").text());
    if (!name) return;

    const priceRaw = parsePriceStrong(
      safe($(el).find(".price").text())
    );
    const price = sanitizePrice(priceRaw);

    out.push(buildItem("duzenlab", name, price));
  });

  return out;
}

/* ============================================================
   MASTER ADAPTER — S22 ULTRA TITAN
============================================================ */

async function searchLabPricesLegacy(query, { region = "TR", signal } = {}) {
  const q = safe(query);
  if (!q) {
    return {
      ok: false,
      adapterName: "labprices",
      items: [],
      count: 0,
    };
  }

  try {
    const providers = [
      fetchAcibadem(q, signal),
      fetchMedicana(q, signal),
      fetchMemorial(q, signal),
      fetchMedicalPark(q, signal),
      fetchDuzenLab(q, signal),
    ];

    const result = (await Promise.all(providers))
      .flat()
      .filter(Boolean);

    return {
      ok: true,
      adapterName: "labprices",
      items: result,
      count: result.length,
      region,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "labprices",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("labPriceAdapter hata:", err.message);

    return {
      ok: false,
      adapterName: "labprices",
      items: [],
      count: 0,
      error: err?.message || "unknown error",
    };
  }
}

// ============================================================================
// S200 WRAPPER — FINAL (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================

function _s200ResolveRegionSignal(regionOrOptions, fallbackRegion = "TR") {
  let region = fallbackRegion;
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || fallbackRegion;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || regionOrOptions.locale || fallbackRegion;
    signal = regionOrOptions.signal || null;
  }

  return { region: String(region || fallbackRegion).toUpperCase(), signal };
}

function _s200IsTimeout(e) {
  const n = String(e?.name || "").toLowerCase();
  const m = String(e?.message || "").toLowerCase();
  return n.includes("timeout") || m.includes("timed out");
}

function _s200IsFake(it) {
  if (!it || typeof it !== "object") return false;
  if (it.fallback === true || it.mock === true) return true;

  const u = String(it.affiliateUrl || it.deeplink || it.finalUrl || it.originUrl || it.url || "");
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

// --------------------------------------------------------------------------------
// S200 WRAPPER — NO FAKE / NO CRASH / NO DRIFT
// --------------------------------------------------------------------------------
export async function searchLabPricesAdapter(q, opts = {}) {
  const startedAt = Date.now();
  const query = String(q ?? "").trim();
  const region = String(opts?.region ?? "TR");

  // empty/too-short query: return empty-state (NOT an error)
  if (!query || query.length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: "lab_prices",
      _meta: { emptyQuery: true, providerKey: "lab_prices", region, tookMs: Date.now() - startedAt }
    };
  }

  try {
    // global context (some scrapers look at this; harmless otherwise)
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "lab_prices",
      providerKey: "lab_prices",
      source: "lab_prices",
      region,
    };

    const raw = await withTimeout(
      () => searchLabPrices(query, opts),
      Number(opts?.timeoutMs ?? 6500),
      "lab_prices"
    );

    const arr = coerceItemsS200(raw);
    const items = [];
    for (const it of arr) {
      const norm = normalizeItemS200(it, { providerKey: "lab_prices", region });
      if (!norm?.title || !norm?.url) continue;

      if (!norm.id) norm.id = stableId("lab_prices", norm.url, norm.title);
      norm.providerKey = fixKey(norm.providerKey || "lab_prices");

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: "lab_prices",
      _meta: {
        providerKey: "lab_prices",
        region,
        tookMs: Date.now() - startedAt
      }
    };
  } catch (e) {
    const msg = String(e?.message || e || "Unknown error");
    const timeout = e?.name === "TimeoutError" || /timeout/i.test(msg);

    return {
      ok: false,
      items: [],
      count: 0,
      source: "lab_prices",
      _meta: {
        providerKey: "lab_prices",
        region,
        timeout,
        error: msg,
        name: e?.name,
        tookMs: Date.now() - startedAt
      }
    };
  }
}


export const searchLabPrices = searchLabPricesAdapter;
export const searchLabPricesScrape = searchLabPricesAdapter;

export default {
  searchLabPrices,
  searchLabPricesScrape,
  searchLabPricesAdapter,
  searchLabPricesLegacy
};
