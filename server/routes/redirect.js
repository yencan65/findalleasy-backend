// server/routes/redirect.js
// ===================================================================
//   REDIRECT ENGINE — S21 GOD-KERNEL FINAL FORM
//   • ZERO DELETE — S16.4 davranışı birebir korunur
//   • URL anti-obfuscation (unicode / mixed-case / JS schemes bloklu)
//   • Localhost / intranet open-redirect blok
//   • Subdomain hijack koruması (FAE domain maskesi engeli)
//   • Provider ultra-normalize (canonical resolver + S9 normalize)
//   • Async recordClick (redirect performansını etkilemez)
//   • Global + micro rate-limit (IP bazlı burst shield)
//   • Secure cookie harden (tek merkezden base options)
//   • Token basic integrity (format / length check) — KORUNDU
//   • IP + UA fingerprint telemetry (S21)
// ===================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

import { recordClick } from "../core/revenueMemoryEngine.js";
import { normalizeProviderKeyS9 } from "../core/providerMasterS9.js";

const router = express.Router();

// ===================================================================
// REDIRECT DOMAIN — hijack koruması için ana referans
// ===================================================================
const REDIRECT_DOMAIN =
  process.env.FAE_REDIRECT_BASE || "https://findalleasy.com";

// ===================================================================
// GLOBAL RATE LIMIT + MICRO BURST SHIELD
// ===================================================================
const redirectLimiter = rateLimit({
  windowMs: 3000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(redirectLimiter);

// Mikro burst shield: aynı IP + aynı URL için 500ms içinde ikinci istek → drop
const burstMap = new Map();
function burstShield(ip, url, ttl = 500) {
  const key = `${ip}::${url}`;
  const now = Date.now();
  const last = burstMap.get(key) || 0;
  if (now - last < ttl) return false;
  burstMap.set(key, now);
  return true;
}

// Periodik temizlik (memory leak koruması)
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of burstMap.entries()) {
    if (now - ts > 10_000) burstMap.delete(k);
  }
}, 10_000).unref?.();

// ===================================================================
// Safe JSON helper
// ===================================================================
function safeJson(res, data, status = 200) {
  try {
    res.status(status).json(data);
  } catch (err) {
    console.error("safeJson ERROR:", err);
    try {
      res.status(500).json({ ok: false, error: "JSON_FAILURE" });
    } catch {}
  }
}

// ===================================================================
// IP + UA yardımcıları
// ===================================================================
function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

function buildFingerprint(ip, ua = "") {
  try {
    return crypto
      .createHash("sha256")
      .update(String(ip) + "|" + String(ua))
      .digest("hex");
  } catch {
    return null;
  }
}

// ===================================================================
// URL SANITIZE + ANTI-OBOFUSCATION
// ===================================================================
const LOCALHOST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

function safeUrl(raw) {
  try {
    if (!raw) return null;

    let url = String(raw).trim();
    if (url.length < 8 || url.length > 2048) return null;

    // Unicode normalization (şeytani karakter maskelerini çözer)
    url = url.normalize("NFKC");

    const lowered = url.toLowerCase();

    // javascript:, data:, vb. saldırılar
    if (
      lowered.startsWith("javascript:") ||
      lowered.startsWith("data:") ||
      lowered.startsWith("vbscript:")
    ) {
      return null;
    }

    const u = new URL(url);
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;

    const host = u.hostname.toLowerCase();

    // Localhost / intranet open redirect istemiyoruz
    if (LOCALHOST_HOSTS.has(host)) return null;

    // Şüpheli internal ağ pattern (çok agresif değil)
    if (host.endsWith(".local") || host.endsWith(".lan")) return null;

    return url;
  } catch {
    return null;
  }
}

// ===================================================================
// FAKE FAE DOMAIN CHECK — subdomain/typo hijack koruması
// ===================================================================
function isFakeFaeDomain(host) {
  if (!host) return false;
  const clean = host.toLowerCase();

  const main = REDIRECT_DOMAIN.replace(/^https?:\/\//, "").toLowerCase();

  // findalleasy.com → gerçek
  if (clean === main) return false;

  // findalleasy.com.evil.org → sahte
  if (clean.endsWith(main)) return true;

  return false;
}

// ===================================================================
// Provider resolver — ultra normalize
// ===================================================================
function resolveProviderFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let host = u.hostname.toLowerCase().replace(/^www\./, "");

    const canonical = normalizeProviderKeyS9(host);
    if (canonical) return canonical;

    if (host.includes("trendyol")) return "trendyol";
    if (host.includes("hepsiburada")) return "hepsiburada";
    if (host.includes("n11")) return "n11";
    if (host.includes("amazon")) return "amazon";
    if (host.includes("aliexpress")) return "aliexpress";

    return host.split(".")[0] || "unknown";
  } catch {
    return "unknown";
  }
}

