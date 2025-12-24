// server/core/revenueMemoryEngine.js
// ===================================================================
//  H E R K Ü L   S 2 0 0   —  R E V E N U E   M E M O R Y   E N G I N E
//  ULTRA OMEGA FINAL FUSION
//
//  ZERO DELETE — Eski S15 API tamamen korunur
//  S200 ana motor (scoreItem, providerPolicyBoost, s10_dynamicProviderBoost)
//  tarafından tüketilen tüm metrikler STABİL, SAFE, ATOMIC, NaN-proof.
//
//  TrendBrain • NeuroScore++ • ConversionVelocity+
//  Atomic FS + Race Proof Lock + JSON Self-Heal
// ===================================================================

import fs from "fs";
import path from "path";
import { recordProviderSignal } from "./rewardEngineS9.js";

// ===================================================================
// GLOBAL ATOMIC LOCK — yarış koruması
// ===================================================================
let LOCK = Promise.resolve();
function acquireLock(fn) {
  LOCK = LOCK.then(fn).catch((err) => {
    console.error("RevenueMemory atomic error:", err);
  });
  return LOCK;
}

// ===================================================================
// SIGNAL BRIDGE — (S9 ile tam uyumlu)
// ===================================================================
export async function recordProviderClick({ provider, url, price }) {
  await recordProviderSignal({
    provider,
    event: "click",
    amount: price || 0,
    commissionRate: null,
    userId: null,
    orderId: null,
  });
}

export async function recordProviderConversion({
  provider,
  amount,
  commissionRate,
  userId,
  orderId,
}) {
  await recordProviderSignal({
    provider,
    event: "conversion",
    amount: amount || 0,
    commissionRate: commissionRate || null,
    userId: userId || null,
    orderId: orderId || null,
  });
}

// ===================================================================
// MEMORY CORE — Atomic FS Boot
// ===================================================================
const MEMORY_FILE = path.join(process.cwd(), "revenueMemory.json");
const TEMP_FILE = MEMORY_FILE + ".tmp";

let memory = {};

// INITIAL LOAD + SELF HEAL
try {
  if (fs.existsSync(MEMORY_FILE)) {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") memory = parsed;
  }
} catch (err) {
  console.error("RevenueMemory load error:", err);
  memory = {};
}

// Atomic Write
async function atomicWrite(data) {
  try {
    await fs.promises.writeFile(TEMP_FILE, data);
    await fs.promises.rename(TEMP_FILE, MEMORY_FILE);
  } catch (err) {
    console.error("RevenueMemory atomic write failed:", err);
  }
}

let lastSave = 0;
let pendingSave = false;

async function scheduleSave() {
  const now = Date.now();
  if (pendingSave || now - lastSave < 2000) return;

  pendingSave = true;
  lastSave = now;

  const data = JSON.stringify(memory, null, 2);
  await atomicWrite(data);

  pendingSave = false;
}

// ===================================================================
// HELPERS — S200 Stabilizasyon
// ===================================================================
function ensureProvider(provider) {
  const p = (provider || "unknown").toLowerCase();

  if (!memory[p]) {
    memory[p] = {
      clicks: 0,
      sales: 0,
      totalRevenue: 0,
      badData: 0,
      updatedAt: Date.now(),
      history: [],

      trendScore: 0,
      freshnessScore: 0,
      neuroScore: 0,

      avgOrderValue: 0,
      conversionVelocity: 0,
      revenuePerClick: 0,
      lastSaleAt: 0,
    };
  }

  return p;
}

function cleanupHistory(p) {
  const ninety = 1000 * 60 * 60 * 24 * 90;
  const now = Date.now();

  memory[p].history = memory[p].history.filter(
    (h) => now - h.ts < ninety && h.revenue >= 0
  );
}

function safeNum(v, fallback = 0) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function calculateTrend(p) {
  const h = memory[p].history;
  if (!Array.isArray(h) || !h.length) return 0;

  let weighted = 0;
  let wsum = 0;

  const now = Date.now();

  for (const entry of h) {
    if (!entry) continue;

    const age = now - safeNum(entry.ts, now);
    let w = 1;

    if (age < 86400000) w = 3;
    else if (age < 604800000) w = 2;

    const rev = safeNum(entry.revenue, 0);

    weighted += rev * w;
    wsum += w;
  }

  if (wsum <= 0) return 0;
  return weighted / wsum;
}

function calculateFreshness(p) {
  const diff = Date.now() - safeNum(memory[p].updatedAt, Date.now());
  if (diff < 3600000) return 1.0;
  if (diff < 86400000) return 0.7;
  if (diff < 604800000) return 0.4;
  return 0.1;
}

function computeNeuroScore(p) {
  const st = memory[p];
  if (!st) return 0;

  const clicks = safeNum(st.clicks, 0);
  const sales = safeNum(st.sales, 0);
  const bad = safeNum(st.badData, 0);

  const cvr = clicks > 0 ? sales / clicks : 0;
  const risk = clicks + sales + bad > 0 ? bad / (clicks + sales + bad) : 0;

  const rpc = clicks > 0 ? safeNum(st.totalRevenue, 0) / clicks : 0;
  const vel = safeNum(st.conversionVelocity, 0);

  const trend = safeNum(st.trendScore, 0);
  const fresh = safeNum(st.freshnessScore, 0);

  return (
    cvr * 0.48 +
    trend * 0.22 +
    fresh * 0.08 +
    (1 - risk) * 0.10 +
    rpc * 0.06 +
    vel * 0.06
  );
}

