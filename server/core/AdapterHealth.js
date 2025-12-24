// server/adapters/core/AdapterHealth.js
const state = new Map(); // name => { ok, fail, lastErrType, disabledUntil }

function now() { return Date.now(); }

export function shouldSkip(adapterName) {
  const s = state.get(adapterName);
  if (!s?.disabledUntil) return false;
  return now() < s.disabledUntil;
}

export function record(adapterName, result) {
  const s = state.get(adapterName) ?? { ok: 0, fail: 0, disabledUntil: 0, lastErrType: null };
  const ok = !!result?.ok;

  if (ok) {
    s.ok++;
    s.lastErrType = null;
    // başarı görünce disable’ı hemen kaldırma; flapping olmasın
  } else {
    s.fail++;
    const status = result?.error?.status;
    const msg = String(result?.error?.message ?? "");
    let errType = "FAIL";

    if (status === 429 || msg.includes("run out of searches") || msg.toLowerCase().includes("quota")) {
      errType = "QUOTA_429";
      s.disabledUntil = now() + 24 * 60 * 60 * 1000; // 24h
    } else if (status === 403) {
      errType = "BLOCK_403";
      s.disabledUntil = Math.max(s.disabledUntil, now() + 30 * 60 * 1000); // 30 dk
    } else if (msg.toLowerCase().includes("timeout") || result?.error?.code === "ECONNABORTED") {
      errType = "TIMEOUT";
      s.disabledUntil = Math.max(s.disabledUntil, now() + 5 * 60 * 1000); // 5 dk
    }

    s.lastErrType = errType;
  }

  state.set(adapterName, s);
}

export function reportTop({ limit = 30 } = {}) {
  const rows = [];
  for (const [name, s] of state.entries()) {
    const total = s.ok + s.fail;
    const sr = total ? (s.ok / total) : 0;
    rows.push({
      name,
      ok: s.ok,
      fail: s.fail,
      successRate: Number((sr * 100).toFixed(1)),
      disabled: shouldSkip(name),
      lastErrType: s.lastErrType,
    });
  }
  rows.sort((a, b) => (b.fail - a.fail) || (a.successRate - b.successRate));
  return rows.slice(0, limit);
}
