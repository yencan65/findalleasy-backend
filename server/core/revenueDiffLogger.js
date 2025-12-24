// server/core/revenueDiffLogger.js
import { writeLog } from "../utils/telemetryLogger.js";

export function estimateRevenue(items = []) {
  try {
    return items.reduce((sum, it) => {
      const c = Number(it.commissionValue || 0);
      return sum + (isFinite(c) ? c : 0);
    }, 0);
  } catch {
    return 0;
  }
}

export async function writeRevenueDiff({
  query,
  mode,
  oldRevenue,
  newRevenue,
  timestamp
}) {
  const diff = (newRevenue || 0) - (oldRevenue || 0);

  await writeLog({
    type: "revenue_diff",
    message: `S40 Revenue Diff (${mode})`,
    payload: {
      query,
      oldRevenue,
      newRevenue,
      diff,
      timestamp
    },
  });
}
