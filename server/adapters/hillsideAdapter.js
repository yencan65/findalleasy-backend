// server/adapters/hillsideAdapter.js
// ============================================================================
//  Hillside — S8 → S200 ULTRA (HARDENED)
// ----------------------------------------------------------------------------
//  ZERO DELETE: Eski davranış korunur. S200 adapter output lock eklendi.
//  ✅ NO CRASH: hatalar observable (ok:false) + empty items
//  ✅ NO FAKE: random/mock listing yok
//  ✅ NO DRIFT: output = { ok, items, count, source, _meta }
//  ✅ Contract: title + url zorunlu; price<=0 => null
// ============================================================================

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  withTimeout,
  normalizeItemS200,
  normalizeUrlS200,
  isBadUrlS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

// ============================================================================
// HELPERS — S33 LEVEL (korunur)
// ============================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 1) return String(v).trim();
  }
  return "";
}

// TITAN stableId (korunur) — deterministic
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "hillside_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

// TITAN wellness scoring (korunur)
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.55;
  if (item.image) s += 0.25;
  s += 0.20; // provider bonus (fitness/spa venues)
  return Number(s.toFixed(2));
}

function safeErr(e) {
  const msg = safe(e?.message || e);
  return msg || "UNKNOWN_ERROR";
}

// ============================================================================
// CONSTANTS
// ============================================================================
const SOURCE = "hillside";
const BASE = "https://www.hillsidesports.com.tr";
const TIMEOUT_MS = 15000;

const CENTER_SELECTORS = [
  ".hs-center-card",
  ".center-card",
  "[data-testid='center-card']",
  ".club-list-item",
];

function toAbsUrl(href) {
  const h = safe(href);
  if (!h) return "";
  if (h.startsWith("http://") || h.startsWith("https://")) return h;
  try {
    return new URL(h, BASE).toString();
  } catch {
    return "";
  }
}

function toAbsImg(src) {
  const s = safe(src);
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  try {
    return new URL(s, BASE).toString();
  } catch {
    return "";
  }
}

// ============================================================================
// Internal scraper: throws on hard failures (adapter can mark ok:false)
// ============================================================================
async function _scrapeCenters({ region = "TR", signal } = {}) {
  const url = `${BASE}/spor-merkezleri`;

  const res = await withTimeout(
    () =>
      fetch(url, {
        method: "GET",
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasyBot)",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
      }),
    TIMEOUT_MS,
    "hillside_fetch"
  );

  if (!res?.ok) {
    const status = Number(res?.status || 0);
    throw new Error(`HTTP_${status || "ERR"}`);
  }

  const html = await res.text();
  const $ = loadCheerioS200(html, SOURCE);

  const list = $(CENTER_SELECTORS.join(", "));
  if (list.length === 0) return [];

  const results = [];

  list.each((i, el) => {
    const titleRaw = pick(
      safe($(el).find(".title").text()),
      safe($(el).find(".name").text()),
      safe($(el).find("h3").text()),
      safe($(el).find("a").text())
    );

    const title = fixKey(titleRaw) || titleRaw;
    if (!title) return;

    let href = safe($(el).find("a").attr("href"));
    href = normalizeUrlS200(toAbsUrl(href));
    if (!href || isBadUrlS200(href)) return;

    // Görsel arayalım (site bazen ekliyor)
    let imgRaw =
      safe($(el).find("img").attr("data-src")) ||
      safe($(el).find("img").attr("src")) ||
      "";

    imgRaw = normalizeUrlS200(toAbsImg(imgRaw));

    const variants = imgRaw && !isBadUrlS200(imgRaw) ? buildImageVariants(imgRaw) : null;

    // Base item (S33) — sonra S200 normalize ile lock
    const base = {
      id: stableIdS200 ? stableIdS200(SOURCE, title, href) : stableId(SOURCE, title, href),

      title,
      url: href,
      originUrl: href,
      finalUrl: href,
      deeplink: href,
      affiliateUrl: null,

      // fiyat yok → null
      price: null,
      finalPrice: null,
      optimizedPrice: null,

      provider: SOURCE,
      providerKey: SOURCE,
      providerType: "wellness",
      providerFamily: SOURCE,
      vertical: "wellness",

      currency: "TRY",
      region,

      image: variants?.image || null,
      imageOriginal: variants?.imageOriginal || null,
      imageProxy: variants?.imageProxy || null,
      hasProxy: variants?.hasProxy || false,

      category: "wellness",
      categoryAI: "wellness",

      raw: { title, href, imgRaw },
    };

    const normalized = normalizeItemS200(base, SOURCE, {
      region,
      currency: "TRY",
      vertical: "wellness",
      category: "wellness",
      providerTitle: "Hillside",
    });

    if (!normalized) return;

    results.push({
      ...normalized,
      // qualityScore: deterministic order booster
      qualityScore: computeQualityScore({ ...base, ...normalized }),
    });
  });

  // Dedupe by id
  const seen = new Set();
  const uniq = [];
  for (const it of results) {
    const id = safe(it?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(it);
  }

  // order stable
  uniq.sort((a, b) => (b?.qualityScore || 0) - (a?.qualityScore || 0));

  return uniq.slice(0, 40);
}

// ============================================================================
// RAW SCRAPER (S8 davranışı korunur)
// - Eski sözleşme: array döner, hata yutulur → []
// ============================================================================
export async function searchHillside(query, options = {}) {
  const region = options.region || "TR";
  const signal = options.signal;

  try {
    return await _scrapeCenters({ region, signal });
  } catch (err) {
    if (err?.name === "AbortError") return [];
    console.warn("⚠️ Hillside scraper hata:", safeErr(err));
    return [];
  }
}

// ============================================================================
// S200 UNIFIED ADAPTER (engine bunu kullanmalı)
// ============================================================================
export async function searchHillsideAdapter(query, options = {}) {
  const region = options.region || "TR";
  const signal = options.signal;

  const started = Date.now();
  try {
    const items = await _scrapeCenters({ region, signal });

    return {
      ok: true,
      items,
      count: items.length,
      source: SOURCE,
      adapterName: SOURCE, // legacy compat
      _meta: {
        region,
        ms: Date.now() - started,
        note: items.length ? "OK" : "OK_EMPTY",
      },
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        ok: false,
        items: [],
        count: 0,
        source: SOURCE,
        adapterName: SOURCE,
        _meta: { region, error: "ABORTED", ms: Date.now() - started },
      };
    }

    return {
      ok: false,
      items: [],
      count: 0,
      source: SOURCE,
      adapterName: SOURCE,
      _meta: {
        region,
        error: safeErr(err),
        ms: Date.now() - started,
      },
    };
  }
}

export default {
  searchHillside,
  searchHillsideAdapter,
};

// Keep cheerio referenced (ZERO DELETE intent)
void cheerio;
