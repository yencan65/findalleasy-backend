import fs from "fs/promises";
import path from "path";

const ROOT = path.resolve("server", "adapters", "groups");

async function walk(dir, out = []) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && p.endsWith(".js")) out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(process.cwd(), p).replaceAll("\\", "/");
}

const files = await walk(ROOT);
const hits = [];

for (const file of files) {
  const txt = await fs.readFile(file, "utf8").catch(() => "");
  if (!txt) continue;
  const lines = txt.split(/\r?\n/);

  lines.forEach((line, i) => {
    const s = line.trim();

    // timeoutMs: 2400
    let m = s.match(/timeoutMs\s*:\s*(\d{3,6})/);
    if (m) hits.push({ file, line: i + 1, ms: Number(m[1]), kind: "timeoutMs", text: s });

    // wrapXxx("key", fn, 2400, ...)
    m = s.match(/wrap\w*\([^)]*,\s*(\d{3,6})\s*,/);
    if (m) hits.push({ file, line: i + 1, ms: Number(m[1]), kind: "wrapArg", text: s });

    // “unknown” izleri (kimlik drift’i buradan çıkar)
    if (/\bunknown\b/i.test(s)) hits.push({ file, line: i + 1, ms: NaN, kind: "unknownWord", text: s });
  });
}

const low = hits.filter((h) => Number.isFinite(h.ms) && h.ms > 0 && h.ms < 3000);
const mid = hits.filter((h) => Number.isFinite(h.ms) && h.ms >= 3000 && h.ms < 6500);
const high = hits.filter((h) => Number.isFinite(h.ms) && h.ms > 15000);
const unknowns = hits.filter((h) => h.kind === "unknownWord");

function print(title, arr, limit = 200) {
  console.log("\n==== " + title + " (" + arr.length + ") ====");
  arr.slice(0, limit).forEach((h) => {
    console.log(`${rel(h.file)}:${h.line}  ${h.kind}${Number.isFinite(h.ms) ? " ms=" + h.ms : ""}  ${h.text}`);
  });
  if (arr.length > limit) console.log("... +" + (arr.length - limit) + " more");
}

print("LOW TIMEOUTS (<3000ms) — FIX THESE FIRST", low);
print("MED TIMEOUTS (3000-6499ms) — OPTIONAL", mid);
print("HIGH TIMEOUTS (>15000ms) — CHECK", high);
print("UNKNOWN WORD HITS — INSPECT FOR IDENTITY DRIFT", unknowns, 120);
