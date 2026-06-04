export type SmsPatternKind =
  | 'transfer_out'
  | 'transfer_in'
  | 'payment'
  | 'withdrawal'
  | 'unknown';

export type ParsedMobileMoney = {
  amount: number;
  type: 'income' | 'expense';
  operator: 'orange' | 'mtn' | 'unknown';
  counterparty: string;
  description: string;
  date: Date;
  confidence: number;
  pattern: SmsPatternKind;
  transaction_id: string;
  sender_name: string;
  sender_phone: string;
  recipient_name: string;
  recipient_phone: string;
};

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(/,/g, '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTransactionId(text: string): string {
  const m =
    text.match(/ID transaction\s*:\s*([A-Z0-9.]+)/i) ||
    text.match(/No de transaction\s+([A-Z0-9.]+)/i) ||
    text.match(/transaction\s+([A-Z]{2}\d{6}\.\d{4}\.[A-Z0-9]+)/i);
  return m?.[1]?.trim() ?? '';
}

function detectOperator(text: string, txId: string): 'orange' | 'mtn' | 'unknown' {
  const lower = text.toLowerCase();
  if (/^PP|^MP|^CO/.test(txId)) return 'orange';
  if (lower.includes('orange') || lower.includes('orangemoney')) return 'orange';
  if (lower.includes('mtn') || lower.includes('momo')) return 'mtn';
  if (/reussi|fcfa|transfert de|paiement de|retrait d'argent/i.test(text)) return 'orange';
  return 'unknown';
}

function extractPrimaryAmount(text: string, kind: SmsPatternKind): number | null {
  const patterns: RegExp[] = [];

  if (kind === 'transfer_out' || kind === 'transfer_in') {
    patterns.push(/Montant Transaction\s*:\s*(\d[\d\s.,]*)\s*FCFA/i);
  }
  if (kind === 'payment') {
    patterns.push(/Montant\s*:\s*(\d[\d\s.,]*)\s*FCFA/i);
  }
  if (kind === 'withdrawal') {
    patterns.push(/Montant\s*:\s*(\d[\d\s.,]*)\s*FCFA/i);
    patterns.push(/montant net debite\s+(\d[\d\s.,]*)\s*FCFA/i);
  }

  patterns.push(
    /Montant Transaction\s*:\s*(\d[\d\s.,]*)\s*FCFA/i,
    /Montant\s*:\s*(\d[\d\s.,]*)\s*FCFA/i,
    /(\d[\d\s.,]+)\s*FCFA/i
  );

  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = parseAmount(m[1]);
      if (n) return n;
    }
  }
  return null;
}

export type UserSmsIdentity = {
  names: string[];
  phones: string[];
};

function normalizeName(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizePhone(s: string): string {
  return s.replace(/\D/g, '').slice(-9);
}

function nameMatches(identity: UserSmsIdentity, name: string): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  return identity.names.some(
    (stored) => n.includes(normalizeName(stored)) || normalizeName(stored).includes(n)
  );
}

function phoneMatches(identity: UserSmsIdentity, phone: string): boolean {
  const p = normalizePhone(phone);
  if (!p) return false;
  return identity.phones.some((stored) => normalizePhone(stored) === p);
}

function inferTransferType(
  senderName: string,
  senderPhone: string,
  recipientName: string,
  recipientPhone: string,
  identity?: UserSmsIdentity
): { type: 'income' | 'expense'; confidence: number } {
  if (identity) {
    const userIsRecipient =
      nameMatches(identity, recipientName) || phoneMatches(identity, recipientPhone);
    const userIsSender =
      nameMatches(identity, senderName) || phoneMatches(identity, senderPhone);

    if (userIsRecipient && !userIsSender) return { type: 'income', confidence: 0.95 };
    if (userIsSender && !userIsRecipient) return { type: 'expense', confidence: 0.95 };
    if (userIsRecipient && userIsSender) return { type: 'expense', confidence: 0.6 };
  }
  return { type: 'expense', confidence: 0.75 };
}

