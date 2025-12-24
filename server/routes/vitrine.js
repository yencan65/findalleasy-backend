// server/routes/vitrine.js
// ============================================================================
//  VITRINE ROUTER — S30 IAM-FORTRESS EDITION + S33 HEALTH ROUTER
//  ZERO DELETE — mevcut davranışlar korunur, sadece güçlendirme yapılır.
//  PATCH: 500 kalkanı + dev token toleransı + preflight + alaka filtresi
//  FIX: provider blocklist underscore bug + catch 500 -> 200 empty-state
// ============================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";

import { getDb } from "../db.js";
import { buildDynamicVitrin, buildDynamicVitrinSafe } from "../core/vitrinEngine.js";
import { getCachedResult, setCachedResult } from "../core/cacheEngine.js";
import { detectIntent } from "../core/intentEngine.js";

// ⭐ S33 HEALTH INTENT & MAP
import { detectHealthIntent } from "../core/intentEngine/healthIntent.js";
import { getHealthAdapters } from "../core/adapterEngine/healthAdapterMap.js";
import { HEALTH_PROVIDER_PRIORITY } from "../core/providerPriority/healthPreset.js";

import crypto from "crypto";
import { fixQueryTyposTR } from "../utils/queryTypoFixer.js";

const router = express.Router();

// ============================================================================
//  IAM — TOKEN REPLAY SHIELD (S30) — HARDENED (normal akışı kırmaz)
// ============================================================================

const recentTokens = new Map();

function isReplay(tokenHash, ctx = {}) {
  try {
    if (!tokenHash) return false;

    const now = Date.now();
    const ip = String(ctx?.ip || "");
    const ua = String(ctx?.ua || "");
    const fp = ip && ua ? `${ip}|${ua}` : ip || ua || "";

    const rec0 = recentTokens.get(tokenHash);

    const rec =
      rec0 && typeof rec0 === "object"
        ? rec0
        : { first: now, last: 0, count: 0, total: 0, fp: fp || "" };

    if (fp && rec.fp && rec.fp !== fp) return true;

    if (rec.last && now - rec.last < 2000) rec.count = (rec.count || 0) + 1;
    else rec.count = 0;

    if (!rec.first) rec.first = now;
    rec.last = now;
    if (!rec.fp && fp) rec.fp = fp;

    rec.total = (rec.total || 0) + 1;
    recentTokens.set(tokenHash, rec);

    if ((rec.count || 0) >= 8) return true;

    if (rec.first && now - rec.first < 10 * 60 * 1000 && (rec.total || 0) > 500) return true;

    if (recentTokens.size > 8000) {
      for (const [k, v] of recentTokens.entries()) {
        const ts = typeof v === "object" ? v.last : v;
        if (!ts || now - ts > 30 * 60 * 1000) recentTokens.delete(k);
      }
    }

    return false;
  } catch {
    return false;
  }
}

function hashToken(t) {
  try {
    return crypto.createHash("sha256").update(String(t)).digest("hex");
  } catch {
    return "";
  }
}

// ============================================================================
//  IAM — JWT + SESSION-BINDING VERIFY
// ============================================================================
function verifyIAM(req) {
  const auth = req.headers["authorization"];

  if (!auth) {
    if (process.env.NODE_ENV !== "production") {
      return { ok: true, userId: "guest", session: null, tokenHash: null, devBypass: true };
    }
    return { ok: false, reason: "NO_AUTH_HEADER" };
  }

  const token = String(auth).replace("Bearer ", "").trim();
  if (!token) return { ok: false, reason: "EMPTY_TOKEN" };

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || "FINDALLEASY_SECRET", {
      algorithms: ["HS256"],
      maxAge: "3h",
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      return {
        ok: true,
        userId: "guest",
        session: null,
        tokenHash: null,
        devBypass: true,
        devInvalidToken: true,
        reason: "INVALID_JWT_DEV_BYPASS",
        detail: err?.message,
      };
    }
    return { ok: false, reason: "INVALID_JWT", detail: err?.message };
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "0.0.0.0";
  const ua = String(req.headers["user-agent"] || "").slice(0, 100);

  if (decoded.ip && decoded.ip !== ip) return { ok: false, reason: "IP_MISMATCH" };
  if (decoded.ua && decoded.ua !== ua) return { ok: false, reason: "UA_MISMATCH" };

  const tokenHash = hashToken(token);
  if (isReplay(tokenHash, { ip, ua })) return { ok: false, reason: "TOKEN_REPLAY_BLOCKED" };

  return {
    ok: true,
    userId: decoded.userId || "guest",
    session: decoded.sessionId || null,
    tokenHash,
  };
}

