// server/adapters/hiwellAdapter.js
// ============================================================================
// HIWELL — S200 TITAN HARDENED (KIT-LOCKED, DRIFT-SAFE)
// - Discovery source (SERPAPI/SEO): price forced null, affiliate injection OFF
// - Output: { ok, items, count, source, _meta }
// - NO FAKE fallback: empty means empty (PROD-safe)
// ============================================================================

import axios from "axios";
import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
} from "../core/s200AdapterKit.js";

const SOURCE = "hiwell";
const BASE = "https://hiwell.com";
const SERPAPI_KEY = process.env.SERPAPI_KEY || process.env.SERPAPI || "";

const DEFAULT_TIMEOUT = Number(process.env.HIWELL_TIMEOUT_MS || 5200);
const HARD_TIMEOUT = Number(process.env.HIWELL_HARD_TIMEOUT_MS || 6500);

function setS200Ctx(query, url = "") {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: SOURCE,
      providerKey: SOURCE,
      query: safeStr(query, 220),
      url: safeStr(url, 900),
    };
  } catch {}
}

function absUrl(base, href) {
  if (!href) return "";
  try {
    if (href.startsWith("http")) return href;
    if (href.startsWith("//")) return "https:" + href;
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

async function fetchHtml(url, signal) {
  const u = absUrl(BASE, url) || url;
  if (!u) return "";
  const res = await axios.get(u, {
    timeout: Math.min(DEFAULT_TIMEOUT, 4500),
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    signal,
    validateStatus: () => true,
  });
  const ct = String(res.headers?.["content-type"] || "");
  if (!String(res.data || "").trim()) return "";
  if (ct && !ct.includes("text/html")) return "";
  return String(res.data || "");
}

function parseAnchors(html, baseUrl = BASE) {
  const $ = loadCheerioS200(html);
  const out = [];
  $("a[href]").each((_, a) => {
    const href = absUrl(baseUrl, $(a).attr("href"));
    const title = String($(a).text() || "").trim();
    if (!href || !title) return;
    // Filter low-signal junk
    if (title.length < 4) return;
    if (href.includes("/blog") || href.includes("/kategori") || href.includes("/tag")) return;

    out.push({
      title,
      url: href,
      price: null, // discovery rule
      provider: SOURCE,
      providerKey: SOURCE,
      providerFamily: SOURCE,
      vertical: "psychology",
      category: "psychology",
      raw: { href, title },
    });
  });
  return out;
}

function uniqByUrl(items = []) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const u = String(it?.url || "");
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(it);
  }
  return out;
}

async function serpSiteSearch(query, limit = 10, signal) {
  if (!SERPAPI_KEY) return [];
  const q = safeStr(query, 200);
  const googleQ = `site:hiwell.com ${q} psikolog terapi online randevu`;

  try {
    const { data } = await axios.get("https://serpapi.com/search.json", {
      timeout: Math.min(DEFAULT_TIMEOUT, 3500),
      signal,
      params: {
        engine: "google",
        q: googleQ,
        api_key: SERPAPI_KEY,
        hl: "tr",
        gl: "tr",
        num: Math.max(3, Math.min(20, Number(limit || 10))),
      },
      validateStatus: () => true,
    });

    const res = data?.organic_results || data?.results || [];
    const out = (Array.isArray(res) ? res : [])
      .map((r) => {
        const title = String(r?.title || "").trim();
        const url = absUrl(BASE, r?.link || r?.url);
        if (!title || !url) return null;

        return {
          title,
          url,
          price: null, // discovery rule
          provider: SOURCE,
          providerKey: SOURCE,
          providerFamily: SOURCE,
          vertical: "psychology",
          category: "psychology",
          raw: r,
        };
      })
      .filter(Boolean);

    return uniqByUrl(out).slice(0, Math.max(1, Math.min(30, Number(limit || 10))));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Legacy RAW (array) — ZERO DELETE
// ---------------------------------------------------------------------------
export async function searchHiwellLegacy(query, options = {}) {
  const q = safeStr(query, 220);
  const limit = Math.max(1, Math.min(30, Number(options.limit || 10)));
  const signal = options.signal;

  // 1) SERPAPI
  const serp = await serpSiteSearch(q, limit, signal);
  if (serp.length) return serp.slice(0, limit);

  // 2) Site anchor parse (best-effort)
  const searchUrls = [
    `${BASE}/search?q=${encodeURIComponent(q || "psikolog")}`,
    `${BASE}/arama?q=${encodeURIComponent(q || "psikolog")}`,
  ];

  for (const u of searchUrls) {
    const html = await fetchHtml(u, signal);
    if (!html) continue;
    const parsed = parseAnchors(html, BASE);
    if (parsed.length) return parsed.slice(0, limit);
  }

  // ✅ NO FAKE fallback in PROD
  return [];
}

// ---------------------------------------------------------------------------
// S200 WRAPPER (public adapter)
// ---------------------------------------------------------------------------
export async function searchHiwellAdapter(query, options = {}) {
  const q = safeStr(query, 240);
  const limit = Math.max(1, Math.min(30, Number(options.limit || 10)));
  const signal = options.signal;

  setS200Ctx(q);

  if (!q) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: SOURCE,
      _meta: { providerKey: SOURCE, emptyQuery: true, discovery: true },
    };
  }

  try {
    const rawItems = await withTimeout(
      Promise.resolve().then(() => searchHiwellLegacy(q, { ...options, limit, signal })),
      HARD_TIMEOUT,
      SOURCE
    );

    const arr = coerceItemsS200(rawItems);
    let dropped = 0;
    const items = [];

    for (const it of arr) {
      if (!it) { dropped++; continue; }
      const clean = { ...it };
      delete clean.id;
      delete clean.listingId;

      // Discovery sources: force price null + kill affiliate fields if any
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;
      clean.affiliateUrl = null;

      const norm = normalizeItemS200(
        {
          ...clean,
          providerKey: SOURCE,
          providerFamily: SOURCE,
          vertical: "psychology",
          category: "psychology",
          currency: null,
        },
        SOURCE,
        {
          vertical: "psychology",
          category: "psychology",
          providerFamily: SOURCE,
          titleFallback: "Hiwell sonucu",
        }
      );

      if (!norm) { dropped++; continue; }
      // Also keep it explicitly price-null
      norm.price = null;
      norm.finalPrice = null;
      norm.optimizedPrice = null;

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: SOURCE,
      _meta: {
        providerKey: SOURCE,
        discovery: true,
        limit,
        rawCount: arr.length,
        dropped,
        serpapiEnabled: !!SERPAPI_KEY,
      },
    };
  } catch (e) {
    const timeout = e instanceof TimeoutError || e?.name === "AbortError" || signal?.aborted;
    return {
      ok: false,
      items: [],
      count: 0,
      source: SOURCE,
      _meta: {
        providerKey: SOURCE,
        discovery: true,
        limit,
        timeout,
        error: e?.message || String(e),
        serpapiEnabled: !!SERPAPI_KEY,
      },
    };
  }
}

export default searchHiwellAdapter;
