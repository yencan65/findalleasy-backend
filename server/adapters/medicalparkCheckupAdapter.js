// ============================================================================
// MEDICAL PARK CHECKUP ADAPTER — S200 STUB
// - Purpose: eliminate "safeImport failed" noise when the real adapter isn't wired.
// - ZERO DELETE: harmless stub returning empty results.
// ============================================================================

export default async function medicalParkCheckupAdapter({ q = "", limit = 10 } = {}) {
  const items = [];
  items.ok = true;
  items._meta = {
    provider: "medicalpark",
    stub: true,
    reason: "NOT_CONNECTED",
    q,
    limit,
  };
  return items;
}
