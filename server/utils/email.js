// ============================================================================
// FAE EMAIL ENGINE — S113 RELIABLE (AUTO-PROFILE FALLBACK + GMAIL APPPASS SAFE)
//
// Fixes:
//  - Prefer EMAIL_* first (Render env karmaşasında en net set bu)
//  - Port string -> Number() + secure doğru hesap
//  - Gmail App Password kopyalanırken boşluk kalırsa auth patlar -> whitespace strip (gmail host)
//  - verify() fail olunca süreci öldürme -> sonraki profile'a geç
//  - Retry + transient error handling
//
// ZERO-DELETE: export imzaları korunur: sendEmail, sendActivationEmail, sendPasswordResetCode
// ============================================================================

import nodemailer from "nodemailer";

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

const MAIL_DEBUG = pickEnv("MAIL_DEBUG") === "1";
// Default: verify kapalı (bazı ortamlarda false-negative / fallback'i gereksiz kesiyor)
// İstersen MAIL_VERIFY=1 ile aç.
const MAIL_VERIFY = pickEnv("MAIL_VERIFY") === "1";

function boolish(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function isGmailHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "smtp.gmail.com" || h.endsWith(".gmail.com") || h.includes("googlemail");
}

function normalizePass(pass, host) {
  const raw = String(pass || "");
  // App Password çoğu zaman 4'lü gruplar halinde kopyalanır. Gmail'de whitespace'i kırp.
  if (isGmailHost(host)) return raw.replace(/\s+/g, "");
  return raw;
}

function isTransient(err) {
  const code = err?.code || "";
  return ["ETIMEDOUT", "ECONNRESET", "ESOCKET", "EADDRINUSE", "ECONNREFUSED", "EPROTO"].includes(code);
}

