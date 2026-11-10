import { Router, Request, Response } from 'express';
import AppRelease from '../models/AppRelease';

/**
 * Version de l'APK à proposer aux utilisateurs (nouveau build Android).
 * Ordre de priorité du lien de téléchargement :
 *  1. l'APK attaché à la dernière release GitHub (asset « MES.POCHES.apk »), s'il existe ;
 *  2. sinon la version publiée par un administrateur (lien saisi dans l'admin) ;
 * La version annoncée est la plus récente des deux. Cache 10 min, vidé à chaque publication admin.
 */
const router = Router();

const REPO = process.env.APK_GITHUB_REPO?.trim() || 'Charles-Louisin/mespoches';
const ASSET = 'MES.POCHES.apk';
/** Lien stable : redirige vers l'APK de la dernière release GitHub. */
export const DIRECT_URL = `https://github.com/${REPO}/releases/latest/download/${ASSET}`;
const CACHE_MS = 10 * 60 * 1000;

export type AppVersionInfo = {
  latestVersion: string | null;
  minVersion: string | null;
  apkUrl: string;
  sizeMb: number | null;
  notes: string | null;
  publishedAt: string | null;
  source: 'github' | 'admin' | 'none';
};

export type GithubRelease = {
  version: string | null;
  apkUrl: string | null;
  sizeMb: number | null;
  notes: string | null;
  publishedAt: string | null;
};

let cache: { at: number; data: AppVersionInfo } | null = null;

export function invalidateAppVersionCache(): void {
  cache = null;
}

export const cleanVersion = (v: unknown): string | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
};

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export async function fetchGithubRelease(): Promise<GithubRelease> {
  const empty: GithubRelease = { version: null, apkUrl: null, sizeMb: null, notes: null, publishedAt: null };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mes-poches-backend' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return empty;
    const j = (await res.json()) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      assets?: { name: string; size: number; browser_download_url?: string }[];
    };
    const asset = j.assets?.find((a) => a.name === ASSET) ?? j.assets?.find((a) => a.name.toLowerCase().endsWith('.apk'));
    return {
      version: cleanVersion(j.tag_name),
      // Lien propre à CETTE release (pas « latest ») : la version annoncée et le fichier correspondent toujours.
      apkUrl: asset?.browser_download_url ?? null,
      sizeMb: asset ? Math.round((asset.size / 1048576) * 10) / 10 : null,
      notes: j.body?.trim() ? j.body.trim().slice(0, 1200) : null,
      publishedAt: j.published_at ?? null,
    };
  } catch {
    return empty;
  }
}

export async function getAppVersionInfo(): Promise<AppVersionInfo> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [gh, admin] = await Promise.all([
    fetchGithubRelease(),
    AppRelease.findOne({ active: true }).sort({ created_at: -1 }).lean().catch(() => null),
  ]);

  const adminVersion = admin ? cleanVersion(admin.version) : null;
  const ghUsable = gh.version && gh.apkUrl;
  // GitHub prioritaire si son APK est disponible et au moins aussi récent que la publication admin.
  const useGithub = ghUsable && (!adminVersion || compareVersions(gh.version!, adminVersion) >= 0);

  let data: AppVersionInfo;
  if (useGithub) {
    data = {
      latestVersion: gh.version,
      minVersion: cleanVersion(process.env.APP_MIN_VERSION) ?? (admin?.minVersion ? cleanVersion(admin.minVersion) : null),
      apkUrl: gh.apkUrl!,
      sizeMb: gh.sizeMb,
      notes: gh.notes,
      publishedAt: gh.publishedAt,
      source: 'github',
    };
  } else if (admin && adminVersion) {
    data = {
      latestVersion: adminVersion,
      minVersion: admin.minVersion ? cleanVersion(admin.minVersion) : cleanVersion(process.env.APP_MIN_VERSION),
      apkUrl: admin.apkUrl,
      sizeMb: null,
      notes: admin.notes,
      publishedAt: new Date(admin.created_at).toISOString(),
      source: 'admin',
    };
  } else {
    data = {
      latestVersion: null,
      minVersion: null,
      apkUrl: DIRECT_URL,
      sizeMb: null,
      notes: null,
      publishedAt: null,
      source: 'none',
    };
  }
  // Réponse vide (GitHub indisponible) gardée 1 min seulement.
  cache = { at: data.latestVersion ? Date.now() : Date.now() - CACHE_MS + 60_000, data };
  return data;
}

/** Public : appelé par l'app au démarrage, sans session. */
router.get('/version', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=120');
  return res.json({ success: true, data: await getAppVersionInfo() });
});

export default router;
