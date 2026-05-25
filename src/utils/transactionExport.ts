import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';

export interface PopulatedTransactionLike {
  _id: unknown;
  type: string;
  amount: number;
  description?: string;
  date: Date;
  balance_before?: number;
  balance_after?: number;
  wallet_id?: { name?: string; currency?: string } | unknown;
  destination_wallet_id?: { name?: string } | unknown;
  category_id?: { name?: string } | null;
}

function escapeCsv(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function walletName(w: PopulatedTransactionLike['wallet_id']): string {
  if (w && typeof w === 'object' && 'name' in w) return String((w as { name: string }).name);
  return '';
}

function categoryName(c: PopulatedTransactionLike['category_id']): string {
  if (c && typeof c === 'object' && 'name' in c) return String((c as { name: string }).name);
  return '';
}

function typeLabel(type: string): string {
  if (type === 'income') return 'Revenu';
  if (type === 'expense') return 'Dépense';
  if (type === 'transfer') return 'Transfert';
  return type;
}

function formatMoney(amount: number, currency = 'XAF'): string {
  return `${formatAmountWithSpaces(amount)} ${currency}`;
}

/** Montants pour Excel : espaces ASCII (évite U+202F / affichage « / » dans Excel). */
function formatAmountWithSpaces(amount: number): string {
  const n = Math.round(amount);
  const negative = n < 0;
  const digits = Math.abs(n).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return negative ? `-${grouped}` : grouped;
}

function formatExcelDate(date: Date): string {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}

function excelAmountValue(value: number | null | undefined): string | number {
  if (value == null || Number.isNaN(value)) return '';
  return formatAmountWithSpaces(value);
}

export function transactionToCsvRow(t: PopulatedTransactionLike): string {
  const cur =
    t.wallet_id && typeof t.wallet_id === 'object' && 'currency' in t.wallet_id
      ? String((t.wallet_id as { currency: string }).currency)
      : 'XAF';
  const dest =
    t.destination_wallet_id && typeof t.destination_wallet_id === 'object'
      ? walletName(t.destination_wallet_id)
      : '';
  return [
    new Date(t.date).toISOString().split('T')[0],
    typeLabel(t.type),
    String(t.amount),
    escapeCsv(walletName(t.wallet_id)),
    escapeCsv(dest),
    escapeCsv(categoryName(t.category_id)),
    escapeCsv(t.description || ''),
    cur,
    t.balance_before != null ? String(t.balance_before) : '',
    t.balance_after != null ? String(t.balance_after) : '',
  ].join(',');
}

export const CSV_HEADER =
  'Date,Type,Montant,Poche,Destination,Catégorie,Description,Devise,Solde avant,Solde après';

export function buildTransactionsCsv(transactions: PopulatedTransactionLike[]): string {
  const rows = transactions.map(transactionToCsvRow);
  return '\uFEFF' + [CSV_HEADER, ...rows].join('\n');
}

export function buildSingleTransactionCsv(t: PopulatedTransactionLike): string {
  return buildTransactionsCsv([t]);
}

function transactionToExcelRow(t: PopulatedTransactionLike): Record<string, string | number> {
  const cur =
    t.wallet_id && typeof t.wallet_id === 'object' && 'currency' in t.wallet_id
      ? String((t.wallet_id as { currency: string }).currency)
      : 'XAF';
  const dest =
    t.destination_wallet_id && typeof t.destination_wallet_id === 'object'
      ? walletName(t.destination_wallet_id)
      : '';
  return {
    Date: formatExcelDate(new Date(t.date)),
    Type: typeLabel(t.type),
    Montant: excelAmountValue(t.amount),
    Poche: walletName(t.wallet_id),
    Destination: dest,
    Catégorie: categoryName(t.category_id),
    Description: t.description || '',
    Devise: cur,
    'Solde avant': excelAmountValue(t.balance_before),
    'Solde après': excelAmountValue(t.balance_after),
  };
}

export function buildTransactionsXlsx(transactions: PopulatedTransactionLike[]): Buffer {
  const rows = transactions.map(transactionToExcelRow);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildSingleTransactionXlsx(t: PopulatedTransactionLike): Buffer {
  return buildTransactionsXlsx([t]);
}

export function buildTransactionPdf(
  t: PopulatedTransactionLike,
  extra?: { transferFrom?: string; transferTo?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency =
      t.wallet_id && typeof t.wallet_id === 'object' && 'currency' in t.wallet_id
        ? String((t.wallet_id as { currency: string }).currency)
        : 'XAF';

    doc.fontSize(20).fillColor('#635BFF').text('MES POCHES', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor('#333').text('Reçu de transaction', { align: 'center' });
    doc.moveDown(1.5);

    const lines: [string, string][] = [
      ['Type', typeLabel(t.type)],
      ['Date', new Date(t.date).toLocaleString('fr-FR')],
      ['Montant', formatMoney(t.amount, currency)],
      ['Poche', walletName(t.wallet_id) || '—'],
    ];

    if (t.type === 'transfer' && extra) {
      lines.push(['De', extra.transferFrom || '—']);
      lines.push(['Vers', extra.transferTo || '—']);
    } else {
      if (categoryName(t.category_id)) lines.push(['Catégorie', categoryName(t.category_id)]);
      if (t.description) lines.push(['Description', t.description]);
      if (t.balance_before != null)
        lines.push(['Solde avant', formatMoney(t.balance_before, currency)]);
      if (t.balance_after != null)
        lines.push(['Solde après', formatMoney(t.balance_after, currency)]);
    }

    doc.fontSize(11).fillColor('#111');
    for (const [label, value] of lines) {
      doc.font('Helvetica-Bold').text(`${label} : `, { continued: true });
      doc.font('Helvetica').text(value);
      doc.moveDown(0.4);
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888').text(
      `Document généré le ${new Date().toLocaleString('fr-FR')} — MES POCHES`,
      { align: 'center' }
    );

    doc.end();
  });
}

export function buildTransactionsPdf(transactions: PopulatedTransactionLike[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).fillColor('#635BFF').text('MES POCHES — Export transactions');
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666').text(`${transactions.length} transaction(s)`);
    doc.moveDown(1);

    transactions.forEach((t, i) => {
      if (i > 0) doc.moveDown(0.8);
      doc.fontSize(11).fillColor('#111').font('Helvetica-Bold');
      doc.text(
        `${new Date(t.date).toLocaleDateString('fr-FR')} — ${typeLabel(t.type)} — ${formatMoney(t.amount)}`
      );
      doc.font('Helvetica').fontSize(10).fillColor('#444');
      const parts = [
        walletName(t.wallet_id),
        categoryName(t.category_id),
        t.description,
      ].filter(Boolean);
      if (parts.length) doc.text(parts.join(' · '));
    });

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888').text(
      `Export du ${new Date().toLocaleString('fr-FR')}`,
      { align: 'center' }
    );

    doc.end();
  });
}
