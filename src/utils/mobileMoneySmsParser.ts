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

/**
 * Montants CM :
 * - avec milliers : 10 000 / 10.000 / 10,000 (éventuellement + décimales)
 * - simples : 2100 / 1.18 / 4054
 * Important : le groupe milliers est `+` (pas `*`) sinon 2100 matchait "210".
 */
const AMOUNT_TOKEN =
  '(\\d{1,3}(?:[\\s.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
/** Groupe capturant la devise (pour firstLabeledAmount). */
const CURRENCY_CAP = '(FCFA|XAF|CFA|USD|EUR)\\b';
/** Devise optionnelle après un montant (non capturante). */
const CURRENCY_OPT = '(?:\\s*(?:FCFA|XAF|CFA|USD|EUR)\\b)?';
/** `F` seul (Wave) — séparé pour ne pas manger le F de FCFA. */
const CURRENCY_WAVE = '(FCFA|XAF|CFA|USD|EUR|\\bF\\b)';
const PHONE = '(\\d{8,15})';
const PERSON_NAME = "([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9\\s.'-]{1,60}?)";

function parseAmount(raw: string): number | null {
  let cleaned = raw.trim().replace(/\s/g, '');
  // Séparateur de milliers : 5,000 / 5.000 / 10 000
  if (/^\d{1,3}([.,]\d{3})+$/.test(cleaned)) {
    cleaned = cleaned.replace(/[.,]/g, '');
  } else if (/^\d{1,3}([.,]\d{3})+[.,]\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/[.,](?=\d{3}([.,]|$))/g, '').replace(/,/g, '.');
  } else {
    cleaned = cleaned.replace(/,/g, '.');
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Contexte trop proche d'un solde / frais → monter pas comme montant principal. */
function isNoiseAmountContext(text: string, index: number): boolean {
  const windowStart = Math.max(0, index - 40);
  const before = text.slice(windowStart, index).toLowerCase();
  return /(?:nouveau\s+)?solde|frais|commission|remise|reduction|réductions?|fidelite|fidélité|recompense|récompense|bons?\s+de\s+reduction/i.test(
    before
  );
}

function firstLabeledAmount(
  text: string,
  patterns: RegExp[]
): { amount: number; currency?: string; index: number } | null {
  for (const re of patterns) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      if (isNoiseAmountContext(text, m.index)) continue;
      const n = parseAmount(m[1]);
      if (!n) continue;
      const currency = m[2]?.toUpperCase();
      return { amount: n, currency, index: m.index };
    }
  }
  return null;
}

export function extractTransactionId(text: string): string {
  const patterns = [
    /ID(?:\s+de)?\s+transaction\s*:\s*([A-Z0-9.]+)/i,
    /No\.?\s*de\s+transaction\s+([A-Z0-9.]+)/i,
    /(?:Financial\s+)?Transaction\s+Id\s*:\s*([A-Z0-9.]+)/i,
    /Identifiant\s+de\s+transaction\s+financi[eè]re\s*:\s*([A-Z0-9.]+)/i,
    /ID\s+de\s+transaction\s+externe\s*:\s*([A-Z0-9.]+)/i,
    /\bID\s*:\s*(\d{4,})\b/i,
    /\b((?:PP|MP|CO)\d{6}\.\d{4}\.[A-Z0-9]+)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim().replace(/\.+$/, '');
  }
  return '';
}

