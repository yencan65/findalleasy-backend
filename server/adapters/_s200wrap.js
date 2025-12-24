// server/adapters/_s200wrap.js
// ===============================================================
// FindAllEasy — S200 UNIVERSAL WRAP (timeout + zero-crash) — FINAL
// - Hem "yeni" imza hem "legacy" imzayı destekler.
//   NEW:    wrapS200(adapterKey, providerKey, runFn, timeoutMs, groupKey)
//   LEGACY: wrapS200(name, runnerFn, timeoutMs)
//
// S200 STANDARD (LOCKED):
// ✅ Output tek format: { ok, items, count, source, _meta }
// ✅ Observable fail: timeout / crash / wiring mismatch => ok:false + items:[]
// ✅ ZERO DELETE: signature + export korunur, sadece güçlendirme
// ===============================================================

function safeStr(v) {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

function asTimeoutMs(v, fallback = 5000) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 50) return Math.floor(n);
  return fallback;
}

function pickItems(out) {
  if (Array.isArray(out)) return out;
  if (out && typeof out === "object" && Array.isArray(out.items)) return out.items;
  if (out && typeof out === "object" && Array.isArray(out.results)) return out.results;
  if (out && typeof out === "object" && Array.isArray(out.data)) return out.data;
  return [];
}

function isObj(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function nowMs() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function packS200({ ok, items, source, _meta, count }) {
  const it = Array.isArray(items) ? items : [];
  const src = safeStr(source) || "unknown";
  const meta = isObj(_meta) ? _meta : {};
  const c = Number.isFinite(Number(count)) ? Number(count) : it.length;

  return { ok: !!ok, items: it, count: c, source: src, _meta: meta };
}

function failS200({ providerKey, adapterKey, groupKey, code, err, tookMs, timeoutMs }) {
  const msg = safeStr(err?.message || err) || "unknown error";
  return packS200({
    ok: false,
    items: [],
    count: 0,
    source: providerKey || "unknown",
    _meta: {
      code: safeStr(code) || "FAIL",
      error: msg,
      providerKey: providerKey || "unknown",
      adapterKey: adapterKey || "unknown",
      group: groupKey || null,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      tookMs: Number.isFinite(tookMs) ? tookMs : undefined,
    },
  });
}

function setGlobalCtx(providerKey, adapterKey, groupKey, url, query, startedAt) {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey: providerKey || "unknown",
      provider: providerKey || "unknown",
      adapter: adapterKey || providerKey || "unknown",
      adapterKey: adapterKey || providerKey || "unknown",
      group: groupKey || null,
      url: safeStr(url || ""),
      query: safeStr(query || ""),
      at: `server/adapters/_s200wrap.js:${safeStr(adapterKey || providerKey || "unknown")}`,
      _meta: {
        startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
      },
    };
  } catch {}
}

/**
 * wrapS200 — universal wrapper
 * NEW signature:
 *   wrapS200(adapterKey, providerKey, runFn, timeoutMs, groupKey)
 * LEGACY signature:
 *   wrapS200(name, runnerFn, timeoutMs)
 */
export function wrapS200(a, b, c, d, e) {
  let adapterKey = "unknown";
  let providerKey = "unknown";
  let runFn = null;
  let timeoutMs = 5000;
  let groupKey = null;

  // LEGACY: (name, runnerFn, timeoutMs)
  if (typeof b === "function") {
    adapterKey = safeStr(a) || "unknown";
    providerKey = adapterKey;
    runFn = b;
    timeoutMs = asTimeoutMs(c, 5000);
    groupKey = null;
  } else {
    // NEW: (adapterKey, providerKey, runFn, timeoutMs, groupKey)
    adapterKey = safeStr(a) || "unknown";
    providerKey = safeStr(b) || adapterKey || "unknown";
    runFn = typeof c === "function" ? c : null;
    timeoutMs = asTimeoutMs(d, 5000);
    groupKey = safeStr(e) || null;
  }

  // wiring mismatch => crash yok, observable fail
  if (typeof runFn !== "function") {
    const bad = async (_query, _opts = {}) =>
      failS200({
        providerKey,
        adapterKey,
        groupKey,
        code: "WIRING_MISMATCH",
        err: "wrapS200: runFn is not a function (wiring mismatch)",
        tookMs: 0,
        timeoutMs,
      });

    bad.__adapterKey = adapterKey;
    bad.__providerKey = providerKey;
    bad.__groupKey = groupKey;
    return bad;
  }

  const run = async (query, opts = {}) => {
    const startedAt = nowMs();

    // kit log "unknown" olmasın: global ctx set
    setGlobalCtx(providerKey, adapterKey, groupKey, opts?.url || opts?.requestUrl || "", query, startedAt);

    try {
      const job = Promise.resolve().then(() => runFn(query, opts));

      let __timer = null;
      const timeout = new Promise((resolve) => {
        __timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
      });

      const out = await Promise.race([job, timeout]);

      // clear timer (avoid timer leaks under load)
      try { if (__timer) clearTimeout(__timer); } catch {}

      // timeout => strict observable fail
      if (out && typeof out === "object" && out.__timeout) {
        return failS200({
          providerKey,
          adapterKey,
          groupKey,
          code: "TIMEOUT",
          err: `timeout (${timeoutMs}ms)`,
          tookMs: nowMs() - startedAt,
          timeoutMs,
        });
      }

      const baseObj = isObj(out) ? out : {};
      const items = pickItems(out);

      // Eğer adapter zaten S200 döndürüyorsa: repack + meta enrich (drift yok)
      if ("ok" in baseObj && "source" in baseObj && Array.isArray(baseObj.items)) {
        const existingMeta = isObj(baseObj._meta) ? baseObj._meta : {};
        return packS200({
          ok: !!baseObj.ok,
          items: baseObj.items,
          count: baseObj.count,
          source: safeStr(baseObj.source) || providerKey,
          _meta: {
            ...existingMeta,
            wrappedBy: "_s200wrap",
            providerKey,
            adapterKey,
            group: safeStr(existingMeta.group) || groupKey || null,
            tookMs: nowMs() - startedAt,
          },
        });
      }

      const ok = "ok" in baseObj ? !!baseObj.ok : true;

      const mergedMeta = isObj(baseObj._meta)
        ? baseObj._meta
        : isObj(baseObj.meta)
        ? baseObj.meta
        : {};

      const err =
        safeStr(baseObj.error) ||
        safeStr(baseObj.err) ||
        safeStr(mergedMeta?.error) ||
        "";

      return packS200({
        ok,
        items,
        count: baseObj.count,
        source: safeStr(baseObj.source) || providerKey,
        _meta: {
          ...(isObj(mergedMeta) ? mergedMeta : {}),
          ...(err ? { error: err } : {}),
          wrappedBy: "_s200wrap",
          providerKey,
          adapterKey,
          group: safeStr(baseObj.group) || groupKey || null,
          tookMs: nowMs() - startedAt,
          timeoutMs,
        },
      });
    } catch (e) {
      return failS200({
        providerKey,
        adapterKey,
        groupKey,
        code: "CRASH",
        err: e,
        tookMs: nowMs() - startedAt,
        timeoutMs,
      });
    }
  };

  run.__adapterKey = adapterKey;
  run.__providerKey = providerKey;
  run.__groupKey = groupKey;

  return run;
}
