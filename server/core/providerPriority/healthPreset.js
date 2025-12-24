// ============================================================
// HEALTH PROVIDER PRIORITY — S33 TITAN
// ------------------------------------------------------------
// Daha yüksek skor = BEST seçilme ihtimali yüksek
// Vitrin motoru final fiyat + kalite + priority ile çalışır
// ============================================================

export const HEALTH_PROVIDER_PRIORITY = {
  // Doktor/Klinik siteleri
  doktorset: 0.95,
  doktortakip: 0.90,

  // Google Medical / Tourism / Lab
  google_medical: 0.70,
  health_tourism: 0.65,
  lab_tests: 0.60,

  // Sigorta
  insurance_health: 0.75,

  // SGK
  sgk_hospitals: 0.85,

  // Generic fallback
  health_fallback: 0.20,
};
