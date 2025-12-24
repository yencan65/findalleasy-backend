// server/adapters/activitiesAdapter.js
// ============================================================================
// ACTIVITIES ADAPTER — S200 FINAL (NO FAKE • NO CRASH • NO DRIFT)
// Multi-provider scraper: GetYourGuide + Viator
//
// S200 RULES:
// - Output tek format: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: import fail / not implemented / timeout => ok:false + items:[]
// - NO RANDOM ID: stableIdS200(providerKey, url, title)
// - withTimeout: her provider call
// - Global ctx: globalThis.__S200_ADAPTER_CTX set edilir (kit “unknown” demesin)
// ============================================================================

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  withTimeout,
  TimeoutError,
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

import { buildAffiliateUrl } from "./affiliateEngine.js";

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function safe(v) {
  return v ? String(v).trim() : "";
}

function parsePriceLoose(v) {
  if (!v) return null;
  try {
    const cleaned = String(v)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function normalizePriceForProvider(price, providerKey) {
  if (price == null) return null;

  // uç değer filtresi (fake/garbage)
  if (price <= 0) return null;
  if (price > 2_000_000) return null;

  if (providerKey === "getyourguide" && price > 100_000) return null;
  if (providerKey === "viator" && price > 200_000) return null;

  return price;
}

function normalizeUrlSoft(url, domain) {
  let u = safe(url);
  if (!u) return null;

  if (u.startsWith("//")) u = "https:" + u;
  if (u.startsWith("/") && !u.startsWith("http")) u = domain + u;

  const lower = u.toLowerCase();
  if (!lower || lower === "#" || lower.startsWith("javascript") || lower.includes("void(0)")) {
    return null;
  }

  // bare host gibi “aliExpress-style” saçmalık üretme; domain yoksa bırak
  if (!/^https?:\/\//i.test(u)) return null;

  return u;
}

async function fetchHtml(url, { signal, timeoutMs, label, headers } = {}) {
  const t = Math.max(1000, Number(timeoutMs || 15000));

  // 1) direct axios
  try {
    const axiosMod = await import("axios").catch(() => null);
    const axios = axiosMod?.default || axiosMod;
    if (axios?.get) {
      const res = await withTimeout(
        axios.get(url, {
          signal,
          timeout: Math.min(20000, t + 1500),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 (FindAllEasy-S200)",
            "Accept-Language": "en-US,en;q=0.9",
            ...(headers || {}),
          },
          validateStatus: (s) => s >= 200 && s < 400,
          maxRedirects: 5,
        }),
        t,
        label || "activities:axios.get"
      );
      const html = res?.data;
      if (typeof html === "string" && html.length > 200) return { html, via: "direct" };
    }
  } catch {
    // fallthrough → proxy
  }

  // 2) proxy fallback
  try {
    const html = await withTimeout(proxyFetchHTML(url), t, label || "activities:proxyFetchHTML");
    if (typeof html === "string" && html.length > 200) return { html, via: "proxy" };
  } catch {
    // fallthrough
  }

  return { html: "", via: "none" };
}

function s200Fail({ providerKey, query, region, url, stage, code, err, meta = {} }) {
  const note = err?.message || String(err || code || "ERROR");
  const isTimeout =
    err instanceof TimeoutError || String(err?.name || "").toLowerCase().includes("timeout");

  return {
    ok: false,
    items: [],
    count: 0,
    source: providerKey,
    _meta: {
      providerKey,
      providerFamily: "tour",
      provider: "tour",
      vertical: "tour",

      query: String(query || ""),
      region: String(region || "TR").toUpperCase(),
      url: String(url || ""),
      stage: stage || "unknown",
      code: code || "ERROR",
      error: note,
      timeout: Boolean(isTimeout),
      ...meta,
      timestamp: Date.now(),
    },
  };
}

// ----------------------------------------------------------------------------
// SCRAPERS (each returns normalized S200 items array)
// ----------------------------------------------------------------------------
async function scrapeGetYourGuide(query, region, { signal, timeoutMs } = {}) {
  const providerKey = "getyourguide";
  const encoded = encodeURIComponent(String(query || ""));
  const url = `https://www.getyourguide.com/s/?q=${encoded}`;

  globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, url, at: "activitiesAdapter:gyg" };

  const { html, via } = await fetchHtml(url, {
    signal,
    timeoutMs,
    label: "activities:getyourguide:fetch",
  });

  if (!html) return { items: [], via };

  const $ = loadCheerioS200(html, { adapter: providerKey, url });
  const items = [];

  const selectors = [
    "[data-test-id='product-card']",
    ".activity-card",
    ".product-card",
    "article",
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      try {
        const w = $(el);

        const title =
          safe(w.find("[data-test-id='product-card-title']").text()) ||
          safe(w.find(".activity-card-title").text()) ||
          safe(w.find("h2, h3").first().text());

        if (!title || title.length < 4) return;

        const priceText =
          safe(w.find("[data-test-id='product-card-price']").text()) ||
          safe(w.find(".price, .activity-card-price").text());

        const priceRaw = parsePriceLoose(priceText);
        const price = normalizePriceForProvider(priceRaw, providerKey);

        const hrefRaw =
          safe(w.find("a[data-test-id='product-card-link']").attr("href")) ||
          safe(w.find("a").attr("href"));

        const urlNorm = normalizeUrlSoft(hrefRaw, "https://www.getyourguide.com");
        if (!urlNorm) return;

        const imgRaw =
          safe(w.find("img").attr("data-src")) ||
          safe(w.find("img").attr("src")) ||
          null;

        const affiliateUrl = (() => {
          try {
            return buildAffiliateUrl(
              { providerKey, provider: "tour", url: urlNorm, title },
              { source: "activitiesAdapter", providerKey, query, region }
            );
          } catch {
            return null;
          }
        })();

        const rawItem = {
          id: stableIdS200(providerKey, urlNorm, title),
          title,
          price: price ?? null,
          currency: null,
          url: urlNorm,
          affiliateUrl: affiliateUrl || null,
          provider: "tour",
          providerKey,
          providerFamily: "tour",
          region,

          raw: {
            providerKey,
            provider: "getyourguide",
            titleRaw: title,
            priceText: priceText || null,
            hrefRaw: hrefRaw || null,
            imageRaw: imgRaw,
            fetchedVia: via,
            source: "getyourguide_html",
            extractedAt: new Date().toISOString(),
          },
        };

        const norm = normalizeItemS200(rawItem, providerKey, {
          providerFamily: "tour",
          vertical: "tour",
          category: "tour",
          region,
          currency: null,
        });

        if (!norm) return;
        // preserve image raw (kit normalizeItem may also enrich later)
        if (imgRaw) norm.image = norm.image || imgRaw;

        items.push(norm);
      } catch {
        // row-level swallow — NO CRASH
      }
    });

    if (items.length > 0) break;
  }

  return { items, via };
}