// ===================================================================
// CLICK EVENT — S200 Safe
// ===================================================================
export function recordClick({ provider, price }) {
  return acquireLock(async () => {
    const p = ensureProvider(provider);

    memory[p].clicks = safeNum(memory[p].clicks, 0) + 1;
    memory[p].updatedAt = Date.now();

    cleanupHistory(p);

    memory[p].trendScore = calculateTrend(p);
    memory[p].freshnessScore = calculateFreshness(p);
    memory[p].neuroScore = computeNeuroScore(p);

    await scheduleSave();
    return memory[p];
  });
}

// ===================================================================
// SALE EVENT — S200 Safe
// ===================================================================
export function recordSale(provider, revenueAmount) {
  return acquireLock(async () => {
    const p = ensureProvider(provider);

    const rev = safeNum(revenueAmount, 0);

    memory[p].sales = safeNum(memory[p].sales, 0) + 1;
    memory[p].totalRevenue = safeNum(memory[p].totalRevenue, 0) + rev;

    memory[p].lastSaleAt = Date.now();

    memory[p].history.push({
      ts: Date.now(),
      clicks: 1,
      sales: 1,
      revenue: rev,
    });

    memory[p].avgOrderValue =
      memory[p].totalRevenue / Math.max(1, memory[p].sales);

    memory[p].revenuePerClick =
      memory[p].totalRevenue / Math.max(1, memory[p].clicks);

    memory[p].conversionVelocity =
      memory[p].sales /
      Math.max(1, (Date.now() - memory[p].updatedAt) / 60000);

    memory[p].updatedAt = Date.now();

    cleanupHistory(p);

    memory[p].trendScore = calculateTrend(p);
    memory[p].freshnessScore = calculateFreshness(p);
    memory[p].neuroScore = computeNeuroScore(p);

    await scheduleSave();
  });
}

// ===================================================================
// BAD DATA
// ===================================================================
export function recordBadData(provider) {
  return acquireLock(async () => {
    const p = ensureProvider(provider);

    memory[p].badData = safeNum(memory[p].badData, 0) + 1;

    memory[p].updatedAt = Date.now();
    memory[p].freshnessScore = calculateFreshness(p);
    memory[p].neuroScore = computeNeuroScore(p);

    await scheduleSave();
  });
}

// ===================================================================
// SINGLE PROVIDER STATS — S200 Stabilize Output
// (S200 motoru scoreItem() içinde burayı kullanıyor)
// ===================================================================
export function getProviderRevenueStats(provider) {
  const p = ensureProvider(provider);

  cleanupHistory(p);

  memory[p].trendScore = calculateTrend(p);
  memory[p].freshnessScore = calculateFreshness(p);
  memory[p].neuroScore = computeNeuroScore(p);

  const clicks = safeNum(memory[p].clicks, 0);
  const sales = safeNum(memory[p].sales, 0);
  const bad = safeNum(memory[p].badData, 0);

  const conversion =
    clicks > 0 ? sales / clicks : 0;

  const riskScore =
    clicks + sales + bad > 0 ? bad / (clicks + sales + bad) : 0;

  return {
    clicks,
    sales,
    totalRevenue: safeNum(memory[p].totalRevenue, 0),
    conversionRate: conversion,
    riskScore,
    trendScore: safeNum(memory[p].trendScore, 0),
    freshnessScore: safeNum(memory[p].freshnessScore, 0),
    neuroScore: safeNum(memory[p].neuroScore, 0),
    avgOrderValue: safeNum(memory[p].avgOrderValue, 0),
    revenuePerClick: safeNum(memory[p].revenuePerClick, 0),
    conversionVelocity: safeNum(memory[p].conversionVelocity, 0),
    lastSaleAt: memory[p].lastSaleAt || 0,
    updatedAt: memory[p].updatedAt || Date.now(),
  };
}

// ===================================================================
// S9 SHIM — DEĞİŞMEDİ
// ===================================================================
export function recordConversion(payload = {}) {
  try {
    const provider = String(payload.provider || "unknown").toLowerCase();

    const amount =
      safeNum(
        payload.amount ??
          payload.total ??
          payload.totalPrice ??
          payload.price ??
          0,
        0
      );

    const rate =
      payload.rate != null && Number.isFinite(Number(payload.rate))
        ? Number(payload.rate)
        : null;

    const userId = payload.userId || null;
    const orderId = payload.orderId || payload.id || null;

    return recordProviderConversion({
      provider,
      amount,
      commissionRate: rate,
      userId,
      orderId,
    });
  } catch (err) {
    console.warn("recordConversion shim error:", err);
    return { ok: false };
  }
}

// ===================================================================
// ALL PROVIDERS — S200
// ===================================================================
export function getAllProviderStats() {
  const out = {};
  for (const provider of Object.keys(memory)) {
    out[provider] = getProviderRevenueStats(provider);
  }
  return out;
}

// ===================================================================
// DEBUG
// ===================================================================
export function debugRevenueMemory() {
  return memory;
}