// ============================================================================
//  🧽 STRING TEMİZLEME
// ============================================================================
function sanitize(input = "") {
  try {
    const s = input?.toString?.() ?? "";
    return s
      .replace(/[<>$;{}\[\]()=]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function safeRegion(region) {
  const r = sanitize(region || "");
  if (/^[A-Z]{2,5}$/.test(r)) return r;
  return "TR";
}

function safeUserId(userId) {
  const u = sanitize(userId || "");
  if (/^[a-zA-Z0-9_\-]{4,64}$/.test(u)) return u;
  return "guest";
}

function safeSessionId(sessionId) {
  const s = sanitize(sessionId || "");
  return s.replace(/[^a-zA-Z0-9_.\-]/g, "").slice(0, 64);
}

// ============================================================================
//  IP / JSON UTILS
// ============================================================================
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || "0.0.0.0";
}

function toJsonSafe(value, maxDepth = 6) {
  const seen = new WeakSet();

  const walk = (v, depth) => {
    if (depth > maxDepth) return "[max_depth]";
    if (v === null || v === undefined) return v;

    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "bigint") return v.toString();
    if (t === "function") return undefined;
    if (t === "symbol") return String(v);

    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: String(v.stack || "").slice(0, 1200) };
    }

    if (Array.isArray(v)) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      return v.slice(0, 400).map((x) => walk(x, depth + 1));
    }

    if (t === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      const out = {};
      const keys = Object.keys(v).slice(0, 400);
      for (const k of keys) {
        const w = walk(v[k], depth + 1);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }

    return String(v);
  };

  try {
    return walk(value, 0);
  } catch (e) {
    return {
      ok: true,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      _meta: { source: "toJsonSafe_error", reason: e?.message || "unknown" },
    };
  }
}


// ============================================================================
//  🖼️ BEST-ONLY NORMALIZATION + BLANK.GIF FILTER (S200)
// ============================================================================
function isBadImageUrl(u) {
  const s = String(u || "").trim();
  if (!s) return true;
  const l = s.toLowerCase();
  if (l.startsWith("data:image/gif")) return true;
  if (l.includes("blank.gif")) return true;
  if (l.includes("/static/css/jquery/img/blank.gif")) return true;
  if (l === "about:blank") return true;
  return false;
}

function normalizeImg(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = "https:" + s;
  return s;
}

function patchBestImage(it) {
  if (!it || typeof it !== "object") return it;

  const candidates = [
    it.image,
    it.imageUrl,
    it.img,
    it.thumbnail,
    it.thumb,
    ...(Array.isArray(it.images) ? it.images : []),
    ...(Array.isArray(it.raw?.images) ? it.raw.images : []),
  ]
    .map(normalizeImg)
    .filter((x) => x && !isBadImageUrl(x));

  const image = candidates[0] || "";
  if (!image) return it;
  if (it.image === image) return it;
  return { ...it, image };
}


// ============================================================================
//  SAFE STRING (S34) — helper used by best-only payload builder
// ============================================================================
function safeStr(v, maxLen = 256) {
  try {
    const s = sanitize(v ?? "");
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  } catch {
    return "";
  }
}


