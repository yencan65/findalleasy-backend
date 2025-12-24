// ======================================================================
//  S33.9 → S200 FAE QUANTUM-ABSOLUTE CACHE ENGINE (ASYNC-SAFE EDITION)
//  • Tüm adapterEngine S200 pipeline ile %100 uyumlu
//  • get/set artık kesin ASYNC Promise döner
//  • NodeCache clone kapalı → biz deepClone yapıyoruz
//  • Race-condition lock korundu
//  • ZERO DELETE · ZERO DRIFT uyumlu
// ======================================================================

import NodeCache from "node-cache";

// ---------------------------------------------------------------
// RAW CACHE INSTANCE
// ---------------------------------------------------------------
const cache = new NodeCache({
  stdTTL: 60,
  checkperiod: 120,
  useClones: false,
});

// ---------------------------------------------------------------
// CLONE UTIL
// ---------------------------------------------------------------
function deepClone(v) {
  try {
    return typeof structuredClone === "function"
      ? structuredClone(v)
      : JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------
// NORMALIZERS
// ---------------------------------------------------------------
function normalizeKey(key) {
  try {
    if (typeof key === "string") return key;
    if (key == null) return "null";
    return String(key);
  } catch {
    return "invalid-key";
  }
}

function normalizeValue(value) {
  if (value === undefined || value === null) return { _null: true };

  if (value?.then) return { _error: "promise-not-allowed" };

  if (value instanceof Date) return { _date: value.toISOString() };

  if (value instanceof Buffer)
    return { _buffer: value.toString("base64") };

  if (value instanceof Uint8Array)
    return { _buffer: Buffer.from(value).toString("base64") };

  return value;
}

function denormalizeValue(v) {
  if (!v) return null;

  if (v._null) return null;
  if (v._error) return null;

  if (v._date) return new Date(v._date);
  if (v._buffer) return Buffer.from(v._buffer, "base64");

  return v;
}

function safeTTL(ttl) {
  ttl = Number(ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) return 60;
  return Math.min(ttl, 3600);
}

// ---------------------------------------------------------------
// MICRO MUTEX
// ---------------------------------------------------------------
const locks = new Map();

async function withLock(key, fn) {
  const k = normalizeKey(key);

  while (locks.get(k)) {
    await locks.get(k); // başka lock bitene kadar bekle
  }

  let release;
  const lockPromise = new Promise((r) => (release = r));
  locks.set(k, lockPromise);

  try {
    return await fn();
  } finally {
    locks.delete(k);
    release();
  }
}

// ---------------------------------------------------------------
// ASYNC GET — S200 COMPAT
// ---------------------------------------------------------------
export async function getCachedResult(key) {
  const k = normalizeKey(key);
  return withLock(k, () => {
    try {
      const raw = cache.get(k);
      if (raw === undefined) return null;

      return deepClone(denormalizeValue(raw));
    } catch (err) {
      console.error("❌ cache.get ERROR:", err);
      return null;
    }
  });
}

// ---------------------------------------------------------------
// ASYNC SET — S200 COMPAT
// ---------------------------------------------------------------
export async function setCachedResult(key, value, ttl = 60) {
  const k = normalizeKey(key);
  return withLock(k, () => {
    try {
      cache.set(k, normalizeValue(value), safeTTL(ttl));
    } catch (err) {
      console.error("❌ cache.set ERROR:", err);
    }
  });
}

// ---------------------------------------------------------------
// CLEAR
// ---------------------------------------------------------------
export function clearCache() {
  try {
    cache.flushAll();
  } catch (err) {
    console.error("❌ cache.flush ERROR:", err);
  }
}

export default {
  getCachedResult,
  setCachedResult,
  clearCache,
};
