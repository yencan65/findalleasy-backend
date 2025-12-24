// server/adapters/lawyerAdapter.js
// ============================================================================
//  LAWYER ADAPTER — S5 → S22 ULTRA TITAN FINAL
// ----------------------------------------------------------------------------
//  ZERO DELETE — Eski S5 fonksiyonları korunur, üstüne Titan katmanları eklendi
//  ✔ deterministic stableId (Titan Merge Engine uyumlu)
//  ✔ proxyFetchHTML + anti-bot cleaner
//  ✔ strongPriceParser → sanitizePrice → optimizePrice
//  ✔ ImageVariants S22
//  ✔ provider meta + categoryAI
//  ✔ qualityScore
//  ✔ multi-source (3 site) + safe fallback
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  coerceItemsS200,
  fixKey,
  loadCheerioS200,
  normalizeItemS200,
  withTimeout,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS =
  String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

function safe(v) {
  return v ? String(v).trim() : "";
}

// ------------------------------------------------------------
// ANTI-BOT CLEANER
// ------------------------------------------------------------
function cleanBotTraps(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

// ------------------------------------------------------------
// TITAN STABLE ID
// ------------------------------------------------------------
function stableId(provider, name, city) {
  const seed = `${provider}::${name}::${city}`;
  return "law_" + Buffer.from(seed).toString("base64").slice(0, 12);
}

// ------------------------------------------------------------
// STRONG PRICE PARSER (S22)
// ------------------------------------------------------------
function parseStrongLawyerPrice(txt) {
  if (!txt) return null;

  try {
    let clean = String(txt)
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
// QUALITY SCORE
// ------------------------------------------------------------
function computeQualityScore(item) {
  let s = 0;
  if (item.title?.length > 3) s += 0.4;
  if (item.city) s += 0.2;
  if (item.price != null) s += 0.2;
  if (item.image) s += 0.2;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// MAKE LAWYER ITEM — S22/TITAN UYUMLU
// (eski fonksiyon adı korunuyor → ZERO DELETE)
// ------------------------------------------------------------
function makeLawyerItem(
  provider,
  name,
  city,
  url,
  img,
  price = null,
  rating = null
) {
  const id = stableId(provider, name, city);
  const image = buildImageVariants(img);

  const base = {
    id,
    title: name || "Avukat",
    provider,
    providerType: "professional_service",
    providerFamily: "lawyer",
    vertical: "legal",

    category: "lawyer",
    categoryAI: "lawyer",

    currency: "TRY",
    region: "TR",

    url: url || null,
    deeplink: url || null,

    image: image.image,
    imageOriginal: image.imageOriginal,
    imageProxy: image.imageProxy,
    hasProxy: image.hasProxy,

    city: city || "",
    location: city || "",

    price: price ?? null,
    rating: rating ?? 4.5,

    trustScore: 0.9,

    badges: ["legal_service", "professional_help"],
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
    optimizedPrice:
      base.price != null
        ? optimizePrice({ price: base.price }, { provider })
        : null,
    raw: { name, city, url, img, price },
  };
}

// ------------------------------------------------------------
// SCRAPE HELPERS — proxy + axios fallback
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 15000,
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

/* =============================================================
   1) AvukatBul.com
============================================================= */
async function scrapeAvukatBul(q, signal) {
  const url = `https://www.avukatbul.com/arama?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".lawyer-card, .result-item, .lawyer-box, .lawyer").each((i, el) => {
    const name =
      safe($(el).find(".lawyer-name").text()) || safe($(el).find("h2").text());
    if (!name) return;

    const city =
      safe($(el).find(".lawyer-location").text()) || safe($(el).find(".city").text());

    let href = $(el).find("a").attr("href") || "";
    if (href && !href.startsWith("http")) href = `https://www.avukatbul.com${href}`;

    const img =
      $(el).find("img").attr("src") ||
      $(el).find("img").attr("data-src") ||
      null;

    const priceTxt = safe($(el).find(".lawyer-price").text());
    const priceRaw = parseStrongLawyerPrice(priceTxt);
    const price = sanitizePrice(priceRaw);

    out.push(makeLawyerItem("avukatbul", name, city, href, img, price));
  });

  return out;
}

/* =============================================================
   2) AvukatRehberi.org
============================================================= */
async function scrapeAvukatRehberi(q, signal) {
  const url = `https://www.avukatrehberi.org/ara?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".avukat-card, .listing, .result, .lawyer-row").each((i, el) => {
    const name =
      safe($(el).find(".title").text()) || safe($(el).find("h3").text());
    if (!name) return;

    const city =
      safe($(el).find(".city").text()) || safe($(el).find(".location").text());

    let href = $(el).find("a").attr("href") || "";
    if (href && !href.startsWith("http")) href = "https://www.avukatrehberi.org" + href;

    const img =
      $(el).find("img").attr("src") ||
      $(el).find("img").attr("data-img") ||
      null;

    out.push(makeLawyerItem("avukatrehberi", name, city, href, img));
  });

  return out;
}

/* =============================================================
   3) Avukat.com.tr
============================================================= */
async function scrapeAvukatCom(q, signal) {
  const url = `https://www.avukat.com.tr/ara?q=${encodeURIComponent(q)}`;
  const html = await fetchHTML(url, signal);
  if (!html) return [];

  const $ = loadCheerioS200(cleanBotTraps(html));
  const out = [];

  $(".lawyer-card, .attorney, .list-item").each((i, el) => {
    const name =
      safe($(el).find(".name").text()) || safe($(el).find("h2").text());
    if (!name) return;

    const city =
      safe($(el).find(".city").text()) || safe($(el).find(".location").text());

    let href = $(el).find("a").attr("href") || "";
    if (href && !href.startsWith("http")) href = "https://www.avukat.com.tr" + href;

    const img =
      $(el).find("img").attr("src") ||
      $(el).find("img").attr("data-src") ||
      null;

    out.push(makeLawyerItem("avukatcom", name, city, href, img));
  });

  return out;
}

/* =============================================================
   MASTER ADAPTER — S5 UYUM + S22 TITAN
============================================================= */
async function searchLawyerLegacy(query, { region = "TR", signal } = {}) {
  const q = safe(query);
  if (!q) {
    return {
      ok: false,
      adapterName: "lawyer",
      items: [],
      count: 0,
      error: "empty_query",
    };
  }

  try {
    const [a, b, c] = await Promise.all([
      scrapeAvukatBul(q, signal),
      scrapeAvukatRehberi(q, signal),
      scrapeAvukatCom(q, signal),
    ]);

    const flat = [...a, ...b, ...c].filter(Boolean);

    return {
      ok: true,
      adapterName: "lawyer",
      items: flat,
      count: flat.length,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        ok: false,
        adapterName: "lawyer",
        timeout: true,
        items: [],
        count: 0,
        error: "abort",
      };
    }

    console.warn("lawyerAdapter hata:", err?.message || err);

    // PROD: NO FAKE — boş dön
    if (!FINDALLEASY_ALLOW_STUBS) {
      return {
        ok: false,
        adapterName: "lawyer",
        items: [],
        count: 0,
        error: err?.message || "legacy_fail",
      };
    }
  }

  // ======================= MOCK FALLBACK (DEV ONLY) =======================
  if (!FINDALLEASY_ALLOW_STUBS) {
    return { ok: true, adapterName: "lawyer", items: [], count: 0 };
  }

  const mocks = [
    makeLawyerItem(
      "mock",
      "Boşanma & Aile Hukuku Avukatı",
      "İstanbul",
      "https://findalleasy.com/mock1"
    ),
    makeLawyerItem(
      "mock",
      "İş Kazası & Tazminat Avukatı",
      "Ankara",
      "https://findalleasy.com/mock2"
    ),
    makeLawyerItem(
      "mock",
      "Ceza & İcra Hukuku Avukatı",
      "İzmir",
      "https://findalleasy.com/mock3"
    ),
  ];

  return {
    ok: true,
    adapterName: "lawyer",
    items: mocks,
    count: mocks.length,
    mock: true,
  };
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

  const u = String(
    it.affiliateUrl ||
      it.deeplink ||
      it.finalUrl ||
      it.originUrl ||
      it.url ||
      ""
  );
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

export async function searchLawyerAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal } = _s200ResolveRegionSignal(regionOrOptions, "TR");

  // Debug/diag context (harmless)
  globalThis.__S200_ADAPTER_CTX = {
    adapter: "lawyer",
    providerKey: "lawyer",
    source: "lawyer",
    region,
  };

  try {
    const legacyOut = await withTimeout(
      searchLawyerLegacy(
        query,
        typeof regionOrOptions === "object" ? { region, signal } : { region }
      ),
      6500,
      "lawyer"
    );

    const rawItems = coerceItemsS200(legacyOut);
    const rawCount = Array.isArray(rawItems) ? rawItems.length : 0;

    const blocked = !FINDALLEASY_ALLOW_STUBS && rawItems.some(_s200IsFake);
    const filtered = blocked ? [] : rawItems;

    const normalized = filtered
      .map((it) => {
        if (!it || typeof it !== "object") return null;

        const copy = { ...it };
        // S200 deterministik id normalizeItemS200 içinde
        delete copy.id;
        delete copy.listingId;

        const pk =
          fixKey(copy.providerKey || copy.provider || copy.source || "lawyer") ||
          "lawyer";

        return normalizeItemS200(copy, pk, {
          providerFamily: "lawyer",
          vertical: "legal",
          category: "lawyer",
          region,
        });
      })
      .filter(Boolean);

    const meta = {
      adapter: "lawyer",
      providerKey: "lawyer",
      source: "lawyer",
      region,
      ms: Date.now() - t0,
      allowStubs: FINDALLEASY_ALLOW_STUBS,
      legacyOk: legacyOut && typeof legacyOut === "object" ? legacyOut.ok : undefined,
      rawCount,
      normalizedCount: normalized.length,
      stubBlocked: blocked,
    };

    if (blocked) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: "lawyer",
        _meta: { ...meta, error: "stub_blocked" },
      };
    }

    if (legacyOut && typeof legacyOut === "object" && legacyOut.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: "lawyer",
        _meta: {
          ...meta,
          timeout: !!legacyOut.timeout,
          error: legacyOut.error || legacyOut.errorMessage || "legacy_fail",
        },
      };
    }

    return {
      ok: true,
      items: normalized,
      count: normalized.length,
      source: "lawyer",
      _meta: meta,
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: "lawyer",
      _meta: {
        adapter: "lawyer",
        providerKey: "lawyer",
        source: "lawyer",
        region,
        ms: Date.now() - t0,
        allowStubs: FINDALLEASY_ALLOW_STUBS,
        timeout: _s200IsTimeout(e),
        error: e?.message || String(e),
      },
    };
  }
}

export const searchLawyer = searchLawyerAdapter;

export default {
  searchLawyer,
  searchLawyerAdapter,
  searchLawyerLegacy,
};
