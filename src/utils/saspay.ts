import crypto from 'crypto';

/**
 * Client SasPay (https://docs.saspay.me) — checkout hébergé.
 * Base URL et routes : spécification OpenAPI officielle (/api-reference/openapi.json).
 * La clé secrète reste côté serveur (SASPAY_SECRET_KEY = sk_test_… ou sk_live_…).
 */

const SASPAY_BASE_URL = (process.env.SASPAY_BASE_URL?.trim() || 'https://api.saspay.me/api/v1').replace(/\/$/, '');
const WEBHOOK_TOLERANCE_SECONDS = 300;

export type SasPayFeeChargeMode = 'ADD_ON' | 'DEDUCTED';
export type SasPayTransactionStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

function secretKey(): string {
  return process.env.SASPAY_SECRET_KEY?.trim() || '';
}

export function isSasPayConfigured(): boolean {
  return /^sk_(test|live)_/.test(secretKey());
}

export function isSasPayLive(): boolean {
  return secretKey().startsWith('sk_live_');
}

/** Mode de frais : ADD_ON par défaut → le client paie les frais, le marchand reçoit le prix affiché. */
export function sasPayFeeMode(): SasPayFeeChargeMode {
  return process.env.SASPAY_FEE_CHARGE_MODE?.trim().toUpperCase() === 'DEDUCTED' ? 'DEDUCTED' : 'ADD_ON';
}

export class SasPayError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorMessage(body: unknown, status: number): { message: string; code?: string } {
  const b = body as { error?: unknown; message?: string; code?: string } | null;
  const err = b?.error as { message?: string; code?: string } | Record<string, string[]> | undefined;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return { message: err.message, code: (err as { code?: string }).code };
  }
  if (err && typeof err === 'object') {
    const parts = Object.entries(err as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`
    );
    if (parts.length) return { message: parts.join(' · ') };
  }
  if (b?.message) return { message: b.message, code: b.code };
  return { message: `SasPay a répondu ${status}` };
}

async function sasPayRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isSasPayConfigured()) {
    throw new SasPayError('SasPay non configuré (SASPAY_SECRET_KEY manquant)', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${SASPAY_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${secretKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 200) };
    }
    if (!res.ok || (body as { success?: boolean })?.success === false) {
      const { message, code } = errorMessage(body, res.status);
      throw new SasPayError(message, res.status, code);
    }
    // Enveloppe { success, data, code } ; certains exemples renvoient l'objet nu.
    const env = body as { data?: T };
    return (env && typeof env === 'object' && 'data' in env ? env.data : body) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Référence marchand interne : « MP » + 20 hex (80 bits aléatoires, non devinable). */
export function generateMerchantTransactionId(): string {
  return `MP${crypto.randomBytes(10).toString('hex')}`;
}

/** Montant en chaîne décimale ("2500.00"), jamais un flottant. */
export function toSasPayAmount(amount: number): string {
  return `${Math.round(amount)}.00`;
}

export interface SasPayCheckoutSession {
  id: string;
  slug: string;
  checkout_url: string;
  amount: string;
  currency: string;
  status: string;
  fee_charge_mode?: string;
  transaction?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createSasPayCheckoutSession(params: {
  amount: number;
  currency: string;
  description: string;
  customerEmail: string;
  customerName: string;
  returnUrl: string;
  metadata: Record<string, string>;
  country?: string;
}): Promise<SasPayCheckoutSession> {
  const payload: Record<string, unknown> = {
    amount: toSasPayAmount(params.amount),
    currency: params.currency,
    description: params.description.slice(0, 255),
    customer_email: params.customerEmail,
    customer_name: params.customerName || params.customerEmail,
    return_url: params.returnUrl,
    metadata: params.metadata,
    fee_charge_mode: sasPayFeeMode(),
  };
  if (params.country) payload.country = params.country;
  const session = await sasPayRequest<SasPayCheckoutSession>('/checkout-sessions/', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!session?.id || !session.checkout_url) {
    throw new SasPayError('Réponse SasPay invalide (checkout_url manquante)', 502);
  }
  return session;
}

export interface SasPayCheckoutStatus {
  id: string;
  slug?: string;
  status: string; // PENDING | PAID | EXPIRED | CANCELLED
  transaction_id?: string | null;
  transaction_status?: SasPayTransactionStatus | null;
  transaction_reference?: string | null;
}

export function getSasPayCheckoutStatus(sessionId: string): Promise<SasPayCheckoutStatus> {
  return sasPayRequest<SasPayCheckoutStatus>(`/checkout-sessions/${encodeURIComponent(sessionId)}/status/`);
}

export interface SasPayVerifiedPayment {
  id: string;
  reference?: string;
  status: SasPayTransactionStatus;
  requested_amount?: string;
  net_amount?: string;
  debited_amount?: string;
  client_fee?: string;
  fee_charge_mode?: string;
  currency?: string;
}

/** Revérifie l'état réel côté gateway — seule source de vérité avant activation. */
export function verifySasPayPayment(paymentId: string): Promise<SasPayVerifiedPayment> {
  return sasPayRequest<SasPayVerifiedPayment>(`/payments/${encodeURIComponent(paymentId)}/verify/`);
}

/**
 * IP publique SORTANTE de ce serveur (celle que voit SasPay) — à ajouter dans
 * Développeur → IP Whitelist (obligatoire pour les retraits / payouts).
 * Plusieurs services en secours ; renvoie null si aucun ne répond.
 */
export async function detectServerPublicIp(): Promise<{ ipv4: string | null; ipv6: string | null; source: string | null }> {
  const probe = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'text/plain' } });
      if (!res.ok) return null;
      const ip = (await res.text()).trim();
      return /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
    } catch {
      return null;
    }
  };
  const v4Sources = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://checkip.amazonaws.com'];
  let ipv4: string | null = null;
  let source: string | null = null;
  for (const url of v4Sources) {
    ipv4 = await probe(url);
    if (ipv4) {
      source = new URL(url).host;
      break;
    }
  }
  const ipv6 = await probe('https://api64.ipify.org');
  return { ipv4, ipv6: ipv6 && ipv6 !== ipv4 && ipv6.includes(':') ? ipv6 : null, source };
}

/** Signature webhook : HMAC-SHA256(secret, `${timestamp}.${rawBody}`), tolérance 5 min, comparaison en temps constant. */
export function isValidSasPayWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !signatureHeader || !timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), body]))
    .digest('hex');
  const a = Buffer.from(signatureHeader.trim().toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
