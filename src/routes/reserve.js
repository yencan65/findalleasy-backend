import { Router } from 'express';
const r = Router();
r.post('/', (req,res)=>{
  const { entities, provider } = req.body || {};
  if (!entities) return res.status(400).json({ error:'entities required' });
  const loc = entities.location || 'Türkiye';
  const deeplink = provider === 'odamax'
    ? `https://www.odamax.com/${encodeURIComponent(loc)}?adults=${entities.guests||2}`
    : `https://www.tatilbudur.com/${encodeURIComponent(loc)}`;
  res.json({ status:'ready', provider: provider||'odamax', deeplink });
});
export default r;