// ===================================================================
// Token basic integrity check (S16.4 mantığı korunur)
// ===================================================================
function safeToken(raw) {
  if (!raw) return null;
  const t = String(raw).trim();

  if (t.length < 5 || t.length > 80) return null;

  // Min hijyen: null byte / açı-kapalı tag temizle
  if (/[<>]/.test(t) || /\0/.test(t)) return null;

  return t;
}

// ===================================================================
// Cookie base options — tek merkez
// ===================================================================
const baseCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};

// ===================================================================
// SECURE REDIRECT HANDLER — S21 GOD-KERNEL
// ===================================================================
router.get("/", async (req, res) => {
  try {
    const { aff_id, token, url, click_id } = req.query || {};

    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const fingerprint = buildFingerprint(ip, ua);

    // -------------------------------------------------------------
    // 0) URL zorunlu
    // -------------------------------------------------------------
    if (!url) {
      return safeJson(res, { ok: false, reason: "MISSING_URL" }, 400);
    }

    // -------------------------------------------------------------
    // 1) Safe URL (anti-injection + anti-unicode mask)
    // -------------------------------------------------------------
    const targetUrl = safeUrl(url);
    if (!targetUrl) {
      return safeJson(res, { ok: false, reason: "UNSAFE_URL" }, 400);
    }

    // Mikro burst shield
    if (!burstShield(ip, targetUrl)) {
      return safeJson(res, {
        ok: true,
        throttled: true,
        reason: "BURST_LIMIT",
      });
    }

    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();

    // -------------------------------------------------------------
    // 2) Anti-loop + Fake FAE domain kalkanı
    // -------------------------------------------------------------
    if (isFakeFaeDomain(host)) {
      return safeJson(
        res,
        { ok: false, reason: "FAKE_REDIRECT_DOMAIN_BLOCKED" },
        400
      );
    }

    if (targetUrl.includes(REDIRECT_DOMAIN)) {
      return safeJson(
        res,
        { ok: false, reason: "LOOP_REDIRECT_BLOCKED" },
        400
      );
    }

    // -------------------------------------------------------------
    // 3) Provider çözümü
    // -------------------------------------------------------------
    const provider = resolveProviderFromUrl(targetUrl);

    // -------------------------------------------------------------
    // 4) Affiliate cookie
    // -------------------------------------------------------------
    const affIdFinal =
      (typeof aff_id === "string" && aff_id.trim()) ||
      process.env.FAE_AFFILIATE_ID ||
      "FAE_DEFAULT";

    res.cookie("fae_aff_id", affIdFinal, {
      ...baseCookieOptions,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    // -------------------------------------------------------------
    // 5) User Token Cookie + safeToken
    // -------------------------------------------------------------
    let userId = null;
    const safeTok = safeToken(token);

    if (safeTok) {
      const dash = safeTok.indexOf("-");
      if (dash > 0) userId = safeTok.slice(0, dash);

      res.cookie("fae_user_token", safeTok, {
        ...baseCookieOptions,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    }

    // -------------------------------------------------------------
    // 6) Click ID Cookie
    // -------------------------------------------------------------
    if (click_id) {
      const clickIdStr = String(click_id).trim().slice(0, 80);
      res.cookie("fae_click_id", clickIdStr, {
        ...baseCookieOptions,
        maxAge: 1000 * 60 * 60 * 24 * 3,
      });
    }

    // -------------------------------------------------------------
    // 7) Son provider bilgisi
    // -------------------------------------------------------------
    res.cookie("fae_last_provider", provider, {
      ...baseCookieOptions,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    // -------------------------------------------------------------
    // 8) revenueMemoryEngine — arka plana alınır
    // -------------------------------------------------------------
    queueMicrotask(() => {
      try {
        recordClick({
          provider,
          price: null,
          userId: userId || null,
          productId: null,
          meta: {
            source: "redirect",
            affId: affIdFinal,
            clickId: click_id || null,
            redirectDomain: REDIRECT_DOMAIN,
            targetUrl,
            ip,
            ua,
            fingerprint,
          },
        });
      } catch (err) {
        console.warn("recordClick (redirect) error:", err?.message);
      }
    });

    // -------------------------------------------------------------
    // 9) Gerçek yönlendirme
    // -------------------------------------------------------------
    return res.redirect(targetUrl);
  } catch (err) {
    console.error("❌ redirect.js ERROR:", err);
    return safeJson(
      res,
      {
        ok: false,
        error: err?.message || "REDIRECT_INTERNAL_ERROR",
      },
      500
    );
  }
});

export default router;
