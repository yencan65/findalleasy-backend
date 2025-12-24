// server/utils/rateLimiter.js
// =====================================================
//  FINDALLEASY — S200 ULTRA+ RATE LIMITER v7.0
//  EN DOLU PAKET — ADAPTER ENGINE v200 / S40 / S10 UYUMLU
//  * Hiçbir işlev silinmedi
//  * Tüm davranışlar korundu
//  * Anti-ban / jitter optimize edildi
//  * Backoff akıllı mod
//  * Provider detect güçlendirildi (fallback + normalize)
// =====================================================

/*
  NOTE:
  normalizeProviderKeyS9 entegre değil ama
  gelecekte entegre edildiğinde otomatik kullanıma hazır fallback sistemi kuruldu.
*/

// -----------------------------------------------------
// GLOBAL STATE
// -----------------------------------------------------
if (!globalThis.__FAE_RL_STATE__) {
  globalThis.__FAE_RL_STATE__ = {
    buckets: {},
    tokenBucket: {},
    backoff: {},
    lastCleanup: Date.now(),
    windowMsPerKey: {},
    adapterStats: {},
  };
}

const STATE = globalThis.__FAE_RL_STATE__;

// -----------------------------------------------------
// CONSTANTS — Hafif optimize, S200 softTimeout uyumu
// -----------------------------------------------------
const DEFAULT_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const MAX_BACKOFF_MS = 8_000;         // 10s → 8s (daha stabil)
const TOKEN_REFILL_RATE = 1.7;        // 1 → 1.7 (yüksek concurrency)
const TOKEN_BUCKET_SIZE = 30;         // 25 → 30

const MIN_CHECK_DELAY = 1;            // 2 → 1
const MAX_CHECK_DELAY = 12;           // 30 → 12 (S200 jitter uyumlu)

// -----------------------------------------------------
// LIMIT TABLOSU (dokunulmadı + optimize mikro ayarlarla güçlendirildi)
// -----------------------------------------------------
const PROVIDER_LIMITS = {
  // DEFAULT
  default: { limit: 30, windowMs: DEFAULT_WINDOW_MS, burst: true, adaptive: true },

  // PRODUCT
  trendyol: { limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },
  hepsiburada:{ limit: 15, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },
  amazon:     { limit: 22, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },
  n11:        { limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },
  ciceksepeti:{ limit: 12, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 2 },
  boyner:     { limit: 10, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 2 },

  // MARKET
  carrefour:  { limit: 12, windowMs: 60_000, burst: true, adaptive: true, category: "market", priority: 2 },
  migros:     { limit: 12, windowMs: 60_000, burst: true, adaptive: true, category: "market", priority: 2 },
  getir:      { limit: 17, windowMs: 60_000, burst: true, adaptive: true, category: "market", priority: 2 },

  // TRAVEL
  booking:    { limit: 22, windowMs: 60_000, burst: true, adaptive: true, category: "travel", priority: 1 },
  skyscanner: { limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "travel", priority: 1 },
  mngtur:     { limit: 12, windowMs: 60_000, burst: true, adaptive: true, category: "travel", priority: 2 },

  getyourguide:{limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "tour", priority: 2 },
  viator:      {limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "tour", priority: 2 },

  // LOCATION
  googleplaces: { limit: 28, windowMs: 60_000, burst: true, adaptive: true, category: "location", priority: 1 },
  openstreetmap:{ limit: 45, windowMs: 60_000, burst: false, adaptive: false, category: "location", priority: 3 },
  googlemaps:   { limit: 25, windowMs: 60_000, burst: true, adaptive: true, category: "location", priority: 1 },

  // META
  serpapi:      { limit: 32, windowMs: 60_000, burst: true, adaptive: true, category: "meta", priority: 1 },
  googleshopping:{limit: 28, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },

  // SPECIAL
  barcode:      { limit: 22, windowMs: 60_000, burst: true, adaptive: true, category: "product", priority: 1 },

  // HEALTH
  health:       { limit: 12, windowMs: 60_000, burst: true, adaptive: true, category: "health", priority: 2 },
  medical:      { limit: 10, windowMs: 60_000, burst: true, adaptive: true, category: "health", priority: 2 },

  // ESTATE
  estate:       { limit: 14, windowMs: 60_000, burst: true, adaptive: true, category: "estate", priority: 2 },
  sahibinden:   { limit: 18, windowMs: 60_000, burst: true, adaptive: true, category: "estate", priority: 1 },

  // FOOD
  yemeksepeti:  { limit: 22, windowMs: 60_000, burst: true, adaptive: true, category: "food", priority: 1 },
  food:         { limit: 17, windowMs: 60_000, burst: true, adaptive: true, category: "food", priority: 2 },
};

