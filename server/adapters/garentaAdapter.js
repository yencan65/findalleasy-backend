// server/adapters/garentaAdapter.js
// ============================================================================
// GARENTA ADAPTER — S200 FINAL (NO-CRASH • NO-FAKE • KIT-COMPAT)
// - Wrapper output: { ok, items, count, source, _meta }
// - Contract lock: title+url required; price<=0 => null
// - NO RANDOM ID: stableIdS200(providerKey, url, title)
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

function _s200Ok(items, source, extraMeta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return {
    ok: true,
    items: arr,
    count: arr.length,
    source: source || "garenta",
    _meta: { ...safeObj(extraMeta) },
  };
}

function _s200Fail(source, err, extraMeta = {}) {
  const msg = err?.message || String(err || "unknown");
  return {
    ok: false,
    items: [],
    count: 0,
    source: source || "garenta",
    _meta: { error: msg, ...safeObj(extraMeta) },
  };
}

// ============================================================================
// Core search (placeholder-safe)
// ============================================================================
async function searchGarentaRaw(_query, _opts = {}) {
  // Buraya gerçek arama/scrape implementasyonunu koy.
  // Şimdilik NO-FAKE: boş dön.
  return [];
}

// ============================================================================
// Public adapter: S200 wrapper
// ============================================================================
export async function searchGarentaAdapter(query, opts = {}) {
  const source = "garenta";

  try {
    const timeoutMs = Number(opts?.timeoutMs || 6500);

    const raw = await withTimeout(
      () => searchGarentaRaw(query, opts),
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

    // Deterministic IDs
    for (const it of items) {
      if (!it.id) it.id = stableIdS200(source, pickUrlS200(it), it.title);
    }

    return _s200Ok(items, source, {
      query: safeStr(query),
      timeoutMs,
      note: "garenta adapter loaded (safeObj local fallback)",
    });
  } catch (e) {
    return _s200Fail(source, e, { query: safeStr(query) });
  }
}

// Back-compat export name
export async function searchGarenta(query, opts = {}) {
  return searchGarentaAdapter(query, opts);
}

export default { searchGarenta, searchGarentaAdapter };
