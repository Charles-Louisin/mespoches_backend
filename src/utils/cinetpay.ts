/**
 * Client API CinetPay v1 (sandbox: api.cinetpay.net — prod: api.cinetpay.co)
 * @see cinetpay/ dans le dépôt
 */

const SANDBOX_API_BASE = 'https://api.cinetpay.net';
const PRODUCTION_API_BASE = 'https://api.cinetpay.co';

export type CinetPayPaymentMethod =
  | 'OM_CM'
  | 'MTN_CM'
  | undefined;

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

export function getCinetPayApiBaseUrl(): string {
  const env = (process.env.CINETPAY_ENV || 'sandbox').toLowerCase();
  return env === 'production' ? PRODUCTION_API_BASE : SANDBOX_API_BASE;
}

export function isCinetPayConfigured(): boolean {
  return Boolean(getAccountCredentials());
}

function getAccountCredentials(): { apiKey: string; apiPassword: string } | null {
  const apiKey =
    process.env.CINETPAY_ACCOUNT_KEY?.trim() ||
    process.env.CINETPAY_API_KEY?.trim();
  const apiPassword =
    process.env.CINETPAY_ACCOUNT_PASSWORD?.trim() ||
    process.env.CINETPAY_API_PASSWORD?.trim();

  if (!apiKey || !apiPassword) return null;
  return { apiKey, apiPassword };
}

async function getAccessToken(): Promise<string> {
  const creds = getAccountCredentials();
  if (!creds) {
    throw new Error(
      'CinetPay non configuré (CINETPAY_ACCOUNT_KEY / CINETPAY_ACCOUNT_PASSWORD)'
    );
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.accessToken;
  }

  const baseUrl = getCinetPayApiBaseUrl();
  const res = await fetch(`${baseUrl}/v1/oauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: creds.apiKey,
      api_password: creds.apiPassword,
    }),
  });

  const json = (await res.json()) as {
    code?: number;
    status?: string;
    access_token?: string;
    expires_in?: number;
    description?: string;
  };

  if (!res.ok || json.code !== 200 || !json.access_token) {
    throw new Error(
      json.description ||
        json.status ||
        'Authentification CinetPay impossible'
    );
  }

  const expiresInSec = Math.min(json.expires_in ?? 300, 300);
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };

  return json.access_token;
}

async function cinetPayFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = getCinetPayApiBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(
      `Réponse CinetPay invalide (${res.status}): ${text.slice(0, 120)}`
    );
  }

  return (await res.json()) as T;
}

export interface CinetPayInitParams {
  merchantTransactionId: string;
  amount: number;
  description: string;
  notifyUrl: string;
  successUrl: string;
  failedUrl: string;
  paymentMethod?: CinetPayPaymentMethod;
  customer: {
    email: string;
    name?: string;
    phone?: string;
  };
}

export interface CinetPayInitResult {
  paymentUrl: string;
  notifyToken: string;
  cinetpayTransactionId: string;
  merchantTransactionId: string;
}

export async function initCinetPayPayment(
  params: CinetPayInitParams
): Promise<CinetPayInitResult> {
  const nameParts = (params.customer.name || 'Client MES POCHES')
    .trim()
    .split(/\s+/);
  const clientFirstName = nameParts[0] || 'Client';
  const clientLastName = nameParts.slice(1).join(' ') || 'MES POCHES';

  const body: Record<string, unknown> = {
    currency: 'XAF',
    merchant_transaction_id: params.merchantTransactionId,
    amount: Math.round(params.amount),
    lang: 'fr',
    designation: params.description.slice(0, 255),
    client_email: params.customer.email,
    client_first_name: clientFirstName.slice(0, 255),
    client_last_name: clientLastName.slice(0, 255),
    success_url: params.successUrl.slice(0, 120),
    failed_url: params.failedUrl.slice(0, 120),
    notify_url: params.notifyUrl.slice(0, 120),
    direct_pay: false,
  };

  if (params.paymentMethod) {
    body.payment_method = params.paymentMethod;
  }

  if (params.customer.phone?.trim()) {
    body.client_phone_number = params.customer.phone.trim();
  }

  const json = await cinetPayFetch<{
    code?: number;
    status?: string;
    description?: string;
    merchant_transaction_id?: string;
    transaction_id?: string;
    notify_token?: string;
    payment_url?: string;
  }>('/v1/payment', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (json.code !== 200 || !json.payment_url || !json.notify_token) {
    throw new Error(
      json.description ||
        json.status ||
        'Impossible d\'initialiser le paiement CinetPay'
    );
  }

  return {
    paymentUrl: json.payment_url,
    notifyToken: json.notify_token,
    cinetpayTransactionId: json.transaction_id || '',
    merchantTransactionId:
      json.merchant_transaction_id || params.merchantTransactionId,
  };
}

export interface CinetPayPaymentStatus {
  code: number;
  status: string;
  merchant_transaction_id?: string;
  transaction_id?: string;
}

export async function getCinetPayPaymentStatus(
  merchantTransactionId: string
): Promise<CinetPayPaymentStatus> {
  const encoded = encodeURIComponent(merchantTransactionId);
  const json = await cinetPayFetch<CinetPayPaymentStatus>(
    `/v1/payment/${encoded}`,
    { method: 'GET' }
  );
  return json;
}

/** Statut canonique — ne jamais se fier uniquement au webhook */
export function isCinetPayPaymentSuccess(status: CinetPayPaymentStatus): boolean {
  return status.status === 'SUCCESS' || status.code === 100;
}

export function isCinetPayPaymentFailed(status: CinetPayPaymentStatus): boolean {
  const failedStatuses = new Set([
    'FAILED',
    'EXPIRED',
    'INSUFFICIENT_BALANCE',
    'OPERATION_ERROR',
  ]);
  const failedCodes = new Set([2010, 2003, 2005, -1]);
  return failedStatuses.has(status.status) || failedCodes.has(status.code);
}

export function isCinetPayPaymentPending(status: CinetPayPaymentStatus): boolean {
  if (isCinetPayPaymentSuccess(status) || isCinetPayPaymentFailed(status)) {
    return false;
  }
  const pendingStatuses = new Set(['INITIATED', 'PENDING', 'OK']);
  const pendingCodes = new Set([2001, 2002]);
  return pendingStatuses.has(status.status) || pendingCodes.has(status.code);
}

/** merchant_transaction_id — max 30 caractères (doc CinetPay) */
export function generateMerchantTransactionId(): string {
  const ts = Date.now().toString(36).slice(-8);
  const rand = Math.random().toString(36).slice(2, 6);
  return `MP${ts}${rand}`.slice(0, 30);
}

/** @deprecated Utiliser generateMerchantTransactionId */
export function generateTransactionId(_userId: string): string {
  return generateMerchantTransactionId();
}
