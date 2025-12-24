// server/adapters/skyscanner.js

// Uçak bileti / rota için ileride Skyscanner veya başka sağlayıcıya bağlanacağız.
// Şimdilik sadece stub olarak duruyor.
export async function searchSkyscanner(query, region = "TR") {
  console.log("ℹ️ skyscanner adapter şu an MOCK, gerçek API bağlı değil.");
  return [];
}
