// ============================================================================
//  MEDICAL PARK — S22 ULTRA TITAN CHECK-UP ADAPTER (FINAL VERSION)
// ----------------------------------------------------------------------------
//  ZERO DELETE — S5 davranışı korunur, S22 Titan katmanları eklendi
// ----------------------------------------------------------------------------
//  • proxyFetchHTML anti-bot bypass
//  • stableId (Merge Engine için şart)
//  • sanitizePrice + optimizePrice fiyat pipeline
//  • ImageVariants (proxy/webp/original)
//  • categoryAI: health_checkup
//  • geoSignal → şehir algısı
//  • qualityScore → BEST kart katkısı
//  • fallback → boş dönse bile motor kırılmaz
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { loadCheerioS200, withTimeout, safeStr, stableIdS200, normalizeUrlS200, isBadUrlS200 } from "../core/s200AdapterKit.js";
import { searchWithSerpApi } from "./serpApi.js";


// ----------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------
const safe = (v) => (v ? String(v).trim() : "");

function parsePrice(v) {
  if (!v) return null;
  const n = Number(
    v.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function stableId(seed, extra = "") {
  return (
    "medpark_" +
    Buffer.from(seed + "_" + extra).toString("base64").slice(0, 12)
  );
}

function detectCategoryAI() {
  return "health_checkup";
}

function extractGeoSignal(txt = "") {
  const t = txt.toLowerCase();
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa", "adana"];
  return cities.find((c) => t.includes(c)) || null;
}

function computeQualityScore({ title, image }) {
  let s = 0;
  if (title && title.length > 3) s += 0.3;
  if (image) s += 0.4;
  return Number(s.toFixed(2));
}

// ----------------------------------------------------------------------
// MAIN ADAPTER — S22 ULTRA
// ----------------------------------------------------------------------
export async function searchMedicalParkCheckup(query, regionOrOptions = "TR", signal) {
  let region = "TR";

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  } else {
    region = regionOrOptions || "TR";
  }

  const url = `https://www.medicalpark.com.tr/check-up?search=${encodeURIComponent(
    query
  )}`;

  let html = null;

  // 1) ProxyFetch → anti-bot
  try {
    html = await proxyFetchHTML(url);
  } catch {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S22)" },
      });
      html = data;
    } catch (err) {
      return [
        {
          provider: "medicalpark",
          title: "Medical Park erişilemedi",
          price: null,
          optimizedPrice: null,
          category: "health_checkup",
          fallback: true,
        },
      ];
    }
  }

  const $ = loadCheerioS200(html);
  const items = [];

  const selectors = [
    ".checkup-card",
    ".package",
    ".item",
    ".checkup-item",
    ".paket-card",
    "[data-checkup-id]",
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find("h3").text()) ||
      safe(wrap.find(".title").text()) ||
      safe(wrap.find(".package-title").text());
    if (!title) return;

    const priceRaw =
      parsePrice(safe(wrap.find(".price").text())) ||
      parsePrice(safe(wrap.find(".package-price").text()));

    const price = sanitizePrice(priceRaw);
    const optimizedPrice = optimizePrice(
      { price },
      { provider: "medicalpark" }
    );

    let href = safe(wrap.find("a").attr("href"));
    if (href && !href.startsWith("http")) {
      href = `https://www.medicalpark.com.tr${href}`;
    }

    const imageRaw =
      safe(wrap.find("img").attr("data-src")) ||
      safe(wrap.find("img").attr("data-original")) ||
      safe(wrap.find("img").attr("src")) ||
      safe(wrap.find("picture img").attr("src")) ||
      null;

    const image = buildImageVariants(imageRaw);

    const id = stableId(href || title, i);
    const categoryAI = detectCategoryAI();
    const geoSignal = extractGeoSignal(title);
    const qualityScore = computeQualityScore({ title, image: imageRaw });

    items.push({
      id,
      title,
      price,
      optimizedPrice,

      provider: "medicalpark",
      source: "medicalpark",
      category: "health_checkup",
      categoryAI,
      geoSignal,
      qualityScore,

      currency: "TRY",
      region: region.toUpperCase(),

      url: href,
      deeplink: href,

      image: image.image,
      imageOriginal: image.imageOriginal,
      imageProxy: image.imageProxy,
      hasProxy: image.hasProxy,

      fallback: false,

      raw: { title, priceRaw, href, imageRaw },
    });
  });

  if (items.length === 0) {
    return [];
  }
return items;
}

// ----------------------------------------------------------------------
// S5 WRAPPER — geri uyumluluk
// ----------------------------------------------------------------------
export async function searchMedicalParkCheckupAdapter(query, regionOrOptions = {}) {
  const started = Date.now();
  const region =
    typeof regionOrOptions === "string"
      ? regionOrOptions
      : regionOrOptions?.region || regionOrOptions?.country || "tr";

  const providerKey = "medicalpark_checkup";

  // ctx (multiline — bazı ortamlar tek satırı kırpıp JS’i bozuluyor)
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "medicalparkCheckupAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };
  } catch {}

  // 1) Primary: direct scrape
  try {
    const itemsRaw = await searchMedicalParkCheckup(query, regionOrOptions);
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];
    return {
      ok: true,
      items,
      count: items.length,
      source: providerKey,
      _meta: { region, startedAt: started, tookMs: Date.now() - started, strategy: "scrape" },
    };
  } catch (e) {
    const msg = e?.message || String(e || "");

    // 2) Fallback: SerpAPI (discovery, price:null)
    try {
      const q = safeStr(query);
      if (!q) {
        return { ok: true, items: [], count: 0, source: providerKey, _meta: { region, startedAt: started, tookMs: Date.now() - started, strategy: "empty_query" } };
      }

      const serpQ = `site:medicalpark.com.tr check-up ${q}`.trim();
      const raw = await withTimeout(searchWithSerpApi(serpQ, { mode: "web", num: 10 }), 2400, "medicalpark_checkup:serp");
      const arr = Array.isArray(raw) ? raw : [];
      const out = [];

      for (const r of arr) {
        const title = safeStr(r?.title);
        const url0 = safeStr(r?.finalUrl || r?.originUrl || r?.url);
        const url = normalizeUrlS200(url0);
        if (!title || !url || isBadUrlS200(url)) continue;

        out.push({
          id: stableIdS200(providerKey, url, title),
          title,
          url,
          originUrl: url,
          finalUrl: url,
          price: null,
          currency: null,
          provider: "medicalpark",
          providerKey,
          providerFamily: "checkup",
          category: "checkup",
          vertical: "checkup",
          discovery: true,
          raw: r?.raw || r,
        });
      }

      return {
        ok: true,
        items: out,
        count: out.length,
        source: providerKey,
        _meta: { region, startedAt: started, tookMs: Date.now() - started, strategy: "serpapi_fallback", error: msg },
      };
    } catch (e2) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: providerKey,
        _meta: { region, startedAt: started, tookMs: Date.now() - started, strategy: "failed", error: msg },
      };
    }
  }
}

export const searchMedicalParkCheckupScrape = searchMedicalParkCheckup;

export default {
  searchMedicalParkCheckup,
  searchMedicalParkCheckupAdapter,
  searchMedicalParkCheckupScrape,
};
