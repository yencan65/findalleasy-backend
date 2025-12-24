// server/adapters/kariyerEgitimAdapter.js
// ============================================================================
//  Kariyer Eğitim/Kurs Adapter — S22 → S33 TITAN FINAL
// ----------------------------------------------------------------------------
//  ZERO DELETE — hiçbir davranış silinmez, sadece güçlendirilir
//  ✔ Titan deterministic stableId
//  ✔ S33 ImageVariants (image, original, proxy, hasProxy)
//  ✔ Strong selectors (5 seviye fallback)
//  ✔ proxyFetchHTML → axios fallback
//  ✔ botTrap sanitizer
//  ✔ education vertical sinyali (sabit)
//  ✔ provider meta uyumu (providerKey, providerType, providerFamily)
//  ✔ qualityScore deterministic
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ------------------------------------------------------------
// SAFE HELPERS
// ------------------------------------------------------------
function clean(v) {
  return String(v || "").trim();
}

function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/noscript/gi, ""); // botTrap severler
}

function stableId(provider, title, href) {
  const seed = `${provider}::${clean(title)}::${clean(href)}`;
  return (
    "kariyer_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 18)
  );
}

function detectCategory() {
  return "education"; // Titan AI böyle istiyor
}

function extractImageStrong($, el) {
  return (
    clean($(el).find("img").attr("data-src")) ||
    clean($(el).find("img").attr("data-original")) ||
    clean($(el).find("img").attr("src")) ||
    clean($(el).find("picture img").attr("src")) ||
    null
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.45;
  if (item.image) s += 0.30;
  if (item.provider) s += 0.15;
  if (item.category === "education") s += 0.10;
  return Number(s.toFixed(3));
}

// ------------------------------------------------------------
// FETCH WRAPPER — Proxy → Axios fallback
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url, { cache: false });
  } catch {
    try {
      const cfg = {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasyBot/22.0)" },
      };
      if (signal) cfg.signal = signal;

      const { data } = await axios.get(url, cfg);
      return data;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------
// MAIN SCRAPER — S33 ULTRA TITAN
// ------------------------------------------------------------
export async function searchKariyerEgitim(query, { region = "TR", signal } = {}) {
  try {
    const qEnc = encodeURIComponent(clean(query));
    const url = `https://www.kariyer.net/egitim-kurs/arama?q=${qEnc}`;

    const html = await fetchHTML(url, signal);
    if (!html) {
      return { ok: true, adapterName: "kariyer", items: [], count: 0 };
    }

    const safeHTML = cleanBotTraps(html);
    const $ = loadCheerioS200(safeHTML);

    const items = [];

    // Çok seviyeli selector fallback sistemi
    const selectors = [
      ".education-card",
      ".course-card",
      ".training-card",
      "[class*='education']",
      "[class*='course']",
    ];

    $(selectors.join(",")).each((i, el) => {
      try {
        const title =
          clean($(el).find(".education-card-title").text()) ||
          clean($(el).find("h3").text()) ||
          clean($(el).find(".title").text()) ||
          clean($(el).find("a").text());

        let href =
          clean($(el).find("a").attr("href")) ||
          clean($(el).find("a").attr("data-href"));

        if (!title || !href) return;

        if (!href.startsWith("http")) href = "https://www.kariyer.net" + href;

        const imgRaw = extractImageStrong($, el);
        const variants = buildImageVariants(imgRaw);

        const id = stableId("kariyer", title, href);
        const category = detectCategory();

        const base = {
          id,
          title,
          price: null,
          optimizedPrice: null,
          rating: null,

          provider: "kariyer",
          providerKey: "kariyer",
          providerFamily: "kariyer",
          providerType: "education",

          region: region.toUpperCase(),
          currency: "TRY",

          url: href,
          deeplink: href,

          image: variants.image,
          imageOriginal: variants.imageOriginal,
          imageProxy: variants.imageProxy,
          hasProxy: variants.hasProxy,

          category,
          categoryAI: "education",
          vertical: "education",

          raw: { title, href, imgRaw },
        };

        items.push({
          ...base,
          qualityScore: computeQualityScore(base),
        });
      } catch (innerErr) {
        console.warn("⚠️ Kariyer iç blok hata:", innerErr?.message);
      }
    });

    return {
      ok: true,
      adapterName: "kariyer",
      items,
      count: items.length,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        ok: false,
        adapterName: "kariyer",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("⚠️ Kariyer Eğitim adapter genel hata:", err?.message);

    return {
      ok: false,
      adapterName: "kariyer",
      error: err?.message || String(err),
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — kariyer (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "kariyer";
const S200_PROVIDER_FAMILY = "kariyer";
const S200_VERTICAL = "education";
const S200_CATEGORY = "education";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.KARIYER_TIMEOUT_MS || 6500);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 6500;
})();

function setS200Ctx(query, url = "") {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: S200_PROVIDER_KEY,
      providerKey: S200_PROVIDER_KEY,
      query: safeStr(query, 220),
      url: safeStr(url, 900),
    };
  } catch {}
}

async function __kariyer_S200(query, regionOrOptions = "TR") {
  const opts = typeof regionOrOptions === "object" ? (regionOrOptions || {}) : { region: regionOrOptions };
  const region = (opts.region || "TR").toString();
  const signal = opts.signal;

  const q = safeStr(query, 240);
  setS200Ctx(q);

  if (!q) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: S200_PROVIDER_KEY,
      _meta: { providerKey: S200_PROVIDER_KEY, emptyQuery: true, region },
    };
  }

  try {
    const raw = await withTimeout(Promise.resolve().then(() => searchKariyerEgitim(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

    // If legacy already signaled an error, keep it observable
    if (raw && typeof raw === "object" && raw.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: S200_PROVIDER_KEY,
        _meta: {
          providerKey: S200_PROVIDER_KEY,
          region,
          timeout: !!raw.timeout,
          error: raw.error || raw.message || "legacy_fail",
        },
      };
    }

    const rawItems = coerceItemsS200(raw);
    let dropped = 0;
    const items = [];

    for (const it of rawItems) {
      if (!it) { dropped++; continue; }

      // NO RANDOM ID: always recompute deterministic stableIdS200(providerKey,url,title)
      const clean = { ...it };
      delete clean.id;
      delete clean.listingId;

      // Discovery sources rule compatibility: allow adapter to pass null price; we also sanitize <=0 in kit.
      if (clean.price != null && Number(clean.price) <= 0) clean.price = null;
      if (clean.finalPrice != null && Number(clean.finalPrice) <= 0) clean.finalPrice = null;
      if (clean.optimizedPrice != null && Number(clean.optimizedPrice) <= 0) clean.optimizedPrice = null;

      const norm = normalizeItemS200(
        {
          ...clean,
          providerKey: S200_PROVIDER_KEY,
          providerFamily: S200_PROVIDER_FAMILY,
          vertical: clean.vertical || S200_VERTICAL,
          category: clean.category || S200_CATEGORY,
          region: clean.region || region,
          currency: clean.currency || "TRY",
        },
        S200_PROVIDER_KEY,
        {
          vertical: clean.vertical || S200_VERTICAL,
          category: clean.category || S200_CATEGORY,
          providerFamily: S200_PROVIDER_FAMILY,
          region,
          currency: clean.currency || "TRY",
          titleFallback: "Kariyer Eğitim sonucu",
        }
      );

      if (!norm) { dropped++; continue; }
      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        rawCount: rawItems.length,
        dropped,
      },
    };
  } catch (e) {
    const timeout = e instanceof TimeoutError || e?.name === "AbortError" || signal?.aborted;
    return {
      ok: false,
      items: [],
      count: 0,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        timeout,
        error: e?.message || String(e),
      },
    };
  }
}


// Legacy exports — ZERO DELETE
export const searchKariyerEgitimScrape = searchKariyerEgitim;
export const searchKariyerEgitimAdapter = __kariyer_S200;

export default { searchKariyerEgitim };