function toBestOnlyPayload(selected, query) {
  const qSafe = safeStr(query);
  const regionSafe = safeStr(selected?.region || selected?._meta?.region || "TR");
  const localeSafe = safeStr(selected?.locale || selected?._meta?.locale || "tr");

  const best = selected?.best || null;
  const best_list = Array.isArray(selected?.best_list)
    ? selected.best_list
    : (Array.isArray(selected?.items) ? selected.items : []);

  const isBadImg = (u) => {
    const s = String(u || "").trim().toLowerCase();
    return (
      !s ||
      s === "about:blank" ||
      s.startsWith("data:image/gif") ||
      s.includes("blank.gif") ||
      s.includes("/static/css/jquery/img/blank.gif")
    );
  };

  const isHomeUrl = (u) => {
    const s = String(u || "").trim();
    if (!s) return true;
    try {
      const x = new URL(s);
      const p = x.pathname || "/";
      return p === "/" || p === "/index.html";
    } catch {
      return true;
    }
  };

  const patchItem = (it) => {
    if (!it || typeof it !== "object") return null;

    // region normalize
    it.region = typeof it.region === "string" ? it.region : regionSafe;

    // image fix
    if (isBadImg(it.image)) {
      const imgs = Array.isArray(it.images) ? it.images : [];
      const pick = imgs.find((x) => !isBadImg(x));
      if (pick) it.image = pick;
    }

    // link fix (home page link = conversion killer)
    const click = !isHomeUrl(it.finalUrl || it.url)
      ? (it.finalUrl || it.url)
      : (!isHomeUrl(it.originUrl) ? it.originUrl : (it.finalUrl || it.url || it.originUrl));

    if (click) {
      it.finalUrl = click;
      it.url = click;
    }

    return it;
  };

  const patchedList = best_list
    .map(patchItem)
    .filter(Boolean)
    .slice(0, 12);

  let best0 = patchedList[0] || patchItem(best);
  if (best0 && patchedList.length === 0) patchedList.push(best0);

  return {
    ok: true,
    query: qSafe,
    q: qSafe,
    category: selected?.category || selected?._meta?.category || undefined,
    group: selected?.group || selected?.category || undefined,
    region: regionSafe,
    locale: localeSafe,
    best: best0 || null,
    best_list: patchedList,
    items: patchedList,
    count: patchedList.length,
    total: patchedList.length,
    cards: { best: best0 || null, best_list: patchedList },
    _meta: selected?._meta || {},
  };
}

function safeJson(res, obj, code = 200) {
  try {
    if (res.headersSent) return;
    const safeObj = toJsonSafe(obj);
    if (code !== 200) return res.status(code).json(safeObj);
    return res.json(safeObj);
  } catch (err) {
    if (res.headersSent) return;
    return res.status(200).json({
      ok: true,
      best: null,
      best_list: [],
      cards: { best: null, best_list: [] },
      _meta: { source: "safeJson_fallback", reason: "JSON_SERIALIZATION_ERROR", detail: err?.message },
    });
  }
}

// ============================================================================
//  NORMALIZER (korunuyor)
// ============================================================================
function normalizeVitrinePayload(payload = {}) {
  try {
    const best = Array.isArray(payload.best) ? payload.best : payload.best ? [payload.best] : [];
    const smart = Array.isArray(payload.smart) ? payload.smart : payload.smart ? [payload.smart] : [];
    const others = Array.isArray(payload.others) ? payload.others : payload.others ? [payload.others] : [];
    return { ok: true, best, smart, others, nextCursor: payload.nextCursor || null };
  } catch {
    return { ok: true, best: [], smart: [], others: [], nextCursor: null };
  }
}

// ============================================================================
//  RELEVANCE FILTER — "saçma sapan alakasız" kartları kes
// ============================================================================

const TR_STOP = new Set([
  "ve","ile","için","icin","en","çok","cok","uygun","ucuz","fiyat","kampanya","indirim","orijinal",
  "resmi","satıcı","satici","ürün","urun","hizmet","satın","satin","al","alma","almak",
  "bul","bulun","bana","lütfen","lutfen"
]);

