// ============================================================================
// FAE EMAIL ENGINE — S113 RELIABLE (HARDENED, PROFILE FALLBACK, SANDBOX SAFE)
//
// ✅ Keeps exports/signatures:
//   - sendEmail(to, subject, text, html?)
//   - sendActivationEmail(to, code, username?)
//   - sendPasswordResetCode(to, code, username?)
//   - getMailHealth()
//
// Features:
//  - EMAIL_* > SMTP_* > MAIL_* priority
//  - Gmail app-password whitespace killer
//  - Optional verify (MAIL_VERIFY=1)
//  - Optional sandbox (MAIL_SANDBOX=1) OR auto-sandbox when no config
//  - Retry + transient handling + profile fallback
//  - Gmail strict-from guard (MAIL_STRICT_FROM=0 to disable)
//
// ============================================================================

import nodemailer from "nodemailer";

// -------------------- helpers --------------------
function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function boolish(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (!s) return def;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function toPort(v, def = 587) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

function isGmailHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "smtp.gmail.com" || h.endsWith(".gmail.com") || h.includes("googlemail");
}

function normalizePass(pass, host) {
  const raw = String(pass || "");
  // Gmail App Password boşlukla kopyalanırsa auth patlar → whitespace strip
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

  if (code === "EAUTH") return true;
  if (code === "EENVELOPE") return true;
  if (msg.includes("535") || msg.includes("username") || msg.includes("password")) return true;
  if (isTransient(err)) return true;

  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------- flags --------------------
const MAIL_DEBUG = boolish(pickEnv("MAIL_DEBUG", "EMAIL_DEBUG", "SMTP_DEBUG"), false);
const MAIL_VERIFY = boolish(pickEnv("MAIL_VERIFY"), false);
const MAIL_SANDBOX = boolish(pickEnv("MAIL_SANDBOX", "EMAIL_SANDBOX", "SMTP_SANDBOX"), false);
const MAIL_TLS_INSECURE = boolish(pickEnv("MAIL_TLS_INSECURE"), false);
const MAIL_STRICT_FROM = pickEnv("MAIL_STRICT_FROM") !== "0"; // default ON

// global from override (optional)
const GLOBAL_FROM = pickEnv("FROM_EMAIL", "MAIL_FROM", "EMAIL_FROM", "SMTP_FROM");
const GLOBAL_FROM_NAME = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
const GLOBAL_REPLY_TO = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO");

// -------------------- profile builder --------------------
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

  const port = toPort(portRaw, 587);

  const secureRaw =
    prefix === "EMAIL" ? pickEnv("EMAIL_SECURE") :
    prefix === "SMTP" ? pickEnv("SMTP_SECURE") :
    pickEnv("MAIL_SECURE");

  const secure = boolish(secureRaw, port === 465);

  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || GLOBAL_FROM_NAME;
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || GLOBAL_REPLY_TO || "";

  // FROM: global override varsa onu al, yoksa user
  let from = GLOBAL_FROM || pickEnv("EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user || "";

  // Gmail strict-from: FROM != authenticated user olursa Gmail çoğu zaman patlar
  if (MAIL_STRICT_FROM && isGmailHost(host) && user && from && from.toLowerCase() !== user.toLowerCase()) {
    from = user;
  }

  if (!user || !pass) return null;

  return { prefix, user, pass, host, port, secure, from, fromName, replyTo };
}

// Priority: EMAIL → SMTP → MAIL
const profiles = ["EMAIL", "SMTP", "MAIL"].map(buildProfile).filter(Boolean);

// mixed fallback (env karmaysa)
(function addMixed() {
  const host = pickEnv("EMAIL_HOST", "SMTP_HOST", "MAIL_HOST") || "smtp.gmail.com";
  const user = pickEnv("EMAIL_USER", "SMTP_USER", "MAIL_USER");
  const pass = normalizePass(pickEnv("EMAIL_PASS", "SMTP_PASS", "MAIL_PASS"), host);
  if (!user || !pass) return;

  const port = toPort(pickEnv("EMAIL_PORT", "SMTP_PORT", "MAIL_PORT"), 587);
  const secure = boolish(pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE"), port === 465);

  let from = GLOBAL_FROM || pickEnv("EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;
  if (MAIL_STRICT_FROM && isGmailHost(host) && from.toLowerCase() !== user.toLowerCase()) {
    from = user;
  }

  const fromName = GLOBAL_FROM_NAME;
  const replyTo = GLOBAL_REPLY_TO || "";

  profiles.push({ prefix: "MIXED", user, pass, host, port, secure, from, fromName, replyTo });
})();

// -------------------- transporter cache --------------------
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

    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: !MAIL_TLS_INSECURE,
    },

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

function hasConfig() {
  return profiles.length > 0;
}

function sandboxReason() {
  if (MAIL_SANDBOX) return "MAIL_SANDBOX=1";
  if (!hasConfig()) return "NO_MAIL_CONFIG";
  return "";
}

if (hasConfig()) useProfile(0);

// -------------------- verify (optional) --------------------
async function verifyIfEnabled() {
  if (!MAIL_VERIFY) return true;
  await transporter.verify();
  return true;
}

// -------------------- core send --------------------
async function sendMailCore({ to, subject, text, html }, { attempts = 3 } = {}) {
  const _to = String(to || "").trim();
  const _subject = String(subject || "").trim();

  if (!_to) throw new Error("sendEmail: 'to' is required");
  if (!_subject) throw new Error("sendEmail: 'subject' is required");

  const reason = sandboxReason();
  if (reason) {
    console.warn(`[mail] SANDBOX MODE (${reason}) → email not sent`, {
      to: _to,
      subject: _subject,
    });
    return { ok: true, sandbox: true, reason };
  }

  const safeSubject = `=?UTF-8?B?${Buffer.from(_subject).toString("base64")}?=`;

  const makeOptions = (p) => ({
    from: { name: p.fromName, address: p.from },
    to: _to,
    subject: safeSubject,
    text: text ? String(text) : "",
    html: html ? String(html) : (text ? `<pre style="font-family:Arial;white-space:pre-wrap;">${String(text)}</pre>` : undefined),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
  });

  let lastErr = null;

  for (let pi = 0; pi < profiles.length; pi++) {
    if (pi !== activeIdx) useProfile(pi);

    const p = profiles[activeIdx];
    const mailOptions = makeOptions(p);

    // verify is optional (can false-negative in some hosts)
    if (MAIL_VERIFY) {
      try {
        await verifyIfEnabled();
      } catch (e) {
        lastErr = e;
        if (MAIL_DEBUG) console.error("[mail] verify failed", e?.code, e?.message || e);
        if (pi < profiles.length - 1) continue; // next profile
        throw e;
      }
    }

    for (let i = 0; i < attempts; i++) {
      try {
        const info = await transporter.sendMail(mailOptions);
        if (MAIL_DEBUG) console.log("[mail] sent", { prefix: p.prefix, to: _to, messageId: info?.messageId });
        return { ok: true, info };
      } catch (e) {
        lastErr = e;

        if (MAIL_DEBUG) {
          console.error("[mail] send failed", {
            prefix: p.prefix,
            code: e?.code,
            message: e?.message,
          });
        }

        if (shouldTryNextProfile(e)) break; // next profile
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

// -------------------- public exports (SIGNATURES PRESERVED) --------------------
export async function sendEmail(to, subject, text, html = null) {
  const r = await sendMailCore({ to, subject, text, html }, { attempts: 3 });
  return r;
}

export async function sendActivationEmail(to, code, username = "") {
  const subject = "FindAllEasy Hesap Aktivasyonu";
  const hello = username ? `<p>Merhaba <b>${String(username)}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Hesabınızı aktifleştirmek için aşağıdaki kodu kullanın:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${String(code)}
      </div>
      <p style="color:#666;font-size:12px;">Bu kod 24 saat geçerlidir.</p>
    </div>
  `;
  return sendEmail(to, subject, `Aktivasyon kodunuz: ${code}`, html);
}

export async function sendPasswordResetCode(to, code, username = "") {
  const subject = "FindAllEasy Şifre Sıfırlama";
  const hello = username ? `<p>Merhaba <b>${String(username)}</b>,</p>` : "";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      ${hello}
      <p>Şifre sıfırlamak için gerekli kod:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${String(code)}
      </div>
      <p style="color:#666;font-size:12px;">Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.</p>
    </div>
  `;
  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}

// -------------------- diagnostics --------------------
function maskEmail(s) {
  const e = String(s || "");
  const at = e.indexOf("@");
  if (at <= 1) return "***";
  return e[0] + "***" + e.slice(at);
}

export function getMailHealth() {
  const active = hasConfig() ? profiles[activeIdx] : null;
  return {
    configured: hasConfig(),
    sandbox: !!sandboxReason(),
    sandboxReason: sandboxReason() || null,
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
    strictFrom: MAIL_STRICT_FROM,
  };
}
