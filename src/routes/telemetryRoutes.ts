import { Router, Request, Response } from 'express';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { protect } from '../middleware/auth';
import { telemetryLimiter } from '../utils/security';

const router = Router();
const NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;
const MAX_BATCH = 40;
const MAX_PROPS = 8;

function cleanStr(value: unknown, max = 64): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanProps(raw: unknown): Record<string, string | number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    const k = key.replace(/[^a-z0-9_]/gi, '').slice(0, 32);
    if (!k) continue;
    if (typeof val === 'number' && Number.isFinite(val)) {
      out[k] = Math.round(val * 100) / 100;
    } else if (typeof val === 'string') {
      out[k] = val.trim().slice(0, 80);
    } else if (typeof val === 'boolean') {
      out[k] = val ? 1 : 0;
    }
  }
  return out;
}

router.post('/events', protect, telemetryLimiter, async (req: Request, res: Response) => {
  try {
    const list = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!list.length) {
      return res.json({ success: true, data: { accepted: 0 } });
    }

    const userId = req.user!._id;
    const docs = [];
    for (const item of list.slice(0, MAX_BATCH)) {
      const name = cleanStr(item?.name, 48).toLowerCase();
      if (!NAME_RE.test(name)) continue;
      docs.push({
        user_id: userId,
        name,
        screen: cleanStr(item?.screen, 48).toLowerCase(),
        platform: cleanStr(item?.platform, 24).toLowerCase() || 'android',
        props: cleanProps(item?.props),
        created_at: new Date(),
      });
    }

    if (docs.length) await AnalyticsEvent.insertMany(docs, { ordered: false });
    return res.json({ success: true, data: { accepted: docs.length } });
  } catch (error) {
    console.error('Erreur telemetry ingest:', error);
    return res.status(500).json({ success: false, message: 'Envoi analytics impossible' });
  }
});

export default router;
