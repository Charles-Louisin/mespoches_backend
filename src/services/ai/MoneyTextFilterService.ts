/**
 * Niveau 1 — filtrage rapide sans IA.
 * Détecte si un texte (SMS / notification) évoque une opération financière.
 */
export class MoneyTextFilterService {
  private static readonly KEYWORDS = [
    'fcfa',
    'xaf',
    'cfa',
    'paiement',
    'débit',
    'debit',
    'crédit',
    'credit',
    'reçu',
    'recu',
    'envoyé',
    'envoye',
    'transfert',
    'retrait',
    'dépôt',
    'depot',
    'solde',
    'transaction',
    'orange money',
    'orangemoney',
    'mtn',
    'momo',
    'express union',
    'uba',
    'ecobank',
    'afriland',
    'scb',
    'bicec',
    'wave',
    'mobile money',
    'virement',
    'montant',
    'facture',
  ]

  /** Packages Android connus pour finance / banks / MM (Niveau 1 côté natif aussi). */
  static readonly MONEY_PACKAGES = [
    'com.orange.money',
    'com.orange.omcm',
    'com.mtn.momo',
    'com.mtn.momocm',
    'com.wave.personal',
    'com.ecobank',
    'com.uba',
    'com.whatsapp',
  ]

  isMoneyRelated(raw: string): boolean {
    if (!raw) return false
    const text = raw.trim()
    if (text.length < 4) return false

    const lower = text.toLowerCase()
    const hasKeyword = MoneyTextFilterService.KEYWORDS.some((kw) => lower.includes(kw))
    if (hasKeyword) return true

    // Montant seul accepté seulement s'il y a une devise / symbole monétaire
    const amountWithCurrency =
      /(\d{1,3}([\s.,]\d{3})+|\d+)([\s.,]\d{1,2})?\s*(fcfa|xaf|cfa|€|eur|euro|euros|\$|usd|dollar|dollars|£|gbp|francs?|f\s*cfa)/i
    return amountWithCurrency.test(lower)
  }

  isMoneyPackage(packageName: string | null | undefined): boolean {
    if (!packageName) return false
    const p = packageName.toLowerCase()
    return MoneyTextFilterService.MONEY_PACKAGES.some(
      (known) => p === known || p.startsWith(known)
    )
  }
}

export const moneyTextFilterService = new MoneyTextFilterService()
