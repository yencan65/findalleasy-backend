// Simple in-memory TTL cache (single-instance). Good enough for Render unless you scale.
// Usage:
//   const cache = require('./memCache')({ defaultTtlMs: 60000 });
//   const hit = cache.get(key);
//   cache.set(key, value, 120000);

module.exports = function createMemCache(opts = {}) {
  const defaultTtlMs = Number(opts.defaultTtlMs || 60_000);
  const store = new Map();

  function get(key) {
    const v = store.get(key);
    if (!v) return null;
    if (Date.now() > v.exp) {
      store.delete(key);
      return null;
    }
    return v.val;
  }

  function set(key, val, ttlMs) {
    const ttl = Number(ttlMs || defaultTtlMs);
    store.set(key, { exp: Date.now() + ttl, val });
  }

  function del(key) {
    store.delete(key);
  }

  function clear() {
    store.clear();
  }

  return { get, set, del, clear };
};
