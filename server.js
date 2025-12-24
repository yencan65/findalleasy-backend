import "dotenv/config";
import bcrypt from "bcryptjs";

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import crypto from "crypto";
import nodemailer from "nodemailer";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createServer } from "http";

// WS + Metrics
import { createTelemetryWSS } from "./server/ws/telemetryWS.js";
import { getMetrics } from "./server/utils/metrics.js";
// Affiliate contracts (startup validation)
import { validateAffiliateContracts } from "./server/core/affiliateContracts.validate.js";
import { PROVIDER_CONFIG } from "./server/core/providerConfig.js";


// MODELLER
import Profile from "./server/models/Profile.js";
import Memory from "./server/models/Memory.js";
import Order from "./server/models/Order.js";

// AI
import OpenAI from "openai";
import * as MistralPkg from "@mistralai/mistralai";
import { GoogleGenerativeAI } from "@google/generative-ai";

// LEARNING
import { syncLearningToMongo } from "./server/core/learningSync.js";
import searchRouter from "./server/routes/search.js";
// =============================================================================
// Helpers
// =============================================================================
function isFn(v) {
  return typeof v === "function";
}
function ok(res, data = {}, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}
function fail(res, status = 400, data = {}) {
  return res.status(status).json({ ok: false, ...data });
}

// =============================================================================
// Frontend static hosting (OPTIONAL)
// - If a Vite/React build exists, serve it from the same Node server
// - Ensures /privacy, /cookies, /affiliate-disclosure etc don't 404 on refresh
// - NO-OP if dist folder not found
// =============================================================================
function resolveFrontendDist() {
  const fromEnv = String(process.env.FINDALLEASY_FRONTEND_DIST || "").trim();
  const candidates = [
    fromEnv,
    path.join(process.cwd(), "dist"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "frontend", "dist"),
    path.join(process.cwd(), "FRONTEND", "dist"),
    path.join(process.cwd(), "..", "frontend", "dist"),
    path.join(process.cwd(), "..", "FRONTEND", "dist"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      const idx = path.join(dir, "index.html");
      if (fs.existsSync(idx)) return { dir, index: idx };
    } catch {}
  }
  return null;
}

function mountFrontend(appInstance) {
  const found = resolveFrontendDist();
  if (!found) {
    console.log("ℹ️ Frontend dist not found (skipping static host). Set FINDALLEASY_FRONTEND_DIST to enable.");
    return;
  }

  const distDir = found.dir;
  const indexHtml = found.index;
  console.log("✅ Frontend static host enabled:", distDir);

  // Static assets
  appInstance.use(
    express.static(distDir, {
      index: false,
      maxAge: "1d",
      etag: true,
    })
  );

  // SPA fallback (only for GET + html accept + not /api)
  appInstance.get(/^\/(?!api\/).*/, (req, res, next) => {
    try {
      if (req.method !== "GET") return next();
      const accept = String(req.headers?.accept || "");
      if (!accept.includes("text/html")) return next();
      return res.sendFile(indexHtml);
    } catch (e) {
      console.warn("⚠️ SPA fallback error:", e?.message || e);
      return next();
    }
  });
}

// =============================================================================
// Global error hooks
// =============================================================================
process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled Promise Rejection:", { reason, promise });
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});

// =============================================================================
// Express app
// =============================================================================
const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 8080);

// Mongo URI
const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || null;

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// =============================================================================
// Affiliate contracts validation (FAIL FAST)
// =============================================================================
const __AFF_CONTRACT_STRICT =
  (process.env.AFF_CONTRACT_STRICT ?? (process.env.NODE_ENV === "production" ? "1" : "0")) === "1";

try {
  const __providers = Array.isArray(PROVIDER_CONFIG) ? PROVIDER_CONFIG : Object.values(PROVIDER_CONFIG || {});
  const r = validateAffiliateContracts({ providers: __providers, strict: __AFF_CONTRACT_STRICT });
  console.log("✅ Affiliate contracts validated:", r);
} catch (e) {
  console.error("🚨 Affiliate contracts validation failed:", e?.message || e);
  process.exit(1);
}

// =============================================================================
// Route registry (NO DRIFT guard)
// =============================================================================
function getRouteRegistry(appInstance) {
  if (!appInstance?.locals) return { mounted: new Set(), missing: new Set() };
  if (!appInstance.locals.__faeRouteRegistry) {
    appInstance.locals.__faeRouteRegistry = {
      mounted: new Set(), // prefixes mounted via app.use("/api/xyz", router)
      missing: new Set(), // prefixes we wanted but couldn't load
    };
  }
  return appInstance.locals.__faeRouteRegistry;
}

function dumpRoutes(appInstance) {
  const out = [];
  const stack = appInstance?._router?.stack || [];
  for (const layer of stack) {
    if (layer?.route?.path) {
      const methods = Object.keys(layer.route.methods || {})
        .filter(Boolean)
        .map((m) => m.toUpperCase())
        .join(",");
      out.push({ path: layer.route.path, methods });
      continue;
    }
    if (layer?.name === "router" && layer?.handle?.stack) {
      for (const l2 of layer.handle.stack) {
        if (!l2?.route?.path) continue;
        const methods = Object.keys(l2.route.methods || {})
          .filter(Boolean)
          .map((m) => m.toUpperCase())
          .join(",");
        out.push({ path: l2.route.path, methods });
      }
    }
  }
  return out;
}

// =============================================================================
// CORS
// =============================================================================
const allowedOrigins = [
  ...new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://findalleasy.com",
    "https://www.findalleasy.com",
    ...FRONTEND_ORIGINS,
  ]),
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);

    console.warn("🚫 CORS REDDEDİLDİ:", origin);
    // deny silently (browser will block)
    return callback(null, false);
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// =============================================================================
// Middleware
// =============================================================================
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(bodyParser.json({ limit: "15mb" }));

// ============================================================================
//  JSON PARSE SHIELD (S34) — body-parser bazen 400 HTML basar (FE'yi öldürür)
//  Amaç: JSON parse hatasında request'i düşürme; body'yi {} yapıp route'a devam.
//  ZERO DELETE: mevcut davranışları kırmaz, sadece 400 yerine kontrollü akış.
// ============================================================================
app.use((err, req, res, next) => {
  try {
    const ct = String(req.headers["content-type"] || "");
    const isJson = ct.includes("application/json") || ct.includes("+json");
    const isParseErr =
      !!err &&
      (err.type === "entity.parse.failed" ||
        err.type === "entity.too.large" ||
        err instanceof SyntaxError ||
        String(err.message || "").toLowerCase().includes("unexpected token"));

    if (isJson && isParseErr) {
      req.body = (req.body && typeof req.body === "object") ? req.body : {};
      req.__jsonParseError = true;
      // Not: response dönmüyoruz; route kendi fallback'ini çalıştırabilir.
      return next();
    }
  } catch {}
  return next(err);
});


