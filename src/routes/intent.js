import { Router } from 'express';
const r = Router();

const rules = [
  { intent: 'reservation', re: /(rezervasyon|otel|bilet|kirala|araç kirala|uçak)/i },
  { intent: 'product',     re: /(al|satın al|fiyat|ürün|kıyas)/i },
  { intent: 'rental',      re: /(kirala|kiralık)/i }
];

r.post('/', (req,res)=>{
  const text = String(req.body?.text || '');
  const locale = String(req.body?.locale || 'tr-TR');
  if (!text.trim()) return res.status(400).json({ error:'text required' });

  const hit = rules.find(r => r.re.test(text));
  const intent = hit?.intent || 'product';

  const entities = {};
  const cityMatch = text.match(/\b(antalya|bodrum|datça|izmir|istanbul|ankara)\b/i);
  if (cityMatch) {
    const c = cityMatch[0];
    entities.location = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
  }
  const guestsMatch = text.match(/(\d+)\s*(kişi|kisi|kişilik|k)/i);
  if (guestsMatch) entities.guests = Number(guestsMatch[1]);

  res.json({ intent, locale, entities });
});

export default r;
