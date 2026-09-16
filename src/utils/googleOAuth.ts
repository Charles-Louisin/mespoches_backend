import type { Request } from 'express';

const RETURN_TO_MAX = 512;

export function publicApiOrigin(req: Request): string {
  const env = process.env.API_PUBLIC_URL?.trim().replace(/\/$/, '');
  if (env) {
    try {
      return new URL(env).origin;
    } catch {
      /* ignore */
    }
  }
  const proto = (
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    req.protocol ||
    'https'
  ).replace(/:$/, '');
  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
    req.get('host') ||
    '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

export function googleCallbackUri(req: Request): string {
  return `${publicApiOrigin(req)}/api/auth/google/callback`;
}

export function buildOAuthState(
  mobile: boolean,
  extra?: { returnTo?: string; nonce?: string }
): string {
  const base = `${crypto.randomUUID()}:${mobile ? '1' : '0'}`;
  if (!extra?.returnTo && !extra?.nonce) return base;
  const packed = Buffer.from(
    JSON.stringify({
      r: extra.returnTo || '',
      n: extra.nonce || '',
    }),
    'utf8'
  ).toString('base64url');
  return `${base}:${packed}`;
}

export function parseOAuthState(returnedState: string | null): {
  id: string;
  mobile: boolean;
  returnTo?: string;
  nonce?: string;
} | null {
  if (!returnedState) return null;
  const match = returnedState.match(
    /^([0-9a-f-]{36}):([01])(?::([A-Za-z0-9_-]+))?$/i
  );
  if (!match) {
    const separator = returnedState.lastIndexOf(':');
    if (separator < 0) return { id: returnedState, mobile: false };
    const id = returnedState.slice(0, separator);
    const flag = returnedState.slice(separator + 1);
    if (!id) return null;
    return { id, mobile: flag === '1' };
  }

  const extraRaw = match[3];
  let returnTo: string | undefined;
  let nonce: string | undefined;
  if (extraRaw) {
    try {
      const extra = JSON.parse(
        Buffer.from(extraRaw, 'base64url').toString('utf8')
      ) as { r?: string; n?: string };
      if (typeof extra.r === 'string' && extra.r) returnTo = extra.r;
      if (typeof extra.n === 'string' && extra.n) nonce = extra.n;
    } catch {
      /* state sans extra */
    }
  }
  return { id: match[1], mobile: match[2] === '1', returnTo, nonce };
}

export function isAllowedAppReturnTo(
  value: string | null | undefined
): value is string {
  if (!value || value.length > RETURN_TO_MAX) return false;
  try {
    const u = new URL(value);
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (scheme === 'mespoches') return true;
    if (scheme === 'exp' || scheme === 'exps') return true;
    if (scheme === 'http' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    if (
      scheme === 'https' &&
      (u.hostname === 'auth.expo.io' ||
        u.hostname.endsWith('.exp.direct') ||
        u.hostname.endsWith('.expo.dev'))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function appendHandoffCode(returnTo: string, code: string): string {
  const sep = returnTo.includes('?') ? '&' : '?';
  return `${returnTo}${sep}code=${encodeURIComponent(code)}`;
}

export function isValidClientNonce(value: string | null): value is string {
  return !!value && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}