// ✅ CANONICAL SEARCH: FE hem {query} hem {q} gönderebilir. 400 yok.
// Not: Bunu app.use("/api/search", searchRouter) ÜSTÜNE koy ki önce bu yakalasın.
app.post("/api/search", async (req, res) => {
  const reply = (payload) => res.status(200).json(payload);

  // Basit TR mojibake tamiri (PowerShell/charset kazaları)
  const fixMojibakeTR = (s) => {
    const str = String(s || "");
    if (!str) return "";
    const looksBroken = /�|Ã|Â/.test(str);
    if (!looksBroken) return str;
    try {
      const repaired = Buffer.from(str, "latin1").toString("utf8");
      if (/[ğüşöçıİĞÜŞÖÇ]/.test(repaired) && !/�/.test(repaired)) return repaired;
      return repaired || str;
    } catch {
      return str;
    }
  };

  try {
    const b = req.body || {};
    const rawQuery = String(b.query ?? b.q ?? "").trim();
    const query = fixMojibakeTR(rawQuery).trim();

    const region = String(b.region ?? "TR");
    const locale = String(b.locale ?? b.lang ?? "tr");
    const category = String(b.category ?? b.group ?? "product");

    const limitN = Number(b.limit);
    const offsetN = Number(b.offset);
    const limit = Number.isFinite(limitN) ? limitN : 20;
    const offset = Number.isFinite(offsetN) ? offsetN : 0;

    // Frontend res.ok kırılmasın: 200 dön, ok:false ile "observable fail" yap.
    if (!query) {
      return reply({
        ok: false,
        query: "",
        q: "",
        category,
        group: category,
        region,
        locale,
        items: [],
        results: [],
        count: 0,
        total: 0,
        nextOffset: offset,
        hasMore: false,
        _meta: { error: "MISSING_QUERY" },
      });
    }

    // Engine'i lazy import (module cache’lenir)
    let eng = null;
    try {
      eng = await import("./server/core/adapterEngine.js");
    } catch (e) {
      return reply({
        ok: false,
        query,
        q: query,
        category,
        group: category,
        region,
        locale,
        items: [],
        results: [],
        count: 0,
        total: 0,
        nextOffset: offset,
        hasMore: false,
        _meta: { error: "ENGINE_IMPORT_FAIL", msg: String(e?.message || e) },
      });
    }

    let raw = null;

    // Çeşitli imzalara tolerans: (q, category, opts) veya (q, opts)
    try {
      raw = await eng.runAdapters(query, category, { limit, offset, region, locale });
    } catch (e1) {
      try {
        raw = await eng.runAdapters(query, { limit, offset, region, locale, category });
      } catch (e2) {
        return reply({
          ok: false,
          query,
          q: query,
          category,
          group: category,
          region,
          locale,
          items: [],
          results: [],
          count: 0,
          total: 0,
          nextOffset: offset,
          hasMore: false,
          _meta: { error: "RUN_ADAPTERS_FAIL", msg: String(e2?.message || e2) },
        });
      }
    }

    const items = Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.results)
        ? raw.results
        : [];

    const total = Number(raw?.total ?? raw?.count ?? items.length);
    const count = items.length;
    const nextOffset = offset + count;
    const hasMore = total > nextOffset;

    return reply({
      ok: raw?.ok === false ? false : true,
      query,
      q: query,
      category,
      group: category,
      region,
      locale,
      items,
      results: items,
      count,
      total,
      nextOffset,
      hasMore,
      _meta: raw?._meta || raw?.meta || { source: raw?.source || "engine" },
    });
  } catch (err) {
    return reply({
      ok: false,
      query: String(req?.body?.query ?? req?.body?.q ?? "").trim(),
      q: String(req?.body?.query ?? req?.body?.q ?? "").trim(),
      category: String(req?.body?.category ?? req?.body?.group ?? "product"),
      group: String(req?.body?.category ?? req?.body?.group ?? "product"),
      region: String(req?.body?.region ?? "TR"),
      locale: String(req?.body?.locale ?? req?.body?.lang ?? "tr"),
      items: [],
      results: [],
      count: 0,
      total: 0,
      nextOffset: Number(req?.body?.offset ?? 0) || 0,
      hasMore: false,
      _meta: { error: "SEARCH_ROUTE_CRASH", msg: String(err?.message || err) },
    });
  }
});

app.use("/api/search", searchRouter);

// Mark as mounted for inline route guard
getRouteRegistry(app).mounted.add("/api/search");
// =============================================================================
// Dynamic auto-loader (optional)
// =============================================================================
export async function loadRouteModules(appInstance) {
  const reg = getRouteRegistry(appInstance);
  try {
    const routesDir = path.join(process.cwd(), "server", "routes");
    if (!fs.existsSync(routesDir)) return true;

    const files = fs.readdirSync(routesDir);
    for (const file of files) {
      if (!file.endsWith(".js")) continue;
      if (file.startsWith("_")) continue;

      const routeName = file.replace(".js", "");
      const prefix = `/api/${routeName}`;

      // NO DRIFT: skip if already mounted explicitly
      if (reg.mounted.has(prefix)) continue;

      const routePath = path.join(routesDir, file);
      const fileUrl = pathToFileURL(routePath).href;

      const mod = await import(fileUrl);
      if (mod?.default) {
        appInstance.use(prefix, mod.default);
        reg.mounted.add(prefix);
        console.log(`➡ Route auto-loaded: ${prefix}`);
      }
    }
    return true;
  } catch (err) {
    console.error("❌ loadRouteModules error:", err?.message || err);
    return false;
  }
}

export default app;