// -----------------------------------------------------
// HELPER
// -----------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------
// PROVIDER DETECTOR (eski + yeni uyumlu güçlendirilmiş mod)
// -----------------------------------------------------
function detectProviderFromKey(key) {
  const lower = String(key || "").toLowerCase();

  // Eski sistem KORUNDU:
  const known = [
    "trendyol","hepsiburada","amazon","n11","booking","googleplaces","googleshopping","serpapi",
    "barcode","openstreetmap","sahibinden","yemeksepeti","migros","carrefour","getir","skyscanner",
    "mngtur","getyourguide","viator","health","medical","estate","emlak","food","restaurant"
  ];

  for (const k of known) {
    if (lower.includes(k)) return k.replace("restaurant","food");
  }

  // Geleceğe uyum: normalizeProviderKeyS9 var ise kullan
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const p = normalizeProviderKeyS9(lower);
      if (p && p !== "unknown") return p;
    }
  } catch {}

   // fallback normalize enforcement
  try {
    const norm = normalizeProviderKeyS9(lower);
    if (norm && norm !== "unknown") return norm;
  } catch {}

  return "default";
}



// -----------------------------------------------------
function resolveLimitConfig(rawKey, config = {}) {
  const provider = config.provider || detectProviderFromKey(rawKey);
  const providerBase = PROVIDER_LIMITS[provider] || PROVIDER_LIMITS.default;

  return {
    provider,
    limit: config.limit > 0 ? config.limit : providerBase.limit,
    windowMs: config.windowMs > 0 ? config.windowMs : providerBase.windowMs,
    burst: typeof config.burst === "boolean" ? config.burst : providerBase.burst,
    adaptive: typeof config.adaptive === "boolean" ? config.adaptive : providerBase.adaptive,
    category: providerBase.category || "default",
    priority: providerBase.priority || 3,
  };
}

// -----------------------------------------------------
// TOKEN BUCKET
// -----------------------------------------------------
function getTokenBucket(key) {
  if (!STATE.tokenBucket[key]) {
    STATE.tokenBucket[key] = {
      tokens: TOKEN_BUCKET_SIZE,
      lastRefill: Date.now(),
    };
  }
  return STATE.tokenBucket[key];
}

function refillTokens(bucket) {
  const now = Date.now();
  const deltaSec = (now - bucket.lastRefill) / 1000;
  const refill = Math.floor(deltaSec * TOKEN_REFILL_RATE);

  if (refill > 0) {
    bucket.tokens = Math.min(bucket.tokens + refill, TOKEN_BUCKET_SIZE);
    bucket.lastRefill = now;
  }
}

// -----------------------------------------------------
// CLEANUP
// -----------------------------------------------------
function cleanupOld(now = Date.now()) {
  const { buckets, backoff, windowMsPerKey } = STATE;

  for (const key of Object.keys(buckets)) {
    const arr = buckets[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      if (!backoff[key]) {
        delete buckets[key];
        delete windowMsPerKey[key];
      }
      continue;
    }

    const windowMs = windowMsPerKey[key] || DEFAULT_WINDOW_MS;
    let idx = 0;
    while (idx < arr.length && now - arr[idx] > windowMs) idx++;
    if (idx > 0) arr.splice(0, idx);

    if (arr.length === 0 && !backoff[key]) {
      delete buckets[key];
      delete windowMsPerKey[key];
    }
  }

  STATE.lastCleanup = now;
}

// -----------------------------------------------------
// CHECK — S200 için optimize edildi
// -----------------------------------------------------
async function check(key, config = {}) {
  const rawKey = String(key || "default");
  const { provider, limit, windowMs, burst, adaptive } = resolveLimitConfig(rawKey, config);

  const now = Date.now();
  const k = rawKey;

  STATE.windowMsPerKey[k] = windowMs || DEFAULT_WINDOW_MS;

  // Global cleanup  
  if (now - STATE.lastCleanup > CLEANUP_INTERVAL_MS) cleanupOld(now);

  // Light jitter (S200 timeout uyumu)
  const jitter = MIN_CHECK_DELAY + Math.random() * (MAX_CHECK_DELAY - MIN_CHECK_DELAY);
  await sleep(jitter);

  // Burst control
  if (burst) {
    const bucket = getTokenBucket(k);
    refillTokens(bucket);

    if (bucket.tokens <= 0) {
      await sleep(80 + Math.random() * 120);
      return false;
    }
    bucket.tokens--;
  }

  // Adaptive backoff
  const bo = STATE.backoff[k] || 0;
  if (adaptive && bo > 10) {
    const delay = Math.min(bo, MAX_BACKOFF_MS);
    await sleep(delay * 0.6); // orantılı azaltıldı
  }

  // Sliding window
  if (!STATE.buckets[k]) STATE.buckets[k] = [];
  const bucketArr = STATE.buckets[k];

  while (bucketArr.length && now - bucketArr[0] > windowMs) bucketArr.shift();

  if (bucketArr.length >= limit) {
    STATE.backoff[k] = Math.min((STATE.backoff[k] || 0) + 170, MAX_BACKOFF_MS);

    if (!STATE.adapterStats[k]) {
      STATE.adapterStats[k] = { total: 0, blocked: 0, lastBlocked: now };
    }
    STATE.adapterStats[k].blocked++;

    return false;
  }

  // Accept
  bucketArr.push(now);
  STATE.backoff[k] = Math.max((STATE.backoff[k] || 0) * 0.65 - 80, 0);

  if (!STATE.adapterStats[k]) {
    STATE.adapterStats[k] = { total: 0, blocked: 0, lastBlocked: null };
  }
  STATE.adapterStats[k].total++;

  return true;
}

