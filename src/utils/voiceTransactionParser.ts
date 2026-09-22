export type VoiceParseResult = {
  detected: boolean
  type: 'income' | 'expense'
  amount: number | null
  description: string
  category_hint: string | null
  date: string | null
  confidence: number
}

const HIGH = 0.85
const MEDIUM = 0.55

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
  soixante: 60,
  cent: 100,
  cents: 100,
  mille: 1000,
  milles: 1000,
}

const INCOME_RES: RegExp[] = [
  /\b(recu|recue|recevoir|recois|recoit|reception)\b/i,
  /\b(salaire|prime|bonus)\b/i,
  /\b(gagne|gagner)\b/i,
  /\b(versement|verse|verser)\b/i,
  /\b(credite|crediter)\b/i,
  /\bm['’ ]?a\s+(envoye|donne|verse|paye|transfere)/i,
  /\bon m['’ ]?a\s+(donne|verse|paye|envoye|transfere)/i,
  /\b(rentree|revenu|depot|deposer|encaisse|encaisser)\b/i,
  /\b(vendu|vendre|vente)\b/i,
  /\b(rembourse|remboursement)\b/i,
  /\bentree d['’]?argent\b/i,
  /\bc['’]est un revenu\b/i,
]

const EXPENSE_RES: RegExp[] = [
  /\b(paye|payer|paiement|payes)\b/i,
  /\b(achete|acheter|achat)\b/i,
  /\b(depense|depenser)\b/i,
  /\b(envoye|envoyer)\b/i,
  /\b(vire|virer)\b/i,
  /\b(retire|retirer|retrait)\b/i,
  /\b(regle|regler)\b/i,
  /\b(facture|facturer)\b/i,
  /\bj['’]ai\s+(donne|pris)\b/i,
  /\b(coute|couter)\b/i,
]

const CANCEL_RE = /\b(annule|annuler|oublie|laisse\s+tomber|cancel)\b/i

const INCOME_HINT = /\b(salaire|paie|prime|bonus)\b/i
const EXPENSE_HINT = /\b(taxi|okada|moto|essence|marche|loyer|pain|restaurant|courses|pharmacie)\b/i

const CATEGORIES: Array<{ hint: string; re: RegExp }> = [
  { hint: 'Transport', re: /\b(taxi|moto|okada|bus|carburant|essence|transport|uber|course)\b/i },
  { hint: 'Alimentation', re: /\b(restaurant|manger|repas|nourriture|marche|courses|pain|poulet|poisson|boisson|bar|cafe)\b/i },
  { hint: 'Loyer', re: /\b(loyer|caution|logement|maison)\b/i },
  { hint: 'Éducation', re: /\b(ecole|scolarite|universite|fournitures)\b/i },
  { hint: 'Santé', re: /\b(pharmacie|medecin|hopital|ordonnance|soins)\b/i },
  { hint: 'Communication', re: /\b(credit\s+telephone|forfait|airtime|mtn|orange|data|internet|wifi)\b/i },
  { hint: 'Shopping', re: /\b(vetement|habits|chaussure|boutique|magasin)\b/i },
  { hint: 'Loisirs', re: /\b(cinema|sortie|jeu|bet|paris)\b/i },
  { hint: 'Factures', re: /\b(eau|eneo|electricite|canal|abonnement)\b/i },
  { hint: 'Salaire', re: /\b(salaire|paie|prime)\b/i },
  { hint: 'Transfert', re: /\b(transfert|envoye\s+a|recu\s+de)\b/i },
]

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MONTHS = [
  'janvier',
  'fevrier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'aout',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'decembre',
  'décembre',
]

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function parseNumberToken(raw: string): number | null {
  let cleaned = raw.trim().replace(/\s/g, '')
  if (/^\d+k$/i.test(cleaned)) {
    return parseInt(cleaned, 10) * 1000
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(cleaned)) {
    cleaned = cleaned.replace(/[.,]/g, '')
  } else if (/^\d{1,3}([.,]\d{3})+[.,]\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/[.,](?=\d{3}([.,]|$))/g, '').replace(/,/g, '.')
  } else {
    cleaned = cleaned.replace(',', '.')
  }
  const n = parseFloat(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseWordAmount(text: string): number | null {
  const folded = fold(text)
  const m = folded.match(
    /\b((?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|cents|mille|milles)(?:[\s-]+(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|trente|quarante|cinquante|soixante|cent|cents|mille|milles))*)\b/
  )
  if (!m) return null
  const parts = m[1].split(/[\s-]+/).filter(Boolean)
  let total = 0
  let current = 0
  for (const p of parts) {
    const v = WORD_NUMBERS[p]
    if (v == null) continue
    if (v === 1000) {
      current = (current || 1) * 1000
      total += current
      current = 0
    } else if (v === 100) {
      current = (current || 1) * 100
    } else {
      current += v
    }
  }
  total += current
  return total > 0 ? total : null
}

function extractAmount(text: string): { amount: number; rest: string } | null {
  const labeled = text.match(
    new RegExp(
      String.raw`(?:montant|somme|de|a|à|pour)?\s*(\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?|\d+k)\s*(?:fcfa|xaf|cfa|francs?|f)?\b`,
      'i'
    )
  )
  if (labeled) {
    const amount = parseNumberToken(labeled[1])
    if (amount) return { amount, rest: text }
  }
  const any = text.match(/(\d{1,3}(?:[\s.,]\d{3})+|\d{2,}(?:[.,]\d{1,2})?|\d+k)\s*(?:fcfa|xaf|cfa|francs?|f)?\b/i)
  if (any) {
    const amount = parseNumberToken(any[1])
    if (amount) return { amount, rest: text }
  }
  const words = parseWordAmount(text)
  if (words) return { amount: words, rest: text }
  return null
}

function applyCorrections(text: string, amount: number | null): number | null {
  const folded = fold(text)
  const notBut = folded.match(/pas\s+(\d[\d\s.,]*|\d+k).{0,12}?(?:mais|plutot|plutôt|,)\s+(\d[\d\s.,]*|\d+k)/i)
  if (notBut) {
    return parseNumberToken(notBut[2]) ?? amount
  }
  const rather = folded.match(/(?:c['’]est|plutot|plutôt)\s+(\d[\d\s.,]*|\d+k)/i)
  if (rather) return parseNumberToken(rather[1]) ?? amount
  return amount
}

function extractDate(text: string): string | null {
  const folded = fold(text)
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  if (/\baujourd['’]?hui\b/.test(folded)) return iso(today)
  if (/\bhier\b/.test(folded)) {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    return iso(d)
  }
  if (/\bavant[- ]hier\b/.test(folded)) {
    const d = new Date(today)
    d.setDate(d.getDate() - 2)
    return iso(d)
  }
  if (/\bdemain\b/.test(folded)) {
    const d = new Date(today)
    d.setDate(d.getDate() + 1)
    return iso(d)
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (folded.includes(WEEKDAYS[i])) {
      const d = new Date(today)
      const diff = (i - d.getDay() + 7) % 7
      d.setDate(d.getDate() - (diff === 0 ? 7 : diff))
      return iso(d)
    }
  }

  const dmy = folded.match(/\b(\d{1,2})\s*(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\b/)
  if (dmy) {
    const day = parseInt(dmy[1], 10)
    const mi = MONTHS.findIndex((m) => fold(m) === fold(dmy[2]))
    const monthIndex = mi <= 1 ? (fold(dmy[2]).startsWith('fev') ? 1 : 0) : Math.max(0, mi - 1)
    const year = today.getFullYear()
    const d = new Date(Date.UTC(year, monthIndex, day))
    if (!Number.isNaN(d.getTime())) return iso(d)
  }

  const slash = folded.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/)
  if (slash) {
    const day = parseInt(slash[1], 10)
    const month = parseInt(slash[2], 10) - 1
    const year = slash[3] ? parseInt(slash[3].length === 2 ? `20${slash[3]}` : slash[3], 10) : today.getFullYear()
    const d = new Date(Date.UTC(year, month, day))
    if (!Number.isNaN(d.getTime())) return iso(d)
  }

  return null
}

function firstIndex(text: string, patterns: RegExp[]): number {
  let best = Infinity
  for (const re of patterns) {
    const m = text.match(re)
    if (m && typeof m.index === 'number' && m.index < best) best = m.index
  }
  return best
}

function detectType(folded: string): { type: 'income' | 'expense'; score: number } {
  let incomeAt = firstIndex(folded, INCOME_RES)
  let expenseAt = firstIndex(folded, EXPENSE_RES)
  if (!Number.isFinite(incomeAt) && INCOME_HINT.test(folded)) {
    incomeAt = folded.search(INCOME_HINT)
  }
  if (!Number.isFinite(expenseAt) && EXPENSE_HINT.test(folded)) {
    expenseAt = folded.search(EXPENSE_HINT)
  }
  if (!Number.isFinite(incomeAt) && !Number.isFinite(expenseAt)) {
    return { type: 'expense', score: 0.35 }
  }
  if (Number.isFinite(incomeAt) && (!Number.isFinite(expenseAt) || incomeAt < expenseAt)) {
    return { type: 'income', score: Number.isFinite(expenseAt) ? 0.7 : 0.94 }
  }
  if (Number.isFinite(expenseAt) && (!Number.isFinite(incomeAt) || expenseAt < incomeAt)) {
    return { type: 'expense', score: Number.isFinite(incomeAt) ? 0.7 : 0.94 }
  }
  return { type: 'expense', score: 0.35 }
}

function extractCategory(text: string): string | null {
  const folded = fold(text)
  for (const cat of CATEGORIES) {
    if (cat.re.test(folded)) return cat.hint
  }
  return null
}

const NAME_STOP = /^(le|la|les|du|des|au|aux|un|une|mon|ma|mes|ton|ta|ce|cet|cette|paye|depense|achete|recu|taxi|marche|aujourd|hier)$/

function extractCounterparty(text: string): string | null {
  const folded = fold(text)
  const proper = folded.match(/\b(?:chez|pour|de)\s+([a-z][a-z' -]{1,30}?)(?:\s+\d|\s*$|,|\.)/)
  if (!proper) return null
  const name = proper[1].trim()
  const first = name.split(/\s+/)[0] || ''
  if (NAME_STOP.test(first) || name.length < 2) return null
  return name.replace(/(^|\s)\S/g, (s) => s.toUpperCase())
}

function describe(type: 'income' | 'expense', amount: number | null, category: string | null, who: string | null): string {
  const whoBit = who ? ` ${who}` : ''
  const catBit = category ? ` · ${category}` : ''
  if (type === 'income') {
    if (who) return `Reçu de${whoBit}${catBit}`.trim()
    return category ? `Revenu · ${category}` : 'Revenu'
  }
  if (who) return `Payé à${whoBit}${catBit}`.trim()
  if (category) return category
  return amount ? `Dépense ${amount} F` : 'Dépense'
}

export function parseVoiceNote(spoken: string): VoiceParseResult {
  const text = String(spoken || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return {
      detected: false,
      type: 'expense',
      amount: null,
      description: '',
      category_hint: null,
      date: null,
      confidence: 0,
    }
  }

  const folded = fold(text)
  if (CANCEL_RE.test(folded) && !extractAmount(text)) {
    return {
      detected: false,
      type: 'expense',
      amount: null,
      description: 'Annulé',
      category_hint: null,
      date: null,
      confidence: 0,
    }
  }

  const found = extractAmount(text)
  let amount = found?.amount ?? null
  amount = applyCorrections(text, amount)

  const { type, score: typeScore } = detectType(folded)

  const category = extractCategory(text)
  const who = extractCounterparty(text)
  const date = extractDate(text)
  const description = describe(type, amount, category, who)

  let confidence = 0
  if (amount && typeScore >= 0.9) confidence = HIGH
  else if (amount && typeScore >= 0.6) confidence = 0.72
  else if (amount) confidence = 0.4
  else if (typeScore >= 0.9) confidence = 0.35
  else confidence = 0.15

  if (category) confidence = Math.min(0.97, confidence + 0.04)
  if (who) confidence = Math.min(0.97, confidence + 0.03)
  if (date) confidence = Math.min(0.97, confidence + 0.02)

  return {
    detected: Boolean(amount && amount > 0),
    type,
    amount,
    description,
    category_hint: category,
    date,
    confidence,
  }
}

export const VOICE_PARSE_HIGH = HIGH
export const VOICE_PARSE_MEDIUM = MEDIUM