// =============================================================================
// Router route mounts (safe import)
// =============================================================================
async function registerRouterRoutes(appInstance) {
  if (globalThis.__FAE_ROUTER_ROUTES_REGISTERED) return;
  globalThis.__FAE_ROUTER_ROUTES_REGISTERED = true;

  const reg = getRouteRegistry(appInstance);
  const strict = String(process.env.FINDALLEASY_STRICT_BOOT || "").toLowerCase() === "1";
  const routeDebug = String(process.env.FINDALLEASY_ROUTE_DEBUG || "") === "1";

  function mountOnce(prefix, router, aliases = []) {
    if (!router) {
      reg.missing.add(prefix);
      return;
    }
    if (reg.mounted.has(prefix)) {
      if (routeDebug) console.log(`⏭️ mount skip (already): ${prefix}`);
      return;
    }
    appInstance.use(prefix, router);
    reg.mounted.add(prefix);
    if (routeDebug) console.log(`✅ mount: ${prefix}`);

    for (const a of aliases) {
      if (!a || typeof a !== "string") continue;
      if (reg.mounted.has(a)) continue;
      appInstance.use(a, router);
      reg.mounted.add(a);
      if (routeDebug) console.log(`✅ alias: ${a} -> ${prefix}`);
    }
  }

  async function safeImportRouter(specOrSpecs, label) {
    const specs = Array.isArray(specOrSpecs) ? specOrSpecs : [specOrSpecs];
    let triedAnyExisting = false;
    let lastErr = null;

    for (const spec of specs) {
      try {
        if (!spec) continue;

        let fileUrl = null;
        if (String(spec).startsWith("file://")) {
          fileUrl = String(spec);
          triedAnyExisting = true;
        } else {
          const absPath = path.isAbsolute(spec)
            ? spec
            : path.join(process.cwd(), String(spec).replace(/^\.\/?/, ""));

          if (!fs.existsSync(absPath)) continue;
          triedAnyExisting = true;
          fileUrl = pathToFileURL(absPath).href;
        }

        const mod = await import(fileUrl);
        const router = mod?.default || mod?.router || null;
        if (!router) throw new Error(`Router export not found (${label || spec})`);
        return router;
      } catch (e) {
        lastErr = e;
        console.error(`❌ Route import FAIL: ${label || spec} ->`, e?.message || e);
        if (strict) throw e;
      }
    }

    if (!triedAnyExisting) {
      if (routeDebug) console.log(`⏭️ Route skip (not found): ${label || "(unknown)"}`);
      return null;
    }
    if (lastErr && strict) throw lastErr;
    return null;
  }

  // ---- ROUTES (CANONICAL) ----
  mountOnce("/api/verify", await safeImportRouter("./server/routes/verify.js", "verify"));
  mountOnce("/api/auth", await safeImportRouter("./server/routes/auth.js", "auth"));

  // vitrin / vitrine: ikisi de ayrı dosya ise ayrı endpoint; legacy alias istersen burada ver.
  mountOnce("/api/vitrin", await safeImportRouter("./server/routes/vitrine.js", "vitrine")); // alias: single implementation
  mountOnce("/api/vitrine", await safeImportRouter("./server/routes/vitrine.js", "vitrine"));

  mountOnce("/api/suggest", await safeImportRouter("./server/routes/suggest.js", "suggest"));
  mountOnce("/api/ai", await safeImportRouter("./server/routes/ai.js", "ai"));
  mountOnce("/api/learn", await safeImportRouter("./server/routes/learn.js", "learn"));

  {
    const r = await safeImportRouter(
      [
        "./server/routes/product-info.js",
        "./server/routes/productInfo.js",
        "./server/routes/productInfoRoutes.js",
        "./server/routes/product-infoRoutes.js",
      ],
      "product-info"
    );
    mountOnce("/api/product-info", r, ["/api/productInfo"]); // legacy alias
  }

  mountOnce("/api/rewards", await safeImportRouter("./server/routes/rewards.js", "rewards"));
  mountOnce("/api/referral", await safeImportRouter("./server/routes/referral.js", "referral"));
  mountOnce("/api/click", await safeImportRouter("./server/routes/click.js", "click"));

  {
    const r = await safeImportRouter("./server/routes/affiliateCallback.js", "affiliateCallback");
    // canonical + legacy file-name alias (auto-loader açılırsa bile sürpriz olmasın)
    mountOnce("/api/affiliate-callback", r, ["/api/affiliateCallback"]);
  }

  mountOnce("/api/interactions", await safeImportRouter("./server/routes/interactions.js", "interactions"));
  mountOnce("/api/coupons", await safeImportRouter("./server/routes/coupons.js", "coupons"));

  {
    const r = await safeImportRouter("./server/routes/orderCallback.js", "orderCallback");
    // canonical istersen /api/order-callback yap; ama sende /api/order kullanılıyor gibi.
    mountOnce("/api/order", r, ["/api/orderCallback"]);
  }

  mountOnce("/api/wallet", await safeImportRouter("./server/routes/wallet.js", "wallet"));
  mountOnce("/api/orders", await safeImportRouter("./server/routes/orders.js", "orders"));
  mountOnce("/api/affiliate", await safeImportRouter("./server/routes/affiliate.js", "affiliate"));
  mountOnce("/api/vision", await safeImportRouter("./server/routes/vision.js", "vision"));

  {
    const r = await safeImportRouter(["./server/routes/revenueRoutes.js", "./server/routes/revenue.js"], "revenue");
    mountOnce("/api/revenue", r, ["/api/revenueRoutes"]);
  }

  mountOnce("/api/redirect", await safeImportRouter("./server/routes/redirect.js", "redirect"));

  {
    const r = await safeImportRouter("./server/routes/adminTelemetry.js", "adminTelemetry");
    mountOnce("/api/adminTelemetry", r, ["/admin/telemetry"]);
  }

  mountOnce("/api/imageProxy", await safeImportRouter("./server/routes/imageProxy.js", "imageProxy"));

  {
    const r = await safeImportRouter("./server/routes/affiliateBridgeS16.js", "affiliateBridgeS16");
    mountOnce("/api/aff", r, ["/api/affiliateBridgeS16"]);
  }

  // Debug route dump (DEV)
  if (routeDebug) {
    appInstance.get("/api/_debug/routes", (_req, res) => ok(res, { routes: dumpRoutes(appInstance) }));
    console.log("🧭 ROUTE_DUMP:", dumpRoutes(appInstance));
  }
}

