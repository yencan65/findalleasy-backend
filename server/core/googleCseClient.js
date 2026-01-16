// server/core/googleCseClient.js
// ============================================================
//  GOOGLE PROGRAMMABLE SEARCH (CSE) CLIENT — S1 (SITE-BY-SITE)
//  - key + cx + q ile arama
//  - siteSearch ile tek domain’e daraltma
//  - Hata durumunda crash yok: boş sonuç döner
// ============================================================

import { httpGetJson } from "../utils/httpClient.js";

// ---------------------------------------------------------------------------
// In-memory cache + 429 circuit breaker (prevents quota burn + log spam)
// ---------------------------------------------------------------------------
const CSE_CACHE = new Map(); // key -> { ts, data }
const FAE_CSE_CACHE_TTL_MS = Number(process.env.FAE_CSE_CACHE_TTL_MS || 10 * 60 * 1000);
const FAE_CSE_COOLDOWN_MS = Number(process.env.FAE_CSE_COOLDOWN_MS || 10 * 60 * 1000);

const CSE_STATE =
  globalThis.__FAE_CSE_STATE ||
  (globalThis.__FAE_CSE_STATE = { disabledUntil: 0, last429: 0 });

function cseCacheGet(key) {
  try {
    if (!FAE_CSE_CACHE_TTL_MS || FAE_CSE_CACHE_TTL_MS <= 0) return null;
    const hit = CSE_CACHE.get(key);
    if (!hit) return null;
    const age = Date.now() - (hit.ts || 0);
    if (age > FAE_CSE_CACHE_TTL_MS) return null;
    return hit.data || null;
  } catch {
    return null;
  }
}

function cseCacheSet(key, data) {
  try {
    if (!FAE_CSE_CACHE_TTL_MS || FAE_CSE_CACHE_TTL_MS <= 0) return;
    CSE_CACHE.set(key, { ts: Date.now(), data });
  } catch {}
}

function is429(e) {
  try {
    const st = Number(e?.status || e?.statusCode || 0);
    if (st == 429) return true;
    const msg = String(e?.message || e || '').toLowerCase();
    return msg.includes(' 429 ') || msg.includes('non_2xx 429') || msg.includes('status 429');
  } catch {
    return false;
  }
}

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function safeInt(n, d) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function normalizeDomain(d) {
  const s = String(d || "").trim().toLowerCase();
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/g, "");
}

function buildParams(obj) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    usp.set(k, s);
  }
  return usp.toString();
}

export function resolveCseCxForGroup(group) {
  const g = String(group || "").trim().toUpperCase();
  // Öncelik: group’a özel CX -> genel CX -> product CX
  return (
    pickEnv(`GOOGLE_CSE_CX_${g}`, "GOOGLE_CSE_CX", "GOOGLE_CSE_CX_PRODUCT") || ""
  );
}

export function resolveCseSitesForGroup(group) {
  const g = String(group || "").trim().toUpperCase();
  // Öncelik: group’a özel sites -> genel sites -> product sites -> boş
  const raw =
    pickEnv(`GOOGLE_CSE_SITES_${g}`, "GOOGLE_CSE_SITES", "GOOGLE_CSE_SITES_PRODUCT") || "";
  const sites = String(raw)
    .split(",")
    .map((x) => normalizeDomain(x))
    .filter(Boolean);

  // Unique
  return Array.from(new Set(sites));
}

export function resolveCseKey() {
  return pickEnv("GOOGLE_CSE_API_KEY", "GOOGLE_API_KEY", "CSE_API_KEY");
}

/**
 * Google CSE Search (siteSearch ile domain’e daraltılmış)
 */
export async function cseSearchSite({
  key,
  cx,
  q,
  site,
  hl,
  gl,
  cr,
  lr,
  num = 5,
  start = 1,
  safe = "off",
  timeoutMs,
}) {
  const domain = normalizeDomain(site);
  const apiKey = String(key || "").trim();
  const cseCx = String(cx || "").trim();
  const query = String(q || "").trim();

  if (!apiKey || !cseCx || !query) return { ok: false, items: [], error: "missing_key_or_cx_or_q" };

  const params = {
    key: apiKey,
    cx: cseCx,
    q: query,
    num: String(Math.max(1, Math.min(10, safeInt(num, 5)))),
    start: String(Math.max(1, safeInt(start, 1))),
    safe,
    hl,
    gl,
    cr,
    lr,
  };

  // Domain daraltma
  if (domain) {
    params.siteSearch = domain;
    params.siteSearchFilter = "i"; // include
  }

  const url = `https://www.googleapis.com/customsearch/v1?${buildParams(params)}`;

  // Cache key includes everything that affects the result
  const cacheKey = [cseCx, query, domain, hl, gl, cr, lr, params.num, params.start, safe].join('|');

  // Circuit breaker: if we recently hit 429, stop calling CSE for a cooldown window
  const now = Date.now();
  if (FAE_CSE_COOLDOWN_MS > 0 && now < (CSE_STATE.disabledUntil || 0)) {
    const until = CSE_STATE.disabledUntil || 0;
    return {
      ok: false,
      items: [],
      error: 'cse_cooldown_429',
      meta: { domain: domain || '', url, disabledUntil: until },
    };
  }

  const cached = cseCacheGet(cacheKey);
  if (cached) return cached;

  try {
    const r = await httpGetJson(url, {
      timeoutMs: timeoutMs ?? safeInt(process.env.GOOGLE_CSE_TIMEOUT_MS, 4500),
      retries: safeInt(process.env.GOOGLE_CSE_RETRIES, 1),
      headers: {
        // CSE key bazlı, ama bazı edge durumlarda UA önem kazanıyor
        "Accept": "application/json",
      },
    });

    const json = r?.data;
    const items = Array.isArray(json?.items) ? json.items : [];
    const out = {
      ok: true,
      items,
      meta: {
        url,
        domain: domain || "",
        totalResults: safeInt(json?.searchInformation?.totalResults, 0),
        searchTime: json?.searchInformation?.searchTime,
      }
    };

    cseCacheSet(cacheKey, out);
    return out;
  } catch (e) {
    // 429 → cooldown (prevents quota burn + noisy logs)
    if (is429(e) && FAE_CSE_COOLDOWN_MS > 0) {
      const now2 = Date.now();
      const nextUntil = now2 + FAE_CSE_COOLDOWN_MS;
      const prevUntil = Number(CSE_STATE.disabledUntil || 0);
      CSE_STATE.last429 = now2;
      if (nextUntil > prevUntil) {
        CSE_STATE.disabledUntil = nextUntil;
        try {
          console.warn('CSE:429 cooldown enabled', { until: new Date(nextUntil).toISOString() });
        } catch {}
      }
    }

    return {
      ok: false,
      items: [],
      error: e?.message || String(e),
      meta: { domain: domain || "", url },
    };
  }
}