async function scrapeViator(query, region, { signal, timeoutMs } = {}) {
  const providerKey = "viator";
  const encoded = encodeURIComponent(String(query || ""));
  const url = `https://www.viator.com/searchResults/all?text=${encoded}`;

  globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, url, at: "activitiesAdapter:viator" };

  const { html, via } = await fetchHtml(url, {
    signal,
    timeoutMs,
    label: "activities:viator:fetch",
  });

  if (!html) return { items: [], via };

  const $ = loadCheerioS200(html, { adapter: providerKey, url });
  const items = [];

  const selectors = ["[data-test-id='product-card']", ".card--product", "article"];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      try {
        const w = $(el);

        const title =
          safe(w.find("[data-test-id='product-card-title']").text()) ||
          safe(w.find(".card__title").text()) ||
          safe(w.find("h2, h3").first().text());

        if (!title || title.length < 4) return;

        const priceText =
          safe(w.find("[data-test-id='price']").text()) ||
          safe(w.find(".price, .card__price").text());

        const priceRaw = parsePriceLoose(priceText);
        const price = normalizePriceForProvider(priceRaw, providerKey);

        const hrefRaw =
          safe(w.find("a[data-test-id='product-card-link']").attr("href")) ||
          safe(w.find("a").attr("href"));

        const urlNorm = normalizeUrlSoft(hrefRaw, "https://www.viator.com");
        if (!urlNorm) return;

        const imgRaw =
          safe(w.find("img").attr("data-src")) ||
          safe(w.find("img").attr("src")) ||
          null;

        const affiliateUrl = (() => {
          try {
            return buildAffiliateUrl(
              { providerKey, provider: "tour", url: urlNorm, title },
              { source: "activitiesAdapter", providerKey, query, region }
            );
          } catch {
            return null;
          }
        })();

        const rawItem = {
          id: stableIdS200(providerKey, urlNorm, title),
          title,
          price: price ?? null,
          currency: null,
          url: urlNorm,
          affiliateUrl: affiliateUrl || null,
          provider: "tour",
          providerKey,
          providerFamily: "tour",
          region,

          raw: {
            providerKey,
            provider: "viator",
            titleRaw: title,
            priceText: priceText || null,
            hrefRaw: hrefRaw || null,
            imageRaw: imgRaw,
            fetchedVia: via,
            source: "viator_html",
            extractedAt: new Date().toISOString(),
          },
        };

        const norm = normalizeItemS200(rawItem, providerKey, {
          providerFamily: "tour",
          vertical: "tour",
          category: "tour",
          region,
          currency: null,
        });

        if (!norm) return;
        if (imgRaw) norm.image = norm.image || imgRaw;

        items.push(norm);
      } catch {
        // NO CRASH
      }
    });

    if (items.length > 0) break;
  }

  return { items, via };
}

