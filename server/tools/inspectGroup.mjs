// server/tools/inspectGroup.mjs
// Run: node server/tools/inspectGroup.mjs craftAdapters.js
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUPS_DIR = path.resolve(__dirname, "../adapters/groups");

function pickAdaptersExport(mod) {
  if (!mod) return null;
  if (Array.isArray(mod.default)) return mod.default;
  for (const [k, v] of Object.entries(mod)) {
    if (Array.isArray(v) && /adapters$/i.test(k)) return v;
  }
  for (const [, v] of Object.entries(mod)) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

const fname = process.argv[2];
if (!fname) {
  console.log("Usage: node server/tools/inspectGroup.mjs <groupFile.js>");
  process.exit(1);
}

const fp = path.join(GROUPS_DIR, fname);
const url = pathToFileURL(fp).href;

const mod = await import(url);
const adapters = pickAdaptersExport(mod);

if (!Array.isArray(adapters)) {
  console.log("No adapters array export found in:", fname);
  process.exit(2);
}

console.log(`\nGROUP: ${fname} | adapters=${adapters.length}\n`);

adapters.slice(0, 12).forEach((a, i) => {
  const fn = a?.fn;
  const fnName = typeof fn === "function" ? (fn.name || "") : "";
  console.log({
    i,
    name: a?.name,
    provider: a?.provider,
    meta_providerKey: a?.meta?.providerKey,
    meta_provider: a?.meta?.provider,
    meta_name: a?.meta?.name,
    fnName,
    keys: a ? Object.keys(a) : [],
  });
});
