import { Router, Request, Response } from 'express';
import { protect, adminOnly } from '../middleware/auth';
import AppRelease from '../models/AppRelease';
import {
  cleanVersion,
  compareVersions,
  fetchGithubRelease,
  getAppVersionInfo,
  invalidateAppVersionCache,
} from './appVersionRoutes';

/** Admin : publier manuellement une version d'APK (lien direct) quand GitHub n'en fournit pas. */
const router = Router();
router.use(protect, adminOnly);

router.get('/', async (_req: Request, res: Response) => {
  invalidateAppVersionCache();
  const [github, adminRelease, effective] = await Promise.all([
    fetchGithubRelease(),
    AppRelease.findOne({ active: true }).sort({ created_at: -1 }).lean(),
    getAppVersionInfo(),
  ]);
  return res.json({ success: true, data: { github, admin: adminRelease, effective } });
});

router.post('/', async (req: Request, res: Response) => {
  const version = cleanVersion(req.body?.version);
  const minVersion = req.body?.minVersion ? cleanVersion(req.body.minVersion) : null;
  const apkUrl = String(req.body?.apkUrl || '').trim();
  const notes = String(req.body?.notes || '').trim().slice(0, 1200) || null;

  if (!version) return res.status(400).json({ success: false, message: 'Version invalide (format 1.2.0)' });
  if (req.body?.minVersion && !minVersion) {
    return res.status(400).json({ success: false, message: 'Version minimale invalide (format 1.2.0)' });
  }
  if (minVersion && compareVersions(minVersion, version) > 0) {
    return res.status(400).json({ success: false, message: 'La version minimale ne peut pas dépasser la version publiée' });
  }
  let url: URL;
  try {
    url = new URL(apkUrl);
  } catch {
    return res.status(400).json({ success: false, message: 'Lien de téléchargement invalide' });
  }
  if (url.protocol !== 'https:') {
    return res.status(400).json({ success: false, message: 'Le lien doit être en https' });
  }

  await AppRelease.updateMany({ active: true }, { active: false });
  const release = await AppRelease.create({
    version,
    minVersion,
    apkUrl: url.toString(),
    notes,
    active: true,
    publishedBy: req.user!._id,
  });
  invalidateAppVersionCache();
  return res.status(201).json({
    success: true,
    message: `Version ${version} publiée : les utilisateurs seront prévenus à l’ouverture de l’app.`,
    data: { release, effective: await getAppVersionInfo() },
  });
});

/** Retire la publication admin : seule la release GitHub reste prise en compte. */
router.delete('/', async (_req: Request, res: Response) => {
  await AppRelease.updateMany({ active: true }, { active: false });
  invalidateAppVersionCache();
  return res.json({ success: true, data: { effective: await getAppVersionInfo() } });
});

export default router;
