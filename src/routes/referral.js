import { Router } from 'express';
const r = Router();
r.post('/claim', (_req,res)=> res.json({ ok:true, reward:'coupon', value:25 }));
export default r;
