import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { moneyTextFilterService } from '../services/ai/MoneyTextFilterService'
import { notificationParserService } from '../services/ai/NotificationParserService'
import { parseMobileMoneySms } from '../utils/mobileMoneySmsParser'
import { extractJsonObject } from '../services/ai/aiLogger'
import { LOW_CONFIDENCE_THRESHOLD } from '../config/aiModels'

describe('MoneyTextFilterService (niveau 1)', () => {
  it('accepte les mots-clés financiers', () => {
    assert.equal(moneyTextFilterService.isMoneyRelated('Paiement de 5000 FCFA réussi'), true)
    assert.equal(moneyTextFilterService.isMoneyRelated('Orange Money: transfert'), true)
    assert.equal(moneyTextFilterService.isMoneyRelated('MTN MoMo débit'), true)
    assert.equal(moneyTextFilterService.isMoneyRelated('Wave payment received'), true)
    assert.equal(moneyTextFilterService.isMoneyRelated('UBA compte crédité'), true)
  })

  it('ignore les textes non financiers', () => {
    assert.equal(moneyTextFilterService.isMoneyRelated('Bonjour, comment allez-vous ?'), false)
    assert.equal(moneyTextFilterService.isMoneyRelated(''), false)
  })

  it('détecte les packages connus', () => {
    assert.equal(moneyTextFilterService.isMoneyPackage('com.mtn.momo'), true)
    assert.equal(moneyTextFilterService.isMoneyPackage('com.example.game'), false)
  })
})

describe('Parsers Mobile Money (niveau 2)', () => {
  const ORANGE_TRANSFER =
    'Transfert de 677123456 JEAN DUPONT vers 699987654 MARIE KAMGA reussi. Montant Transaction : 10 000 FCFA. ID transaction : PP260714.1234.A12345'

  const ORANGE_PAYMENT =
    'Paiement de SUPERMARCHE DOUALA reussi par 677111222 PAUL BIYA. Montant : 3500 FCFA. ID transaction : MP260714.0001.B99'

  const ORANGE_WITHDRAWAL =
    "Retrait d'argent reussi par le 690000111. Montant : 20000 FCFA. ID transaction : CO260714.5555.C01"

    const MTN =
    'MTN MoMo: You have sent 5000 FCFA to ALICE. Transaction ID MO2607.111'

  const WAVE = 'Wave: Vous avez payé 2500 F à Boulangerie Centrale'

  const BANK =
    'UBA Alert: Debit of 15000 XAF on your account for CARD PURCHASE'

  it('parse SMS Orange Money transfert', () => {
    const p = parseMobileMoneySms(ORANGE_TRANSFER)
    assert.ok(p)
    assert.equal(p!.amount, 10000)
    assert.equal(p!.operator, 'orange')
    assert.ok(['transfer_out', 'transfer_in'].includes(p!.pattern))
  })

  it('parse SMS Orange Money paiement', () => {
    const p = parseMobileMoneySms(ORANGE_PAYMENT)
    assert.ok(p)
    assert.equal(p!.amount, 3500)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.pattern, 'payment')
  })

  it('parse SMS Orange Money retrait', () => {
    const p = parseMobileMoneySms(ORANGE_WITHDRAWAL)
    assert.ok(p)
    assert.equal(p!.amount, 20000)
    assert.equal(p!.pattern, 'withdrawal')
  })

  it('parse SMS MTN MoMo', () => {
    const p = parseMobileMoneySms(MTN)
    assert.ok(p)
    assert.equal(p!.operator, 'mtn')
    assert.equal(p!.amount, 5000)
  })

  it('parse notification Wave', () => {
    const p = notificationParserService.parseNotification('Wave', WAVE)
    assert.ok(p)
    assert.equal(p!.amount, 2500)
  })

  it('parse notification bancaire', () => {
    const p = parseMobileMoneySms(BANK)
    assert.ok(p)
    assert.equal(p!.amount, 15000)
    assert.equal(p!.type, 'expense')
  })

  it('montant absent → null', () => {
    const p = parseMobileMoneySms('Transfert Orange Money reussi sans chiffre')
    assert.equal(p, null)
  })

  it('texte hors argent → rejet niveau 1', () => {
    assert.equal(notificationParserService.passesLevel1('Photo likée sur Instagram'), false)
  })
})

describe('Cas edge extraction', () => {
  it('plusieurs montants : prend le montant transaction principal', () => {
    const text =
      'Paiement de SHOP reussi par 677111222 PAUL. Montant : 4200 FCFA. Frais : 100 FCFA. Solde : 50 000 FCFA. ID transaction : MP1.2.3'
    const p = parseMobileMoneySms(text)
    assert.ok(p)
    assert.equal(p!.amount, 4200)
  })

  it('devise absente mais FCFA implicite via pattern Orange', () => {
    const text =
      'Paiement de CAFE reussi par 677111222 PAUL BIYA. Montant : 1500 FCFA. ID transaction : MP260714.0001.B99'
    const p = parseMobileMoneySms(text)
    assert.ok(p)
    assert.equal(p!.amount, 1500)
  })

  it('faible confiance < seuil', () => {
    const text = 'Montant : 9000 FCFA transaction mobile'
    const p = parseMobileMoneySms(text)
    assert.ok(p)
    assert.ok(p!.confidence < LOW_CONFIDENCE_THRESHOLD || p!.confidence <= 0.75)
  })

  it('aucune transaction détectée (filtre)', () => {
    assert.equal(moneyTextFilterService.isMoneyRelated('Réunion demain à 10h'), false)
  })

  it('extractJsonObject ignore markdown', () => {
    const raw = '```json\n{"detected":true,"amount":100}\n```'
    const json = extractJsonObject(raw)
    assert.ok(json)
    assert.equal(JSON.parse(json!).amount, 100)
  })
})