function normText(s) {
  try {
    return String(s || "")
      .toLowerCase()
      .replace(/ı/g, "i")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// 🔥 providerKey gibi “anahtarlar” için underscore/hyphen koruyan normalize
function normKey(s) {
  try {
    return String(s || "")
      .toLowerCase()
      .replace(/ı/g, "i")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c")
      .replace(/[^a-z0-9_\-]/g, "") // underscore/hyphen kalsın
      .trim();
  } catch {
    return "";
  }
}

function tokenize(s) {
  const n = normText(s);
  if (!n) return [];
  const parts = n.split(" ").filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 1) continue;
    if (TR_STOP.has(p)) continue;
    out.push(p);
  }
  return out.slice(0, 16);
}

function hasAny(qNorm, list) {
  for (const w of list) if (qNorm.includes(w)) return true;
  return false;
}

function inferCategoryFromQuery(qSafe) {
  const q = normText(qSafe);

  const serviceWords = [
    "kiralama","tamir","tesisat","boya","temizlik","nakliye","tadilat","servis","montaj","kurulum",
    "usta","hizmet","ozel ders","ders","avukat","danisman","sigorta","emlak","arac kiralama"
  ];

  const travelWords = [
    "otel","ucak","uçak","bilet","bileti","tur","tatil","seyahat","rent a car","araba","arac",
    "transfer","booking","airbnb"
  ];

  if (hasAny(q, travelWords)) return "travel";
  if (hasAny(q, serviceWords)) return "service";
  return "product";
}

const SERVICE_PROVIDER_BLOCKLIST = new Set([
  "armut",
  "bionluk",
  "sahibinden_hizmet",
  "ustam",
  "usta",
  "hizmet",
]);

function itemHaystack(item) {
  try {
    const t = [
      item?.title,
      item?.name,
      item?.provider,
      item?.providerKey,
      item?.category,
      item?.type,
      item?.desc,
      item?.description,
      Array.isArray(item?.tags) ? item.tags.join(" ") : "",
    ].filter(Boolean);
    return normText(t.join(" "));
  } catch {
    return "";
  }
}

function isRelevantItem(item, qSafe) {
  if (!item) return false;

  const qNorm = normText(qSafe);
  if (!qNorm) return true;

  const hay = itemHaystack(item);
  if (!hay) return false;

  if (hay.includes(qNorm)) return true;

  const qTokens = tokenize(qNorm);
  if (!qTokens.length) return true;

  const tTokens = new Set(tokenize(hay));
  let hit = 0;
  for (const qt of qTokens) if (tTokens.has(qt)) hit++;

  const ratio = hit / Math.max(1, qTokens.length);

  if (qTokens.length === 1) {
    const one = qTokens[0];
    return hay.includes(one);
  }

  return ratio >= 0.4;
}

function filterItemsForQuery(items, qSafe, intent) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : items ? [items] : [];
  if (!arr.length) return arr;

  const qKind = inferCategoryFromQuery(qSafe);
  const qNorm = normText(qSafe);

  const serviceHint = qKind === "service";
  const productHint = qKind === "product";

  const out = [];
  for (const it of arr) {
    try {
      const providerKey = normKey(it?.providerKey || it?.provider || "");
      if (productHint && providerKey && SERVICE_PROVIDER_BLOCKLIST.has(providerKey)) {
        if (!serviceHint && !hasAny(qNorm, ["hizmet","kiralama","tamir","usta","servis"])) continue;
      }

      if (!isRelevantItem(it, qSafe)) continue;

      out.push(it);
    } catch {}
  }

  return out;
}

function postFilterSelected(selected, qSafe, intent) {
  try {
    if (!selected || typeof selected !== "object") return selected;

    const bestArr = filterItemsForQuery(
      selected.best_list || (selected.best ? [selected.best] : []),
      qSafe,
      intent
    );
    const smartArr = filterItemsForQuery(selected.smart || [], qSafe, intent);
    const othersArr = filterItemsForQuery(selected.others || [], qSafe, intent);

    const best = bestArr.length ? bestArr[0] : null;

    selected.best = best;
    selected.best_list = bestArr;
    selected.smart = smartArr;
    selected.others = othersArr;

    if (!selected.cards || typeof selected.cards !== "object") {
      selected.cards = { best, best_list: bestArr, smart: smartArr, others: othersArr };
    }

    return selected;
  } catch {
    return selected;
  }
}