function detectOperator(text: string, txId: string): 'orange' | 'mtn' | 'unknown' {
  const lower = text.toLowerCase();
  if (/^(PP|MP|CO)/i.test(txId)) return 'orange';
  if (
    lower.includes('orange money') ||
    lower.includes('orangemoney') ||
    lower.includes('orange')
  ) {
    return 'orange';
  }
  if (
    lower.includes('mtn') ||
    lower.includes('momo') ||
    /financial transaction id/i.test(text) ||
    /compte (?:d['’])?argent mobile|compte mobile money/i.test(text)
  ) {
    return 'mtn';
  }
  return 'unknown';
}

function extractDate(text: string): Date {
  const iso = text.match(
    /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/
  );
  if (iso) {
    const d = new Date(`${iso[1]}T${iso[2]}`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function cleanCounterparty(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*[,.]\s*$/, '')
    .trim();
}

/** Montant principal selon le type de message (évite soldes / frais). */
function extractPrimaryAmount(
  text: string,
  kind: SmsPatternKind
): { amount: number; currency?: string } | null {
  const labeled: RegExp[] = [];

  if (kind === 'transfer_out' || kind === 'transfer_in') {
    labeled.push(
      new RegExp(`Montant\\s+Transaction\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
      new RegExp(`Montant\\s+Net\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i')
    );
  }
  if (kind === 'payment' || kind === 'withdrawal' || kind === 'unknown') {
    labeled.push(
      new RegExp(`Montant\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
      new RegExp(
        `(?:votre\\s+)?paiement\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`,
        'i'
      ),
      new RegExp(`(?:une\\s+)?transaction\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`, 'i'),
      new RegExp(
        `(?:vous\\s+avez\\s+)?re[cç]u\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`,
        'i'
      ),
      new RegExp(`recharg[ée]e?\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`, 'i'),
      new RegExp(`(?:sent|paid|received)\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`, 'i')
    );
  }
  if (kind === 'withdrawal') {
    labeled.push(
      new RegExp(`montant\\s+net\\s+debit[ée]\\s+${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i')
    );
  }

  // Fallbacks génériques (toujours après les labels)
  labeled.push(
    new RegExp(`Montant\\s+Transaction\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
    new RegExp(`Montant\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
    new RegExp(`${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`, 'i')
  );

  return firstLabeledAmount(text, labeled);
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

function result(partial: Omit<ParsedMobileMoney, 'date'> & { date?: Date }): ParsedMobileMoney {
  return {
    ...partial,
    date: partial.date ?? new Date(),
    counterparty: cleanCounterparty(partial.counterparty),
    description: cleanCounterparty(partial.description),
  };
}

/** Orange — transfert P2P. */
function parseOrangeTransfer(
  text: string,
  identity?: UserSmsIdentity
): ParsedMobileMoney | null {
  const m = text.match(
    new RegExp(
      `Transfert\\s+de\\s+${PHONE}\\s+${PERSON_NAME}\\s+vers\\s+${PHONE}\\s+${PERSON_NAME}\\s+r[eé]ussi`,
      'i'
    )
  );
  if (!m) return null;

  const [, senderPhone, senderName, recipientPhone, recipientName] = m;
  const txId = extractTransactionId(text);
  const amt = extractPrimaryAmount(text, 'transfer_out');
  if (!amt) return null;

  const { type, confidence: typeConf } = inferTransferType(
    senderName,
    senderPhone,
    recipientName,
    recipientPhone,
    identity
  );
  const counterparty = type === 'income' ? senderName.trim() : recipientName.trim();

  return result({
    amount: amt.amount,
    type,
    operator: 'orange',
    counterparty,
    description:
      type === 'income'
        ? `Transfert reçu — ${counterparty}`
        : `Transfert vers ${counterparty}`,
    date: extractDate(text),
    confidence: typeConf,
    pattern: type === 'income' ? 'transfer_in' : 'transfer_out',
    transaction_id: txId,
    sender_name: senderName.trim(),
    sender_phone: senderPhone,
    recipient_name: recipientName.trim(),
    recipient_phone: recipientPhone,
  });
}

/**
 * Orange — paiement marchand.
 * Ex: "Paiement de WelcomePack en succes par 693… CHARLES"
 * Ex: "Paiement de Achat Max it?3 reussi par 693… YIMBNE"
 */
function parseOrangePayment(text: string): ParsedMobileMoney | null {
  const m = text.match(
    /Paiement\s+de\s+(.+?)\s+(?:r[eé]ussi|en\s+succ[eè]s)\s+par\s+(\d{8,15})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9\s.'-]{1,60})/i
  );
  if (!m) return null;

  const [, merchant, payerPhone, payerName] = m;
  const txId = extractTransactionId(text);
  const amt =
    extractPrimaryAmount(text, 'payment') ||
    firstLabeledAmount(text, [
      new RegExp(`Montant\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
    ]);
  if (!amt) return null;

  const counterparty = cleanCounterparty(merchant);

  return result({
    amount: amt.amount,
    type: 'expense',
    operator: 'orange',
    counterparty,
    description: `Paiement — ${counterparty}`,
    date: extractDate(text),
    confidence: amt.currency || /FCFA|XAF|CFA/i.test(text) ? 0.92 : 0.85,
    pattern: 'payment',
    transaction_id: txId,
    sender_name: payerName.trim(),
    sender_phone: payerPhone,
    recipient_name: counterparty,
    recipient_phone: '',
  });
}

/** Orange — retrait chez un agent. */
function parseOrangeWithdrawal(text: string): ParsedMobileMoney | null {
  if (!/Retrait\s+d['’]argent\s+r[eé]ussi/i.test(text)) return null;

  const txId = extractTransactionId(text);
  const amt = extractPrimaryAmount(text, 'withdrawal');
  if (!amt) return null;

  // Montant affiché = montant retiré (pas le net débité avec frais)
  const withdrawn =
    firstLabeledAmount(text, [
      new RegExp(`Montant\\s*:\\s*${AMOUNT_TOKEN}${CURRENCY_OPT}`, 'i'),
    ]) || amt;

  const agentMatch = text.match(/r[eé]ussi\s+par\s+le\s+(\d{8,15})/i);

  return result({
    amount: withdrawn.amount,
    type: 'expense',
    operator: 'orange',
    counterparty: agentMatch ? `Agent ${agentMatch[1]}` : 'Retrait espèces',
    description: 'Retrait Orange Money',
    date: extractDate(text),
    confidence: 0.9,
    pattern: 'withdrawal',
    transaction_id: txId,
    sender_name: '',
    sender_phone: '',
    recipient_name: '',
    recipient_phone: agentMatch?.[1] ?? '',
  });
}

/**
 * Orange Money — paiement carte prépayée (souvent en devise étrangère).
 * Ex: "votre paiement de 1.18 USD chez NAME-CHEAP.COM* Z9S4ZH a été effectué"
 */
function parseOrangeCardPayment(text: string): ParsedMobileMoney | null {
  if (!/orange\s*money|carte\s+pr[eé]pay/i.test(text) && !/chez\s+\S+/i.test(text)) {
    return null;
  }

  const m = text.match(
    new RegExp(
      `(?:votre\\s+)?paiement\\s+de\\s+${AMOUNT_TOKEN}\\s*(USD|EUR|XAF|FCFA|CFA)\\s+chez\\s+(.+?)\\s+a\\s+[eé]t[eé]\\s+[eé]ffectu[eé]`,
      'i'
    )
  );
  if (!m) return null;

  const amount = parseAmount(m[1]);
  if (!amount) return null;

  const currency = m[2].toUpperCase();
  const counterparty = cleanCounterparty(m[3]).slice(0, 80);

  return result({
    amount,
    type: 'expense',
    operator: 'orange',
    counterparty,
    description: `Paiement carte — ${counterparty}${currency !== 'XAF' && currency !== 'FCFA' ? ` (${amount} ${currency})` : ''}`,
    date: extractDate(text),
    confidence: currency === 'USD' || currency === 'EUR' ? 0.72 : 0.88,
    pattern: 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: '',
    sender_phone: '',
    recipient_name: counterparty,
    recipient_phone: '',
  });
}

/**
 * Orange — recharge carte virtuelle depuis le wallet.
 * Ex: "Votre carte prépayée virtuelle a été rechargée de 1000 XAF"
 */
function parseOrangeCardReload(text: string): ParsedMobileMoney | null {
  const m = text.match(
    new RegExp(
      `carte\\s+pr[eé]pay[eé]e(?:\\s+virtuelle)?\\s+a\\s+[eé]t[eé]\\s+recharg[eé]e\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`,
      'i'
    )
  );
  if (!m) return null;

  const amount = parseAmount(m[1]);
  if (!amount) return null;

  return result({
    amount,
    type: 'expense',
    operator: 'orange',
    counterparty: 'Carte prépayée virtuelle',
    description: 'Recharge carte prépayée Orange Money',
    date: extractDate(text),
    confidence: 0.9,
    pattern: 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: '',
    sender_phone: '',
    recipient_name: 'Carte prépayée virtuelle',
    recipient_phone: '',
  });
}

/**
 * MTN — réception d'argent.
 * Ex: "Vous avez recu 10000 XAF de LOUISE SIPORA KOUMEN (237678834414)"
 */
function parseMtnReceived(text: string): ParsedMobileMoney | null {
  const m = text.match(
    new RegExp(
      `Vous\\s+avez\\s+re[cç]u\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}\\s+de\\s+(.+?)\\s*(?:\\((\\d{8,15})\\))?\\s+sur\\s+votre\\s+compte`,
      'i'
    )
  );
  if (!m) {
    // Variante sans "sur votre compte"
    const alt = text.match(
      new RegExp(
        `Vous\\s+avez\\s+re[cç]u\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}\\s+de\\s+([A-Za-zÀ-ÿ0-9\\s.'-]{2,60}?)(?:\\s*\\((\\d{8,15})\\))?`,
        'i'
      )
    );
    if (!alt) return null;
    const amount = parseAmount(alt[1]);
    if (!amount) return null;
    const name = cleanCounterparty(alt[3]);
    const phone = alt[4] ?? '';
    return result({
      amount,
      type: 'income',
      operator: 'mtn',
      counterparty: name,
      description: `MoMo reçu — ${name}`,
      date: extractDate(text),
      confidence: 0.93,
      pattern: 'transfer_in',
      transaction_id: extractTransactionId(text),
      sender_name: name,
      sender_phone: phone,
      recipient_name: '',
      recipient_phone: '',
    });
  }

  const amount = parseAmount(m[1]);
  if (!amount) return null;
  const name = cleanCounterparty(m[3]);
  const phone = m[4] ?? '';

  return result({
    amount,
    type: 'income',
    operator: 'mtn',
    counterparty: name,
    description: `MoMo reçu — ${name}`,
    date: extractDate(text),
    confidence: 0.94,
    pattern: 'transfer_in',
    transaction_id: extractTransactionId(text),
    sender_name: name,
    sender_phone: phone,
    recipient_name: '',
    recipient_phone: '',
  });
}

/**
 * MTN — paiement marchand / airtime.
 * Ex: "Votre paiement de 200 XAF a MTNC AIRTIME a ete effectue"
 */
function parseMtnPayment(text: string): ParsedMobileMoney | null {
  const m = text.match(
    new RegExp(
      `Votre\\s+paiement\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}\\s+(?:a|à)\\s+(.+?)\\s+a\\s+[eé]t[eé]\\s+[eé]ffectu[eé]`,
      'i'
    )
  );
  if (!m) return null;

  const amount = parseAmount(m[1]);
  if (!amount) return null;
  const merchant = cleanCounterparty(m[3]);

  return result({
    amount,
    type: 'expense',
    operator: 'mtn',
    counterparty: merchant,
    description: `Paiement MoMo — ${merchant}`,
    date: extractDate(text),
    confidence: 0.92,
    pattern: 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: '',
    sender_phone: '',
    recipient_name: merchant,
    recipient_phone: '',
  });
}

/**
 * MTN — débit service / bundles.
 * Ex: "Une transaction de 500 XAF effectuee par MTNC BUNDLES_FORFAITS (MTN_Bundles)"
 */
function parseMtnDebitTransaction(text: string): ParsedMobileMoney | null {
  const m = text.match(
    new RegExp(
      `(?:Une\\s+)?transaction\\s+de\\s+${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}\\s+[eé]ffectu[eé]e\\s+par\\s+(.+?)\\s+sur\\s+votre\\s+compte`,
      'i'
    )
  );
  if (!m) return null;

  const amount = parseAmount(m[1]);
  if (!amount) return null;

  let merchant = cleanCounterparty(m[3]);
  // Préférer le libellé hors parenthèses s'il est plus court/lisible
  const paren = merchant.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    merchant = cleanCounterparty(paren[1]);
  }

  return result({
    amount,
    type: 'expense',
    operator: 'mtn',
    counterparty: merchant,
    description: `Débit MoMo — ${merchant}`,
    date: extractDate(text),
    confidence: 0.91,
    pattern: 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: '',
    sender_phone: '',
    recipient_name: merchant,
    recipient_phone: '',
  });
}

/** MTN / MoMo — formats anglais ou génériques restants. */
function parseMtnMomoGeneric(text: string): ParsedMobileMoney | null {
  const lower = text.toLowerCase();
  if (!/mtn|momo|mobile\s+money|argent\s+mobile/.test(lower)) return null;
  // Promo footer souvent collée : ne pas s'appuyer uniquement sur "retrait(s)" promo
  const core = text.split(/Prix\s+Cass[eé]s|Disponible\s+sur\s+la\s+MoMo/i)[0] ?? text;

  const amt = extractPrimaryAmount(core, 'unknown');
  if (!amt) return null;

  const isIncome =
    /you have received|vous avez re[cç]u|credited|cr[eé]dit[eé]/i.test(core);
  const isExpense =
    /you have sent|envoy[eé]|paid|paiement|withdrawn|retrait(?!s\s+Hors)|debit[eé]?|transaction\s+de/i.test(
      core
    );
  if (!isIncome && !isExpense) return null;

  const partyMatch =
    core.match(
      /(?:from|to|de|chez)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9\s.'*_-]{1,50}?)(?:\s+\(|\s+sur\s+votre|\s+a\s+[eé]t|\.|,|$)/i
    ) ||
    core.match(
      /[eé]ffectu[eé]e?\s+par\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s._-]{1,50}?)(?:\s+\(|\s+sur\s+votre)/i
    );
  const party = cleanCounterparty(partyMatch?.[1] || 'MTN MoMo');

  return result({
    amount: amt.amount,
    type: isIncome ? 'income' : 'expense',
    operator: 'mtn',
    counterparty: party,
    description: isIncome ? `MoMo reçu — ${party}` : `MoMo — ${party}`,
    date: extractDate(text),
    confidence: 0.8,
    pattern: isIncome ? 'transfer_in' : isExpense ? 'payment' : 'unknown',
    transaction_id: extractTransactionId(text),
    sender_name: isIncome ? party : '',
    sender_phone: '',
    recipient_name: isIncome ? '' : party,
    recipient_phone: '',
  });
}

function parseWave(text: string): ParsedMobileMoney | null {
  const lower = text.toLowerCase();
  if (!lower.includes('wave')) return null;

  const amt =
    extractPrimaryAmount(text, 'unknown') ||
    firstLabeledAmount(text, [new RegExp(`${AMOUNT_TOKEN}\\s*${CURRENCY_WAVE}`, 'i')]);
  if (!amt) return null;

  const isIncome = /re[cç]u|received|vous avez re[cç]u|credit/i.test(lower);
  const merchant =
    cleanCounterparty(
      text.match(/(?:à|a|chez|from|de)\s+([A-Za-zÀ-ÿ0-9\s.'-]{2,40})/i)?.[1] || 'Wave'
    );

  return result({
    amount: amt.amount,
    type: isIncome ? 'income' : 'expense',
    operator: 'unknown',
    counterparty: merchant,
    description: isIncome ? `Wave — reçu de ${merchant}` : `Wave — paiement ${merchant}`,
    date: extractDate(text),
    confidence: 0.82,
    pattern: isIncome ? 'transfer_in' : 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: isIncome ? merchant : '',
    sender_phone: '',
    recipient_name: isIncome ? '' : merchant,
    recipient_phone: '',
  });
}

function parseBankNotification(text: string): ParsedMobileMoney | null {
  const lower = text.toLowerCase();
  // Ne pas confondre "carte prépayée Orange" avec une notif bancaire
  if (/orange\s*money|momo|mtn|mobile\s+money/i.test(lower)) return null;

  const isBank =
    /uba|ecobank|afriland|scb|bicec|express union|\bbanque\b|\bbank\b/.test(lower);
  if (!isBank) return null;

  const amt =
    firstLabeledAmount(text, [
      /(?:debit|credit|cr[eé]dit[eé]|d[eé]bit[eé]|of)\s+(?:of\s+)?(\d[\d\s.,]*)\s*(FCFA|XAF|CFA)?/i,
      new RegExp(`${AMOUNT_TOKEN}\\s*${CURRENCY_CAP}`, 'i'),
    ]) || extractPrimaryAmount(text, 'unknown');
  if (!amt) return null;

  const isIncome =
    /credit|cr[eé]dit[eé]|re[cç]u|depot|d[eé]p[oô]t|virement\s+(re[cç]u)/i.test(lower);
  const isExpense =
    /debit|d[eé]bit[eé]|paiement|retrait|achat|pr[eé]lev[eé]/i.test(lower);
  if (!isIncome && !isExpense) return null;

  const bank = lower.includes('uba')
    ? 'UBA'
    : lower.includes('ecobank')
      ? 'Ecobank'
      : lower.includes('afriland')
        ? 'Afriland'
        : lower.includes('scb')
          ? 'SCB'
          : lower.includes('bicec')
            ? 'BICEC'
            : lower.includes('express union')
              ? 'Express Union'
              : 'Banque';

  return result({
    amount: amt.amount,
    type: isIncome ? 'income' : 'expense',
    operator: 'unknown',
    counterparty: bank,
    description: isIncome ? `Crédit ${bank}` : `Débit ${bank}`,
    date: extractDate(text),
    confidence: 0.78,
    pattern: isIncome ? 'transfer_in' : 'payment',
    transaction_id: extractTransactionId(text),
    sender_name: '',
    sender_phone: '',
    recipient_name: '',
    recipient_phone: '',
  });
}

function parseGenericFallback(text: string): ParsedMobileMoney | null {
  if (
    !/fcfa|xaf|cfa|r[eé]ussi|succ[eè]s|transfert|paiement|retrait|montant|debit|credit|mobile\s+money/i.test(
      text
    )
  ) {
    return null;
  }

  const txId = extractTransactionId(text);
  const amt = extractPrimaryAmount(text, 'unknown');
  if (!amt) return null;

  const lower = text.toLowerCase();
  const isIncome = /re[cç]u|credite|cr[eé]dit[eé]|you have received/i.test(lower);

  return result({
    amount: amt.amount,
    type: isIncome ? 'income' : 'expense',
    operator: detectOperator(text, txId),
    counterparty: '',
    description: 'Mobile Money',
    date: extractDate(text),
    confidence: 0.5,
    pattern: 'unknown',
    transaction_id: txId,
    sender_name: '',
    sender_phone: '',
    recipient_name: '',
    recipient_phone: '',
  });
}

/**
 * Parse SMS / notifications Orange Money & MTN MoMo (Cameroun).
 * Patterns calés sur formats réels, avec tolérance (accents, espaces, devise collée).
 */
export function parseMobileMoneySms(
  text: string,
  identity?: UserSmsIdentity
): ParsedMobileMoney | null {
  const body = text.trim().replace(/\s+/g, ' ');
  if (!body) return null;

  return (
    parseOrangeTransfer(body, identity) ||
    parseOrangePayment(body) ||
    parseOrangeWithdrawal(body) ||
    parseOrangeCardPayment(body) ||
    parseOrangeCardReload(body) ||
    parseMtnReceived(body) ||
    parseMtnPayment(body) ||
    parseMtnDebitTransaction(body) ||
    parseMtnMomoGeneric(body) ||
    parseWave(body) ||
    parseBankNotification(body) ||
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
