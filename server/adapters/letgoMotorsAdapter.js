// server/adapters/letgoMotorsAdapter.js
// Letgo Motors Adapter – Herkül S5-Ultra
// ✔ signal destekli
// ✔ multi-selector
// ✔ normalize uyumlu
// ✔ multi-page
// ✔ eski fonksiyonlar silinmeden güçlendirildi

import axios from "axios";
import * as cheerio from "cheerio";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt.replace(/[^\d]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractImage($, el) {
  return (
    $(el).find("img").attr("src") ||
    $(el).find("img").attr("data-src") ||
    null
  );
}

// Çoklu selector seti (Letgo sık değiştiriyor)
const SELECTORS = [
  ".ListingCard__Card-sc-__sc-1xf18x6-1",
  ".AdCardstyled__Container-sc-1h260jj-0",
  ".listing-card",
  ".card",
  "[data-testid='ad-card']"
];

const MAX_PAGES = 2;

/* ============================================================
   TEK SAYFA SCRAPER – MOTORS
============================================================ */
async function scrapeLetgoMotorsPage(query, page = 1, signal) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.letgo.com/tr-tr/c/motors?q=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      timeout: 17000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        Accept: "text/html,application/xhtml+xml"
      }
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $(SELECTORS.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find("h2").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find(".ListingCard__Title").text());

      if (!title) return;

      const priceTxt =
        safe(wrap.find(".price").text()) ||
        safe(wrap.find(".ListingCard__Price").text());

      const price = parsePrice(priceTxt);

      let href =
        wrap.find("a").attr("href") ||
        wrap.find(".ListingCard__Link").attr("href");

      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.letgo.com" + href;

      const img = extractImage($, el);

      out.push({
        id: href,
        title,
        price,
        provider: "letgo_motors",
        rating: null,
        currency: "TRY",
        region: "TR",
        image: img,
        url: href,
        deeplink: href,
        category: "motors",
        raw: { title, priceTxt, href, img }
      });
    });

    return out;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("⛔ Letgo Motors abort");
      return [];
    }

    console.warn("Letgo Motors scrape hata:", err.message);
    return [];
  }
}

/* ============================================================
   ANA ADAPTER – HYBRID V6 → S5 ULTRA FORMAT
============================================================ */
async function searchLetgoMotorsLegacy(
  query,
  regionOrOptions = "TR"
) {
  // Yeni format ile uyumlu hale getiriyoruz
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  try {
    const q = safe(query);
    if (!q) return [];

    let all = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const part = await scrapeLetgoMotorsPage(q, page, signal);
      if (part.length === 0) break;
      all = all.concat(part);
    }

    return all;
  } catch (err) {
    return [];
  }
}

/* ============================================================
   S5 - SCRAPE WRAPPER
============================================================ */
async function searchLetgoMotorsScrapeLegacy(query, regionOrOptions = "TR") {
  return searchLetgoMotors(query, regionOrOptions);
}

/* ============================================================
   S5 - ULTIMATE ADAPTER FORMAT
============================================================ */
async function searchLetgoMotorsAdapterLegacy(
  query,
  regionOrOptions = "TR"
) {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  try {
    const items = await searchLetgoMotors(query, { region, signal });

    return {
      ok: true,
      adapterName: "letgo_motors",
      items,
      count: items.length
    };
  } catch (err) {
    return {
      ok: false,
      adapterName: "letgo_motors",
      items: [],
      count: 0,
      error: err?.message || "unknown error"
    };
  }
}

/* ============================================================
   DEFAULT EXPORT (silinmedi)
============================================================ */

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
export async function searchLetgoMotorsAdapter(q, opts = {}) {
  const startedAt = Date.now();
  const query = String(q ?? "").trim();
  const region = String(opts?.region ?? "TR");

  // empty/too-short query: return empty-state (NOT an error)
  if (!query || query.length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: "letgo_motors",
      _meta: { emptyQuery: true, providerKey: "letgo_motors", region, tookMs: Date.now() - startedAt }
    };
  }

  try {
    // global context (some scrapers look at this; harmless otherwise)
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "letgo_motors",
      providerKey: "letgo_motors",
      source: "letgo_motors",
      region,
    };

    const raw = await withTimeout(
      () => searchLetgoMotors(query, opts),
      Number(opts?.timeoutMs ?? 6500),
      "letgo_motors"
    );

    const arr = coerceItemsS200(raw);
    const items = [];
    for (const it of arr) {
      const norm = normalizeItemS200(it, { providerKey: "letgo_motors", region });
      if (!norm?.title || !norm?.url) continue;

      if (!norm.id) norm.id = stableIdS200("letgo_motors", norm.url, norm.title);
      norm.providerKey = fixKey(norm.providerKey || "letgo_motors");

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: "letgo_motors",
      _meta: {
        providerKey: "letgo_motors",
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
      source: "letgo_motors",
      _meta: {
        providerKey: "letgo_motors",
        region,
        timeout,
        error: msg,
        name: e?.name,
        tookMs: Date.now() - startedAt
      }
    };
  }
}


export const searchLetgoMotors = searchLetgoMotorsAdapter;
export const searchLetgoMotorsScrape = searchLetgoMotorsAdapter;

export default {
  searchLetgoMotors,
  searchLetgoMotorsScrape,
  searchLetgoMotorsAdapter,
  searchLetgoMotorsLegacy,
  searchLetgoMotorsScrapeLegacy,
  searchLetgoMotorsAdapterLegacy
};