// ============================================================================
//  🛡 IAM FIREWALL (S30) — API KEY + JWT + SESSION BINDING
// ============================================================================

// ============================================================================
//  PUBLIC ALLOWLIST (S34) — vitrin/search büyümenin can damarı
//  - Public = rate limit + abuse shield
//  - Private = auth (admin/user-only endpointler)
//  - ZERO DELETE: IAM mantığı korunur, sadece allowlist bypass eklenir.
// ============================================================================
const PUBLIC_VITRINE_ROUTES = new Set(["/ping", "/dynamic", "/"]);
const PUBLIC_VITRINE_PREFIXES = ["/api/vitrin", "/api/vitrine"];

function normalizePublicPath(raw) {
  try {
    let s = String(raw || "");
    if (!s) return "";
    // strip querystring + absolute URL prefix if present
    s = s.split("?")[0].replace(/^https?:\/\/[^/]+/i, "");
    if (!s.startsWith("/")) s = "/" + s;
    // collapse duplicate slashes
    s = s.replace(/\/\/{2,}/g, "/");
    // trim trailing slash (except root)
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return "";
  }
}

function isPublicVitrineRoute(req) {
  try {
    const candidates = [];
    const push = (v) => {
      if (v === undefined || v === null) return;
      const s = normalizePublicPath(v);
      if (s) candidates.push(s);
    };

    // Express variants (bazen path/baseUrl/originalUrl farklı gelebiliyor)
    push(req?.path);
    push(req?.url);
    push(req?.originalUrl);
    try {
      if (req?.baseUrl && req?.path) push(String(req.baseUrl) + String(req.path));
    } catch {}

    for (const p of candidates) {
      if (PUBLIC_VITRINE_ROUTES.has(p)) return true;

      for (const pre of PUBLIC_VITRINE_PREFIXES) {
        if (!pre) continue;
        const preN = normalizePublicPath(pre);
        if (!preN) continue;

        // exact mount root: /api/vitrin  => treat as "/"
        if (p === preN && PUBLIC_VITRINE_ROUTES.has("/")) return true;

        if (p.startsWith(preN + "/")) {
          let tail = p.slice(preN.length);
          if (!tail) tail = "/";
          tail = normalizePublicPath(tail);
          if (PUBLIC_VITRINE_ROUTES.has(tail)) return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

router.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);


  // ✅ PUBLIC: vitrine endpointleri auth istemez (growth-friendly)
  if (isPublicVitrineRoute(req)) {
    res.setHeader("x-fae-public", "1");
    req.IAM = { ok: true, userId: "guest", session: null, public: true };
    return next();
  }

  const clientKey = req.headers["x-api-key"];
  if (process.env.API_KEY && clientKey !== process.env.API_KEY) {
    return safeJson(res, { ok: false, error: "Unauthorized request" }, 403);
  }

  const iam = verifyIAM(req);

  if (!iam.ok) {
    if (process.env.NODE_ENV !== "production") {
      req.IAM = { ok: true, userId: "guest", session: null, devBypass: true, devIAMReject: true, reason: iam.reason };
      return next();
    }
    return safeJson(res, { ok: false, error: "IAM_REJECTED", detail: iam.reason }, 401);
  }

  req.IAM = iam;
  next();
});

// ============================================================================
//  RATE LIMIT
// ============================================================================
const limiter = rateLimit({
  windowMs: 40 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(limiter);

router.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  })
);


// ---------------------------------------
// PING (healthcheck / debug)
// ---------------------------------------
router.get("/ping", (req, res) => {
  return safeJson(res, { ok: true, service: "vitrine", ts: Date.now() });
});

// ============================================================================
//  CORE
// ============================================================================
async function handleVitrinCore(req, res) {
  try {
    const body = req.body || {};
    const rawQuery = body.query?.toString?.() ?? "";
    const typo = fixQueryTyposTR(rawQuery);
    const fixedQuery = typo?.query || rawQuery;
    const rawRegion = body.region || "TR";
    const rawLocale = body.locale || body.lang || "tr";

    const iam = req.IAM || {};
    const userSafe = safeUserId(iam?.userId || "guest");

    let qSafe = sanitize(fixedQuery);
    const regionSafe = safeRegion(rawRegion);
    const localeSafe = String(rawLocale || "tr");
    const clientIp = getClientIp(req);

    const sessionId = safeSessionId(String(req.headers["x-session-id"] || body.sessionId || iam?.session || ""));

    const userId =
      userSafe !== "guest"
        ? userSafe
        : "guest_" + crypto.createHash("sha256").update(String(clientIp || "guest")).digest("hex").slice(0, 16);

    if (qSafe.length > 256) qSafe = qSafe.slice(0, 256);

    // 0) HEALTH
    try {
      const healthIntent = detectHealthIntent(qSafe);
      if (healthIntent && healthIntent !== "non_health") {
        const adapters = getHealthAdapters(healthIntent) || [];
        let results = [];

        for (const fn of adapters) {
          try {
            const part = await fn(qSafe, { region: regionSafe });
            if (Array.isArray(part)) results.push(...part);
          } catch {}
        }

        for (const item of results) {
          try {
            item.__providerPriority = HEALTH_PROVIDER_PRIORITY[item.provider] || 0.4;
          } catch {}
        }

        results = filterItemsForQuery(results, qSafe, { type: "health" });

        return safeJson(res, { ok: true, mode: "health", healthIntent, items: results });
      }
    } catch {}

    // 1) NORMAL INTENT
    let intent = null;
    try {
      intent = await detectIntent({ query: fixedQuery, source: "text" });

    } catch {}

    try {
      const inferred = inferCategoryFromQuery(qSafe);
      const t = intent?.type || intent?.category || "";
      const tNorm = normText(t);
      if (!tNorm || tNorm === "mixed" || tNorm === "general") {
        intent = { ...(intent || {}), type: inferred, category: inferred, _forcedBy: "route_heuristic" };
      }
    } catch {}

    let b64 = "-";
    try {
      b64 = qSafe ? Buffer.from(qSafe).toString("base64") : "-";
    } catch {
      b64 = qSafe ? encodeURIComponent(qSafe) : "-";
    }
    const cacheKey = `vitrine:${regionSafe}:${userId}:${b64}`;

    try {
      const cached = await getCachedResult(cacheKey);
      const cachedPayload = cached?.data || cached;
      if (cachedPayload && typeof cachedPayload === "object") {
        const outCached = toBestOnlyPayload(cachedPayload, qSafe);
        return safeJson(res, outCached);
      }
    } catch {}

    // Mongo preferred
    let preferredType = null;
    try {
      const db = await getDb();
      const col = db.collection("userLearning");
      if (col && userSafe !== "guest") {
        const userData = await col.findOne({ userId: userSafe });
        preferredType = userData?.lastSearch || null;
      }
    } catch {}

    // Engine
    let engineData = null;
    try {
      const enginePromise = (async () => {
        try {
          if (typeof buildDynamicVitrinSafe === "function") {
            return await buildDynamicVitrinSafe(qSafe, regionSafe, userId, {
              intent,
              preferredType,
              clientIp,
              sessionId,
            });
          }
        } catch {}
        return await buildDynamicVitrin(qSafe, regionSafe, userId, {
          intent,
          preferredType,
          clientIp,
          sessionId,
        });
      })();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("vitrinEngine timeout")), 11000)
      );

      engineData = await Promise.race([enginePromise, timeoutPromise]);
    } catch {}

    // Fallback
    const mockBestItem = {
      id: "route_mock_best",
      title: "En Uygun Satıcı",
      provider: "findalleasy",
      providerKey: "findalleasy",
      price: null,
      finalUserPrice: null,
      priceHint: "₺999",
      category: "product",
      region: regionSafe,
      rating: 0,
      trustScore: 0,
      qualityScore: 0,
      cardType: "main",
      isPlaceholder: true,
    };

    const mockData = {
      ok: true,
      query: qSafe,
      category: "product",
      best: mockBestItem,
      best_list: [mockBestItem],
      smart: [],
      others: [],
      cards: { best: mockBestItem, best_list: [mockBestItem], smart: [], others: [] },
      _meta: { source: "route_fallback", reason: "engine_timeout_or_error" },
    };

    const hasRealQuery = !!qSafe && String(qSafe).trim().length > 0;

    const fallbackEmpty = {
      ok: true,
      query: qSafe,
      category: (intent && (intent.type || intent.category)) || preferredType || "general",
      best: null,
      best_list: [],
      cards: { best: null, best_list: [] },
      _meta: { source: "route_fallback_empty", reason: "engine_timeout_or_error" },
    };

    let selected = engineData?.ok ? engineData : hasRealQuery ? fallbackEmpty : mockData;

    if (!selected || typeof selected !== "object") selected = mockData;

    if (!Array.isArray(selected.best_list)) selected.best_list = [];
    if (selected.best && selected.best_list.length === 0) selected.best_list = [selected.best];
    if (!selected.best && selected.best_list.length > 0) selected.best = selected.best_list[0];

    if (!Array.isArray(selected.smart)) selected.smart = selected.smart ? [selected.smart] : [];
    if (!Array.isArray(selected.others)) selected.others = selected.others ? [selected.others] : [];

    selected = postFilterSelected(selected, qSafe, intent);

    const hasAnyRealContent =
      !!selected.best ||
      (Array.isArray(selected.best_list) && selected.best_list.length > 0) ||
      (Array.isArray(selected.smart) && selected.smart.length > 0) ||
      (Array.isArray(selected.others) && selected.others.length > 0);

    if (hasRealQuery && !hasAnyRealContent) {
      // ✅ BEST ONLY + adapterEngine fallback (vitrinEngine bazen boş dönebiliyor)
      try {
        const t = String((intent && (intent.type || intent.category)) || preferredType || "product");
        let cat = normText(t) || "product";
        if (!cat || cat === "general" || cat === "mixed") cat = "product";

        const eng = await import("../core/adapterEngine.js");

        let raw = null;
        const engOpts = { limit: 24, offset: 0, region: regionSafe, locale: localeSafe, categoryHint: cat, preferredType: cat, category: cat, group: cat };
        try {
          raw = await eng.runAdapters(qSafe, regionSafe, engOpts);
        } catch (_) {
          try {
            raw = await eng.runAdapters(qSafe, cat, engOpts);
          } catch (_) {
            try {
              raw = await eng.runAdapters(qSafe, engOpts);
            } catch (_) {}
          }
        }
const items = Array.isArray(raw?.items)
          ? raw.items
          : Array.isArray(raw?.results)
          ? raw.results
          : Array.isArray(raw)
          ? raw
          : [];

        if (items.length > 0) {
          const priceOf = (it) => {
            const v = it?.optimizedPrice ?? it?.finalPrice ?? it?.price;
            const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
            return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
          };

          const sorted = items.slice().sort((a, b) => priceOf(a) - priceOf(b));

          selected = {
            ok: raw?.ok === false ? false : true,
            query: qSafe,
            q: qSafe,
            category: cat,
            region: regionSafe,
            locale: localeSafe,
            best: sorted[0] || null,
            best_list: sorted.slice(0, 12),
            _meta: {
              ...(raw?._meta || {}),
              source: "route_adapterEngine_fallback",
              fallbackUsed: true,
              reason: selected?._meta?.reason,
            },
          };
        }
      } catch {}

      const out = toBestOnlyPayload(selected, qSafe);
      const outSafe = toJsonSafe(out);
      try {
        await setCachedResult(cacheKey, outSafe, 120);
      } catch {}
      return safeJson(res, outSafe);
    }

    if (!selected.best && selected.best_list.length === 0) {
      const ALLOW_PLACEHOLDER = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";
      if (ALLOW_PLACEHOLDER) {
        const placeholder = {
          id: "route_empty",
          title: "Şu anda satıcılar yanıt vermiyor",
          provider: "system",
          providerKey: "system",
          price: null,
          finalUserPrice: null,
          priceHint: "Biraz sonra tekrar deneyin",
          category: "product",
          region: regionSafe,
          isPlaceholder: true,
        };

        selected.best = placeholder;
        selected.best_list = [placeholder];
        if (selected.cards && typeof selected.cards === "object") {
          selected.cards.best = placeholder;
          selected.cards.best_list = [placeholder];
        }
      }
    }

    const out = toBestOnlyPayload(selected, qSafe);
    const outSafe = toJsonSafe(out);
    try {
      await setCachedResult(cacheKey, outSafe, 300);
    } catch {}

    return safeJson(res, outSafe);
  } catch (err) {
    const body = req.body || {};
    const qSafe = sanitize(body.query || "");
    const regionSafe = safeRegion(body.region || "TR");

    return safeJson(res, {
      ok: true,
      query: qSafe,
      category: "general",
      best: null,
      best_list: [],
      smart: [],
      others: [],
      cards: { best: null, best_list: [], smart: [], others: [] },
      _meta: { source: "route_exception", reason: String(err?.message || err || "unknown"), region: regionSafe },
    });
  }
}

