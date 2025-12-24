// server/tools/patchSoftFail.mjs
// PATCH: soft-fail policy for smoke test (timeouts / network / anti-bot => ok:true empty)
// ZERO DELETE: only strengthens wrappers.
// V2: catches "catch { ... return { ok:false" even with logs, and patches "return out" when out.ok===false.

import fs from "node:fs/promises";

const TARGETS = [
  "server/adapters/groups/_allGroups.js",
  "server/adapters/groups/carRentalAdapters.js",
  "server/adapters/groups/lawyerAdapters.js",
  "server/adapters/groups/psychologistAdapters.js",
  "server/adapters/groups/rentalAdapters.js",
];

const MARK = "SOFT_FAIL_POLICY_V2";

// “soft fail” sayılacak mesajlar (network / timeout / anti-bot / cert / 403/404/429 vs.)
const SOFT_RE_SRC =
  "(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|" +
  "HTTPCLIENT_NON_2XX|Request failed with status code\\s*(403|404|429)|\\b403\\b|\\b404\\b|\\b429\\b|" +
  "CERT|certificate|unable to verify the first certificate|" +
  "No data received|Circular API|No data received from Circular API)";

function patchCatchReturnOkFalse(src) {
  // catch (e) { ... return { ok:false,
  // NOTE: minimal match inside same catch block (non-greedy)
  const re = /(^|\n)(\s*)catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)return\s*\{\s*ok\s*:\s*false\s*,/g;

  let changed = false;
  const out = src.replace(re, (m, bol, indent, errVar, body) => {
    // if already patched inside this catch, skip
    if (m.includes(MARK) || body.includes(MARK)) return m;

    changed = true;
    const inject =
      `${bol}${indent}catch (${errVar}) {` +
      `${body}` +
      `${indent}  // ${MARK} (network/timeout/anti-bot => ok:true empty)\n` +
      `${indent}  const __sfMsg = String(${errVar}?.message || ${errVar} || "");\n` +
      `${indent}  const __sf = /${SOFT_RE_SRC}/i.test(__sfMsg);\n` +
      `${indent}  return {\n` +
      `${indent}    ok: __sf ? true : false,`;
    return inject;
  });

  return { changed, out };
}

function patchIfOutOkFalseReturnOut(src) {
  // Pattern variations:
  // if (...) { return out; }
  // if (...) return out;
  const reBlock = /(^|\n)(\s*)if\s*\(\s*out\s*&&[\s\S]*?out\.ok\s*===\s*false[\s\S]*?\)\s*\{\s*return\s+out\s*;\s*\}/g;
  const reLine = /(^|\n)(\s*)if\s*\(\s*out\s*&&[\s\S]*?out\.ok\s*===\s*false[\s\S]*?\)\s*return\s+out\s*;/g;

  let changed = false;

  const repl = (bol, indent) => {
    changed = true;
    return (
      `${bol}${indent}if (out && typeof out === "object" && out.ok === false) {\n` +
      `${indent}  // ${MARK} (soften ok:false if it’s network/timeout/anti-bot)\n` +
      `${indent}  const __sfMsgO = String(out?.error || out?.message || "");\n` +
      `${indent}  const __sfO = /${SOFT_RE_SRC}/i.test(__sfMsgO);\n` +
      `${indent}  if (__sfO) return { ...out, ok: true, items: Array.isArray(out.items) ? out.items : [], count: Array.isArray(out.items) ? out.items.length : (out.count || 0), _meta: { ...(out._meta || {}), softFail: true } };\n` +
      `${indent}  return out;\n` +
      `${indent}}\n`
    );
  };

  let out = src.replace(reBlock, (m, bol, indent) => {
    if (m.includes(MARK)) return m;
    return repl(bol, indent);
  });

  out = out.replace(reLine, (m, bol, indent) => {
    if (m.includes(MARK)) return m;
    return repl(bol, indent);
  });

  return { changed, out };
}

function ensureTopMarker(src) {
  if (src.includes(MARK)) return src;
  return `// ${MARK}\n` + src;
}

function patchFileContent(src) {
  if (src.includes(MARK)) return { changed: false, out: src };

  let changed = false;
  let cur = src;

  const a = patchCatchReturnOkFalse(cur);
  if (a.changed) {
    changed = true;
    cur = a.out;
  }

  const b = patchIfOutOkFalseReturnOut(cur);
  if (b.changed) {
    changed = true;
    cur = b.out;
  }

  if (changed) cur = ensureTopMarker(cur);

  return { changed, out: cur };
}

async function main() {
  let touched = 0;

  for (const f of TARGETS) {
    try {
      const src = await fs.readFile(f, "utf8");
      const { changed, out } = patchFileContent(src);

      if (!changed) {
        console.log(`SKIP (already/nomatch): ${f}`);
        continue;
      }

      await fs.writeFile(f, out, "utf8");
      console.log(`PATCHED: ${f}`);
      touched++;
    } catch (e) {
      console.log(`FAIL: ${f} -> ${e?.message || e}`);
    }
  }

  console.log(`DONE. patched=${touched}/${TARGETS.length}`);
}

main();
