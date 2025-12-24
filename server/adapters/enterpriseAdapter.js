// server/adapters/enterpriseAdapter.js
// ============================================================================
// ENTERPRISE / CORPORATE TRAVEL / CAR RENTAL (Provider) — S200 FINAL PATCH
// - ZERO CRASH: safeImport friendly
// - NO FAKE RESULTS: PROD’da stub yok
// - Wrapper output: { ok, items, count, source, _meta }
// ============================================================================

import axios from "axios";

import {
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  pickUrlS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// NOTE: Some kit versions may not export safeObj; keep local fallback.
function safeObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// -------------------------
// Local helpers
// -------------------------
function safeLower(v) {
  return safeStr(v).toLowerCase();
}

function _s200Ok(items, source, extraMeta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: true,
    items: arr,
    count: arr.length,
    source: source || "enterprise",
    _meta: { ...safeObj(extraMeta) },
  };
}

function _s200Fail(source, err, extraMeta = {}) {
  const msg = err?.message || String(err || "unknown");
  return {
    ok: false,
    items: [],
    count: 0,
    source: source || "enterprise",
    _meta: { error: msg, ...safeObj(extraMeta) },
  };
}

// ============================================================================
// Core search (placeholder-safe)
// ============================================================================
async function searchEnterpriseRaw(query, _opts = {}) {
  // Burada gerçek scraping / API çağrısı implement edebilirsin.
  // Şimdilik NO-FAKE: PROD’da boş döner.
  return [];
}

// ============================================================================
// Public adapter: S200 wrapper
// ============================================================================
export async function searchEnterpriseAdapter(query, opts = {}) {
  const source = "enterprise";

  try {
    const timeoutMs = Number(opts?.timeoutMs || 6500);

    const raw = await withTimeout(
      () => searchEnterpriseRaw(query, opts),
      timeoutMs,
      `${source} timed out`
    );

    const items = coerceItemsS200(raw)
      .map((it) =>
        normalizeItemS200(it, {
          providerKey: source,
        })
      )
      .filter((x) => x && x.title && (x.url || x.deeplink || x.finalUrl || x.originUrl));

    // ID hardening (deterministic)
    for (const it of items) {
      if (!it.id) it.id = stableIdS200(source, pickUrlS200(it), it.title);
    }

    return _s200Ok(items, source, {
      query: safeStr(query),
      timeoutMs,
      note: "enterprise adapter loaded (no cheerio default import)",
    });
  } catch (e) {
    return _s200Fail(source, e, { query: safeStr(query) });
  }
}

// Back-compat export name
export async function searchEnterprise(query, opts = {}) {
  return searchEnterpriseAdapter(query, opts);
}

export default { searchEnterprise, searchEnterpriseAdapter };