// =============================================================================
// Inline routes (REGISTER ONLY IF ROUTER PREFIX IS NOT MOUNTED)
// =============================================================================
function registerInlineRoutes(appInstance) {
  if (globalThis.__FAE_INLINE_ROUTES_REGISTERED) return;
  globalThis.__FAE_INLINE_ROUTES_REGISTERED = true;

  const reg = getRouteRegistry(appInstance);
  const routeDebug = String(process.env.FINDALLEASY_ROUTE_DEBUG || "") === "1";
  const INLINE_UNDER_ROUTER = String(process.env.FINDALLEASY_INLINE_UNDER_ROUTER || "0") === "1";

  function inlineAllowed(prefix) {
    // default: router varsa inline altında endpoint TANIMLAMA (NO DRIFT)
    return INLINE_UNDER_ROUTER || !reg.mounted.has(prefix);
  }

  function logSkip(what, prefix) {
    if (!routeDebug) return;
    console.log(`⏭️ inline skip: ${what} (router mounted: ${prefix})`);
  }

  // Metrics
  appInstance.get("/metrics", (_req, res) => {
    try {
      const out = isFn(getMetrics) ? getMetrics() : {};
      return ok(res, { metrics: out });
    } catch (e) {
      return fail(res, 500, { error: e?.message || String(e) });
    }
  });

  // Basit watch stub (yalnızca router yoksa)
  if (!reg.mounted.has("/api/watch")) {
    appInstance.post("/api/watch", (_req, res) => ok(res, { watch: true }));
  }

  // Models (inline)
  const UserSchema = new mongoose.Schema(
    {
      name: String,
      email: { type: String, unique: true },
      password: String,
      referralCode: String,
      referredBy: String,
      resetCode: String,
      resetExpires: Date,
      createdAt: { type: Date, default: Date.now },
    },
    { strict: false }
  );
  const User = mongoose.models.User || mongoose.model("User", UserSchema);

  const RewardSchema = new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      amount: Number,
      type: String,
      expireAt: Date,
      createdAt: { type: Date, default: Date.now },
      meta: Object,
      notified3Days: Boolean,
    },
    { strict: false }
  );
  const Reward = mongoose.models.Reward || mongoose.model("Reward", RewardSchema);

  const ReferralSchema = new mongoose.Schema(
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      code: { type: String, unique: true },
      referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      createdAt: { type: Date, default: Date.now },
    },
    { strict: false }
  );
  const Referral = mongoose.models.Referral || mongoose.model("Referral", ReferralSchema);

  // SMTP mailer
  let transporter = null;
  try {
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = Number(process.env.SMTP_PORT || 465);

    if (smtpUser && smtpPass) {
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
        tls: { rejectUnauthorized: false },
      });
      console.log("✅ SMTP bağlantısı hazır");
    } else {
      console.log("⚠️ SMTP kullanıcı bilgileri eksik");
    }
  } catch (e) {
    console.warn("⚠️ SMTP init error:", e?.message || e);
    transporter = null;
  }

  // AI clients
  console.log("🔑 AI Keys Loaded:");
  console.log("   Mistral :", process.env.MISTRAL_API_KEY ? "🟢" : "🔴");
  console.log("   OpenAI  :", process.env.OPENAI_API_KEY ? "🟢" : "🔴");
  console.log("   Gemini  :", process.env.GEMINI_API_KEY ? "🟢" : "🔴");

  let mistral = null;
  try {
    if (process.env.MISTRAL_API_KEY) {
      const MistralCtor = MistralPkg.Mistral || MistralPkg.default || MistralPkg;
      mistral = isFn(MistralCtor) ? new MistralCtor({ apiKey: process.env.MISTRAL_API_KEY }) : null;
    }
  } catch (e) {
    console.warn("⚠️ Mistral init error:", e?.message || e);
    mistral = null;
  }

  let openai = null;
  try {
    if (process.env.OPENAI_API_KEY) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.warn("⚠️ OpenAI init error:", e?.message || e);
    openai = null;
  }

  let genai = null;
  try {
    if (process.env.GEMINI_API_KEY) genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  } catch (e) {
    console.warn("⚠️ Gemini init error:", e?.message || e);
    genai = null;
  }

  // UI helpers
  function greetingByHour(hour, locale = "tr", name = "") {
    const n = name ? `${name} ` : "";
    if (hour < 6) return locale === "tr" ? `${n}İyi geceler` : `Good night ${n}`.trim();
    if (hour < 12) return locale === "tr" ? `${n}Günaydın` : `Good morning ${n}`.trim();
    if (hour < 18) return locale === "tr" ? `${n}İyi günler` : `Good afternoon ${n}`.trim();
    return locale === "tr" ? `${n}İyi akşamlar` : `Good evening ${n}`.trim();
  }

  function triggerLines({ locale = "tr", persona = "expert", lastAction = "idle" } = {}) {
    const t = [];
    if (locale === "tr") {
      t.push("Ne arıyorsun? Yazman yeterli, gerisini hallederim.");
      if (persona === "expert") t.push("Bölgen için en uygun ve güvenilir seçenekleri bulabilirim.");
      if (lastAction === "idle") t.push("‘Hey Sono’ de, hemen başlayayım.");
    } else {
      t.push("What are you looking for? Just type it, I’ll handle the rest.");
      if (persona === "expert") t.push("I can fetch trusted best-value options for your region.");
      if (lastAction === "idle") t.push("Say ‘Hey Sono’ to start.");
    }
    return t;
  }

  function buildVitrinCards({ query = "", answer = "", locale = "tr", region = "TR" } = {}) {
    return [
      {
        title: locale === "tr" ? "En uygun & güvenilir" : "Best value & trusted",
        desc: answer || (locale === "tr" ? "Öneriler hazırlanıyor..." : "Preparing suggestions..."),
        cta: locale === "tr" ? "Tıkla" : "Open",
        region,
      },
      {
        title: locale === "tr" ? "Konumuna göre öneri" : "Suggestions by location",
        desc: query || "",
        cta: locale === "tr" ? "Tıkla" : "Open",
        region,
      },
      {
        title: locale === "tr" ? "Diğer satıcılar" : "Other sellers",
        desc: locale === "tr" ? "Karşılaştırmalı alternatifler" : "Comparable alternatives",
        cta: locale === "tr" ? "Tıkla" : "Open",
        region,
      },
    ];
  }

  async function aiChain(prompt, { locale = "tr", region = "TR" } = {}) {
    // 1) Mistral
    try {
      if (mistral && isFn(mistral.chat)) {
        const r = await mistral.chat({
          model: "mistral-medium",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
        });
        const text =
          r?.choices?.[0]?.message?.content ||
          r?.data?.[0]?.message?.content ||
          r?.output ||
          r?.text ||
          "";
        if (text) return { provider: "mistral", text: String(text) };
      }
    } catch (e) {
      console.warn("⚠️ Mistral error:", e?.message || e);
    }

    // 2) OpenAI
    try {
      if (openai) {
        const r = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Kısa ve net yanıt ver. Kullanıcı ürün/hizmet arıyor." },
            { role: "user", content: `Dil:${locale} Bölge:${region} İstek:${prompt}` },
          ],
          max_tokens: 200,
          temperature: 0.5,
        });
        const text = r?.choices?.[0]?.message?.content || r?.choices?.[0]?.text || "";
        if (text) return { provider: "openai", text: String(text) };
      }
    } catch (e) {
      console.warn("⚠️ OpenAI error:", e?.message || e);
    }

    // 3) Gemini
    try {
      if (genai) {
        const model = genai.getGenerativeModel({ model: "gemini-1.5-flash" });
        const r = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        });
        const text = r?.response?.text?.() || "";
        if (text) return { provider: "gemini", text: String(text) };
      }
    } catch (e) {
      console.warn("⚠️ Gemini error:", e?.message || e);
    }

    return {
      provider: "none",
      text: locale === "tr" ? "Şu an öneri veremiyorum." : "No suggestion currently.",
    };
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------
  appInstance.get("/health", async (_req, res) => {
    try {
      const mongoOk = !!mongoose?.connection && mongoose.connection.readyState === 1;
      return ok(res, {
        mongo: mongoOk,
        openai: !!openai,
        mistral: !!mistral,
        gemini: !!genai,
        time: new Date().toISOString(),
      });
    } catch (e) {
      return fail(res, 500, { error: e?.message || String(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Greeting + triggers
  // ---------------------------------------------------------------------------
  appInstance.post("/api/greeting", async (req, res) => {
    try {
      const { locale = "tr", name = "", hour } = req.body || {};
      const h = typeof hour === "number" ? hour : new Date().getHours();
      const text = greetingByHour(h, locale, name);
      return ok(res, { text, hour: h });
    } catch {
      return fail(res, 500, { text: "" });
    }
  });

  appInstance.post("/api/triggers", async (req, res) => {
    try {
      const { locale = "tr", persona = "expert", lastAction = "idle" } = req.body || {};
      const lines = triggerLines({ locale, persona, lastAction });
      return ok(res, { lines });
    } catch {
      return fail(res, 500, { lines: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // Personalize
  // ---------------------------------------------------------------------------
  appInstance.post("/api/personalize", async (req, res) => {
    try {
      const { userId = "", sessionId = "", region = "TR", locale = "tr", mood = "calm", ipCity = "" } =
        req.body || {};
      if (MONGO) {
        await Profile.findOneAndUpdate(
          { userId: userId || null, sessionId: sessionId || null },
          { $set: { region, locale, mood, lastSeen: new Date(), ipCity } },
          { upsert: true }
        );
      }
      const cards = buildVitrinCards({ query: "", answer: "", locale, region });
      return ok(res, { cards, mood });
    } catch (e) {
      console.error("personalize error:", e);
      return fail(res, 500, { cards: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // Search (DEV stub gated)
  // ---------------------------------------------------------------------------
  appInstance.post("/api/search", async (req, res) => {
    try {
      const { query = "", region = "TR", locale = "tr", userId = "", sessionId = "", offset = 0, limit = 20 } =
        req.body || {};
      const off = Number(offset) || 0;
      const lim = Math.min(50, Number(limit) || 20);

      if (MONGO && (userId || sessionId)) {
        await Profile.findOneAndUpdate(
          { userId: userId || null, sessionId: sessionId || null },
          {
            $push: { lastQueries: { q: query, at: new Date() } },
            $set: { lastSeen: new Date(), region, locale },
          },
          { upsert: true }
        );
      }

      const ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
      if (!ALLOW_STUBS) {
        const cards = buildVitrinCards({ query, answer: "", locale, region });
        return fail(res, 501, {
          error: "SEARCH_NOT_IMPLEMENTED",
          cards,
          results: [],
          nextOffset: 0,
          hasMore: false,
          total: 0,
        });
      }

      const total = 100;
      const all = Array.from({ length: total }, (_, i) => ({
        id: `alt-${i + 1}`,
        title: `${query || "Alternatif"} #${i + 1}`,
        price: Math.round(50 + (i % 7) * 200),
        deeplink: "https://example.com/product/" + (i + 1),
        rating: ((i % 10) + 10) / 10,
        provider: i % 2 ? "Trendyol" : "Global",
        region,
      }));
      const slice = all.slice(off, off + lim);
      const nextOffset = off + slice.length;
      const hasMore = nextOffset < total;

      const cards = buildVitrinCards({ query, answer: "", locale, region });
      return ok(res, { cards, results: slice, nextOffset, hasMore, total });
    } catch (e) {
      console.error("search error:", e);
      return fail(res, 500, { cards: [], results: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // AI route (inline) — only if /api/ai router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/ai")) {
    let aiRecentCalls = [];
    function aiRateAllowed() {
      const now = Date.now();
      aiRecentCalls = aiRecentCalls.filter((t) => now - t < 1000);
      if (aiRecentCalls.length >= 3) return false;
      aiRecentCalls.push(now);
      return true;
    }

    appInstance.post("/api/ai", async (req, res) => {
      try {
        if (!aiRateAllowed()) {
          return fail(res, 429, {
            answer: "Şu anda çok fazla istek alıyorum, birkaç saniye sonra tekrar dene.",
            cards: [],
          });
        }

        const body = req.body || {};
        let { message = "", region = "TR", locale = "tr", userId = "" } = body;

        let prompt = String(message || "").trim();
        if (!prompt) return ok(res, { provider: "none", answer: "", cards: [] });

        const MAX_PROMPT_LEN = 800;
        if (prompt.length > MAX_PROMPT_LEN) prompt = prompt.slice(0, MAX_PROMPT_LEN);

        locale = String(locale || "tr").slice(0, 8).toLowerCase();
        region = String(region || "TR").slice(0, 8).toUpperCase();

        let provider = "none";
        let text = "";

        try {
          const aiResult = await aiChain(prompt, { locale, region });
          provider = aiResult?.provider || "unknown";
          text = String(aiResult?.text || "").trim();
        } catch (err) {
          console.error("aiChain hata:", err);
          provider = "fallback";
          text = "Gerçek AI şu an sessiz ama yine de senin için bakıyorum.";
        }

        let cards = [];
        try {
          const out = buildVitrinCards({ query: prompt, answer: text, locale, region });
          if (Array.isArray(out)) cards = out;
        } catch (err) {
          console.error("buildVitrinCards hata:", err);
        }

        try {
          if (MONGO && userId) {
            await Profile.findOneAndUpdate(
              { userId },
              { $push: { lastQueries: { q: prompt, at: new Date() } } },
              { upsert: true }
            );
          }
        } catch (err) {
          console.warn("Profile.lastQueries kaydı sırasında hata:", err);
        }

        try {
          if (MONGO && userId && text) {
            await Memory.create({
              userId,
              query: prompt.slice(0, 1200),
              answer: String(text).slice(0, 4000),
              locale,
              region,
            });
          }
        } catch (err) {
          console.warn("Memory kayıt hatası:", err);
        }

        return ok(res, { provider, answer: text, cards });
      } catch (e) {
        console.error("AI route genel hata:", e);
        return fail(res, 500, { answer: "Gerçek AI şu anda sessiz.", cards: [] });
      }
    });
  } else {
    logSkip("/api/ai", "/api/ai");
  }

  // ---------------------------------------------------------------------------
  // Vision — only if /api/vision router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/vision")) {
    appInstance.post("/api/vision", async (req, res) => {
      try {
        const { imageBase64 = "", locale = "tr", region = "TR" } = req.body || {};
        if (!imageBase64) return fail(res, 400, { error: "imageBase64 required" });
        let extracted = "";

        if (genai) {
          try {
            const model = genai.getGenerativeModel({ model: "gemini-1.5-flash" });
            const cleaned = imageBase64.replace(/^data:image\/\w+;base64,/, "");
            const r = await model.generateContent({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: locale === "tr" ? "Bu görseli kısa tanımla." : "Briefly describe this image." },
                    { inlineData: { data: cleaned, mimeType: "image/png" } },
                  ],
                },
              ],
            });
            extracted = r?.response?.text?.() || "";
          } catch (ge) {
            console.warn("⚠️ Gemini vision error:", ge?.message || ge);
          }
        }

        const cards = buildVitrinCards({ query: extracted, answer: "", locale, region });
        return ok(res, { query: extracted || "", cards });
      } catch (e) {
        console.error("vision error:", e);
        return fail(res, 500, { cards: [] });
      }
    });
  } else {
    logSkip("/api/vision", "/api/vision");
  }

  // ---------------------------------------------------------------------------
  // Voice
  // ---------------------------------------------------------------------------
  appInstance.post("/api/voice", async (req, res) => {
    try {
      const { transcript = "", region = "TR", locale = "tr" } = req.body || {};
      const t = String(transcript || "").trim();
      if (!t) return ok(res, { type: "voice", provider: "none", answer: "", cards: [] });

      const out = await aiChain(t, { locale, region });
      const cards = buildVitrinCards({ query: t, answer: out.text, locale, region });
      return ok(res, { type: "voice", provider: out.provider, answer: out.text, cards });
    } catch (e) {
      console.error("voice error:", e);
      return fail(res, 500, { answer: "", cards: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // Auth legacy + custom (router olsa bile alt endpoint'ler; istersen auth.js'e taşı)
  // ---------------------------------------------------------------------------
  appInstance.post("/api/auth/legacy-signup", async (req, res) => {
    try {
      const { email = "", password = "", referral = "" } = req.body || {};
      if (!email || !password) return fail(res, 400, { error: "email & password required" });

      const exists = await User.findOne({ email }).exec();
      if (exists) return fail(res, 400, { error: "user exists" });

      const hashed = crypto.createHash("sha256").update(password).digest("hex");
      const referralCode = crypto.randomBytes(4).toString("hex");

      const user = await User.create({
        email,
        password: hashed,
        referralCode,
        referredBy: referral || null,
      });

      await Reward.create({
        userId: user._id,
        amount: 1,
        type: "signup",
        expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        meta: { note: "ilk giriş %1 indirim" },
      });

      if (referral) {
        const inviter = await User.findOne({ referralCode: referral }).lean();
        if (inviter) {
          await Reward.create({
            userId: inviter._id,
            amount: 0.5,
            type: "referral",
            expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
            meta: { invited: user.email },
          });
        }
      }

      return ok(res, { userId: String(user._id), email: user.email, referralCode });
    } catch (e) {
      console.error("legacy signup error:", e);
      return fail(res, 500, { error: "signup error" });
    }
  });

  appInstance.post("/api/auth/legacy-login", async (req, res) => {
    try {
      const { email = "", password = "" } = req.body || {};
      if (!email || !password) return fail(res, 400, { error: "email & password required" });

      const hashed = crypto.createHash("sha256").update(password).digest("hex");
      const user = await User.findOne({ email, password: hashed }).exec();
      if (!user) return fail(res, 401, { error: "invalid credentials" });

      const active = await Reward.find({ userId: user._id, expireAt: { $gte: new Date() } }).lean();
      const rewards = (active || []).reduce((s, r) => s + (r.amount || 0), 0);

      return ok(res, {
        userId: String(user._id),
        email: user.email,
        referralCode: user.referralCode,
        rewards: Number(rewards.toFixed(2)),
      });
    } catch (e) {
      console.error("legacy login error:", e);
      return fail(res, 500, { error: "login error" });
    }
  });

  function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  appInstance.post("/api/auth/request-reset", async (req, res) => {
    try {
      const { email } = req.body || {};
      const user = await User.findOne({ email }).exec();
      if (!user) return res.status(404).json({ success: false, message: "Bu e-posta kayıtlı değil." });

      const code = generateCode();
      user.resetCode = code;
      user.resetExpires = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();

      if (!transporter) return res.status(500).json({ success: false, message: "E-posta servisi devre dışı." });

      await transporter.sendMail({
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: email,
        subject: "FindAllEasy | Şifre Yenileme Kodun",
        html: `
          <div style="font-family:sans-serif;background:#111;padding:20px;color:#fff;">
            <h2 style="color:#ffd347;">FindAllEasy | Şifre Yenileme</h2>
            <p>Şifreni yenilemek için doğrulama kodun:</p>
            <div style="font-size:24px;letter-spacing:4px;margin:16px 0;"><b>${code}</b></div>
            <p>Bu kod <b>15 dakika</b> boyunca geçerlidir.</p>
          </div>`,
      });

      return res.json({ success: true, message: "Kod e-posta adresine gönderildi." });
    } catch (err) {
      console.error("E-posta gönderim hatası:", err);
      return res.status(500).json({ success: false, message: "E-posta gönderilemedi." });
    }
  });

  appInstance.post("/api/auth/verify-reset", async (req, res) => {
    try {
      const { email, code } = req.body || {};
      const user = await User.findOne({ email }).exec();
      if (!user || user.resetCode !== code || !user.resetExpires || user.resetExpires < new Date()) {
        return res.json({ verified: false, message: "Kod geçersiz veya süresi dolmuş." });
      }
      return res.json({ verified: true });
    } catch (err) {
      console.error("Kod doğrulama hatası:", err);
      return res.status(500).json({ verified: false, message: "Doğrulama hatası." });
    }
  });

  appInstance.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { email, newPassword } = req.body || {};
      const user = await User.findOne({ email }).exec();
      if (!user) return res.status(404).json({ success: false, message: "Kullanıcı bulunamadı." });

      if (!user.resetCode || !user.resetExpires || user.resetExpires < new Date())
        return res.status(400).json({ success: false, message: "Kod geçersiz veya süresi dolmuş." });

      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(newPassword, salt);

      user.password = hashed;
      user.resetCode = null;
      user.resetExpires = null;
      await user.save();

      return res.json({ success: true, message: "Şifre başarıyla değiştirildi." });
    } catch (err) {
      console.error("Şifre yenileme hatası:", err);
      return res.status(500).json({ success: false, message: "Şifre güncellenemedi." });
    }
  });

  appInstance.post("/api/auth/custom-signup", async (req, res) => {
    try {
      const { name, email, password, referral } = req.body || {};
      if (!email || !password) return fail(res, 400, { error: "email & password required" });

      const exists = await User.findOne({ email }).exec();
      if (exists) return fail(res, 400, { error: "user exists" });

      const hashed = await bcrypt.hash(password, 10);
      const referralCode = crypto.randomBytes(4).toString("hex");

      const user = await User.create({
        name,
        email,
        password: hashed,
        referralCode,
        referredBy: referral || null,
      });

      return ok(res, { userId: String(user._id), name: user.name, email: user.email, referralCode });
    } catch (err) {
      console.error("signup error:", err);
      return fail(res, 500, { error: "signup error" });
    }
  });

  appInstance.post("/api/auth/custom-login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ success: false, message: "E-posta ve şifre gerekli." });

      const user = await User.findOne({ email }).exec();
      if (!user) return res.status(401).json({ success: false, message: "E-posta kayıtlı değil." });

      const match = await bcrypt.compare(password, user.password || "");
      if (!match) return res.status(401).json({ success: false, message: "Şifre hatalı." });

      return res.json({
        success: true,
        message: "Giriş başarılı.",
        userId: String(user._id),
        name: user.username || user.name || user.email.split("@")[0],
      });
    } catch (err) {
      console.error("login error:", err);
      return res.status(500).json({ success: false, message: "Sunucu hatası." });
    }
  });

  // ---------------------------------------------------------------------------
  // Orders stats (inline) — only if /api/orders router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/orders")) {
    appInstance.get("/api/orders/stats", async (req, res) => {
      try {
        const { userId } = req.query || {};
        if (!userId) return fail(res, 400, { error: "userId required" });

        const completedCount = await Order.countDocuments({ userId: String(userId), status: "paid" }).exec();
        return ok(res, { completedCount });
      } catch (e) {
        console.error("orders/stats error:", e);
        return fail(res, 500, { error: "orders stats error" });
      }
    });
  } else {
    logSkip("/api/orders/*", "/api/orders");
  }

  // ---------------------------------------------------------------------------
  // Coupons (inline) — only if /api/coupons router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/coupons")) {
    appInstance.post("/api/coupons/create", async (req, res) => {
      try {
        const { userId, amount } = req.body || {};
        if (!userId || !amount) return fail(res, 400, { error: "userId ve amount gereklidir" });

        const code = "FAE-" + crypto.randomBytes(3).toString("hex").toUpperCase();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        return ok(res, { code, amount: Number(amount), expiresAt });
      } catch (e) {
        console.error("coupon create error:", e);
        return fail(res, 500, { error: "coupon create error" });
      }
    });
  } else {
    logSkip("/api/coupons/*", "/api/coupons");
  }

  // ---------------------------------------------------------------------------
  // Badges
  // ---------------------------------------------------------------------------
  appInstance.get("/api/badges", async (req, res) => {
    try {
      const { userId } = req.query || {};
      if (!userId) return ok(res, { badges: [] });

      const completed = await Order.countDocuments({ userId: String(userId), status: "paid" }).exec();
      const badges = [];
      if (completed >= 1) badges.push({ code: "first_purchase", label: "İlk Alışverişini Tamamladı" });
      if (completed >= 5) badges.push({ code: "loyal_buyer", label: "Sadık Müşteri" });

      return ok(res, { badges });
    } catch (e) {
      console.error("badges error:", e);
      return fail(res, 500, { error: "badges error" });
    }
  });

  // ---------------------------------------------------------------------------
  // Rewards (inline) — only if /api/rewards router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/rewards")) {
    appInstance.get("/api/rewards", async (req, res) => {
      try {
        const { userId } = req.query || {};
        if (!userId) return fail(res, 400, { error: "userId required" });

        const list = await Reward.find({ userId, expireAt: { $gte: new Date() } }).sort({ expireAt: 1 }).lean();
        const total = (list || []).reduce((s, z) => s + (z.amount || 0), 0);
        return ok(res, { total, list });
      } catch (e) {
        console.error("rewards error:", e);
        return fail(res, 500, { error: "rewards error" });
      }
    });

    appInstance.post("/api/rewards/redeem", async (req, res) => {
      try {
        const { userId, amount = 0 } = req.body || {};
        if (!userId || !amount) return fail(res, 400, { error: "userId & amount required" });

        const userDoc = await User.findById(userId).lean();
        if (!userDoc) return fail(res, 403, { error: "login required for discount" });

        const active = await Reward.find({ userId, expireAt: { $gte: new Date() } }).sort({ expireAt: 1 }).lean();
        const available = (active || []).reduce((s, z) => s + (z.amount || 0), 0);
        if (available < amount) return fail(res, 400, { error: "insufficient reward" });

        let remaining = amount;
        for (const r of active) {
          if (remaining <= 0) break;
          const use = Math.min(remaining, r.amount);
          remaining -= use;
          await Reward.updateOne({ _id: r._id }, { $inc: { amount: -use } });
        }
        return ok(res, { used: amount });
      } catch (e) {
        console.error("redeem error:", e);
        return fail(res, 500, { error: "redeem error" });
      }
    });
  } else {
    logSkip("/api/rewards/*", "/api/rewards");
  }

  // ---------------------------------------------------------------------------
  // Cron cleanup + notify
  // ---------------------------------------------------------------------------
  if (transporter) {
    cron.schedule("0 0 * * *", async () => {
      try {
        const now = new Date();
        await Reward.deleteMany({ $or: [{ amount: { $lte: 0 } }, { expireAt: { $lte: now } }] });

        const threeDays = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
        const soon = await Reward.find({
          expireAt: { $gte: now, $lte: threeDays },
          notified3Days: { $ne: true },
        }).lean();

        for (const r of soon) {
          const user = await User.findById(r.userId).lean();
          if (!user?.email) continue;

          await transporter.sendMail({
            from: process.env.FROM_EMAIL || process.env.SMTP_USER,
            to: user.email,
            subject: "FindAllEasy: ödülün 3 gün içinde sona eriyor",
            html: `<div style="font:14px/1.6 Arial">
                    <h3>Merhaba,</h3>
                    <p>Hesabındaki <b>${r.amount}</b> ödül yakında sona erecek.</p>
                    <p>Son kullanım: <b>${(r.expireAt || now).toISOString().slice(0, 10)}</b></p>
                   </div>`,
          });

          await Reward.updateOne({ _id: r._id }, { $set: { notified3Days: true } });
        }
        console.log("cron ok");
      } catch (e) {
        console.warn("cron error:", e?.message || e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Referral (inline) — only if /api/referral router NOT mounted
  // ---------------------------------------------------------------------------
  if (inlineAllowed("/api/referral")) {
    appInstance.post("/api/referral/create", async (req, res) => {
      try {
        const { userId } = req.body || {};
        if (!userId) return fail(res, 400, { error: "userId required" });
        const code = crypto.randomBytes(5).toString("hex");
        await Referral.create({ userId, code });
        return ok(res, { code, url: `${process.env.PUBLIC_URL || "https://findalleasy.com"}/invite?c=${code}` });
      } catch (e) {
        console.error("referral create error:", e);
        return fail(res, 500);
      }
    });

    appInstance.post("/api/referral/use", async (req, res) => {
      try {
        const { newUserId, code } = req.body || {};
        if (!newUserId || !code) return fail(res, 400, { error: "params required" });

        const ref = await Referral.findOne({ code }).lean();
        if (!ref) return fail(res, 404, { error: "invalid code" });

        await Referral.updateOne({ code }, { $set: { referredUserId: newUserId } });
        return ok(res, { used: true });
      } catch (e) {
        console.error("referral use error:", e);
        return fail(res, 500);
      }
    });

    appInstance.post("/api/referral/invite", async (req, res) => {
      try {
        const { userId } = req.body || {};
        if (!userId) return fail(res, 400, { error: "userId required" });

        const code = crypto.randomBytes(5).toString("hex");
        await Referral.create({ userId, code });
        return ok(res, { code });
      } catch (e) {
        console.error("referral invite error:", e);
        return fail(res, 500, { error: "referral invite error" });
      }
    });
  } else {
    logSkip("/api/referral/*", "/api/referral");
  }

  // ---------------------------------------------------------------------------
  // Payment webhook (stub signature)
  // ---------------------------------------------------------------------------
  function verifyProviderSignature(_req) {
    return true;
  }

  appInstance.post("/api/payment/webhook", async (req, res) => {
    try {
      if (!verifyProviderSignature(req)) return fail(res, 401);

      const {
        orderId,
        userId,
        amount = 0,
        currency = "TRY",
        provider = "iyzico",
        referralCode = null,
        event = "payment_succeeded",
      } = req.body || {};
      if (!orderId || !userId) return fail(res, 400, { error: "orderId & userId required" });

      let order = await Order.findOne({ providerOrderId: orderId });
      if (!order) {
        order = await Order.create({
          userId,
          amount,
          currency,
          provider,
          providerOrderId: orderId,
          status: "pending",
          referredBy: referralCode || null,
        });
      }

      if (event === "payment_succeeded") {
        const count = await Order.countDocuments({ userId, status: "paid" });
        if (count === 0) {
          const buyerDiscount = Math.round(amount * 0.01 * 100) / 100;
          await Reward.create({
            userId,
            amount: -buyerDiscount,
            type: "discount_applied",
            expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          });
        }

        if (referralCode) {
          const inviter = await User.findOne({ referralCode }).lean();
          if (inviter) {
            const invBonus = Math.round(amount * 0.005 * 100) / 100;
            await Reward.create({
              userId: inviter._id,
              amount: invBonus,
              type: "referral_bonus",
              expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
            });
          }
        }

        order.status = "paid";
        order.paidAt = new Date();
        await order.save();
      }

      return ok(res, { handled: true });
    } catch (e) {
      console.error("payment webhook error:", e);
      return fail(res, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Memory API
  // ---------------------------------------------------------------------------
  appInstance.get("/api/memory", async (req, res) => {
    try {
      const { userId } = req.query || {};
      if (!userId) return fail(res, 400, { error: "userId required" });
      const items = await Memory.find({ userId }).lean();
      return ok(res, { items });
    } catch (e) {
      console.error("memory load error:", e);
      return fail(res, 500);
    }
  });

  appInstance.post("/api/memory/save", async (req, res) => {
    try {
      const { userId, items = [] } = req.body || {};
      if (!userId) return fail(res, 400, { error: "userId required" });
      for (const { key, value } of items) {
        await Memory.updateOne({ userId, key }, { $set: { value, lastUpdated: new Date() } }, { upsert: true });
      }
      return ok(res, { saved: items.length });
    } catch (e) {
      console.error("memory save error:", e);
      return fail(res, 500);
    }
  });

  // Translate (stub)
  appInstance.post("/api/translate", async (req, res) => {
    try {
      const { text = "", targetLang = "tr" } = req.body || {};
      return ok(res, { translated: text, targetLang });
    } catch (e) {
      console.error("translate error:", e);
      return fail(res, 500);
    }
  });

  // Debug panel
  appInstance.get("/api/debug/s10", async (_req, res) => {
    try {
      const lastProfiles = await Profile.find({}).sort({ lastSeen: -1 }).limit(20).lean();
      const lastMemory = await Memory.find({}).sort({ _id: -1 }).limit(20).lean();

      const rewardStats = await Reward.aggregate([
        { $match: {} },
        { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]);

      const orderStats = await Order.aggregate([
        { $match: {} },
        { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$amount" } } },
      ]);

      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      const adapterEngineStats = globalThis?.AdapterStats || {};

      return res.json({
        ok: true,
        system: {
          uptime: process.uptime(),
          cpu,
          memory: { rss: mem.rss, heap: mem.heapUsed, heapTotal: mem.heapTotal },
          mongo: mongoose?.connection?.readyState === 1,
        },
        engine: { adapters: adapterEngineStats },
        rewards: rewardStats,
        orders: orderStats,
        lastProfiles,
        lastMemory,
      });
    } catch (e) {
      console.error("S10 DEBUG ERROR:", e);
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}

// =============================================================================
// MAIN (DB -> RewardEngine -> routes -> listen)
// =============================================================================
async function main() {
  if (!MONGO) {
    console.error("❌ env.MONGODB_URI veya MONGO_URI tanımlı değil. Mongo olmadan sistem çalıştırmak mantıksız.");
    process.exit(1);
  }

  // DB connect
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ MongoDB bağlantısı başarılı");
  } catch (e) {
    console.error("❌ MongoDB bağlantı hatası:", e?.message || e);
    process.exit(1);
  }

  // settle guard (optional)
  try {
    if (typeof mongoose.connection?.asPromise === "function") {
      await mongoose.connection.asPromise();
    }
  } catch (e) {
    console.warn("⚠️ mongoose settle warn:", e?.message || e);
  }

  globalThis.mongoose = mongoose;

  // Model preload (optional)
  try {
    await Promise.allSettled([
      import("./server/models/User.js"),
      import("./server/models/Order.js"),
      import("./server/models/WalletTransaction.js"),
    ]);
  } catch (e) {
    console.warn("⚠️ model preload warn:", e?.message || e);
  }

  
// RewardEngine init (soft)
const __REWARD_DISABLED =
  String(process.env.REWARD_ENGINE_DISABLE || "0") === "1" ||
  String(process.env.FINDALLEASY_TEST_MODE || "0") === "1";

if (__REWARD_DISABLED) {
  console.log("🧯 Reward Engine S16 disabled (skip boot)");
} else
  try {
    const rewardEngineMod = await import("./server/core/rewardEngine.js");
    const ensureModel = rewardEngineMod.ensureModel || rewardEngineMod.default?.ensureModel;
    const systemStartupCheck = rewardEngineMod.systemStartupCheck || rewardEngineMod.default?.systemStartupCheck;

    if (typeof ensureModel === "function") {
      const okEnsure = await ensureModel();
      if (!okEnsure) console.warn("⚠️ RewardEngine ensureModel => false (devam)");
    }
    if (typeof systemStartupCheck === "function") {
      await systemStartupCheck();
    } else {
      console.warn("⚠️ rewardEngine.systemStartupCheck bulunamadı");
    }
    console.log("✅ Reward Engine S16 boot tamam");
  } catch (e) {
    console.warn("⚠️ RewardEngine boot error (soft):", e?.message || e);
  }

  // Routes (router first, then inline fallback)
  await registerRouterRoutes(app);
  registerInlineRoutes(app);

  // Optional frontend static hosting (only if dist exists)
  // Keeps clean URLs working on refresh: /privacy, /cookies, etc.
  try {
    mountFrontend(app);
  } catch (e) {
    console.warn("⚠️ mountFrontend warn:", e?.message || e);
  }

  // Optional: auto-loader (explicit ON only)
  try {
    const AUTO_ROUTE_LOADER = String(process.env.FINDALLEASY_AUTO_ROUTE_LOADER || "0") === "1";
    if (AUTO_ROUTE_LOADER) await loadRouteModules(app);
  } catch (e) {
    console.warn("⚠️ AUTO_ROUTE_LOADER warn:", e?.message || e);
  }

  // Learning sync
  try {
    setInterval(syncLearningToMongo, 300000);
  } catch {}

  // HTTP + WS
  const httpServer = createServer(app);
  try {
    createTelemetryWSS(httpServer);
  } catch (e) {
    console.warn("⚠️ Telemetry WS init warn:", e?.message || e);
  }

  httpServer.listen(PORT, () => {
    console.log("HTTP+WS server running on", PORT);
  });
}

main().catch((e) => {
  console.error("💥 MAIN_FATAL:", e?.message || e);
  process.exit(1);
});
