// server/services/serpapi.js
export async function serpSearch({ q, engine = "google_shopping", gl = "tr", hl = "tr" }) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("SERPAPI_KEY missing");

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", engine);
  url.searchParams.set("q", q);
  url.searchParams.set("gl", gl);
  url.searchParams.set("hl", hl);
  url.searchParams.set("api_key", apiKey);

  const r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`SerpApi error ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}
