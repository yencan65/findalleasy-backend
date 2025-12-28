// backend/db.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGODB_URL;
let client;
let db;

export async function getDb() {
  // 1) Cache varsa aynen dön
  if (db) return db;

  // 2) Ortam değişkeni kontrolü
  if (!uri) {
    throw new Error(
      "[DB] Mongo URI tanımlı değil. (MONGO_URI / MONGODB_URI / MONGO_URL) .env ve Render ortam değişkenlerini kontrol et."
    );
  }

  // 3) Client yoksa, güvenli şekilde oluştur
  if (!client) {
    try {
      client = new MongoClient(uri, {
        maxPoolSize: 20,               // aynı anda en fazla 20 bağlantı
        serverSelectionTimeoutMS: 10000, // 10 sn içinde cevap yoksa pes et
      });

      await client.connect();
    } catch (err) {
      console.error("[DB] MongoDB bağlantı hatası:", err?.message || err);
      client = null; // bozuk client’ı çöpe at
      throw err;
    }
  }

  const dbName = process.env.MONGO_DB || "findalleasy";
  db = client.db(dbName);
  console.log(`[DB] MongoDB bağlantısı başarılı → ${dbName}`);
  return db;
}

// İstersen ileride kullanmak için (opsiyon, şu an zorunlu değil)
export async function closeDb() {
  try {
    if (client) {
      await client.close();
      client = null;
      db = null;
      console.log("[DB] MongoDB bağlantısı kapatıldı.");
    }
  } catch (err) {
    console.warn("[DB] closeDb sırasında hata:", err?.message || err);
  }
}
