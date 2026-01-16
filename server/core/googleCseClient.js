// server/core/googleCseClient.js
// ============================================================
//  GOOGLE PROGRAMMABLE SEARCH (CSE) CLIENT — S1 (SITE-BY-SITE)
//  - key + cx + q ile arama
//  - siteSearch ile tek domain’e daraltma
//  - ✅ 429/403 koruması: cache + otomatik devre dışı (log spam kesilir)
//  - ✅ Hata durumunda "ok:false" döner (boş ama ok:true değil)
// ============================================================

import { httpGetJson } from "../utils/httpClient.js";

// ----------------------------------------------
// Cache + cooldown (in-memory)
// ----------------------------------------------
const CSE_CACHE = new Map(); // cacheKey -> { exp:number, value:any }
const TTL_OK_MS = Number(process.env.GOOGLE_CSE_CACHE_TTL_OK_MS || 10 * 60 * 1000);
const TTL_ERR_MS = Number(process.env.GOOGLE_CSE_CACHE_TTL_ERR_MS || 60 * 1000);
const COOLDOWN_429_MS = Number(process.env.GOOGLE_CSE_429_COOLDOWN_MS || 15 * 60 * 1000);

let CSE_DISABLED_UNTIL = 0;
let CSE_DISABLED_REASON = "";

function cacheGet(k) {
  try {
    const hit = CSE_CACHE.get(k);
    if (!hit) return null;
    if (!hit.exp || Date.now() > hit.exp) {
      CSE_CACHE.delete(k);
      return null;
    }
    return hit.value || null;
  } catch {
    return null;
  }
}

function cacheSet(k, value, ttlMs) {
  try {
    const exp = Date.now() + Math.max(1000, Number(ttlMs || 0));
    CSE_CACHE.set(k, { exp, value });
  } catch {
    // ignore
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
  return pickEnv(`GOOGLE_CSE_CX_${g}`, "GOOGLE_CSE_CX", "GOOGLE_CSE_CX_PRODUCT") || "";
}

export function resolveCseSitesForGroup(group) {
  const g = String(group || "").trim().toUpperCase();
  // Öncelik: group’a özel sites -> genel sites -> product sites -> boş
  const raw = pickEnv(`GOOGLE_CSE_SITES_${g}`, "GOOGLE_CSE_SITES", "GOOGLE_CSE_SITES_PRODUCT") || "";
  const sites = String(raw)
    .split(",")
    .map((x) => normalizeDomain(x))
    .filter(Boolean);

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
  const now = Date.now();
  if (CSE_DISABLED_UNTIL && now < CSE_DISABLED_UNTIL) {
    return {
      ok: false,
      items: [],
      error: "cse_disabled",
      meta: {
        disabledUntil: CSE_DISABLED_UNTIL,
        reason: CSE_DISABLED_REASON || "cooldown",
      },
    };
  }

  const domain = normalizeDomain(site);
  const apiKey = String(key || "").trim();
  const cseCx = String(cx || "").trim();
  const query = String(q || "").trim();

  if (!apiKey || !cseCx || !query) {
    return { ok: false, items: [], error: "missing_key_or_cx_or_q" };
  }

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

  if (domain) {
    params.siteSearch = domain;
    params.siteSearchFilter = "i";
  }

  const url = `https://www.googleapis.com/customsearch/v1?${buildParams(params)}`;

  const cacheKey = `${domain}|${cseCx}|${query}|${params.start}|${params.num}|${hl}|${gl}|${cr}|${lr}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await httpGetJson(url, {
    timeoutMs: timeoutMs ?? safeInt(process.env.GOOGLE_CSE_TIMEOUT_MS, 4500),
    // retries: 0 -> tek request disiplini (429 log spam azalır)
    retries: safeInt(process.env.GOOGLE_CSE_RETRIES, 0),
    headers: { Accept: "application/json" },
    adapterName: `cse:${domain || "global"}`,
  });

  if (!r?.ok) {
    const status = Number(r?.status || r?.error?.status || 0);
    const msg = String(r?.error?.message || r?.error || "CSE_ERROR");

    // 429/403: global cooldown (boş deneme kesilir)
    if (status === 429 || status === 403) {
      CSE_DISABLED_UNTIL = Date.now() + COOLDOWN_429_MS;
      CSE_DISABLED_REASON = `http_${status}`;
    }

    const out = {
      ok: false,
      items: [],
      error: msg,
      meta: { domain: domain || "", url, status },
    };

    cacheSet(cacheKey, out, TTL_ERR_MS);
    return out;
  }

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
    },
  };

  cacheSet(cacheKey, out, TTL_OK_MS);
  return out;
}
