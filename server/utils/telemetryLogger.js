// ============================================================================
//  FAE TELEMETRY ENGINE — S100 ULTRA
//  Güvenli, hızlı, queue destekli, KVKK uyumlu
// ============================================================================

import Log from "../models/TelemetryLog.js";

// ------------------------------------------------------------
// IP Masking (KVKK SAFE)
// ------------------------------------------------------------
function maskIp(ip) {
  if (!ip) return "";
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
}

// ------------------------------------------------------------
// Payload limiter
// ------------------------------------------------------------
function safePayload(payload) {
  try {
    const str = JSON.stringify(payload);
    if (str.length > 5000) {
      return {
        truncated: true,
        size: str.length,
        payload: str.slice(0, 5000)
      };
    }
    return payload;
  } catch {
    return { invalidPayload: true };
  }
}

// ------------------------------------------------------------
// LOG QUEUE — Write batching (Performans canavarı)
// ------------------------------------------------------------
const LOG_QUEUE = [];
let QUEUE_TIMER = null;

function flushQueue() {
  if (LOG_QUEUE.length === 0) return;

  const batch = [...LOG_QUEUE];
  LOG_QUEUE.length = 0;

  Log.insertMany(batch)
    .then(() => {
      // console.log("Telemetry batch OK:", batch.length);
    })
    .catch((err) => {
      console.error("❌ Telemetry batch ERROR:", err.message);
    });
}

function queueLog(entry) {
  LOG_QUEUE.push(entry);

  if (!QUEUE_TIMER) {
    QUEUE_TIMER = setTimeout(() => {
      flushQueue();
      QUEUE_TIMER = null;
    }, 150); // 150 ms batch window
  }
}

// ------------------------------------------------------------
// Ana fonksiyon
// ------------------------------------------------------------
export async function writeLog({ type, message, payload, userId, ip }) {
  try {
    const entry = {
      type: type || "unknown",
      message: message || "",
      payload: safePayload(payload),
      userId: userId || null,
      ip: maskIp(ip),
      createdAt: new Date()
    };

    queueLog(entry);
  } catch (err) {
    console.error("❌ Telemetry writeLog fatal:", err.message);
  }
}
