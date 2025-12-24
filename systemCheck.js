#!/usr/bin/env node
// systemCheck.js — ESM + dotenv + safe API check
import "dotenv/config";

const BASE = process.env.FINDALLEASY_BASE_URL || "http://localhost:8080";

async function main() {
  const payload = { query: "iphone 15", region: "TR", locale: "tr", limit: 10 };
  const r = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  console.log({
    ok: r.ok,
    status: r.status,
    url: r.url,
    body: json ?? text?.slice(0, 600),
  });
}

main().catch((e) => {
  console.error("systemCheck failed:", e?.message || e);
  process.exitCode = 1;
});
