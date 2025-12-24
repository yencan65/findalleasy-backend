// server/routes/referral.js
// ===================================================================
//   REFERRAL ENGINE — S21 GOD-KERNEL EDITION
//   • ZERO BREAKING CHANGE
//   • 5-level referral tree (cycle-proof) — KORUNDU
//   • S21: Anti-spam, anti-burst, sanitized inputs, JSON-safe output
//   • S21: Safer recursion guard + time cutoff (DoS engeli)
//   • S21: inviteCode hard-normalization (XSS & unicode mask blok)
//   • S21: Mongo query hijack koruması
// ===================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import User from "../models/User.js";

const router = express.Router();

// ---------------------------------------------------------
// CONFIG — maximum depth
// ---------------------------------------------------------
const MAX_DEPTH = 5;

// ---------------------------------------------------------
// S21 SANITIZERS
// ---------------------------------------------------------
function safeId(v) {
  if (!v) return "";
  let s = String(v).trim();
  if (!/^[a-fA-F0-9]{10,40}$/.test(s)) return ""; // Mongo ObjectId rough check
  return s;
}

function safeCode(v) {
  if (!v) return "";
  let s = String(v).trim().toUpperCase().normalize("NFKC");
  s = s.replace(/[^A-Z0-9\-]/g, "");
  return s.slice(0, 40);
}

function safeJsonObj(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------
// RATE LIMIT + BURST SHIELD — S21
// ---------------------------------------------------------
const limiter = rateLimit({
  windowMs: 4000,
  max: 40,
});
router.use(limiter);

// micro burst per-IP per-route
const burstMap = new Map();
function burst(ip, key, ttl = 500) {
  const k = `${ip}::${key}`;
  const now = Date.now();
  const last = burstMap.get(k) || 0;
  if (now - last < ttl) return false;
  burstMap.set(k, now);
  return true;
}

// ---------------------------------------------------------
// S21 — Safe IP extractor
// ---------------------------------------------------------
function getClientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

// ---------------------------------------------------------
// DB Helper: fetch children safely
// ---------------------------------------------------------
async function fetchChildren(parentId) {
  return User.find({ referredBy: parentId })
    .select("username email inviteCode walletBalance createdAt referredBy")
    .lean();
}

// ---------------------------------------------------------
// S21 — Referral Tree Builder (DoS-proof)
// ---------------------------------------------------------
async function buildReferralTree(rootId, depth = 1, visited = new Set(), startTs = Date.now()) {
  if (!rootId) return [];
  if (depth > MAX_DEPTH) return [];

  // DoS koruması — 150ms'ten uzun recursion anında kesilir
  if (Date.now() - startTs > 150) return [];

  // Cycle protection
  if (visited.has(rootId)) return [];
  visited.add(rootId);

  const children = await fetchChildren(rootId);
  if (!children || children.length === 0) return [];

  const out = [];

  for (const ch of children) {
    const node = {
      userId: ch._id,
      username: ch.username,
      email: ch.email,
      inviteCode: ch.inviteCode || null,
      walletBalance: ch.walletBalance || 0,
      createdAt: ch.createdAt,
      depth,
      children: [],
    };

    node.children = await buildReferralTree(
      String(ch._id),
      depth + 1,
      visited,
      startTs
    );

    out.push(node);
  }

  return out;
}

// ===================================================================
// 1) GET /api/referral/tree/:id
// ===================================================================
router.get("/tree/:id", async (req, res) => {
  try {
    const ip = getClientIp(req);

    const id = safeId(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
    }

    if (!burst(ip, `tree:${id}`)) {
      return res.json({ ok: true, cached: true, tree: [] });
    }

    const user = await User.findById(id).select("_id username email");
    if (!user) {
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }

    const tree = await buildReferralTree(String(user._id));

    return res.json({
      ok: true,
      user: safeJsonObj({
        id: user._id,
        username: user.username,
        email: user.email,
      }),
      totalInvited: tree.length,
      tree: safeJsonObj(tree),
    });
  } catch (err) {
    console.error("REFERRAL TREE ERROR:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ===================================================================
// 2) GET /api/referral/code/:inviteCode
// ===================================================================
router.get("/code/:inviteCode", async (req, res) => {
  try {
    const ip = getClientIp(req);

    const inviteCode = safeCode(req.params.inviteCode);
    if (!inviteCode) {
      return res.status(400).json({ ok: false, error: "INVALID_INVITE_CODE" });
    }

    if (!burst(ip, `code:${inviteCode}`)) {
      return res.json({ ok: true, cached: true, tree: [] });
    }

    const user = await User.findOne({ inviteCode })
      .select("_id username email inviteCode");

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "INVITE_CODE_NOT_FOUND",
      });
    }

    const tree = await buildReferralTree(String(user._id));

    return res.json({
      ok: true,
      inviteCode,
      owner: safeJsonObj({
        id: user._id,
        username: user.username,
        email: user.email,
      }),
      totalInvited: tree.length,
      tree: safeJsonObj(tree),
    });
  } catch (err) {
    console.error("INVITE CODE TREE ERROR:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// ===================================================================
export default router;
