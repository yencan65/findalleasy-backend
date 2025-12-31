// ============================================================================
// FAE EMAIL ENGINE — S112 RELIABLE (AUTO-PROFILE FALLBACK)
// Goal: Aktivasyon & Şifre Sıfırlama mailleri "bazen geliyor" seviyesinden
//       "tutarlı" seviyeye çekmek.
//
// What this fixes (production-real problems):
//  - Render ENV'te aynı anda EMAIL_ / SMTP_ / MAIL_ setleri var → yanlış set seçilirse mail patlar
//  - Port string gelince secure hatası ( "465" !== 465 ) → Number()
//  - Önceki sürüm bazı durumlarda hatayı yutuyordu → retry + en sonda throw
//  - SMTP stabilitesi: pool + timeouts
//  - Eğer bir set EAUTH verirse (yanlış app password / yanlış env), otomatik diğer sete dener
//
// ZERO-DELETE: Export imzaları korunur: sendEmail, sendActivationEmail, sendPasswordResetCode
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
// Bazı SMTP'ler verify() çağrısını sevmez. Default ON; MAIL_VERIFY=0 ile kapat.
const MAIL_VERIFY = pickEnv("MAIL_VERIFY") !== "0";

function boolish(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ---------------------------------------------------------------------------
// Profiles: EMAIL_* / SMTP_* / MAIL_* (karışık env'e dayanıklı)
// ---------------------------------------------------------------------------
function buildProfile(prefix) {
  const user =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_USER")
      : prefix === "SMTP"
      ? pickEnv("SMTP_USER")
      : pickEnv("MAIL_USER");

  const pass =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_PASS")
      : prefix === "SMTP"
      ? pickEnv("SMTP_PASS")
      : pickEnv("MAIL_PASS");

  const host =
    (prefix === "EMAIL"
      ? pickEnv("EMAIL_HOST")
      : prefix === "SMTP"
      ? pickEnv("SMTP_HOST")
      : pickEnv("MAIL_HOST")) || "smtp.gmail.com";

  const portRaw =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_PORT")
      : prefix === "SMTP"
      ? pickEnv("SMTP_PORT")
      : pickEnv("MAIL_PORT");

  const port = Number(portRaw || 587);

  const secureRaw =
    prefix === "EMAIL"
      ? pickEnv("EMAIL_SECURE")
      : prefix === "SMTP"
      ? pickEnv("SMTP_SECURE")
      : pickEnv("MAIL_SECURE");

  const secure = boolish(secureRaw) || port === 465;

  const from =
    // En yaygın: FROM_EMAIL / EMAIL_FROM / SMTP_FROM / MAIL_FROM
    pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;

  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

  if (!user || !pass) return null;

  return { prefix, user, pass, host, port, secure, from, fromName, replyTo };
}

const profiles = ["SMTP", "MAIL", "EMAIL"] // öncelik: SMTP > MAIL > EMAIL (Render karmaşasını toparlar)
  .map(buildProfile)
  .filter(Boolean);

// Eğer ayrıca mixed isimlerle set edilmişse (senin env'inde var): EMAIL_ ama MAIL_ de var
// Hepsini denemek için "multi-name" profile ekleyelim.
(function addMultiNameProfile() {
  const user = pickEnv("EMAIL_USER", "SMTP_USER", "MAIL_USER");
  const pass = pickEnv("EMAIL_PASS", "SMTP_PASS", "MAIL_PASS");
  if (!user || !pass) return;

  const host = pickEnv("EMAIL_HOST", "SMTP_HOST", "MAIL_HOST") || "smtp.gmail.com";
  const port = Number(pickEnv("EMAIL_PORT", "SMTP_PORT", "MAIL_PORT") || 587);

  const secure =
    boolish(pickEnv("EMAIL_SECURE", "SMTP_SECURE", "MAIL_SECURE")) || port === 465;

  const from =
    pickEnv("FROM_EMAIL", "EMAIL_FROM", "SMTP_FROM", "MAIL_FROM") || user;

  const fromName = pickEnv("EMAIL_FROM_NAME", "MAIL_FROM_NAME", "FROM_NAME") || "FindAllEasy";
  const replyTo = pickEnv("EMAIL_REPLY_TO", "MAIL_REPLY_TO") || "";

  // multi profile en sona
  profiles.push({ prefix: "MIXED", user, pass, host, port, secure, from, fromName, replyTo });
})();

if (profiles.length === 0) {
  // Fail fast: env yok → route'lar 500 ile doğru hata döndürsün
  throw new Error("MAIL_NOT_CONFIGURED: set EMAIL_* or SMTP_* or MAIL_* envs (USER/PASS)");
}

// ---------------------------------------------------------------------------
// Transporter cache (aktif profile)
// ---------------------------------------------------------------------------
let activeIdx = 0;
let transporter = null;
let verifiedOnce = false;
let verifyPromise = null;

function createTransporter(p) {
  const tx = nodemailer.createTransport({
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },

    // Stabilite
    pool: true,
    maxConnections: 3,
    maxMessages: 200,
    connectionTimeout: 12_000,
    socketTimeout: 25_000,

    tls: { minVersion: "TLSv1.2" },

    logger: MAIL_DEBUG,
    debug: MAIL_DEBUG,
  });

  return tx;
}

