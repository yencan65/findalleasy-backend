// systemCheck.js — lightweight sanity checks for FindAllEasy backend
// Purpose: reviewer-friendly "does this repo look sane?" checks.
// Run: npm run test:system

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function fail(msg) {
  console.error("❌", msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log("✅", msg);
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}

(function main() {
  // Required files
  if (!exists("server.js")) fail("server.js missing");
  else ok("server.js");

  if (!exists("package.json")) fail("package.json missing");
  else ok("package.json");

  if (!exists(".env.example")) {
    console.warn("⚠️ missing .env.example (recommended)");
  } else {
    ok(".env.example");
    const env = read(".env.example");
    if (!/MONGO/i.test(env)) console.warn("⚠️ .env.example does not mention MONGO_ variables");
  }

  // Common foot-guns
  const server = exists("server.js") ? read("server.js") : "";
  if (/const\s+httpServer\s*=\s*\n/.test(server)) {
    fail("server.js contains a broken 'const httpServer =' line (syntax hazard)");
  } else {
    ok("httpServer assignment looks sane");
  }

  // Accidental secrets
  const secretPatterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /GOCSPX-[A-Za-z0-9_-]{10,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /xox[baprs]-[0-9A-Za-z-]{10,}/,
  ];

  // Search a small, safe subset to avoid scanning node_modules
  const scanDirs = ["server", "src", "api", "models", "docs"].filter((d) => exists(d));
  let flagged = false;

  function walk(dir) {
    const abs = path.join(ROOT, dir);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const rel = path.join(dir, e.name);
      const abs2 = path.join(ROOT, rel);
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) {
        // Skip binaries
        if (/\.(png|jpg|jpeg|webp|gif|pdf|zip)$/i.test(e.name)) continue;
        let data = "";
        try { data = fs.readFileSync(abs2, "utf8"); } catch { continue; }
        for (const pat of secretPatterns) {
          if (pat.test(data)) {
            console.warn("⚠️ possible secret pattern in:", rel);
            flagged = true;
            break;
          }
        }
      }
    }
  }

  for (const d of scanDirs) walk(d);
  if (!flagged) ok("no obvious secrets found (basic scan)");

  if (exists(".env")) {
    console.warn("⚠️ .env exists in repo root — make sure it's NOT committed");
  }

  if (process.exitCode) {
    console.log("\nSystem check finished with issues.");
    process.exit(1);
  }

  console.log("\n✅ System check passed.");
})();