// ----------------------------------------------------------------------------
// MAIN ADAPTER — S200
// ----------------------------------------------------------------------------
export async function searchActivities(query, regionOrOptions = "TR") {
  const providerKey = "activities";

  // query invalid => observable success(empty) (no crash)
  if (!query || typeof query !== "string" || !query.trim()) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        providerKey,
        providerFamily: "tour",
        provider: "tour",
        code: "EMPTY_QUERY",
        timestamp: Date.now(),
      },
    };
  }

  let region = "TR";
  let signal = undefined;
  let timeoutMs = 15000;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
    timeoutMs = Number(regionOrOptions.timeoutMs || regionOrOptions.timeout || 15000);
  }
  region = String(region || "TR").toUpperCase();

  // global RL
  const globalKey = `s200:adapter:activities:${region}`;
  let allowed = true;
  try {
    allowed = await rateLimiter.check(globalKey, {
      limit: 20,
      windowMs: 60_000,
      adaptive: true,
      burst: true,
    });
  } catch {
    allowed = true; // RL util patlarsa adapter ölmez
  }

  if (!allowed) {
    return s200Fail({
      providerKey,
      query,
      region,
      url: "",
      stage: "rate_limit",
      code: "RATE_LIMIT",
      err: new Error("rate limited"),
      meta: { limiterKey: globalKey },
    });
  }

  const providerMeta = [];
  const allItems = [];
  const startedAt = Date.now();

  // GetYourGuide
  const gygKey = `s200:adapter:activities:getyourguide:${region}`;
  let gygAllowed = true;
  try {
    gygAllowed = await rateLimiter.check(gygKey, { limit: 12, windowMs: 60_000, adaptive: true });
  } catch {
    gygAllowed = true;
  }

  if (gygAllowed) {
    try {
      const { items, via } = await withTimeout(
        scrapeGetYourGuide(query, region, { signal, timeoutMs }),
        timeoutMs,
        "activities:getyourguide"
      );
      allItems.push(...(items || []));
      providerMeta.push({ providerKey: "getyourguide", ok: true, count: (items || []).length, via });
    } catch (e) {
      providerMeta.push({
        providerKey: "getyourguide",
        ok: false,
        error: e?.message || String(e),
        timeout: e instanceof TimeoutError,
      });
    }
  } else {
    providerMeta.push({ providerKey: "getyourguide", ok: false, code: "RATE_LIMIT" });
  }

  // Viator
  const viatorKey = `s200:adapter:activities:viator:${region}`;
  let viatorAllowed = true;
  try {
    viatorAllowed = await rateLimiter.check(viatorKey, { limit: 10, windowMs: 60_000, adaptive: true });
  } catch {
    viatorAllowed = true;
  }

  if (viatorAllowed) {
    try {
      const { items, via } = await withTimeout(
        scrapeViator(query, region, { signal, timeoutMs }),
        timeoutMs,
        "activities:viator"
      );
      allItems.push(...(items || []));
      providerMeta.push({ providerKey: "viator", ok: true, count: (items || []).length, via });
    } catch (e) {
      providerMeta.push({
        providerKey: "viator",
        ok: false,
        error: e?.message || String(e),
        timeout: e instanceof TimeoutError,
      });
    }
  } else {
    providerMeta.push({ providerKey: "viator", ok: false, code: "RATE_LIMIT" });
  }

  // Hard cap
  const items = Array.isArray(allItems) ? allItems.filter(Boolean).slice(0, 120) : [];

  // partial success: en az 1 provider ok ise ok:true (items boş olabilir)
  const anyOk = providerMeta.some((p) => p.ok === true);
  const ok = anyOk;

  if (!ok) {
    return s200Fail({
      providerKey,
      query,
      region,
      url: "",
      stage: "providers",
      code: "ALL_PROVIDERS_FAILED",
      err: new Error("all providers failed"),
      meta: { providers: providerMeta, elapsedMs: Date.now() - startedAt },
    });
  }

  return {
    ok: true,
    items,
    count: items.length,
    source: providerKey,
    _meta: {
      providerKey,
      providerFamily: "tour",
      provider: "tour",
      vertical: "tour",
      query: String(query || ""),
      region,
      providers: providerMeta,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

// ----------------------------------------------------------------------------
// CONFIG + LEGACY EXPORTS (ZERO DELETE)
// ----------------------------------------------------------------------------
export const activitiesAdapterConfig = {
  name: "activities",
  fn: searchActivities,
  timeoutMs: 15000,
  priority: 1.3,
  category: "tour",
  subCategories: [
    "food_tour",
    "walking_tour",
    "boat_tour",
    "cultural",
    "adventure",
    "night_tour",
    "general_tour",
  ],
  providers: ["getyourguide", "viator"],
  regionSupport: ["TR", "US", "EU", "ASIA"],
  commissionRate: 0.11,
  vertical: "tourism",
  features: ["experiences", "activities"],
};

export const activitiesAdapter = searchActivities;
export const searchActivitiesAdapter = searchActivities;
export const searchTourActivities = searchActivities;

export default {
  searchActivities,
  activitiesAdapterConfig,
};

console.log("🎭 Activities Adapter — S200 FINAL loaded.");