function useProfile(idx) {
  activeIdx = idx;
  transporter = createTransporter(profiles[activeIdx]);
  verifiedOnce = false;
  verifyPromise = null;

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

async function verifyTransporterOnce() {
  if (verifiedOnce) return true;
  if (verifyPromise) return verifyPromise;

  verifyPromise = transporter
    .verify()
    .then(() => {
      verifiedOnce = true;
      if (MAIL_DEBUG) {
        const p = profiles[activeIdx];
        console.log("[mail] transporter verified", {
          prefix: p.prefix,
          host: p.host,
          port: p.port,
          secure: p.secure,
          from: p.from,
        });
      }
      return true;
    })
    .catch((e) => {
      if (MAIL_DEBUG) console.error("[mail] transporter verify failed", e?.code, e?.message || e);
      throw e;
    });

  return verifyPromise;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldTryNextProfile(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  // Auth fail → başka credential seti denenebilir
  if (code === "EAUTH") return true;
  if (msg.includes("535") || msg.toLowerCase().includes("username and password")) return true;
  // envelope/from yetkisiz → from/user uyumsuz olabilir
  if (code === "EENVELOPE") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Core send (retry + profile fallback)
// ---------------------------------------------------------------------------
async function sendMailCore({ to, subject, text, html }, { attempts = 3 } = {}) {
  const makeOptions = (p) => ({
    from: { name: p.fromName, address: p.from },
    to,
    subject,
    text: text || "",
    html: html || (text ? `<p>${text}</p>` : undefined),
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
  });

  let lastErr = null;

  // profile loop
  for (let pi = 0; pi < profiles.length; pi++) {
    if (pi !== activeIdx) useProfile(pi);

    const p = profiles[activeIdx];
    const mailOptions = makeOptions(p);

    // verify first (optional)
    if (MAIL_VERIFY) {
      try {
        await verifyTransporterOnce();
      } catch (e) {
        lastErr = e;
        // verify fail auth ise next profile dene
        if (shouldTryNextProfile(e) && pi < profiles.length - 1) continue;
        // verify fail ama kullanıcı MAIL_VERIFY=1 istiyor → denemeyi burada kes
        throw e;
      }
    }

    // retry loop
    for (let i = 0; i < attempts; i++) {
      try {
        const info = await transporter.sendMail(mailOptions);
        if (MAIL_DEBUG) {
          console.log("[mail] sent", {
            prefix: p.prefix,
            messageId: info?.messageId,
            to,
          });
        }
        return info;
      } catch (e) {
        lastErr = e;

        if (MAIL_DEBUG) {
          console.error("[mail] send failed", {
            prefix: p.prefix,
            code: e?.code,
            message: e?.message,
          });
        }

        // Auth/envelope → diğer profile'a geç
        if (shouldTryNextProfile(e)) break;

        // transient → retry
        if (["ETIMEDOUT", "ECONNRESET", "ESOCKET", "EADDRINUSE"].includes(e?.code)) {
          await sleep(400 * Math.pow(2, i));
          continue;
        }

        // other errors: no retry
        break;
      }
    }

    // next profile
  }

  throw lastErr || new Error("MAIL_SEND_FAILED");
}

// ---------------------------------------------------------------------------
// Public exports (kept compatible)
// ---------------------------------------------------------------------------
export async function sendEmail(to, subject, text, html = null) {
  // UTF-8 subject safe (base64)
  const safeSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  return sendMailCore({ to, subject: safeSubject, text, html }, { attempts: 3 });
}

// Aktivasyon
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

// Şifre sıfırlama
export async function sendPasswordResetCode(to, code) {
  const subject = "FindAllEasy Şifre Sıfırlama";
  const html = `
    <div style="font-family:Arial; padding:15px;">
      <h2>FindAllEasy</h2>
      <p>Şifre sıfırlamak için gerekli kod:</p>
      <div style="font-size:22px;font-weight:bold;padding:10px 0;">
        ${code}
      </div>
      <p style="color:#666;font-size:12px;">Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.</p>
    </div>
  `;
  return sendEmail(to, subject, `Şifre sıfırlama kodunuz: ${code}`, html);
}
