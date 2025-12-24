// server/core/s200ResilienceKit.js
// ============================================================================
// S200 RESILIENCE KIT — Provider Cooldown (Circuit Breaker) + Coverage Floor
// ZERO DELETE • ADDITIVE MODULE
// - 403/429/404 gibi durumlarda provider otomatik cooldown'a alınır
// - product/fashion boşsa SerpAPI shopping + GoogleShopping ile coverage floor
// - Memory-only (process içi). İstersen ileride Redis ile kalıcılaştırırsın.
// ============================================================================

const NOW = () => Date.now();

const ENV = process.env;

// ------------------------------
// Feature flags
// ------------------------------
const COOLDOWN_ENABLED = String(ENV.FINDALLEASY_PROVIDER_COOLDOWN || "1") !== "0";
const COVERAGE_FLOOR_ENABLED = String(ENV.FINDALLEASY_COVERAGE_FLOOR || "1") !== "0";

// Cooldown skip davranışı:
// - "ok=true" => smoke test / sistem fail saymaz, sadece boş döner
// - "ok=false" => observable ama bazı testlerde fail artabilir
const COOLDOWN_SKIP_OK = String(ENV.FINDALLEASY_COOLDOWN_SKIP_OK || "1") !== "0";

// ------------------------------
// Cooldown settings (ms)
// ------------------------------
const MINUTE = 60_000;

const BASE_403_MS = Number(ENV.FINDALLEASY_COOLDOWN_403_MS || 5 * MINUTE);
const BASE_429_MS = Number(ENV.FINDALLEASY_COOLDOWN_429_MS || 2 * MINUTE);
const BASE_404_MS = Number(ENV.FINDALLEASY_COOLDOWN_404_MS || 45_000); // 45s
const BASE_5XX_MS = Number(ENV.FINDALLEASY_COOLDOWN_5XX_MS || 60_000); // 60s
const BASE_NET_MS = Number(ENV.FINDALLEASY_COOLDOWN_NET_MS || 30_000); // 30s

// Üst limit (ms)
const MAX_COOLDOWN_MS = Number(ENV.FINDALLEASY_COOLDOWN_MAX_MS || 5 * MINUTE);

// Cooldown'a almak için strike eşiği (bazı türlerde)
const NET_STRIKE_THRESHOLD = Number(ENV.FINDALLEASY_NET_STRIKE_THRESHOLD || 5);

// Success gördüğünde strike azaltma
const SUCCESS_DECAY = Number(ENV.FINDALLEASY_COOLDOWN_SUCCESS_DECAY || 1);

// cooldown growth factor (exponential backoff)
const COOLDOWN_GROWTH = Number(ENV.FINDALLEASY_COOLDOWN_GROWTH || 1.5);

// Jitter (ms) — herd effect azaltır
const JITTER_MS = Number(ENV.FINDALLEASY_COOLDOWN_JITTER_MS || 7_000);

// ------------------------------
// In-memory store
// ------------------------------
/** @type {Map<string, {until:number, strikes:number, lastStatus:number|null, lastReason:string, lastAt:number}>} */
const store = new Map();

