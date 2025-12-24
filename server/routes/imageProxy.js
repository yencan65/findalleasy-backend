// ======================================================================
//  S21 GOD-KERNEL — IMAGE PROXY
//  • ZERO DELETE — S16’daki tüm davranışlar aynen duruyor
//  • Anti-Bypass Whitelist (hostname === exact match / endsWith match)
//  • Anti-Loop + Anti-Chain (self → self → self engeli)
//  • Request Rate Shield (IP bazlı micro RL)
//  • Bandwidth Guard (image size limit 12MB)
//  • Timeout hardening + Crash-proof fallback
//  • UA rotate korunuyor
// ======================================================================

import express from "express";
import axios from "axios";

const router = express.Router();

// ----------------------------------------------------------------------
// 1) WHITELIST — S16 → S21 güçlendirme
//    Artık sadece hostname tam eşleşme veya güvenli suffix kabul edilir
// ----------------------------------------------------------------------
const SAFE_HOSTS = [
  "cdn.dsmcdn.com",
  "productimages.hepsiburada.net",
  "img-trendyol.mncdn.com",
  "n11scdn.akamaized.net",
  "m.media-amazon.com",
  "images-eu.ssl-images-amazon.com",
  "cdn.jsdelivr.net",
  "lh3.googleusercontent.com",
];

// Host doğrulama (S21 anti-bypass)
function isSafeHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();

  // Tam eşleşme
  if (SAFE_HOSTS.includes(h)) return true;

  // Güvenli son ek (örn. subdomain.img-trendyol.mncdn.com)
  return SAFE_HOSTS.some((safe) => h === safe || h.endsWith("." + safe));
}

// ----------------------------------------------------------------------
// 2) UA ROTATION — Aynen korunuyor
// ----------------------------------------------------------------------
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/118 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10) Chrome/122 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
];

function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// ----------------------------------------------------------------------
// 3) HARDENED AXIOS CONFIG
// ----------------------------------------------------------------------
const AXIOS_CONFIG = {
  timeout: 7000,
  responseType: "arraybuffer",
  maxRedirects: 3,
  decompress: true,
  validateStatus: () => true,
  maxContentLength: 12 * 1024 * 1024,   // 12MB limit
  maxBodyLength: 12 * 1024 * 1024,      // 12MB limit
};

// ----------------------------------------------------------------------
// 4) Anti-loop (S16 → S21 genişletilmiş kontrol)
// ----------------------------------------------------------------------
function isProxyLoop(target) {
  if (!target) return false;
  if (target.includes("/api/image-proxy")) return true;
  if (target.includes("/image-proxy")) return true;
  return false;
}

// ----------------------------------------------------------------------
// 5) MIME CHECK — S16 davranışı korunuyor, sadece genişletildi
// ----------------------------------------------------------------------
function isAllowedMime(mime = "") {
  const m = mime.toLowerCase();
  return (
    m.startsWith("image/") ||
    m.includes("jpeg") ||
    m.includes("png") ||
    m.includes("gif") ||
    m.includes("webp")
  );
}

// ----------------------------------------------------------------------
// 6) MICRO RATE LIMIT (S21 — IP başına 25 req / 10 saniye)
// ----------------------------------------------------------------------
const RL = new Map();

function rateLimit(ip, limit = 25, windowMs = 10_000) {
  const now = Date.now();
  const entry = RL.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  RL.set(ip, entry);

  return {
    allowed: entry.count <= limit,
    retry: entry.resetAt - now,
  };
}

function getIP(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    "0.0.0.0"
  );
}

// ======================================================================
//  ROUTE — S21 FINAL
// ======================================================================
router.get("/", async (req, res) => {
  const ip = getIP(req);

  // RATE LIMIT
  const rl = rateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).send("Rate limit exceeded");
  }

  try {
    const target = req.query.url;

    if (!target) return res.status(400).send("Missing url");

    // Anti-loop
    if (isProxyLoop(target)) {
      return res.status(400).send("Proxy loop blocked");
    }

    const parsed = new URL(target);
    const host = parsed.hostname?.toLowerCase();

    // Whitelist control (S21)
    if (!isSafeHost(host)) {
      console.warn("⚠ Unsafe Host Blocked:", host);
      return res.status(403).send("Blocked host");
    }

    // Fetch image
    const response = await axios.get(target, {
      ...AXIOS_CONFIG,
      headers: {
        "User-Agent": randomUA(),
        Accept: "*/*",
        Referer: parsed.origin,
      },
    });

    const mime = response.headers["content-type"] || "";

    if (!isAllowedMime(mime)) {
      console.warn("⚠ Unsupported MIME:", mime);
      return res.status(415).send("Unsupported content-type");
    }

    // SUCCESS — return image
    res.set("Content-Type", mime);
    res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return res.send(response.data);

  } catch (err) {
    console.error("IMG PROXY ERROR (S21):", err?.message);

    // FAILOVER fallback
    const fallback =
      "https://cdn.jsdelivr.net/gh/sonermete/findalleasy-fallbacks/no-image.png";

    try {
      const f = await axios.get(fallback, { responseType: "arraybuffer" });
      res.set("Content-Type", "image/png");
      return res.send(f.data);
    } catch {
      return res.status(500).send("Proxy error");
    }
  }
});

export default router;
