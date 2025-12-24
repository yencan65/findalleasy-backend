import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This script lives in: server/tools/
// So ROOT is: server/
const ROOT = path.resolve(__dirname, "..");

const TARGET_DIRS = [
  path.join(ROOT, "adapters"),
  path.join(ROOT, "adapters", "groups"),
];

const KIT_PATH = path.join(ROOT, "core", "s200AdapterKit.js");

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);

    // skip junk
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist" || ent.name === "build")
        continue;
      out.push(...walk(p));
      continue;
    }

    if (/\.(m?js|cjs)$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function relImportPath(fromFile) {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, KIT_PATH).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function injectOrExtendKitImport(content, importPath) {
  // If there's already an import from the kit path, extend it.
  const kitImportRe = new RegExp(
    String.raw`^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*["']` +
      importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      String.raw`["']\s*;\s*$`,
    "m"
  );

  const m = content.match(kitImportRe);
  if (m) {
    const inside = m[1];
    if (/\bloadCheerioS200\b/.test(inside)) return content; // already there
    const updated = inside.trim().length ? `${inside.trim()}, loadCheerioS200` : "loadCheerioS200";
    return content.replace(kitImportRe, (line) => line.replace(inside, updated));
  }

  // Otherwise, add a new import line (after last import).
  const importLine = `import { loadCheerioS200 } from "${importPath}";\n`;
  if (content.includes(importLine)) return content;

  const importRegex = /(^\s*import[\s\S]*?;\s*$)/gm;
  let last = null;
  for (const mm of content.matchAll(importRegex)) last = mm;

  if (last) {
    const idx = last.index + last[0].length;
    return content.slice(0, idx) + "\n" + importLine + content.slice(idx);
  }

  return importLine + "\n" + content;
}

function patchFile(file) {
  let content = fs.readFileSync(file, "utf8");

  // Patch only if it actually contains cheerio.load(...)
  if (!/\bcheerio\.load\s*\(/.test(content)) return false;

  const importPath = relImportPath(file);
  content = injectOrExtendKitImport(content, importPath);

  // Replace cheerio.load( -> loadCheerioS200(
  content = content.replace(/\bcheerio\.load\s*\(/g, "loadCheerioS200(");

  fs.writeFileSync(file, content, "utf8");
  return true;
}

const files = TARGET_DIRS.flatMap((d) => walk(d));

let patched = 0;
for (const f of files) {
  try {
    if (patchFile(f)) {
      patched++;
      console.log("patched:", path.relative(ROOT, f).replace(/\\/g, "/"));
    }
  } catch (e) {
    console.warn("skip:", path.relative(ROOT, f).replace(/\\/g, "/"), "=>", e?.message || e);
  }
}

console.log(`done. patched=${patched}`);