function parseTransfer(text: string, identity?: UserSmsIdentity): ParsedMobileMoney | null {
  const m = text.match(
    /Transfert de\s+(\d+)\s+([A-Za-zÀ-ÿ\s.'-]+?)\s+vers\s+(\d+)\s+([A-Za-zÀ-ÿ\s.'-]+?)\s+reussi/i
  );
  if (!m) return null;

  const [, senderPhone, senderName, recipientPhone, recipientName] = m;
  const txId = extractTransactionId(text);
  const amount = extractPrimaryAmount(text, 'transfer_out');
  if (!amount) return null;

  const { type, confidence: typeConf } = inferTransferType(
    senderName,
    senderPhone,
    recipientName,
    recipientPhone,
    identity
  );

  const counterparty =
    type === 'income' ? senderName.trim() : recipientName.trim();
  const pattern: SmsPatternKind = type === 'income' ? 'transfer_in' : 'transfer_out';

  return {
    amount,
    type,
    operator: detectOperator(text, txId),
    counterparty,
    description:
      type === 'income'
        ? `Transfert reçu — ${counterparty}`
        : `Transfert vers ${counterparty}`,
    date: new Date(),
    confidence: typeConf,
    pattern,
    transaction_id: txId,
    sender_name: senderName.trim(),
    sender_phone: senderPhone,
    recipient_name: recipientName.trim(),
    recipient_phone: recipientPhone,
  };
}

function parsePayment(text: string): ParsedMobileMoney | null {
  const m = text.match(
    /Paiement de\s+(.+?)\s+reussi\s+par\s+(\d+)\s+([A-Za-zÀ-ÿ\s.'-]+)/i
  );
  if (!m) return null;

  const [, merchant, , payerName] = m;
  const txId = extractTransactionId(text);
  const amount = extractPrimaryAmount(text, 'payment');
  if (!amount) return null;

  const counterparty = merchant.trim();

  return {
    amount,
    type: 'expense',
    operator: detectOperator(text, txId),
    counterparty,
    description: `Paiement — ${counterparty}`,
    date: new Date(),
    confidence: 0.9,
    pattern: 'payment',
    transaction_id: txId,
    sender_name: payerName.trim(),
    sender_phone: m[2],
    recipient_name: counterparty,
    recipient_phone: '',
  };
}

function parseWithdrawal(text: string): ParsedMobileMoney | null {
  if (!/Retrait d'argent reussi/i.test(text)) return null;

  const txId = extractTransactionId(text);
  const amount = extractPrimaryAmount(text, 'withdrawal');
  if (!amount) return null;

  const agentMatch = text.match(/reussi par le\s+(\d+)/i);

  return {
    amount,
    type: 'expense',
    operator: detectOperator(text, txId),
    counterparty: agentMatch ? `Agent ${agentMatch[1]}` : 'Retrait espèces',
    description: 'Retrait Orange Money',
    date: new Date(),
    confidence: 0.88,
    pattern: 'withdrawal',
    transaction_id: txId,
    sender_name: '',
    sender_phone: '',
    recipient_name: '',
    recipient_phone: agentMatch?.[1] ?? '',
  };
}

function parseGenericFallback(text: string): ParsedMobileMoney | null {
  const lower = text.toLowerCase();
  if (
    !/fcfa|reussi|transfert|paiement|retrait|montant/i.test(text)
  ) {
    return null;
  }

  const txId = extractTransactionId(text);
  const amount = extractPrimaryAmount(text, 'unknown');
  if (!amount) return null;

  const isIncome = /recu|reçu|credite|crédité|de\s+.+\s+vers\s+vous/i.test(lower);

  return {
    amount,
    type: isIncome ? 'income' : 'expense',
    operator: detectOperator(text, txId),
    counterparty: '',
    description: 'Mobile Money',
    date: new Date(),
    confidence: 0.5,
    pattern: 'unknown',
    transaction_id: txId,
    sender_name: '',
    sender_phone: '',
    recipient_name: '',
    recipient_phone: '',
  };
}

/** Parse SMS Orange Money / MTN MoMo (Cameroun, XAF) — formats réels CM. */
export function parseMobileMoneySms(
  text: string,
  identity?: UserSmsIdentity
): ParsedMobileMoney | null {
  const body = text.trim().replace(/\s+/g, ' ');
  if (!body) return null;

  return (
    parseTransfer(body, identity) ||
    parsePayment(body) ||
    parseWithdrawal(body) ||
    parseGenericFallback(body)
  );
}

export function parseNotificationText(
  title: string,
  body: string,
  identity?: UserSmsIdentity
): ParsedMobileMoney | null {
  return parseMobileMoneySms(`${title}\n${body}`, identity);
}

export function counterpartyKey(counterparty: string, pattern: SmsPatternKind): string {
  const c = counterparty.trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 80);
  return `${pattern}::${c || 'UNKNOWN'}`;
}
