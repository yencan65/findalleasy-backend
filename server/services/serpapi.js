// server/services/serpapi.js
// ============================================================================
// SerpApi tiny client (drift-safe)
// - Env drift: SERPAPI_KEY / SERP_API_KEY / SERPAPI_API_KEY
// - Empty query guard (prevents accidental billing)
// - Timeout-safe when caller doesn't provide an AbortSignal
// ============================================================================

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export async function serpSearch({ q, engine = "google_shopping", gl = "tr", hl = "tr", signal }) {
  const apiKey = pickEnv("SERPAPI_KEY", "SERP_API_KEY", "SERPAPI_API_KEY");
  if (!apiKey) throw new Error("SERPAPI_KEY missing");

  const query = String(q ?? "").trim();
  if (!query) throw new Error("EMPTY_QUERY");

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", String(engine || "google_shopping"));
  url.searchParams.set("q", query);
  url.searchParams.set("gl", String(gl || "tr"));
  url.searchParams.set("hl", String(hl || "tr"));
  url.searchParams.set("api_key", apiKey);
  // IMPORTANT: Do NOT set no_cache=1. We WANT SerpApi's cache.

  // If caller doesn't pass a signal, enforce a reasonable timeout.
  let controller = null;
  let t = null;
  let usedSignal = signal;

  if (!usedSignal && typeof AbortController !== "undefined") {
    controller = new AbortController();
    usedSignal = controller.signal;
    t = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, 12_000);
  }

  try {
    const r = await fetch(url, { method: "GET", signal: usedSignal });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`SerpApi error ${r.status}: ${text.slice(0, 200)}`);
    }
    return r.json();
  } finally {
    if (t) clearTimeout(t);
  }
}
