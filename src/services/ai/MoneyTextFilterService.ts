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

  /** Packages Android finance / MM / banques — jamais de messagerie grand public. */
  static readonly MONEY_PACKAGES = [
    'com.orange.money',
    'com.orange.omcm',
    'cm.orange.om',
    'com.mtn.momo',
    'com.mtn.momocm',
    'com.wave.personal',
    'com.ecobank',
    'com.ubagroup.uba',
    'com.uba',
    'com.afriland',
    'cm.bicec',
    'com.moovmoney',
    'cm.yup',
    'com.expressunion',
    'com.paypal.android.p2pmobile',
    'com.revolut.revolut',
    'com.wise.android',
    'com.google.android.apps.walletnfcrel',
  ]

  /** Apps explicitement exclues (chat, mail, réseaux). */
  static readonly BLOCKED_PACKAGES = [
    'com.whatsapp',
    'com.whatsapp.w4b',
    'com.google.android.gm',
    'com.google.android.gm.lite',
    'com.facebook.orca',
    'com.facebook.katana',
    'org.telegram.messenger',
    'com.instagram.android',
    'com.twitter.android',
    'com.zhiliaoapp.musically',
    'com.snapchat.android',
    'com.viber.voip',
    'org.thoughtcrime.securesms',
    'com.discord',
    'com.slack',
    'com.microsoft.office.outlook',
    'com.yahoo.mobile.client.android.mail',
    'com.google.android.apps.gmail',
  ]

  isBlockedPackage(packageName: string | null | undefined): boolean {
    if (!packageName) return false
    const p = packageName.toLowerCase()
    return MoneyTextFilterService.BLOCKED_PACKAGES.some(
      (known) => p === known || p.startsWith(`${known}.`)
    )
  }

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
    if (this.isBlockedPackage(packageName)) return false
    const p = packageName.toLowerCase()
    if (
      MoneyTextFilterService.MONEY_PACKAGES.some((known) => p === known || p.startsWith(known))
    ) {
      return true
    }
    return (
      p.includes('momo') ||
      p.includes('orangemoney') ||
      p.includes('.bank') ||
      p.includes('banque') ||
      p.includes('mobilemoney')
    )
  }
}

export const moneyTextFilterService = new MoneyTextFilterService()
