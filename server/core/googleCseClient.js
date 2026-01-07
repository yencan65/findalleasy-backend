// server/core/googleCseClient.js
// ============================================================
//  GOOGLE PROGRAMMABLE SEARCH (CSE) CLIENT — S1 (SITE-BY-SITE)
//  - key + cx + q ile arama
//  - siteSearch ile tek domain’e daraltma
//  - Hata durumunda crash yok: boş sonuç döner
// ============================================================

import { httpGetJson } from "../utils/httpClient.js";

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
    return {
      ok: true,
      items,
      meta: {
        url,
        domain: domain || "",
        totalResults: safeInt(json?.searchInformation?.totalResults, 0),
        searchTime: json?.searchInformation?.searchTime,
      },
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      error: e?.message || String(e),
      meta: { domain: domain || "", url },
    };
  }
}
