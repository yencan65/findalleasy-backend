import { Router } from 'express';
import { trendyolSearch } from '../adapters/trendyol.js';
import { hepsiburadaSearch } from '../adapters/hepsiburada.js';
import { normalizeProduct } from '../utils/normalize.js';

const r = Router();
r.get('/', async (req,res)=>{
  try {
    const q = String(req.query.q || '').trim();
    const region = String(req.query.region || 'TR').toUpperCase();
    if (!q) return res.status(400).json({ error:'query required' });

    let results = [];
    if (region === 'TR') {
      const settled = await Promise.allSettled([
        trendyolSearch(q),
        hepsiburadaSearch(q)
      ]);
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          results.push(...s.value.map(p => normalizeProduct(p, 'src')));
        }
      }
    }
    res.json({ query:q, region, results });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
export default r;
