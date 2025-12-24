// ===================================================================
//   REWARD ROUTER — S11.5 OMEGA API LAYER
//   Zero-crash • Zero-ambiguity • Perfect Route Priority
//   Compatible with S11.5 RewardEngine
// ===================================================================

import express from "express";
import {
  getUserRewardsSummary,
  getUserInviteTree,
  checkModelHealth,
} from "../../core/rewardEngine.js";

const router = express.Router();

// ===================================================================
// SAFETY HELPERS
// ===================================================================
function safeJson(res, obj) {
  try {
    return res.json(obj);
  } catch {
    return res.status(500).json({ ok: false, error: "JSON_SERIALIZATION_ERROR" });
  }
}

// ObjectId validator (S11)
function isValidId(id) {
  if (!id || typeof id !== "string") return false;
  if (id.length < 2 || id.length > 200) return false;
  return true; // Esnek: email / ID / ObjectId
}

// ===================================================================
// 1) INVITE TREE ROUTE — En üste alınmalı (yoksa /:id tarafından bloklanır)
// ===================================================================
router.get("/tree/:id", async (req, res) => {
  const { id } = req.params;

  if (!isValidId(id)) {
    return safeJson(res, { ok: false, reason: "INVALID_ID", id });
  }

  try {
    const data = await getUserInviteTree(id);

    if (!data || data.ok === false) {
      return safeJson(res, {
        ok: false,
        reason: "USER_NOT_FOUND",
        id,
      });
    }

    return safeJson(res, data);
  } catch (err) {
    console.error("❌ [rewards] /tree/:id error:", err);
    return safeJson(res, {
      ok: false,
      reason: "SERVER_ERROR",
      error: err?.message,
    });
  }
});

// ===================================================================
// 2) REWARDS SUMMARY
// ===================================================================
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!isValidId(id)) {
    return safeJson(res, { ok: false, reason: "INVALID_ID", id });
  }

  try {
    const data = await getUserRewardsSummary(id);

    if (!data || data.ok === false) {
      return safeJson(res, {
        ok: false,
        reason: "USER_NOT_FOUND",
        id,
      });
    }

    return safeJson(res, data);
  } catch (err) {
    console.error("❌ [rewards] /:id error:", err);
    return safeJson(res, {
      ok: false,
      reason: "SERVER_ERROR",
      error: err?.message,
    });
  }
});

// ===================================================================
// 3) HEALTH CHECK (Opsiyonel ama S11 için kritik)
// ===================================================================
router.get("/system/health/check", async (req, res) => {
  try {
    const health = await checkModelHealth();
    return safeJson(res, health);
  } catch (err) {
    console.error("❌ [rewards] healthCheck error:", err);
    return safeJson(res, {
      ok: false,
      reason: "HEALTH_CHECK_FAILURE",
      error: err?.message,
    });
  }
});

// ===================================================================
// EXPORT
// ===================================================================
export default router;
