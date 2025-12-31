// ============================================================================
<<<<<<< HEAD
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
=======
// FAE EMAIL ENGINE — S114 RELIABLE (MULTI-PROFILE + SANDBOX + GMAIL SAFE)
// ----------------------------------------------------------------------------
// Goals:
//  - Never crash server at import-time if mail env is missing (routes handle it)
//  - Support Render/Cloudflare env naming chaos: EMAIL_*, MAIL_*, SMTP_*, GMAIL_*
//  - Gmail App Password copy/paste whitespace -> strip
//  - Optional SANDBOX mode for testing without sending real emails
//  - Multi-profile fallback: try next profile if one fails
//
// ZERO-DELETE: export signatures preserved:
//   - sendEmail({ to, subject, text, html, from })
//   - sendActivationEmail(to, code, username)
//   - sendPasswordResetCode(to, code, username)
>>>>>>> 0b88fab (fix: email activation/reset + env fallbacks + sandbox)
// ============================================================================

import nodemailer from "nodemailer";

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
<<<<<<< HEAD
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

  let from = pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  // Gmail SMTP genelde authenticated user ile aynı FROM adresini ister.
  // FROM_EMAIL yanlış set edilirse EENVELOPE/EAUTH tarzı hatalar görürsün.
  const isGmail = host === "smtp.gmail.com" || host.endsWith(".gmail.com") || host.endsWith(".googlemail.com");
  const strictFrom = pickEnv("MAIL_STRICT_FROM") !== "0"; // default ON
  if (isGmail && strictFrom && from.toLowerCase() !== user.toLowerCase()) {
    from = user;
  }
  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

  if (!user || !pass) return null;

  return { prefix, user, pass, host, port, secure, from, fromName, replyTo };
}

// ✅ ÖNEMLİ: Öncelik EMAIL → SMTP → MAIL
// Render'da en stabil kurulum genelde EMAIL_* setidir.
const profiles = ["EMAIL", "SMTP", "MAIL"].map(buildProfile).filter(Boolean);

