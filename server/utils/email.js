// server/utils/email.js
// ============================================================================
// FAE EMAIL ENGINE — SINGLE SOURCE (RESEND HTTP API + SMTP FALLBACK) — S121
// - Preferred: RESEND (HTTPS 443) => Render/EC2 SMTP port bloklarını bypass.
// - SMTP fallback: local/dev için.
// - ZERO-BREAK exports: sendEmail, sendActivationEmail, sendPasswordResetCode
// - Diagnostics: getMailHealth
// - Hardened: no crash-on-import + fetch timeout + retry/backoff
// ============================================================================

import nodemailer from "nodemailer";

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function boolish(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function toPort(v, def) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

function isGmailHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "smtp.gmail.com" || h.endsWith(".gmail.com") || h.includes("googlemail");
}

function normalizePass(pass, host) {
  const raw = String(pass || "");
  if (isGmailHost(host)) return raw.replace(/\s+/g, "");
  return raw;
}

function extractEmailAddress(fromValue) {
  const s = String(fromValue || "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

function makeFromString(name, fromValue) {
  const s = String(fromValue || "").trim();
  if (!s) return "";
  if (s.includes("<") && s.includes(">")) return s;
  return `${name} <${s}>`;
}

function isTransient(err) {
  const code = err?.code || "";
  return ["ETIMEDOUT", "ECONNRESET", "ESOCKET", "ECONNREFUSED", "EPROTO"].includes(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------
const MAIL_DEBUG = boolish(pickEnv("MAIL_DEBUG", "EMAIL_DEBUG", "SMTP_DEBUG"));
const MAIL_SANDBOX = boolish(pickEnv("MAIL_SANDBOX", "EMAIL_SANDBOX", "SMTP_SANDBOX"));
const MAIL_PROVIDER = (pickEnv("MAIL_PROVIDER") || "").toLowerCase();

const FROM_NAME = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
const FROM_RAW = pickEnv("MAIL_FROM", "EMAIL_FROM", "FROM_EMAIL", "SMTP_FROM") || "";
const REPLY_TO = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

// ---------------------------------------------------------------------------
// Provider: RESEND (HTTP API) — recommended for Render
// ---------------------------------------------------------------------------
const RESEND_API_KEY = pickEnv("RESEND_API_KEY");

function normalizeRecipients(to) {
  if (Array.isArray(to)) return to.map((x) => String(x).trim()).filter(Boolean);
  const s = String(to || "").trim();
  if (!s) return [];
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

async function resendFetchWithRetry(url, init, { timeoutMs = 12_000, maxAttempts = 4 } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(t);

      // retryable: 408, 429, 5xx
      const retryable = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 599);

      if (!res.ok && retryable && attempt < maxAttempts) {
        const backoff = 400 * Math.pow(2, attempt - 1);
        if (MAIL_DEBUG) console.warn("[mail][resend] retryable status", res.status, "backoff", backoff);
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;

      // network/timeout -> retry
      const retryable = true;
      if (MAIL_DEBUG) console.warn("[mail][resend] fetch error", attempt, String(e?.message || e));

      if (retryable && attempt < maxAttempts) {
        const backoff = 400 * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }

  throw lastErr || new Error("RESEND_FETCH_FAILED");
}

async function sendViaResend({ to, subject, text, html, from, cc, bcc, replyTo }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_NOT_CONFIGURED: set RESEND_API_KEY");

  const toArr = normalizeRecipients(to);
  if (!toArr.length) throw new Error("sendEmail: 'to' is required");

  const subjectStr = String(subject || "").trim();
  if (!subjectStr) throw new Error("sendEmail: 'subject' is required");

  const fromStr = String(from || "").trim();
  if (!fromStr) throw new Error("sendEmail: 'from' is required for Resend (set MAIL_FROM)");

  if (!text && !html) throw new Error("sendEmail: text/html missing");

  const payload = {
    from: fromStr,
    to: toArr,
    subject: subjectStr,
    ...(text ? { text: String(text) } : {}),
    ...(html ? { html: String(html) } : {}),
    ...((replyTo || REPLY_TO) ? { reply_to: String(replyTo || REPLY_TO) } : {}),
    ...(cc ? { cc: normalizeRecipients(cc) } : {}),
    ...(bcc ? { bcc: normalizeRecipients(bcc) } : {}),
  };

  if (MAIL_SANDBOX) {
    console.log("[MAIL_SANDBOX][resend] would send:", payload);
    return { ok: true, sandbox: true, provider: "resend" };
  }

  const r = await resendFetchWithRetry(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    { timeoutMs: 12_000, maxAttempts: 4 }
  );

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`RESEND_SEND_FAILED: ${r.status} ${t.slice(0, 400)}`);
  }

  const data = await r.json().catch(() => ({}));
  if (MAIL_DEBUG) console.log("[mail][resend] sent", { to: payload.to, id: data?.id });
  return { ok: true, provider: "resend", id: data?.id, data };
}

// ---------------------------------------------------------------------------
// Provider: SMTP (fallback for local/dev)
// ---------------------------------------------------------------------------
function buildSmtpProfile(prefix) {
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

  const secure = boolish(secureRaw) || port === 465;

  if (!user || !pass) return null;

  let fromAddress = extractEmailAddress(FROM_RAW) || user;
  const strictFrom = pickEnv("MAIL_STRICT_FROM") !== "0";
  if (isGmailHost(host) && strictFrom && fromAddress.toLowerCase() !== user.toLowerCase()) {
    fromAddress = user;
  }

  return { prefix, user, pass, host, port, secure, fromAddress };
}

const smtpProfiles = ["EMAIL", "SMTP", "MAIL"].map(buildSmtpProfile).filter(Boolean);

function createSmtpTransport(p) {
  return nodemailer.createTransport({
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 20_000,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
    logger: MAIL_DEBUG,
    debug: MAIL_DEBUG,
  });
}

async function sendViaSmtp({ to, subject, text, html, from, replyTo }) {
  if (!smtpProfiles.length) {
    throw new Error("SMTP_NOT_CONFIGURED: set EMAIL_USER/EMAIL_PASS or SMTP_*/MAIL_*");
  }

  const toStr = String(to || "").trim();
  if (!toStr) throw new Error("sendEmail: 'to' is required");

  const subjectStr = String(subject || "").trim();
  if (!subjectStr) throw new Error("sendEmail: 'subject' is required");

  const chosenFrom = String(from || "").trim();
  const fallbackFrom = makeFromString(FROM_NAME, chosenFrom || FROM_RAW || smtpProfiles[0].fromAddress);

  if (MAIL_SANDBOX) {
    console.log("[MAIL_SANDBOX][smtp] would send:", { to: toStr, subject: subjectStr, from: fallbackFrom });
    return { ok: true, sandbox: true, provider: "smtp" };
  }

  let lastErr = null;

  for (const p of smtpProfiles) {
    const transporter = createSmtpTransport(p);

    try {
      const info = await transporter.sendMail({
        from: { name: FROM_NAME, address: extractEmailAddress(fallbackFrom) || p.fromAddress },
        to: toStr,
        subject: subjectStr,
        text: text ? String(text) : "",
        html: html ? String(html) : (text ? `<p>${String(text)}</p>` : undefined),
        ...((replyTo || REPLY_TO) ? { replyTo: String(replyTo || REPLY_TO) } : {}),
      });

      if (MAIL_DEBUG) console.log("[mail][smtp] sent", { prefix: p.prefix, to: toStr, messageId: info?.messageId });
      return { ok: true, provider: "smtp", info };
    } catch (e) {
      lastErr = e;
      console.error("[mail][smtp] send failed (profile fallback)", {
        prefix: p.prefix,
        host: p.host,
        port: p.port,
        secure: p.secure,
        code: e?.code,
        message: e?.message,
      });

      // transient or not: try next profile anyway
      if (!isTransient(e)) {
        // keep going
      }
    }
  }

  throw lastErr || new Error("SMTP_SEND_FAILED");
}

// ---------------------------------------------------------------------------
// Provider select (auto) — LAZY (no crash on import)
// ---------------------------------------------------------------------------
function resolveProvider() {
  if (MAIL_PROVIDER) return MAIL_PROVIDER;
  if (RESEND_API_KEY) return "resend";
  if (smtpProfiles.length) return "smtp";
  return "";
}

// ---------------------------------------------------------------------------
// Core send
// ---------------------------------------------------------------------------
async function sendMailCore({ to, subject, text, html, from, cc, bcc, replyTo }) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      "MAIL_NOT_CONFIGURED: Use RESEND_API_KEY + MAIL_FROM (recommended). " +
      "On Render, SMTP ports are often blocked."
    );
  }

  const fromStr = makeFromString(FROM_NAME, from || FROM_RAW);

  if (provider === "resend") {
    return sendViaResend({ to, subject, text, html, from: fromStr, cc, bcc, replyTo });
  }

  // smtp fallback
  return sendViaSmtp({ to, subject, text, html, from: fromStr, replyTo });
}

