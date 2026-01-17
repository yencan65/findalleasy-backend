// server/core/costGuards.js
// ============================================================
// COST GUARDS — "masrafsız" modun sigortası
//
// Default davranış:
//   - serpapi.com istekleri BLOK (FAE_ENABLE_SERPAPI=1 değilse)
//
// Amaç:
//   - Yanlışlıkla 4-5 kredi yakacak loop/fallback hatalarını kökten engellemek.
//   - Adapter içinde gate unutulsa bile network seviyesinde fren.
// ============================================================

import "dotenv/config";
import http from "http";
import https from "https";
import { EventEmitter } from "events";

const SERP_ENABLED = String(process.env.FAE_ENABLE_SERPAPI || "").trim() === "1";

function isBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  if (!SERP_ENABLED && (h === "serpapi.com" || h.endsWith(".serpapi.com"))) return true;
  return false;
}

function extractHost(arg0) {
  try {
    if (!arg0) return "";
    if (typeof arg0 === "string") {
      try {
        return new URL(arg0).hostname;
      } catch {
        return "";
      }
    }
    if (arg0 instanceof URL) return arg0.hostname;
    if (typeof arg0 === "object") {
      const host = arg0.hostname || arg0.host || "";
      return String(host).split(":")[0];
    }
    return "";
  } catch {
    return "";
  }
}

function makeBlockedRequest(err) {
  const req = new EventEmitter();
  req.setHeader = () => {};
  req.getHeader = () => undefined;
  req.removeHeader = () => {};
  req.write = () => {};
  req.end = () => {};
  req.abort = () => {};
  req.destroy = () => {};
  process.nextTick(() => req.emit("error", err));
  return req;
}

function wrapRequest(original) {
  return function patchedRequest(...args) {
    const hostname = extractHost(args[0]);
    if (isBlockedHost(hostname)) {
      const err = new Error(
        "PAID_PROVIDER_BLOCKED: serpapi disabled (set FAE_ENABLE_SERPAPI=1 to allow)"
      );
      err.code = "PAID_PROVIDER_BLOCKED";
      return makeBlockedRequest(err);
    }
    return original.apply(this, args);
  };
}

let installed = false;
export function installCostGuards() {
  if (installed) return;
  installed = true;

  http.request = wrapRequest(http.request);
  https.request = wrapRequest(https.request);

  // http.get/https.get internally uses request; keep them as-is
  console.log("✅ CostGuards: serpapi.com blocked by default");
}

installCostGuards();