// Mixed profile (her şey karmaysa son çare)
(function addMixed() {
  const host = pickEnv("EMAIL_HOST", "SMTP_HOST", "MAIL_HOST") || "smtp.gmail.com";
  const user = pickEnv("EMAIL_USER", "SMTP_USER", "MAIL_USER");
  const pass = normalizePass(pickEnv("EMAIL_PASS", "SMTP_PASS", "MAIL_PASS"), host);
  if (!user || !pass) return;

  const port = Number(pickEnv("EMAIL_PORT", "SMTP_PORT", "MAIL_PORT") || 587);
  const secure = boolish(pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE")) || port === 465;

  let from = pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  // Gmail SMTP genelde authenticated user ile aynı FROM adresini ister.
  // FROM_EMAIL yanlış set edilirse EENVELOPE/EAUTH tarzı hatalar görürsün.
  const isGmail = host === "smtp.gmail.com" || host.endsWith(".gmail.com") || host.endsWith(".googlemail.com");
  const strictFrom = pickEnv("MAIL_STRICT_FROM") !== "0"; // default ON
  if (isGmail && strictFrom && from.toLowerCase() !== user.toLowerCase()) {
    from = user;
  }
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
=======
}

function toBool(v, def = false) {
  if (v == null || String(v).trim() === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function toPort(v, def) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

const MAIL_DEBUG = toBool(pickEnv("MAIL_DEBUG", "EMAIL_DEBUG", "SMTP_DEBUG"), false);
const MAIL_SANDBOX = toBool(pickEnv("MAIL_SANDBOX", "EMAIL_SANDBOX", "SMTP_SANDBOX"), false);
const MAIL_TLS_INSECURE = toBool(pickEnv("MAIL_TLS_INSECURE"), false);

const GLOBAL_FROM = pickEnv("MAIL_FROM", "EMAIL_FROM", "SMTP_FROM");

// -----------------------------------------------------------------------------
// Profile builder
// -----------------------------------------------------------------------------
function buildProfile(prefix) {
  const user = pickEnv(
    `${prefix}_USER`,
    `${prefix}_USERNAME`,
    `${prefix}_EMAIL`,
    `${prefix}_ADDRESS`
  );
  const passRaw = pickEnv(
    `${prefix}_PASS`,
    `${prefix}_PASSWORD`,
    `${prefix}_APP_PASS`,
    `${prefix}_APP_PASSWORD`
  );
  const pass = passRaw ? String(passRaw).replace(/\s+/g, "") : ""; // Gmail app-pass whitespace killer

  const host = pickEnv(`${prefix}_HOST`, `${prefix}_SMTP_HOST`);
  const service = pickEnv(`${prefix}_SERVICE`);
  const port = toPort(pickEnv(`${prefix}_PORT`, `${prefix}_SMTP_PORT`), 0);

  // If secure isn't provided, infer from port if possible.
  const secure = toBool(pickEnv(`${prefix}_SECURE`, `${prefix}_SMTP_SECURE`), port === 465);

  const from = pickEnv(`${prefix}_FROM`) || GLOBAL_FROM || user;

  const p = {
    prefix,
    user,
    pass,
    host,
    port,
    secure,
    service,
    from
  };

  // Minimal validity: auth is required (for our use-case)
  if (!p.user || !p.pass) return null;
  return p;
}

function inferGmail(profile) {
  const email = String(profile.user || "").toLowerCase();
  if (profile.service) return profile;
  if (profile.host) return profile;

  // If it's gmail, prefer service or standard host/port.
  if (email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) {
    return {
      ...profile,
      host: "smtp.gmail.com",
      port: profile.port || 465,
      secure: profile.port ? profile.secure : true
    };
  }
  return profile;
}

const RAW_PROFILES = [
  buildProfile("EMAIL"),
  buildProfile("MAIL"),
  buildProfile("SMTP"),
  buildProfile("GMAIL")
].filter(Boolean).map(inferGmail);

// De-dup by signature
const PROFILES = [];
const seen = new Set();
for (const p of RAW_PROFILES) {
  const key = [p.user, p.host, p.port, p.secure, p.service].join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  PROFILES.push(p);
}

class MailConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailConfigError";
    this.code = "MAIL_NOT_CONFIGURED";
  }
}

// Cache transporters (avoid reconnect spam)
const transporterCache = new Map();

function transporterKey(p) {
  return [p.user, p.host, p.port, p.secure, p.service].join("|");
}

function createTransporter(p) {
  const key = transporterKey(p);
  const cached = transporterCache.get(key);
  if (cached) return cached;

  const opts = p.service
    ? {
        service: p.service,
        auth: { user: p.user, pass: p.pass }
      }
    : {
        host: p.host,
        port: p.port || (p.secure ? 465 : 587),
        secure: !!p.secure,
        auth: { user: p.user, pass: p.pass },
        // Default: verify TLS certs. If your host has TLS issues, set MAIL_TLS_INSECURE=1.
        tls: {
          rejectUnauthorized: !MAIL_TLS_INSECURE
        }
      };

  const t = nodemailer.createTransport(opts);
  transporterCache.set(key, t);
  return t;
}

// -----------------------------------------------------------------------------
// Core sender
// -----------------------------------------------------------------------------
async function sendMailCore({ to, subject, text, html, from }) {
  const _to = String(to || "").trim();
  const _subject = String(subject || "").trim();
  if (!_to) throw new Error("sendEmail: 'to' is required");
  if (!_subject) throw new Error("sendEmail: 'subject' is required");

  const payload = {
    to: _to,
    subject: _subject,
    text: text ? String(text) : undefined,
    html: html ? String(html) : undefined
  };

  if (MAIL_SANDBOX) {
    console.log("[MAIL_SANDBOX] sendEmail:", { ...payload, from: from || GLOBAL_FROM || "(auto)" });
    return { ok: true, sandbox: true };
  }

  if (!PROFILES.length) {
    throw new MailConfigError(
      "Mail is not configured. Set EMAIL_USER/EMAIL_PASS (or MAIL_*/SMTP_* envs)."
    );
  }

  let lastErr = null;

  for (const p of PROFILES) {
    const transporter = createTransporter(p);
    const fromFinal = String(from || p.from || GLOBAL_FROM || p.user).trim();

    try {
      if (MAIL_DEBUG) {
        console.log("[MAIL_DEBUG] Trying profile:", {
          prefix: p.prefix,
          user: p.user,
          host: p.host || p.service,
          port: p.port || (p.secure ? 465 : 587),
          secure: !!p.secure
        });
      }

      const info = await transporter.sendMail({
        from: fromFinal,
        to: _to,
        subject: _subject,
        text: payload.text,
        html: payload.html
      });

      if (MAIL_DEBUG) {
        console.log("[MAIL_DEBUG] sendMail OK:", {
          messageId: info?.messageId,
          accepted: info?.accepted,
          rejected: info?.rejected
        });
      }

      return { ok: true, info };
    } catch (err) {
      lastErr = err;
      console.error("[MAIL] sendMail failed (profile fallback):", {
        prefix: p.prefix,
        user: p.user,
        host: p.host || p.service,
        port: p.port || (p.secure ? 465 : 587),
        secure: !!p.secure,
        err: String(err?.message || err)
      });
      // try next profile
    }
  }

  // all failed
  throw lastErr || new Error("sendEmail failed");
}

// -----------------------------------------------------------------------------
// Public API (exports)
// -----------------------------------------------------------------------------
export async function sendEmail({ to, subject, text, html, from }) {
  return sendMailCore({ to, subject, text, html, from });
}

export async function sendActivationEmail(to, code, username = "") {
  const safeName = String(username || "").trim() || "there";
  const subject = "FindAllEasy — Activation Code";
  const text = `Hi ${safeName},\n\nYour activation code is: ${code}\n\nIf you did not request this, ignore this email.\n`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2 style="margin:0 0 12px;">FindAllEasy Activation</h2>
      <p>Hi <b>${safeName}</b>,</p>
      <p>Your activation code is:</p>
      <div style="font-size: 22px; font-weight: 700; letter-spacing: 2px; padding: 10px 14px; border: 1px solid #d4af37; display: inline-block; border-radius: 10px;">
        ${code}
      </div>
      <p style="margin-top:16px;">If you did not request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendMailCore({ to, subject, text, html });
}

export async function sendPasswordResetCode(to, code, username = "") {
  const safeName = String(username || "").trim() || "there";
  const subject = "FindAllEasy — Password Reset Code";
  const text = `Hi ${safeName},\n\nYour password reset code is: ${code}\n\nThis code expires in 15 minutes.\nIf you did not request this, ignore this email.\n`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <h2 style="margin:0 0 12px;">FindAllEasy Password Reset</h2>
      <p>Hi <b>${safeName}</b>,</p>
      <p>Your password reset code is:</p>
      <div style="font-size: 22px; font-weight: 700; letter-spacing: 2px; padding: 10px 14px; border: 1px solid #d4af37; display: inline-block; border-radius: 10px;">
        ${code}
      </div>
      <p style="margin-top:16px;">This code expires in <b>15 minutes</b>.</p>
      <p>If you did not request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendMailCore({ to, subject, text, html });
>>>>>>> 0b88fab (fix: email activation/reset + env fallbacks + sandbox)
}

// ---------------------------------------------------------------------------
// Diagnostics helpers (safe to expose ONLY behind a token)
// ---------------------------------------------------------------------------
function maskEmail(s) {
  const e = String(s || "");
  const at = e.indexOf("@");
  if (at <= 1) return "***";
  return e[0] + "***" + e.slice(at);
}

export function getMailHealth() {
  const active = profiles[activeIdx];
  return {
    active: active
      ? {
          prefix: active.prefix,
          host: active.host,
          port: active.port,
          secure: active.secure,
          from: active.from,
          user: maskEmail(active.user),
        }
      : null,
    profiles: profiles.map((p) => ({
      prefix: p.prefix,
      host: p.host,
      port: p.port,
      secure: p.secure,
      from: p.from,
      user: maskEmail(p.user),
    })),
    verifyEnabled: MAIL_VERIFY,
    debugEnabled: MAIL_DEBUG,
  };
}
