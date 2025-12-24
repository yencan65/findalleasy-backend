// server/tools/placesKeyCheck.mjs
import "dotenv/config";

const key = process.env.GOOGLE_PLACES_KEY || process.env.PLACES_API_KEY || "";
if (!key) {
  console.error("NO_KEY: GOOGLE_PLACES_KEY / PLACES_API_KEY yok");
  process.exit(1);
}

const q = process.argv.slice(2).join(" ") || "otel bodrum";

const url =
  "https://maps.googleapis.com/maps/api/place/textsearch/json?" +
  new URLSearchParams({
    query: q,
    language: "tr",
    region: "tr",
    key,
  }).toString();

const res = await fetch(url);
const json = await res.json().catch(() => ({}));

console.log("HTTP", res.status);
console.log("data.status =", json?.status);
console.log("error_message =", json?.error_message || null);
console.log("results.length =", Array.isArray(json?.results) ? json.results.length : null);

if (json?.status && !["OK", "ZERO_RESULTS"].includes(json.status)) {
  process.exit(2);
}