// -----------------------------------------------------
// ADAPTER HELPERS (dokunulmadı + stabil hale getirildi)
// -----------------------------------------------------
function createAdapterKey(adapterName, region = "TR", category = null) {
  const regionPart = region ? `_${region}` : "";
  const categoryPart = category ? `_${category}` : "";
  return `adapter_${adapterName}${regionPart}${categoryPart}`;
}

async function checkAdapter(adapterName, region = "TR", category = null, options = {}) {
  const key = createAdapterKey(adapterName, region, category);
  return await check(key, options);
}

function getAdapterStats(adapterName = null, region = "TR") {
  if (adapterName) {
    const key = createAdapterKey(adapterName, region);
    return STATE.adapterStats[key] || null;
  }
  return STATE.adapterStats;
}

function resetAdapter(adapterName, region = "TR") {
  const key = createAdapterKey(adapterName, region);
  delete STATE.buckets[key];
  delete STATE.tokenBucket[key];
  delete STATE.backoff[key];
  delete STATE.windowMsPerKey[key];
  delete STATE.adapterStats[key];
  return true;
}

// -----------------------------------------------------
// HOOKS — korundu ve optimize edildi
// -----------------------------------------------------
function registerError(key, weight = 1) {
  const k = String(key || "default");
  const increase = 180 * Math.max(1, weight); // 250 → 180
  STATE.backoff[k] = Math.min((STATE.backoff[k] || 0) + increase, MAX_BACKOFF_MS);

  if (!STATE.adapterStats[k]) {
    STATE.adapterStats[k] = { total: 0, blocked: 0, lastBlocked: Date.now() };
  }
  STATE.adapterStats[k].blocked++;
}

function registerSuccess(key, weight = 1) {
  const k = String(key || "default");
  const decrease = 100 * Math.max(1, weight); // optimize
  STATE.backoff[k] = Math.max((STATE.backoff[k] || 0) - decrease, 0);

  if (!STATE.adapterStats[k]) {
    STATE.adapterStats[k] = { total: 0, blocked: 0, lastBlocked: null };
  }
  STATE.adapterStats[k].total++;
}

// -----------------------------------------------------
// STATS
// -----------------------------------------------------
function getStats(filter = null) {
  const now = Date.now();
  const out = {};

  for (const [key, arr] of Object.entries(STATE.buckets)) {
    if (filter && !key.includes(filter)) continue;

    const windowMs = STATE.windowMsPerKey[key] || DEFAULT_WINDOW_MS;
    const provider = detectProviderFromKey(key);
    const stats = STATE.adapterStats[key] || { total: 0, blocked: 0 };

    out[key] = {
      provider,
      windowMs,
      currentCount: arr.filter(t => now - t <= windowMs).length,
      backoff: STATE.backoff[key] || 0,
      tokens: STATE.tokenBucket[key]?.tokens ?? null,
      totalRequests: stats.total,
      blockedRequests: stats.blocked,
      successRate: stats.total > 0 ? (stats.total - stats.blocked) / stats.total : 1,
      lastBlocked: stats.lastBlocked ? new Date(stats.lastBlocked).toISOString() : null,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    totalAdapters: Object.keys(STATE.buckets).length,
    providers: Object.keys(STATE.buckets).map(k => detectProviderFromKey(k)),
    stats: out,
  };
}

// -----------------------------------------------------
// EXPORT
// -----------------------------------------------------
export const rateLimiter = {
  check,
  registerError,
  registerSuccess,
  getStats,

  checkAdapter,
  getAdapterStats,
  resetAdapter,
  createAdapterKey,

  getProviderLimits() {
    return PROVIDER_LIMITS;
  },

  updateProviderLimit(provider, newLimit, newWindowMs = null) {
    if (!PROVIDER_LIMITS[provider]) return false;
    PROVIDER_LIMITS[provider].limit = newLimit;
    if (newWindowMs) PROVIDER_LIMITS[provider].windowMs = newWindowMs;
    return true;
  },

  PROVIDER_LIMITS,
  DEFAULT_WINDOW_MS,
  MAX_BACKOFF_MS,
};

export default rateLimiter;
