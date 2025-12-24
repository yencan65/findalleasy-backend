// server/adapters/evimdekipsikologAdapter.js
// ============================================================================
// EVIMDEKI PSIKOLOG ADAPTER — S200 SAFE (ZERO-CRASH)
// - Uses sitemap.xml to discover /Danismanlar/ profile URLs
// - Fetches a small subset of profile pages to extract name + (best-effort) price
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { loadCheerioS200, coerceItemsS200, normalizeItemS200, priceOrNullS200, withTimeout } from "../core/s200AdapterKit.js";

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

const BASE = String(process.env.EVIMDEKIPSIKOLOG_BASE_URL || "https://www.evimdekipsikolog.com").replace(/\/+$/, "");
const SITEMAP_URL = String(process.env.EVIMDEKIPSIKOLOG_SITEMAP_URL || `${BASE}/sitemap.xml`);
const DEFAULT_TIMEOUT_MS = Number(process.env.EVIMDEKIPSIKOLOG_TIMEOUT_MS || 9000);

function safeStr(v, max = 600) {
  const s = v == null ? "" : String(v);
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}
function normSpace(s) {
  return safeStr(s, 5000).replace(/\s+/g, " ").trim();
}
function addUtm(url) {
  const u = safeStr(url, 2200);
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.searchParams.get("utm_source")) parsed.searchParams.set("utm_source", "findalleasy");
    if (!parsed.searchParams.get("utm_medium")) parsed.searchParams.set("utm_medium", "ref");
    if (!parsed.searchParams.get("utm_campaign")) parsed.searchParams.set("utm_campaign", "psychology");
    if (!parsed.searchParams.get("utm_content")) parsed.searchParams.set("utm_content", "evimdekipsikolog");
    return parsed.toString();
  } catch {
    return u;
  }
}

function tokensFromQuery(q) {
  const s = normSpace(q).toLowerCase();
  if (!s) return [];
  return s.split(" ").map(x => x.trim()).filter(x => x.length >= 3).slice(0, 8);
}

async function fetchText(url, timeoutMs) {
  const tms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const res = await axios.get(url, {
    timeout: Math.max(1500, Math.min(15000, tms)),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
    },
  });
  return String(res?.data || "");
}

function parseSitemapUrls(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const url = safeStr(m[1], 2200);
    if (!url) continue;
    out.push(url);
  }
  return out;
}

function scoreUrl(url, qTokens) {
  const u = String(url || "").toLowerCase();
  let s = 0;
  for (const t of qTokens) if (u.includes(t)) s += 2;
  if (u.includes("/danismanlar/")) s += 1;
  return s;
}

function parseTryPrice(text) {
  const t = String(text || "");
  const nums = [];
  const re = /(\d{2,6})\s*(₺|TL)/gi;
  let m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  if (!nums.length) return null;
  return Math.min(...nums);
}

function parseProfile(html, url) {
  const $ = loadCheerioS200(html);

  const h1 = normSpace($("h1").first().text());
  const title = h1 || "Evimdeki Psikolog — Danışman Profili";

  // best-effort role
  const whole = normSpace($.text());
  const roleMatch = whole.match(/\b(Uzman Klinik Psikolog|Klinik Psikolog|Uzman Psikolog|Psikolog|Psikolojik Danışman)\b/i);
  const role = roleMatch ? normSpace(roleMatch[0]) : "";

  const price = parseTryPrice(whole);

  return normalizeItemS200({
    title: safeStr(title, 160),
    url: addUtm(url),
    price: price && price > 0 ? price : null,
    provider: "evimdekipsikolog",
    providerKey: "evimdekipsikolog",
    providerFamily: "evimdekipsikolog",
    category: "psychology",
    raw: {
      role,
      source: "profile_scrape",
    },
  }, "evimdekipsikolog", { vertical: "health", category: "psychologist", region: "TR" });
}

export async function searchEvimdekiPsikologAdapter(query, opts = {}) {
  const q = safeStr(query, 300);
  const limit = Math.max(1, Math.min(20, Number(opts.limit || 10)));
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const qTokens = tokensFromQuery(q);

  // how many profiles to fetch in detail
  const detailLimit = Math.max(1, Math.min(15, Number(opts.detailLimit || limit)));

  try {
    const xml = await fetchText(SITEMAP_URL, timeoutMs);
    const urls = parseSitemapUrls(xml)
      .filter(u => /\/Danismanlar\//i.test(u))
      .filter(u => u.startsWith("http"));

    if (!urls.length) throw new Error("sitemap içinde /Danismanlar/ URL bulunamadı");

    // rank by query match
    const ranked = urls
      .map(u => ({ u, s: scoreUrl(u, qTokens) }))
      .sort((a, b) => b.s - a.s);

    // seed set: take more than we need, then fetch some profiles
    const seed = ranked.slice(0, Math.max(detailLimit * 3, 30)).map(x => x.u);

    const picked = seed.slice(0, detailLimit);

    const items = [];
    for (const u of picked) {
      try {
        const html = await fetchText(u, timeoutMs);
        const it = parseProfile(html, u);
        items.push(it);
        if (items.length >= limit) break;
      } catch {
        // skip broken profile
      }
    }

    // If query tokens exist, filter items by tokens in title/role
    let finalItems = items;
    if (qTokens.length) {
      finalItems = items.filter(it => {
        const blob = `${it.title} ${(it.raw && it.raw.role) || ""}`.toLowerCase();
        return qTokens.some(t => blob.includes(t));
      });
      // fallback to unfiltered if too strict
      if (!finalItems.length) finalItems = items;
    }

    finalItems = finalItems.slice(0, limit);

    return {
      ok: true,
      items: finalItems,
      count: finalItems.length,
      source: "evimdekipsikolog",
      _meta: { provider: "evimdekipsikolog", sitemap: SITEMAP_URL, query: q, detailLimit },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 300);
    console.warn("❌ evimdekipsikologAdapter error:", msg);

    if (ALLOW_STUBS) {
      return {
        ok: true,
        items: [
          {
            title: "Evimdeki Psikolog — Danışmanlar",
            url: addUtm(`${BASE}/`),
            price: null,
            provider: "evimdekipsikolog",
            providerKey: "evimdekipsikolog",
            providerFamily: "evimdekipsikolog",
            category: "psychology",
            raw: { stub: true, reason: msg },
          },
        ],
        count: 1,
        source: "evimdekipsikolog",
        _meta: { stub: true },
      };
    }

    return { ok: false, items: [], count: 0, source: "evimdekipsikolog", _meta: { error: msg } };
  }
}

export default searchEvimdekiPsikologAdapter;
