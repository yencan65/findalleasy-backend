// ============================================================
// HEALTH INTENT ENGINE — S33 TITAN
// ------------------------------------------------------------
// Amaç: sağlıkla ilgili sorguları %100 doğru kümeye ayırmak
// Kategoriler: checkup, insurance, sgk, lab, tourism, doctor,
//              generic_health, non_health
// ZERO DELETE — tamamen additive.
// ============================================================

const normalize = (t) =>
  String(t || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

export function detectHealthIntent(query) {
  const q = normalize(query);

  // === CHECK-UP / PAKETLER ===
  if (
    q.includes("check up") ||
    q.includes("checkup") ||
    q.includes("check-up") ||
    q.includes("genel sağlık taraması") ||
    q.includes("genel saglik taramasi") ||
    q.includes("check up paketi") ||
    q.includes("checkup paketi") ||
    q.includes("sağlık paketi") ||
    q.includes("kan tahlili paketi")
  ) {
    return "checkup";
  }

  // === LAB TESTS ===
  if (
    q.includes("tahlil") ||
    q.includes("kan tahlili") ||
    q.includes("pcr") ||
    q.includes("laboratuvar") ||
    q.includes("lab test") ||
    q.includes("vitamin testi") ||
    q.includes("hormon testi")
  ) {
    return "lab";
  }

  // === SGK HASTANELERİ ===
  if (
    q.includes("sgk") ||
    q.includes("devlet hastanesi") ||
    q.includes("aile sağlığı") ||
    q.includes("aile sagligi") ||
    q.includes("sağlık ocağı") ||
    q.includes("hastane randevu") ||
    q.includes("tıp merkezi")
  ) {
    return "sgk";
  }

  // === ÖZEL SAĞLIK SİGORTASI ===
  if (
    q.includes("özel sağlık sigortası") ||
    q.includes("ozel saglik sigortasi") ||
    q.includes("tamamlayıcı sağlık") ||
    q.includes("tamamlayici saglik") ||
    q.includes("poliçe") ||
    q.includes("police")
  ) {
    return "insurance";
  }

  // === SAĞLIK TURİZMİ ===
  if (
    q.includes("sağlık turizmi") ||
    q.includes("saglik turizmi") ||
    q.includes("estetik") ||
    q.includes("dental turkey") ||
    q.includes("estetik paketi") ||
    q.includes("burun estetiği") ||
    q.includes("dental implant")
  ) {
    return "tourism";
  }

  // === DOKTOR / KLİNİK ARAMALARI ===
  if (
    q.includes("doktor") ||
    q.includes("uzman") ||
    q.includes("klinik") ||
    q.includes("muayene") ||
    q.includes("ortopedi") ||
    q.includes("nöroloji") ||
    q.includes("dermatoloji") ||
    q.includes("psikiyatri")
  ) {
    return "doctor";
  }

  // === GENEL SAĞLIK ANAHTARLARI ===
  if (
    q.includes("sağlık") ||
    q.includes("saglik") ||
    q.includes("medical") ||
    q.includes("hastane")
  ) {
    return "generic_health";
  }

  return "non_health";
}
