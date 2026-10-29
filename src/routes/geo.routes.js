// /qup-work-api/src/routes/geo.routes.js
// GET /geo/postcode/5003 → { place: { postalCode, city, municipality, location } }
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/AppError.js';
import { lookupPostcode } from '../utils/geo.js';

const router = Router();
// Public, but it calls Kartverket, so keep it from being hammered
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

router.get('/postcode/:code', async (req, res) => {
  if (!/^\d{4}$/.test(req.params.code)) throw new AppError('A postcode has 4 digits', 400);
  let place;
  try {
    place = await lookupPostcode(req.params.code);
  } catch {
    throw new AppError('The postcode lookup is not available right now', 503);
  }
  if (!place) throw AppError.notFound('Postcode');
  res.json({ place });
});

export default router;