// ============================================================================
//  ROUTES
// ============================================================================
router.options("/dynamic", (req, res) => res.sendStatus(204));
router.options("/", (req, res) => res.sendStatus(204));
router.options("/mock", (req, res) => res.sendStatus(204));

router.all("/dynamic", (req, res, next) => {
  try {
    const query =
  req.method === "GET"
    ? (req.query.q || req.query.query)
    : (req.body?.query ?? req.body?.q);

    const region = req.method === "GET" ? req.query.region : req.body?.region;

    req.body = {
      ...(req.body || {}),
      query: query ?? "",
      region: region ?? "",
      sessionId: req.body?.sessionId || req.headers["x-session-id"] || "",
    };

    return next();
  } catch (e) {
    // ✅ ZERO-CRASH: 500 basma, UI'yi öldürme
    return safeJson(res, {
      ok: true,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      cards: { best: null, best_list: [], smart: [], others: [] },
      _meta: { source: "DYNAMIC_ERROR", reason: String(e?.message || e || "unknown") },
    });
  }
});

router.post("/dynamic", handleVitrinCore);
router.get("/dynamic", handleVitrinCore);

router.post("/", handleVitrinCore);

router.get("/", (req, res) => {
  try {
    const q = req.query.q || req.query.query || "";
    const region = req.query.region || "TR";

    req.body = { ...(req.body || {}), query: q, region };
    return handleVitrinCore(req, res);
  } catch (e) {
    // ✅ ZERO-CRASH
    return safeJson(res, {
      ok: true,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      cards: { best: null, best_list: [], smart: [], others: [] },
      _meta: { source: "ROOT_ROUTE_ERROR", reason: String(e?.message || e || "unknown") },
    });
  }
});

router.post("/mock", (req, res) => {
  try {
    const qSafe = sanitize(req.body?.query || "");
    const regionSafe = safeRegion(req.body?.region || "TR");

    const mockBestItem = {
      id: "mock_best",
      title: "En Uygun Satıcı",
      provider: "findalleasy",
      providerKey: "findalleasy",
      price: null,
      finalUserPrice: null,
      priceHint: "₺999",
      category: "product",
      region: regionSafe,
      rating: 0,
      trustScore: 0,
      qualityScore: 0,
      cardType: "main",
      isPlaceholder: true,
    };

    return safeJson(res, {
      ok: true,
      query: qSafe,
      category: "product",
      best: mockBestItem,
      best_list: [mockBestItem],
      smart: [],
      others: [],
      cards: { best: mockBestItem, best_list: [mockBestItem], smart: [], others: [] },
      _meta: { source: "route_mock", reason: "engine_unavailable" },
    });
  } catch (err) {
    return safeJson(res, {
      ok: true,
      best: null,
      best_list: [],
      smart: [],
      others: [],
      cards: { best: null, best_list: [], smart: [], others: [] },
      _meta: { source: "mock_exception", reason: String(err?.message || err || "unknown") },
    });
  }
});

export default router;