function safeStr(v, fb = "") {
  try {
    const s = v == null ? "" : String(v).trim();
    return s || fb;
  } catch {
    return fb;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function jitter(ms) {
  if (!ms || ms <= 0) return 0;
  const j = Math.floor(Math.random() * Math.max(0, JITTER_MS));
  return ms + j;
}

function getEntry(providerKey) {
  const k = safeStr(providerKey, "");
  if (!k) return null;
  if (!store.has(k)) {
    store.set(k, {
      until: 0,
      strikes: 0,
      lastStatus: null,
      lastReason: "",
      lastAt: 0,
    });
  }
  return store.get(k);
}

function cleanupExpired() {
  const t = NOW();
  for (const [k, v] of store.entries()) {
    if (!v) continue;
    const expired = v.until > 0 && v.until <= t;
    const stale = v.lastAt > 0 && t - v.lastAt > 6 * 60 * MINUTE; // 6 saat pasifse temizle
    if (expired && v.strikes <= 0) store.delete(k);
    else if (stale && v.strikes <= 0) store.delete(k);
    else if (expired) v.until = 0;

    // Soft recovery: if cooldown expired, slowly decay strikes so providers can come back.
    if (expired && typeof v.strikes === 'number' && v.strikes > 0) {
      v.strikes = Math.max(0, v.strikes - 1);
      if (v.strikes === 0) store.delete(k);
    }

  }
}

// ------------------------------
// Status inference
// ------------------------------
function inferHttpStatus(err) {
  try {
    if (!err) return { status: null, reason: "no_error" };

    // axios: err.response.status
    const ax = err?.response?.status;
    if (typeof ax === "number") return { status: ax, reason: "axios_response_status" };

    // fetch style: err.status
    const st = err?.status;
    if (typeof st === "number") return { status: st, reason: "error_status" };

    // msg parse: "status code 403"
    const msg = safeStr(err?.message, "").toLowerCase();
    const m = msg.match(/status code\s+(\d{3})/i);
    if (m && m[1]) return { status: Number(m[1]), reason: "message_status_code" };

    // custom: HTTPCLIENT_NON_2XX 403 ...
    const m2 = msg.match(/\bnon_2xx\s+(\d{3})\b/i);
    if (m2 && m2[1]) return { status: Number(m2[1]), reason: "message_non_2xx" };

    // timeout / network
    const code = safeStr(err?.code, "").toUpperCase();
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNABORTED") {
      return { status: 408, reason: "timeout_code" };
    }
    if (code === "ENOTFOUND" || code === "ECONNRESET" || code === "EAI_AGAIN") {
      return { status: 0, reason: "network_code" };
    }

    if (msg.includes("timed out")) return { status: 408, reason: "timeout_message" };
    if (msg.includes("socket hang up") || msg.includes("network error")) return { status: 0, reason: "network_message" };

    return { status: null, reason: "unknown" };
  } catch {
    return { status: null, reason: "infer_crash" };
  }
}

function baseCooldownForStatus(status) {
  if (status === 403) return BASE_403_MS;
  if (status === 429) return BASE_429_MS;
  if (status === 404) return BASE_404_MS;
  if (status >= 500 && status <= 599) return BASE_5XX_MS;
  if (status === 408) return BASE_NET_MS;
  if (status === 0) return BASE_NET_MS;
  return 0;
}

function shouldCooldown(status, strikes) {
  // 403/429/404 => tek seferde bile cooldown
  if (status === 403 || status === 429 || status === 404) return true;

  // 5xx => 2. strike'tan sonra
  if (status >= 500 && status <= 599) return strikes >= 2;

  // network/timeout => NET_STRIKE_THRESHOLD sonrası
  if (status === 408 || status === 0) return strikes >= NET_STRIKE_THRESHOLD;

  return false;
}

function computeCooldownMs(status, strikes) {
  const base = baseCooldownForStatus(status);
  if (!base || base <= 0) return 0;

  const s = Math.max(1, Number(strikes || 1));
  const mult = Math.pow(COOLDOWN_GROWTH, Math.max(0, s - 1));
  const ms = Math.floor(base * mult);

  return clamp(ms, 0, MAX_COOLDOWN_MS);
}

// ------------------------------
// Public API — Cooldown
// ------------------------------
export function isProviderCoolingDownS200(providerKey) {
  cleanupExpired();
  const e = getEntry(providerKey);
  if (!e) return { coolingDown: false, until: 0, remainingMs: 0, strikes: 0, status: null, reason: "" };

  const t = NOW();
  const remaining = e.until > t ? e.until - t : 0;

  return {
    coolingDown: remaining > 0,
    until: e.until || 0,
    remainingMs: remaining,
    strikes: e.strikes || 0,
    status: e.lastStatus ?? null,
    reason: e.lastReason || "",
  };
}

export function reportProviderStatusS200(providerKey, status, meta = {}) {
  if (!COOLDOWN_ENABLED) return;

  const e = getEntry(providerKey);
  if (!e) return;

  const st = typeof status === "number" ? status : null;
  e.lastStatus = st;
  e.lastAt = NOW();

  // strikes güncelle
  e.strikes = clamp((e.strikes || 0) + 1, 0, 50);

  const reason = safeStr(meta?.reason || meta?.source || "", "");
  e.lastReason = reason || `http_${st ?? "unknown"}`;

  if (!st) return;

  if (!shouldCooldown(st, e.strikes)) return;

  const ms = computeCooldownMs(st, e.strikes);
  const until = NOW() + jitter(ms);

  // daha uzun cooldown varsa overwrite et, daha kısaysa kısaltma
  e.until = Math.max(e.until || 0, until);

  try {
    const remMin = Math.ceil((e.until - NOW()) / MINUTE);
    console.warn(
      `🧊 COOLDOWN: ${providerKey} status=${st} strikes=${e.strikes} → ${remMin}dk (reason=${e.lastReason})`
    );
  } catch {}
}

export function reportProviderErrorS200(providerKey, err, meta = {}) {
  if (!COOLDOWN_ENABLED) return;

  const inf = inferHttpStatus(err);
  const status = inf.status;

  // status null ise: strike artırmayalım (boş yere provider öldürmeyelim)
  // ama istersen debug için meta.reason yaz
  if (status == null) return;

  reportProviderStatusS200(providerKey, status, {
    ...meta,
    reason: meta?.reason || inf.reason,
  });
}

export function noteProviderSuccessS200(providerKey, meta = {}) {
  if (!COOLDOWN_ENABLED) return;

  const e = getEntry(providerKey);
  if (!e) return;

  e.lastAt = NOW();

  // Başarı gördüğümüzde strikes'ı azalt.
  // itemsCount=0 bile olsa provider'ın "alive" olduğunu gösterir (bazı aramalarda 0 sonuç normaldir).
  const itemsCount = Number(meta?.itemsCount ?? 0);
  const ok = meta?.ok !== false;

  if (ok) {
    const decay = itemsCount > 0 ? SUCCESS_DECAY : Math.min(1, SUCCESS_DECAY);
    e.strikes = clamp((e.strikes || 0) - decay, 0, 50);

    // cooldown varsa ve gerçekten çalıştığını gördüysek (items>0) erken gevşet
    if (itemsCount > 0 && e.until && e.until > NOW()) {
      const remaining = e.until - NOW();
      e.until = NOW() + Math.floor(remaining / 2);
    }
  }
}

// ------------------------------
// Adapter wrapper — central guard
// ------------------------------
export async function runWithCooldownS200(providerKey, fn, meta = {}) {
  cleanupExpired();

  const cd = isProviderCoolingDownS200(providerKey);
  if (COOLDOWN_ENABLED && cd.coolingDown) {
    const out = {
      ok: COOLDOWN_SKIP_OK ? true : false,
      items: [],
      count: 0,
      source: safeStr(providerKey, "unknown"),
      _meta: {
        skipped: true,
        skipReason: "cooldown",
        cooldown: {
          until: cd.until,
          remainingMs: cd.remainingMs,
          strikes: cd.strikes,
          status: cd.status,
          reason: cd.reason,
        },
        ...meta,
      },
    };
    return out;
  }

  try {
    const res = await fn();

    // res array olabilir ya da {ok,items}
    const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    let ok = true;

    if (Array.isArray(res)) {
      if (typeof res.ok === 'boolean') ok = res.ok;
    } else if (res && typeof res === 'object') {
      if (typeof res.ok === 'boolean') ok = res.ok;
      else if (res.ok === false) ok = false;
    }


    if (ok) {
      noteProviderSuccessS200(providerKey, { itemsCount: items.length });
    }

    return res;
  } catch (err) {
    // hata → status çıkar, cooldown raporla
    reportProviderErrorS200(providerKey, err, meta);

    // crash yok: standart wrapper output
    return {
      ok: false,
      items: [],
      count: 0,
      source: safeStr(providerKey, "unknown"),
      error: safeStr(err?.message, "ADAPTER_ERROR"),
      _meta: {
        ...meta,
        errCode: safeStr(err?.code, ""),
      },
    };
  }
}

// ============================================================================
// COVERAGE FLOOR — product/fashion empty kalmasın
// ============================================================================

function dedupeByUrlTitle(items) {
  const out = [];
  const seen = new Set();

  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const title = safeStr(it?.title, "");
    const url = safeStr(it?.url || it?.finalUrl || it?.originUrl || it?.deeplink, "");
    if (!title || !url) continue;

    const k = `${title}::${url}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);

    out.push(it);
  }
  return out;
}

async function safeImport(path) {
  try {
    return await import(path);
  } catch (e) {
    return null;
  }
}

export async function ensureCoverageFloorS200(params = {}) {
  if (!COVERAGE_FLOOR_ENABLED) return Array.isArray(params?.items) ? params.items : [];

  const group = safeStr(params?.group, "").toLowerCase();
  const query = safeStr(params?.query, "");
  const region = safeStr(params?.region || "TR", "TR").toUpperCase();

  const minItems =
    typeof params?.minItems === "number"
      ? params.minItems
      : group === "fashion"
      ? Number(ENV.FINDALLEASY_FLOOR_FASHION || 6)
      : group === "product"
      ? Number(ENV.FINDALLEASY_FLOOR_PRODUCT || 8)
      : 0;

  const baseItems = Array.isArray(params?.items) ? params.items : [];
  if (!query) return baseItems;
  if (!minItems) return baseItems;

  if (!["product", "fashion"].includes(group)) return baseItems;

  if (baseItems.length >= minItems) return baseItems;

  const extra = [];

  // 1) Google Shopping (SerpAPI engine=google_shopping)
  {
    const mod = await safeImport("../adapters/googleShopping.js");
    const fn = mod?.searchGoogleShopping;
    if (typeof fn === "function") {
      const res = await runWithCooldownS200(
        "google_shopping",
        async () => await fn(query, region),
        { feature: "coverage_floor", group, query, region, source: "googleShopping" }
      );

      const arr = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      if (arr.length) extra.push(...arr);
    }
  }

  // 2) SerpAPI shopping (adapter: serpApi.js)
  {
    const mod = await safeImport("../adapters/serpApi.js");
    const fn = mod?.searchWithSerpApi || mod?.default;
    if (typeof fn === "function") {
      const res = await runWithCooldownS200(
        "serpapi",
        async () =>
          await fn(query, {
            region,
            mode: "shopping",
            forceShopping: true,
          }),
        { feature: "coverage_floor", group, query, region, source: "serpApi" }
      );

      const arr = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      if (arr.length) extra.push(...arr);
    }
  }

  // merge + dedupe
  const merged = dedupeByUrlTitle([...baseItems, ...extra]);

  return merged;
}
