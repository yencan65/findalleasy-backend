// server/adapters/busTicketSerpApiAdapter.js
// ============================================================
// BUS TICKET SERPAPI FALLBACK — S200 SAFE OUTPUT
// Fast supply bootstrap: Obilet / Enuygun / Turna
// ============================================================

import axios from "axios";
import crypto from "crypto";

import {
  withTimeout, coerceItemsS200, normalizeItemS200, stableIdS200, safeStr,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// S200: deterministic request/trace ids (NO RANDOM)
// ---------------------------------------------------------------------------
let __s200_seq = 0;
const __s200_next = () => {
  __s200_seq = (__s200_seq + 1) % 1000000000;
  return __s200_seq;
};
const SERPAPI_KEY =
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  process.env.SERP_API_KEY ||
  "";

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";

// Sıkı allowlist: alakasız site istemiyoruz
const ALLOWED_HOSTS = ["obilet.com", "enuygun.com", "turna.com"];

const safe = (v) => (v == null ? "" : String(v)).trim();

function stableId(prefix, ...xs) {
  try {
    const h = crypto
      .createHash("sha1")
      .update(xs.join("|"))
      .digest("hex")
      .slice(0, 16);
    return `${prefix}_${h}`;
  } catch {
    return `${prefix}_${String(__s200_next()).padStart(8, '0')}`;
  }
}

function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAllowed(url = "") {
  const h = hostOf(url);
  return ALLOWED_HOSTS.some((x) => h === x || h.endsWith("." + x));
}

function parsePriceTRY(text = "") {
  // Snippet içinden kaba fiyat yakalama (her zaman gelmez)
  const t = safe(text);
  const m =
    t.match(/(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?\s?(₺|TL)\b/) ||
    t.match(/₺\s?(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?/);

  if (!m) return null;

  const raw = (m[1] || "").replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function searchBusTicketSerpApiAdapterLegacy(query, opts = {}) {
  try {
    const q0 = safe(query);
    if (!q0) return [];
    if (!SERPAPI_KEY) return [];

    const q =
      `${q0} otobüs bileti ` +
      `(site:obilet.com OR site:enuygun.com OR site:turna.com)`;

    const params = {
      engine: "google",
      q,
      hl: "tr",
      gl: "tr",
      num: 10,
      api_key: SERPAPI_KEY,
    };

    const { data } = await axios.get(SERPAPI_ENDPOINT, {
      params,
      timeout: Math.max(2500, Number(opts.timeoutMs || 7000)),
      validateStatus: () => true,
    });

    const organic = Array.isArray(data?.organic_results)
      ? data.organic_results
      : [];

    const items = organic
      .map((r, i) => {
        const title = safe(r?.title);
        const url = safe(r?.link);
        const snippet = safe(r?.snippet);

        if (!title || !url) return null;
        if (!isAllowed(url)) return null;

        const price = parsePriceTRY(snippet);

        return {
          id: stableId("bus_serp", url, title, String(i)),
          title,
          originUrl: url,
          finalUrl: url,
          url,
          price, // null olabilir; sakın 0’a çevirmeyin
          currency: "TRY",
          image: null,
          provider: hostOf(url) || "serpapi",
          raw: {
            source: "serpapi_google",
            snippet,
            position: r?.position ?? i,
            displayedLink: r?.displayed_link || null,
          },
        };
      })
      .filter(Boolean)
      .slice(0, 10);

    return items;
  } catch {
    return [];
  }
}

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBusTicketSerpApiAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "busticketserpapi";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "busTicketSerpApiAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBusTicketSerpApiAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "busticketserpapi",
        _meta: {
          startedAt: started,
          durationMs: Date.now() - started,
          timeoutMs,
          error: errMsg,
          legacyOk: false,
        },
      };
    }

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      if (!it || typeof it !== "object") continue;

      const x = { ...it };

      // NO RANDOM ID — wipe any legacy/random ids and rebuild deterministically.
      x.id = null;
      x.listingId = null;
      x.listing_id = null;
      x.itemId = null;

      // Discovery sources: price forced null, affiliate injection OFF.
      if (true) {
        x.price = null;
        x.finalPrice = null;
        x.optimizedPrice = null;
        x.originalPrice = null;
        x.affiliateUrl = null;
        x.deeplink = null;
        x.deepLink = null;
        x.finalUrl = null;
      }

      const ni = normalizeItemS200(x, providerKey, {
        category: "general",
        vertical: "general",
        query: String(query || ""),
        region: String(options?.region || "TR").toUpperCase(),
      });

      if (!ni) {
        bad++;
        continue;
      }

      // Hard enforce stable id.
      ni.id = stableIdS200(providerKey, ni.url, ni.title);

      out.push(ni);
    }

    return {
      ok: true,
      items: out,
      count: out.length,
      source: "busticketserpapi",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        legacyOk: true,
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: "busticketserpapi",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        timeout: isTimeout,
        error: msg,
      },
    };
  }
}