function shouldTryNextProfile(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "").toLowerCase();
  // Auth fail → başka credential seti denenebilir
  if (code === "EAUTH") return true;
  if (msg.includes("535") || msg.includes("username") || msg.includes("password")) return true;
  // envelope/from yetkisiz → from/user uyumsuz olabilir
  if (code === "EENVELOPE") return true;
  // TLS/connection problemleri → başka host/port seti denenebilir
  if (isTransient(err)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Profiles: EMAIL_* / SMTP_* / MAIL_* (karışık env'e dayanıklı)
// ---------------------------------------------------------------------------
function buildProfile(prefix) {
  const user =
    prefix === "EMAIL" ? pickEnv("EMAIL_USER") :
    prefix === "SMTP" ? pickEnv("SMTP_USER") :
    pickEnv("MAIL_USER");

  const host =
    (prefix === "EMAIL" ? pickEnv("EMAIL_HOST") :
     prefix === "SMTP" ? pickEnv("SMTP_HOST") :
     pickEnv("MAIL_HOST")) || "smtp.gmail.com";

  const passRaw =
    prefix === "EMAIL" ? pickEnv("EMAIL_PASS") :
    prefix === "SMTP" ? pickEnv("SMTP_PASS") :
    pickEnv("MAIL_PASS");

  const pass = normalizePass(passRaw, host);

  const portRaw =
    prefix === "EMAIL" ? pickEnv("EMAIL_PORT") :
    prefix === "SMTP" ? pickEnv("SMTP_PORT") :
    pickEnv("MAIL_PORT");

  const port = Number(portRaw || 587);

  const secureRaw =
    prefix === "EMAIL" ? pickEnv("EMAIL_SECURE") :
    prefix === "SMTP" ? pickEnv("SMTP_SECURE") :
    pickEnv("MAIL_SECURE");

  const secure = boolish(secureRaw) || port === 465;

  const from = pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

  if (!user || !pass) return null;

  return { prefix, user, pass, host, port, secure, from, fromName, replyTo };
}

// ✅ ÖNEMLİ: Öncelik EMAIL → SMTP → MAIL
const profiles = ["EMAIL", "SMTP", "MAIL"].map(buildProfile).filter(Boolean);

// Mixed profile (her şey karmaysa son çare)
(function addMixed() {
  const host = pickEnv("EMAIL_HOST", "SMTP_HOST", "MAIL_HOST") || "smtp.gmail.com";
  const user = pickEnv("EMAIL_USER", "SMTP_USER", "MAIL_USER");
  const pass = normalizePass(pickEnv("EMAIL_PASS", "SMTP_PASS", "MAIL_PASS"), host);
  if (!user || !pass) return;

  const port = Number(pickEnv("EMAIL_PORT", "SMTP_PORT", "MAIL_PORT") || 587);
  const secure = boolish(pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE")) || port === 465;

  const from = pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

  profiles.push({ prefix: "MIXED", user, pass, host, port, secure, from, fromName, replyTo });
})();

if (profiles.length === 0) {
  throw new Error("MAIL_NOT_CONFIGURED: set EMAIL_USER/EMAIL_PASS (recommended) or SMTP_* / MAIL_*");
}

// ---------------------------------------------------------------------------
// Transporter cache
// ---------------------------------------------------------------------------
let activeIdx = 0;
let transporter = null;

function createTransporter(p) {
  return nodemailer.createTransport({
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },

    pool: true,
    maxConnections: 3,
    maxMessages: 200,
    connectionTimeout: 12_000,
    socketTimeout: 25_000,

    tls: { minVersion: "TLSv1.2" },

    logger: MAIL_DEBUG,
    debug: MAIL_DEBUG,
  });
}

function useProfile(idx) {
  activeIdx = idx;
  transporter = createTransporter(profiles[activeIdx]);

  if (MAIL_DEBUG) {
    const p = profiles[activeIdx];
    console.log("[mail] using profile", {
      prefix: p.prefix,
      host: p.host,
      port: p.port,
      secure: p.secure,
      user: p.user,
      from: p.from,
    });
  }
}

useProfile(0);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function verifyIfEnabled() {
  if (!MAIL_VERIFY) return true;
  try {
    await transporter.verify();
    return true;
  } catch (e) {
    if (MAIL_DEBUG) console.error("[mail] verify failed", e?.code, e?.message || e);
    // verify fail: mail gönderimini burada öldürme — fallback'e izin ver
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Core send (retry + profile fallback)
// ---------------------------------------------------------------------------
async function sendMailCore({ to, subject, text, html }, { attempts = 3 } = {}) {
  const safeSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;

  const makeOptions = (p) => ({
    from: { name: p.fromName, address: p.from },
    to,
    subject: safeSubject,
    text: text || "",
    html: html || (text ? `<p>${text}</p>` : undefined),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
  });

  let lastErr = null;

  for (let pi = 0; pi < profiles.length; pi++) {
    if (pi !== activeIdx) useProfile(pi);

    const p = profiles[activeIdx];
    const mailOptions = makeOptions(p);

    // verify (optional)
    if (MAIL_VERIFY) {
      try {
        await verifyIfEnabled();
      } catch (e) {
        lastErr = e;
        // verify fail → sonraki profile'a geç
        if (pi < profiles.length - 1) continue;
        throw e;
      }
    }

    for (let i = 0; i < attempts; i++) {
      try {
        const info = await transporter.sendMail(mailOptions);
        if (MAIL_DEBUG) console.log("[mail] sent", { prefix: p.prefix, to, messageId: info?.messageId });
        return info;
      } catch (e) {
        lastErr = e;
        if (MAIL_DEBUG) console.error("[mail] send failed", { prefix: p.prefix, code: e?.code, message: e?.message });

        if (shouldTryNextProfile(e)) break; // başka profile

        if (isTransient(e)) {
          await sleep(400 * Math.pow(2, i));
          continue;
        }

        break;
      }
    }
  }

  throw lastErr || new Error("MAIL_SEND_FAILED");
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export async function sendEmail(to, subject, text, html = null) {
  return sendMailCore({ to, subject, text, html }, { attempts: 3 });
}

export async function sendActivationEmail(to, code, username = "") {
  const subject = "FindAllEasy Hesap Aktivasyonu";
  const hello = username ? `<p>Merhaba <b>${username}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Hesabınızı aktifleştirmek için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${code}
      </div>
      <p style="color:#666;font-size:12px;">Bu kod 24 saat geçerlidir.</p>
    </div>
  `;
  return sendEmail(to, subject, `Aktivasyon kodunuz: ${code}`, html);
}

export async function sendPasswordResetCode(to, code, username = "") {
  const subject = "FindAllEasy Şifre Sıfırlama";
  const hello = username ? `<p>Merhaba <b>${username}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Şifre sıfırlamak için gerekli kod:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${code}
      </div>
      <p style="color:#666;font-size:12px;">Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.</p>
    </div>
  `;
  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}
