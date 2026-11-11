import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

/* ───────────────────────────── Types ───────────────────────────── */

type Named = { name?: string } | null | undefined;

export interface PopulatedTransactionLike {
  _id: unknown;
  type: string;
  amount: number;
  description?: string;
  date: Date;
  balance_before?: number;
  balance_after?: number;
  wallet_id?: Named | unknown;
  destination_wallet_id?: Named | unknown;
  category_id?: Named | unknown;
  savings_goal_id?: { title?: string } | unknown;
  line_items?: Array<{
    description?: string;
    amount?: number;
    quantity?: number;
    unit_amount?: number;
    type?: string;
    category_id?: Named | unknown;
  }>;
  created_at?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Contexte du document : titulaire, période choisie, devise, fuseau de l'utilisateur. */
export interface ExportContext {
  holderName: string;
  holderEmail: string;
  currency: string;
  timeZone: string;
  /** Période demandée (dates locales AAAA-MM-JJ, fin incluse) ; null = déduite des opérations. */
  from: string | null;
  to: string | null;
  generatedAt: Date;
}

/** Ligne prête à écrire : une opération et ses tâches. */
interface Row {
  ref: string;
  id: string;
  type: 'income' | 'expense' | 'transfer';
  typeLabel: string;
  date: Date;
  description: string;
  category: string;
  wallet: string;
  destination: string;
  amount: number;
  income: number | null;
  expense: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
  tasks: {
    description: string;
    category: string;
    quantity: number;
    unit: number | null;
    amount: number;
    type: 'income' | 'expense';
  }[];
}

/* ───────────────────────────── Données ───────────────────────────── */

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const LOGO = path.join(ASSETS, 'logo.png');
const FONT = {
  regular: path.join(ASSETS, 'fonts', 'Outfit_400Regular.ttf'),
  medium: path.join(ASSETS, 'fonts', 'Outfit_500Medium.ttf'),
  semi: path.join(ASSETS, 'fonts', 'Outfit_600SemiBold.ttf'),
  bold: path.join(ASSETS, 'fonts', 'Outfit_700Bold.ttf'),
};

function nameOf(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return String((v as { name?: string }).name || '');
  return '';
}

function typeLabel(type: string): string {
  if (type === 'income') return 'Entrée';
  if (type === 'expense') return 'Sortie';
  if (type === 'transfer') return 'Transfert';
  return type;
}

function toRow(t: PopulatedTransactionLike, index: number): Row {
  const type = (t.type === 'income' || t.type === 'expense' ? t.type : 'transfer') as Row['type'];
  const goal =
    t.savings_goal_id && typeof t.savings_goal_id === 'object' && 'title' in t.savings_goal_id
      ? String((t.savings_goal_id as { title?: string }).title || '')
      : '';
  const category =
    nameOf(t.category_id) || (goal ? `Épargne : ${goal}` : type === 'transfer' ? 'Transfert' : 'Sans catégorie');
  const created = t.createdAt || t.created_at || null;
  const updated = t.updatedAt || null;
  // Modifiée : dernière mise à jour plus d'une minute après la création.
  const modifiedAt =
    created && updated && new Date(updated).getTime() - new Date(created).getTime() > 60_000 ? new Date(updated) : null;
  const amount = Number(t.amount) || 0;
  return {
    ref: `OP-${String(index + 1).padStart(4, '0')}`,
    id: String(t._id),
    type,
    typeLabel: goal ? (type === 'income' ? 'Retrait d’épargne' : 'Versement d’épargne') : typeLabel(type),
    date: new Date(t.date),
    description: (t.description || '').trim() || category,
    category,
    wallet: nameOf(t.wallet_id),
    destination: nameOf(t.destination_wallet_id),
    amount,
    income: type === 'income' ? amount : null,
    expense: type === 'expense' ? amount : null,
    balanceBefore: typeof t.balance_before === 'number' ? t.balance_before : null,
    balanceAfter: typeof t.balance_after === 'number' ? t.balance_after : null,
    createdAt: created ? new Date(created) : null,
    modifiedAt,
    tasks: (t.line_items || []).map((line) => {
      const quantity = line.quantity && line.quantity > 1 ? line.quantity : 1;
      const lineType: 'income' | 'expense' =
        line.type === 'income' || line.type === 'expense' ? line.type : type === 'income' ? 'income' : 'expense';
      return {
        description: (line.description || '').trim() || 'Sans libellé',
        category: nameOf(line.category_id) || category,
        quantity,
        unit: line.unit_amount && quantity > 1 ? line.unit_amount : null,
        amount: Number(line.amount) || 0,
        type: lineType,
      };
    }),
  };
}

/** Une seule tâche identique à l'opération n'apporte rien : on ne la répète pas. */
function meaningfulTasks(r: Row) {
  return r.tasks.length > 1 ? r.tasks : [];
}

function totals(rows: Row[]) {
  let income = 0;
  let expense = 0;
  let transfers = 0;
  for (const r of rows) {
    if (r.type === 'income') income += r.amount;
    else if (r.type === 'expense') expense += r.amount;
    else transfers += r.amount;
  }
  return { income, expense, net: income - expense, transfers, count: rows.length };
}

function groupBy(rows: Row[], key: (r: Row) => string) {
  const map = new Map<string, { income: number; expense: number; count: number }>();
  for (const r of rows) {
    if (r.type === 'transfer') continue;
    const k = key(r) || '—';
    const cur = map.get(k) ?? { income: 0, expense: 0, count: 0 };
    if (r.type === 'income') cur.income += r.amount;
    else cur.expense += r.amount;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.expense + b.income - (a.expense + a.income));
}

/* ───────────────────────────── Formats ───────────────────────────── */

export function currencyLabel(currency: string): string {
  return currency === 'XAF' || currency === 'XOF' ? 'FCFA' : currency;
}

function money(n: number, currency: string): string {
  const v = Math.round(n);
  const s = Math.abs(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '-' : ''}${s} ${currencyLabel(currency)}`;
}

function fmtDate(d: Date, tz: string, withTime = false): string {
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: tz,
  });
}

function longDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** AAAA-MM-JJ dans le fuseau de l'utilisateur. */
function ymdIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Excel n'a pas de fuseau : on écrit l'heure locale de l'utilisateur comme heure « murale ». */
function wallClock(d: Date | null, tz: string): Date | null {
  if (!d) return null;
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value || 0);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

function periodOf(ctx: ExportContext, dates: Date[]): { from: string; to: string } | null {
  if (ctx.from && ctx.to) return { from: ctx.from, to: ctx.to };
  const times = dates.map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return { from: ymdIn(new Date(Math.min(...times)), ctx.timeZone), to: ymdIn(new Date(Math.max(...times)), ctx.timeZone) };
}

/** Titre conforme aux dates choisies : « Relevé du 1 octobre 2026 au 31 octobre 2026 ». */
export function exportTitle(ctx: ExportContext, transactions: PopulatedTransactionLike[] = []): string {
  const p = periodOf(ctx, transactions.map((t) => t.date));
  if (!p) return 'Relevé de toutes les opérations';
  if (p.from === p.to) return `Relevé du ${longDate(p.from)}`;
  return `Relevé du ${longDate(p.from)} au ${longDate(p.to)}`;
}

/** Nom de fichier : mes-poches-releve-2026-10-01_au_2026-10-31. */
export function exportFileBase(ctx: ExportContext, transactions: PopulatedTransactionLike[]): string {
  const p = periodOf(ctx, transactions.map((t) => t.date));
  if (!p) return `mes-poches-releve-${ymdIn(ctx.generatedAt, ctx.timeZone)}`;
  return p.from === p.to ? `mes-poches-releve-${p.from}` : `mes-poches-releve-${p.from}_au_${p.to}`;
}

/* ───────────────────────────── CSV ───────────────────────────── */

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round = (n: number | null | undefined) => (n == null ? '' : Math.round(n));

/**
 * CSV au format Excel français (séparateur « ; », BOM UTF-8) : une ligne par opération,
 * puis une ligne par tâche juste en dessous (colonne « Niveau »).
 */
export function buildTransactionsCsv(transactions: PopulatedTransactionLike[], ctx: ExportContext): string {
  const rows = transactions.map(toRow);
  const cur = currencyLabel(ctx.currency);
  const header = [
    'N°',
    'Niveau',
    'Date',
    'Type',
    'Description',
    'Catégorie',
    'Poche',
    'Poche destination',
    'Quantité',
    `Prix unitaire (${cur})`,
    `Entrée (${cur})`,
    `Sortie (${cur})`,
    `Transfert (${cur})`,
    `Solde avant (${cur})`,
    `Solde après (${cur})`,
    'Créée le',
    'Modifiée le',
  ];
  const lines = [header.map(csvCell).join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.ref,
        'Opération',
        fmtDate(r.date, ctx.timeZone, true),
        r.typeLabel,
        r.description,
        r.category,
        r.wallet,
        r.destination,
        '',
        '',
        round(r.income),
        round(r.expense),
        r.type === 'transfer' ? round(r.amount) : '',
        round(r.balanceBefore),
        round(r.balanceAfter),
        r.createdAt ? fmtDate(r.createdAt, ctx.timeZone, true) : '',
        r.modifiedAt ? fmtDate(r.modifiedAt, ctx.timeZone, true) : '',
      ]
        .map(csvCell)
        .join(';')
    );
    meaningfulTasks(r).forEach((task, i) => {
      lines.push(
        [
          `${r.ref}.${i + 1}`,
          'Tâche',
          fmtDate(r.date, ctx.timeZone, true),
          task.type === 'income' ? 'Entrée' : 'Sortie',
          task.description,
          task.category,
          r.wallet,
          '',
          task.quantity,
          round(task.unit),
          task.type === 'income' ? round(task.amount) : '',
          task.type === 'expense' ? round(task.amount) : '',
          '',
          '',
          '',
          '',
          '',
        ]
          .map(csvCell)
          .join(';')
      );
    });
  }
  return '﻿' + lines.join('\r\n');
}

export function buildSingleTransactionCsv(t: PopulatedTransactionLike, ctx: ExportContext): string {
  return buildTransactionsCsv([t], ctx);
}

/* ───────────────────────────── Excel ───────────────────────────── */

const X = {
  brand: 'FF2563EB',
  brandSoft: 'FFEEF4FF',
  ink: 'FF111111',
  muted: 'FF707070',
  zebra: 'FFF8F9FA',
  green: 'FF047857',
  red: 'FFB91C1C',
};

function styleHeader(row: ExcelJS.Row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X.brand } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
}

function zebra(row: ExcelJS.Row, span: number) {
  for (let c = 1; c <= span; c++) {
    row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X.zebra } };
  }
}

function sheetTitle(ws: ExcelJS.Worksheet, title: string, subtitle: string, span: number) {
  ws.mergeCells(1, 1, 1, span);
  ws.mergeCells(2, 1, 2, span);
  const t = ws.getCell(1, 1);
  t.value = `MES POCHES — ${title}`;
  t.font = { bold: true, size: 15, color: { argb: X.ink } };
  ws.getRow(1).height = 26;
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { size: 10, color: { argb: X.muted } };
  ws.addRow([]);
}

export async function buildTransactionsXlsx(
  transactions: PopulatedTransactionLike[],
  ctx: ExportContext
): Promise<Buffer> {
  const rows = transactions.map(toRow);
  const title = exportTitle(ctx, transactions);
  const cur = currencyLabel(ctx.currency);
  const numFmt = `#,##0 "${cur}";-#,##0 "${cur}";0 "${cur}"`;
  const dateFmt = 'dd/mm/yyyy hh:mm';
  const sum = totals(rows);
  const tz = ctx.timeZone;
  const subtitle = `${ctx.holderName || ctx.holderEmail} · ${ctx.holderEmail} · généré le ${fmtDate(ctx.generatedAt, tz, true)}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MES POCHES';
  wb.created = ctx.generatedAt;
  wb.title = title;

  /* Synthèse */
  const syn = wb.addWorksheet('Synthèse', { views: [{ showGridLines: false }] });
  syn.columns = [{ width: 34 }, { width: 20 }, { width: 20 }, { width: 14 }];
  sheetTitle(syn, title, subtitle, 4);
  const kv = (label: string, value: number, color: string, isCount = false) => {
    const r = syn.addRow([label, value]);
    r.getCell(1).font = { color: { argb: X.muted } };
    const c = r.getCell(2);
    c.numFmt = isCount ? '0' : numFmt;
    c.font = { bold: true, color: { argb: color } };
    c.alignment = { horizontal: 'right' };
  };
  kv('Total des entrées', sum.income, X.green);
  kv('Total des sorties', sum.expense, X.red);
  kv('Solde net de la période', sum.net, sum.net >= 0 ? X.green : X.red);
  kv('Transferts entre poches', sum.transfers, X.ink);
  kv('Nombre d’opérations', sum.count, X.ink, true);
  syn.addRow([]);

  const table = (heading: string, data: { name: string; income: number; expense: number; count: number }[]) => {
    styleHeader(syn.addRow([heading, 'Entrées', 'Sorties', 'Opérations']));
    data.forEach((d, i) => {
      const r = syn.addRow([d.name, d.income, d.expense, d.count]);
      r.getCell(2).numFmt = numFmt;
      r.getCell(3).numFmt = numFmt;
      if (i % 2 === 1) zebra(r, 4);
    });
    if (!data.length) syn.addRow(['Aucune opération']);
    syn.addRow([]);
  };
  table('Par catégorie', groupBy(rows, (r) => r.category));
  table('Par poche', groupBy(rows, (r) => r.wallet));

  /* Opérations : une ligne par opération, prête à filtrer et additionner */
  const ops = wb.addWorksheet('Opérations', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const opCols = [
    { header: 'N°', width: 10 },
    { header: 'Date', width: 17 },
    { header: 'Type', width: 18 },
    { header: 'Description', width: 34 },
    { header: 'Catégorie', width: 22 },
    { header: 'Poche', width: 18 },
    { header: 'Poche destination', width: 18 },
    { header: 'Entrée', width: 15 },
    { header: 'Sortie', width: 15 },
    { header: 'Transfert', width: 15 },
    { header: 'Solde avant', width: 16 },
    { header: 'Solde après', width: 16 },
    { header: 'Tâches', width: 8 },
    { header: 'Créée le', width: 17 },
    { header: 'Modifiée le', width: 17 },
  ];
  ops.columns = opCols.map((c) => ({ width: c.width }));
  sheetTitle(ops, title, `${subtitle} · montants en ${cur} · détail des tâches dans l’onglet « Tâches »`, opCols.length);
  styleHeader(ops.addRow(opCols.map((c) => c.header)));
  rows.forEach((r, i) => {
    const row = ops.addRow([
      r.ref,
      wallClock(r.date, tz),
      r.typeLabel,
      r.description,
      r.category,
      r.wallet,
      r.destination || null,
      r.income,
      r.expense,
      r.type === 'transfer' ? r.amount : null,
      r.balanceBefore,
      r.balanceAfter,
      r.tasks.length > 1 ? r.tasks.length : null,
      wallClock(r.createdAt, tz),
      wallClock(r.modifiedAt, tz),
    ]);
    row.getCell(2).numFmt = dateFmt;
    row.getCell(14).numFmt = dateFmt;
    row.getCell(15).numFmt = dateFmt;
    for (const c of [8, 9, 10, 11, 12]) row.getCell(c).numFmt = numFmt;
    row.getCell(8).font = { color: { argb: X.green } };
    row.getCell(9).font = { color: { argb: X.red } };
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    if (i % 2 === 1) zebra(row, opCols.length);
  });
  if (rows.length) {
    const first = 5;
    const last = 4 + rows.length;
    const tot = ops.addRow([
      'TOTAL',
      null,
      null,
      `${rows.length} opération${rows.length > 1 ? 's' : ''}`,
      null,
      null,
      null,
      { formula: `SUM(H${first}:H${last})`, result: sum.income },
      { formula: `SUM(I${first}:I${last})`, result: sum.expense },
      { formula: `SUM(J${first}:J${last})`, result: sum.transfers },
    ]);
    for (let c = 1; c <= opCols.length; c++) {
      const cell = tot.getCell(c);
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X.brandSoft } };
      cell.border = { top: { style: 'thin', color: { argb: X.brand } } };
    }
    for (const c of [8, 9, 10]) tot.getCell(c).numFmt = numFmt;
    ops.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: opCols.length } };
  }

  /* Tâches : une ligne par tâche, rattachée à son opération */
  const tasks = wb.addWorksheet('Tâches', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const tCols = [
    { header: 'N° tâche', width: 13 },
    { header: 'Date', width: 17 },
    { header: 'Opération', width: 30 },
    { header: 'Poche', width: 18 },
    { header: 'Tâche', width: 30 },
    { header: 'Catégorie de la tâche', width: 24 },
    { header: 'Type', width: 10 },
    { header: 'Quantité', width: 10 },
    { header: 'Prix unitaire', width: 15 },
    { header: 'Montant', width: 15 },
  ];
  tasks.columns = tCols.map((c) => ({ width: c.width }));
  sheetTitle(tasks, title, 'Détail des opérations à plusieurs tâches (tickets, achats groupés)', tCols.length);
  styleHeader(tasks.addRow(tCols.map((c) => c.header)));
  let taskCount = 0;
  for (const r of rows) {
    meaningfulTasks(r).forEach((task, i) => {
      const row = tasks.addRow([
        `${r.ref}.${i + 1}`,
        wallClock(r.date, tz),
        r.description,
        r.wallet,
        task.description,
        task.category,
        task.type === 'income' ? 'Entrée' : 'Sortie',
        task.quantity,
        task.unit,
        task.amount,
      ]);
      row.getCell(2).numFmt = dateFmt;
      row.getCell(9).numFmt = numFmt;
      row.getCell(10).numFmt = numFmt;
      row.getCell(10).font = { color: { argb: task.type === 'income' ? X.green : X.red } };
      if (taskCount % 2 === 1) zebra(row, tCols.length);
      taskCount += 1;
    });
  }
  if (!taskCount) tasks.addRow(['Aucune opération à plusieurs tâches sur cette période.']);
  else tasks.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + taskCount, column: tCols.length } };

  const safeTitle = title.replace(/&/g, '&&');
  for (const ws of [syn, ops, tasks]) {
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    ws.headerFooter = {
      oddHeader: `&L&BMES POCHES&R${safeTitle}`,
      oddFooter: `&L© ${ctx.generatedAt.getFullYear()} MES POCHES. Tous droits réservés.&RPage &P / &N`,
    };
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function buildSingleTransactionXlsx(t: PopulatedTransactionLike, ctx: ExportContext): Promise<Buffer> {
  return buildTransactionsXlsx([t], ctx);
}

/* ───────────────────────────── PDF ───────────────────────────── */

const C = {
  brand: '#2563EB',
  brandSoft: '#EEF4FF',
  ink: '#111111',
  muted: '#707070',
  line: '#E7E7E7',
  zebra: '#F8F9FA',
  green: '#047857',
  red: '#B91C1C',
};

type Doc = PDFKit.PDFDocument;
const MARGIN = 40;

function newDoc(title: string, layout: 'portrait' | 'landscape'): Doc {
  const doc = new PDFDocument({
    size: 'A4',
    layout,
    margins: { top: 92, bottom: 70, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: title, Author: 'MES POCHES', Creator: 'MES POCHES', Producer: 'MES POCHES' },
  });
  if (fs.existsSync(FONT.regular)) {
    doc.registerFont('R', FONT.regular);
    doc.registerFont('M', FONT.medium);
    doc.registerFont('S', FONT.semi);
    doc.registerFont('B', FONT.bold);
  } else {
    doc.registerFont('R', 'Helvetica');
    doc.registerFont('M', 'Helvetica');
    doc.registerFont('S', 'Helvetica-Bold');
    doc.registerFont('B', 'Helvetica-Bold');
  }
  doc.font('R');
  return doc;
}

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** En-tête et pied de page sur chaque page : logo, MES POCHES, titre, mention légale, pagination. */
function decorate(doc: Doc, title: string, ctx: ExportContext) {
  const range = doc.bufferedPageRange();
  const hasLogo = fs.existsSync(LOGO);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const left = MARGIN;
    const right = width - MARGIN;
    const w = right - left;
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // écrire dans la marge sans créer de page

    // En-tête
    if (hasLogo) doc.image(LOGO, left, 30, { width: 30, height: 30 });
    doc.font('B').fontSize(14).fillColor(C.ink).text('MES POCHES', left + 40, 32, { lineBreak: false });
    doc.font('R').fontSize(8.5).fillColor(C.muted).text('Gestion de budget personnel', left + 40, 49, { lineBreak: false });
    doc.font('S').fontSize(9.5).fillColor(C.ink).text(title, left, 34, { width: w, align: 'right', lineBreak: false });
    doc
      .font('R')
      .fontSize(8.5)
      .fillColor(C.muted)
      .text(`Généré le ${fmtDate(ctx.generatedAt, ctx.timeZone, true)}`, left, 49, { width: w, align: 'right', lineBreak: false });
    doc.moveTo(left, 70).lineTo(right, 70).lineWidth(1).strokeColor(C.brand).stroke();

    // Pied de page
    const fy = height - 44;
    doc.moveTo(left, fy - 8).lineTo(right, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    if (hasLogo) doc.image(LOGO, left, fy - 1, { width: 14, height: 14 });
    doc.font('S').fontSize(8.5).fillColor(C.ink).text('MES POCHES', left + 19, fy + 1, { lineBreak: false });
    doc
      .font('R')
      .fontSize(8)
      .fillColor(C.muted)
      .text(`© ${ctx.generatedAt.getFullYear()} MES POCHES. Tous droits réservés.`, left, fy + 1, {
        width: w,
        align: 'center',
        lineBreak: false,
      });
    doc.text(`Page ${i - range.start + 1} / ${range.count}`, left, fy + 1, { width: w, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

function summaryTiles(doc: Doc, items: { label: string; value: string; color: string }[], y: number): number {
  const full = doc.page.width - MARGIN * 2;
  const gap = 10;
  const w = (full - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = MARGIN + i * (w + gap);
    doc.roundedRect(x, y, w, 54, 8).lineWidth(0.8).strokeColor(C.line).stroke();
    doc.font('R').fontSize(8.5).fillColor(C.muted).text(it.label, x + 12, y + 10, { width: w - 24, lineBreak: false });
    doc.font('B').fontSize(13).fillColor(it.color).text(it.value, x + 12, y + 26, { width: w - 24, lineBreak: false });
  });
  return y + 54;
}

export async function buildTransactionsPdf(
  transactions: PopulatedTransactionLike[],
  ctx: ExportContext
): Promise<Buffer> {
  const rows = transactions.map(toRow);
  const title = exportTitle(ctx, transactions);
  const doc = newDoc(title, 'landscape');
  const done = collect(doc);
  const cur = ctx.currency;
  const sum = totals(rows);
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  // Les sauts de page sont gérés ici (ensure) : pdfkit ne doit jamais en ajouter de lui-même
  // au milieu d'une ligne du tableau (sinon la fin de la ligne part sur la page suivante).
  const limit = doc.page.height - doc.page.margins.bottom;
  const bottomLimit = () => limit;
  const freeze = () => {
    doc.page.margins.bottom = 0;
  };
  doc.on('pageAdded', freeze);
  freeze();

  // Titre du document
  doc.font('B').fontSize(20).fillColor(C.ink).text(title, left, 92, { width: right - left });
  doc
    .font('R')
    .fontSize(10)
    .fillColor(C.muted)
    .text(`Titulaire : ${ctx.holderName || '—'} · ${ctx.holderEmail} · montants en ${currencyLabel(cur)}`, left, doc.y + 4);
  let y = summaryTiles(
    doc,
    [
      { label: 'Entrées', value: money(sum.income, cur), color: C.green },
      { label: 'Sorties', value: money(sum.expense, cur), color: C.red },
      { label: 'Solde net', value: money(sum.net, cur), color: sum.net >= 0 ? C.green : C.red },
      { label: 'Opérations', value: String(sum.count), color: C.ink },
    ],
    doc.y + 14
  );
  y += 20;

  // Colonnes du tableau (761 pt utiles en paysage)
  const cols = [
    { label: 'N°', w: 52, align: 'left' as const },
    { label: 'Date', w: 82, align: 'left' as const },
    { label: 'Description', w: 196, align: 'left' as const },
    { label: 'Catégorie', w: 112, align: 'left' as const },
    { label: 'Poche', w: 92, align: 'left' as const },
    { label: 'Montant', w: 87, align: 'right' as const },
    { label: 'Solde avant', w: 70, align: 'right' as const },
    { label: 'Solde après', w: 70, align: 'right' as const },
  ];
  const xs: number[] = [];
  cols.reduce((x, c) => {
    xs.push(x);
    return x + c.w;
  }, left);
  const pad = 5;
  const inner = (i: number) => cols[i].w - pad * 2;

  const drawHead = () => {
    doc.rect(left, y, right - left, 22).fill(C.brand);
    cols.forEach((c, i) => {
      doc
        .font('S')
        .fontSize(8.5)
        .fillColor('#FFFFFF')
        .text(c.label, xs[i] + pad, y + 7, { width: inner(i), align: c.align, lineBreak: false });
    });
    y += 22;
  };
  const ensure = (h: number) => {
    if (y + h > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHead();
    }
  };

  if (!rows.length) {
    doc.font('R').fontSize(11).fillColor(C.muted).text('Aucune opération sur cette période.', left, y);
  } else {
    drawHead();
    rows.forEach((r, idx) => {
      const amountText =
        r.type === 'income' ? `+${money(r.amount, cur)}` : r.type === 'expense' ? `-${money(r.amount, cur)}` : money(r.amount, cur);
      const amountColor = r.type === 'income' ? C.green : r.type === 'expense' ? C.red : C.ink;
      const walletText = r.type === 'transfer' && r.destination ? `${r.wallet} → ${r.destination}` : r.wallet;
      const dateLines = [fmtDate(r.date, ctx.timeZone, true)];
      if (r.modifiedAt) dateLines.push(`modif. ${fmtDate(r.modifiedAt, ctx.timeZone)}`);

      doc.font('M').fontSize(9);
      const descH = doc.heightOfString(r.description, { width: inner(2) });
      doc.font('R').fontSize(8);
      const subH = doc.heightOfString(r.typeLabel, { width: inner(2) });
      doc.font('R').fontSize(8.5);
      const catH = doc.heightOfString(r.category, { width: inner(3) });
      const walletH = doc.heightOfString(walletText || '—', { width: inner(4) });
      const rowH = Math.max(30, descH + subH + 14, catH + 14, walletH + 14, dateLines.length * 11 + 14);
      const tasks = meaningfulTasks(r);
      ensure(rowH + (tasks.length ? 18 : 0));

      if (idx % 2 === 1) doc.rect(left, y, right - left, rowH).fill(C.zebra);
      const ty = y + 7;
      doc.font('R').fontSize(8.5).fillColor(C.muted).text(r.ref, xs[0] + pad, ty, { width: inner(0), lineBreak: false });
      dateLines.forEach((line, i) =>
        doc
          .font('R')
          .fontSize(i === 0 ? 8.5 : 7.5)
          .fillColor(i === 0 ? C.ink : C.muted)
          .text(line, xs[1] + pad, ty + i * 11, { width: inner(1), lineBreak: false })
      );
      doc.font('M').fontSize(9).fillColor(C.ink).text(r.description, xs[2] + pad, ty, { width: inner(2) });
      doc.font('R').fontSize(8).fillColor(C.muted).text(r.typeLabel, xs[2] + pad, ty + descH + 1, { width: inner(2) });
      doc.font('R').fontSize(8.5).fillColor(C.ink).text(r.category, xs[3] + pad, ty, { width: inner(3) });
      doc.font('R').fontSize(8.5).fillColor(C.ink).text(walletText || '—', xs[4] + pad, ty, { width: inner(4) });
      doc
        .font('S')
        .fontSize(9)
        .fillColor(amountColor)
        .text(amountText, xs[5] + pad, ty, { width: inner(5), align: 'right', lineBreak: false });
      doc
        .font('R')
        .fontSize(8.5)
        .fillColor(C.muted)
        .text(r.balanceBefore != null ? money(r.balanceBefore, cur) : '—', xs[6] + pad, ty, {
          width: inner(6),
          align: 'right',
          lineBreak: false,
        });
      doc
        .font('M')
        .fontSize(8.5)
        .fillColor(C.ink)
        .text(r.balanceAfter != null ? money(r.balanceAfter, cur) : '—', xs[7] + pad, ty, {
          width: inner(7),
          align: 'right',
          lineBreak: false,
        });
      y += rowH;

      // Tâches de l'opération, en retrait sous la ligne
      tasks.forEach((task) => {
        const label = `${task.description}${task.quantity > 1 ? ` × ${task.quantity}` : ''}`;
        doc.font('R').fontSize(8.5);
        const h = Math.max(18, doc.heightOfString(label, { width: inner(2) - 12 }) + 8);
        ensure(h);
        if (idx % 2 === 1) doc.rect(left, y, right - left, h).fill(C.zebra);
        doc.moveTo(xs[2] + pad, y + 3).lineTo(xs[2] + pad, y + h - 3).lineWidth(1.5).strokeColor(C.brand).stroke();
        doc.font('R').fontSize(8.5).fillColor(C.ink).text(label, xs[2] + pad + 8, y + 4, { width: inner(2) - 12 });
        doc.font('R').fontSize(8).fillColor(C.muted).text(task.category, xs[3] + pad, y + 4, {
          width: inner(3),
          lineBreak: false,
          ellipsis: true,
        });
        doc
          .font('M')
          .fontSize(8.5)
          .fillColor(task.type === 'income' ? C.green : C.red)
          .text(money(task.amount, cur), xs[5] + pad, y + 4, { width: inner(5), align: 'right', lineBreak: false });
        y += h;
      });
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(C.line).stroke();
    });

    // Totaux
    ensure(28);
    doc.rect(left, y, right - left, 26).fill(C.brandSoft);
    doc.font('B').fontSize(9.5).fillColor(C.ink).text('Solde net de la période', xs[2] + pad, y + 8, { lineBreak: false });
    doc
      .font('B')
      .fontSize(9.5)
      .fillColor(sum.net >= 0 ? C.green : C.red)
      .text(money(sum.net, cur), xs[5] + pad, y + 8, { width: inner(5), align: 'right', lineBreak: false });
    doc
      .font('R')
      .fontSize(8)
      .fillColor(C.muted)
      .text(`entrées ${money(sum.income, cur)} · sorties ${money(sum.expense, cur)}`, xs[3] + pad, y + 9, {
        width: cols[3].w + cols[4].w - pad * 2,
        lineBreak: false,
      });
  }

  doc.removeListener('pageAdded', freeze);
  for (let i = doc.bufferedPageRange().start; i < doc.bufferedPageRange().count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 70;
  }
  decorate(doc, title, ctx);
  doc.end();
  return done;
}

/** Reçu d'une opération : détail, soldes, tâches. */
export async function buildTransactionPdf(t: PopulatedTransactionLike, ctx: ExportContext): Promise<Buffer> {
  const r = toRow(t, 0);
  const title = `Reçu de l’opération du ${longDate(ymdIn(r.date, ctx.timeZone))}`;
  const doc = newDoc(title, 'portrait');
  const done = collect(doc);
  const cur = ctx.currency;
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;

  doc.font('B').fontSize(20).fillColor(C.ink).text(title, left, 92, { width });
  doc.font('R').fontSize(10).fillColor(C.muted).text(`Titulaire : ${ctx.holderName || '—'} · ${ctx.holderEmail}`, left, doc.y + 4);

  const sign = r.type === 'income' ? '+' : r.type === 'expense' ? '-' : '';
  const amountColor = r.type === 'income' ? C.green : r.type === 'expense' ? C.red : C.ink;
  let y = doc.y + 16;
  doc.roundedRect(left, y, width, 70, 10).fill(C.brandSoft);
  doc.font('R').fontSize(10).fillColor(C.muted).text(r.typeLabel, left + 16, y + 14);
  doc.font('B').fontSize(24).fillColor(amountColor).text(`${sign}${money(r.amount, cur)}`, left + 16, y + 30, { lineBreak: false });
  y += 86;

  const field = (label: string, value: string) => {
    doc.font('R').fontSize(9.5).fillColor(C.muted).text(label, left, y, { width: 150 });
    doc.font('M').fontSize(10.5).fillColor(C.ink).text(value || '—', left + 160, y, { width: width - 160 });
    y = Math.max(doc.y, y + 14) + 8;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(C.line).stroke();
  };
  field('Description', r.description);
  field('Date de l’opération', fmtDate(r.date, ctx.timeZone, true));
  field('Catégorie', r.category);
  if (r.type === 'transfer') {
    field('De la poche', r.wallet);
    field('Vers la poche', r.destination);
  } else {
    field('Poche', r.wallet);
  }
  field('Solde avant', r.balanceBefore != null ? money(r.balanceBefore, cur) : '—');
  field('Solde après', r.balanceAfter != null ? money(r.balanceAfter, cur) : '—');
  field('Créée le', r.createdAt ? fmtDate(r.createdAt, ctx.timeZone, true) : '—');
  if (r.modifiedAt) field('Modifiée le', fmtDate(r.modifiedAt, ctx.timeZone, true));
  field('Référence', r.id);

  const tasks = meaningfulTasks(r);
  if (tasks.length) {
    y += 10;
    doc.font('B').fontSize(12).fillColor(C.ink).text(`Tâches (${tasks.length})`, left, y);
    y = doc.y + 8;
    const cw = [width - 250, 140, 110];
    const drawHead = () => {
      doc.rect(left, y, width, 20).fill(C.brand);
      ['Tâche', 'Catégorie', 'Montant'].forEach((h, i) => {
        const x = left + cw.slice(0, i).reduce((a, b) => a + b, 0);
        doc
          .font('S')
          .fontSize(8.5)
          .fillColor('#FFFFFF')
          .text(h, x + 6, y + 6, { width: cw[i] - 12, align: i === 2 ? 'right' : 'left', lineBreak: false });
      });
      y += 20;
    };
    drawHead();
    tasks.forEach((task, i) => {
      const label = `${task.description}${task.quantity > 1 ? ` × ${task.quantity}` : ''}`;
      doc.font('R').fontSize(9.5);
      const h = Math.max(22, doc.heightOfString(label, { width: cw[0] - 12 }) + 10);
      if (y + h > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHead();
      }
      if (i % 2 === 1) doc.rect(left, y, width, h).fill(C.zebra);
      doc.font('R').fontSize(9.5).fillColor(C.ink).text(label, left + 6, y + 6, { width: cw[0] - 12 });
      doc.font('R').fontSize(9).fillColor(C.muted).text(task.category, left + cw[0] + 6, y + 6, { width: cw[1] - 12 });
      doc
        .font('M')
        .fontSize(9.5)
        .fillColor(task.type === 'income' ? C.green : C.red)
        .text(money(task.amount, cur), left + cw[0] + cw[1] + 6, y + 6, { width: cw[2] - 12, align: 'right', lineBreak: false });
      y += h;
    });
  }

  decorate(doc, title, ctx);
  doc.end();
  return done;
}
