const CINETPAY_API_URL = 'https://api-checkout.cinetpay.com/v2';

export function isCinetPayConfigured(): boolean {
  return Boolean(
    process.env.CINETPAY_API_KEY?.trim() && process.env.CINETPAY_SITE_ID?.trim()
  );
}

function getCredentials() {
  const apikey = process.env.CINETPAY_API_KEY?.trim();
  const site_id = process.env.CINETPAY_SITE_ID?.trim();
  if (!apikey || !site_id) {
    throw new Error('CinetPay non configuré (CINETPAY_API_KEY / CINETPAY_SITE_ID)');
  }
  return { apikey, site_id };
}

export interface CinetPayInitParams {
  transactionId: string;
  amount: number;
  description: string;
  notifyUrl: string;
  returnUrl: string;
  customer: {
    id: string;
    email: string;
    name?: string;
  };
}

export async function initCinetPayPayment(
  params: CinetPayInitParams
): Promise<{ paymentUrl: string; paymentToken?: string }> {
  const { apikey, site_id } = getCredentials();
  const [firstName, ...rest] = (params.customer.name || 'Client').trim().split(/\s+/);
  const lastName = rest.join(' ') || firstName;

  const body = {
    apikey,
    site_id,
    transaction_id: params.transactionId,
    amount: Math.round(params.amount),
    currency: 'XAF',
    description: params.description,
    notify_url: params.notifyUrl,
    return_url: params.returnUrl,
    channels: 'ALL',
    lang: 'fr',
    customer_id: params.customer.id,
    customer_name: firstName,
    customer_surname: lastName,
    customer_email: params.customer.email,
    customer_phone_number: '237000000000',
    customer_address: 'Cameroun',
    customer_city: 'Douala',
    customer_country: 'CM',
    customer_state: 'CM',
    customer_zip_code: '00000',
  };

  const res = await fetch(`${CINETPAY_API_URL}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    code?: string;
    message?: string;
    description?: string;
    data?: { payment_url?: string; payment_token?: string };
  };

  if (!res.ok || json.code !== '201') {
    throw new Error(
      json.description || json.message || 'Impossible d\'initialiser le paiement CinetPay'
    );
  }

  const paymentUrl = json.data?.payment_url;
  if (!paymentUrl) {
    throw new Error('URL de paiement CinetPay manquante');
  }

  return { paymentUrl, paymentToken: json.data?.payment_token };
}

export async function checkCinetPayPayment(transactionId: string): Promise<{
  success: boolean;
  status?: string;
}> {
  const { apikey, site_id } = getCredentials();

  const res = await fetch(`${CINETPAY_API_URL}/payment/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey, site_id, transaction_id: transactionId }),
  });

  const json = (await res.json()) as {
    code?: string;
    data?: { status?: string };
  };

  const status = String(json.data?.status || '').toUpperCase();
  const code = String(json.code || '');

  const success =
    code === '00' ||
    status === 'ACCEPTED' ||
    status === 'SUCCESS' ||
    status === 'COMPLETED';

  return { success, status: status || code };
}

export function generateTransactionId(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `MP${safe}${ts}${rand}`.slice(0, 64);
}