// ---------------------------------------------------------------------------
// Public exports (KEEP + EXTEND)
// ---------------------------------------------------------------------------
// Supports both:
//  A) sendEmail(to, subject, text, html?)
//  B) sendEmail({ to, subject, text, html, from, cc, bcc, replyTo })
export async function sendEmail(a, b, c, d = null) {
  const isObj = a && typeof a === "object" && !Array.isArray(a);

  if (isObj) {
    const { to, subject, text, html, from, cc, bcc, replyTo } = a;
    return sendMailCore({ to, subject, text, html, from, cc, bcc, replyTo });
  }

  const to = a;
  const subject = b;
  const text = c;
  const html = d;
  return sendMailCore({ to, subject, text, html });
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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function maskEmail(s) {
  const e = String(s || "");
  const at = e.indexOf("@");
  if (at <= 1) return "***";
  return e[0] + "***" + e.slice(at);
}

export function getMailHealth() {
  const provider = resolveProvider();
  return {
    provider: provider || "none",
    sandbox: MAIL_SANDBOX,
    from: makeFromString(FROM_NAME, FROM_RAW),
    replyTo: REPLY_TO || null,
    resendConfigured: !!RESEND_API_KEY,
    smtpConfigured: smtpProfiles.length > 0,
    smtpProfiles: smtpProfiles.map((p) => ({
      prefix: p.prefix,
      host: p.host,
      port: p.port,
      secure: p.secure,
      user: maskEmail(p.user),
      from: maskEmail(p.fromAddress),
    })),
  };
}
