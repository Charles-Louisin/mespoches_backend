import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseMobileMoneySms } from '../utils/mobileMoneySmsParser'

/** Messages réels (Cameroun) — source instructions.txt */
const REAL = {
  orangePayment:
    'Paiement de Achat Max it?3 reussi par 693460259 YIMBNE NYEMB. ID transaction:MP260714.1658.D46780, Montant:2100 FCFA. Solde: 11057.81 FCFA.',
  orangeTransferIn:
    'Transfert de 693353171 YIMBNE MBOMBOG vers 693460259 YIMBNE NYEMB reussi. Details: ID transaction: PP260714.2117.B36023, Montant Transaction: 4054FCFA, Frais: 0 FCFA, Commission: 0 FCFA, Montant Net: 4054 FCFA, Nouveau Solde: 15111.81 FCFA.',
  orangeWithdrawal:
    "Retrait d'argent reussi par le 656939968 avec le Code : 358619. Informations detaillees : Montant: 10000 FCFA, Frais: 124 FCFA, No de transaction CO260714.0958.B98633, montant net debite 10124 FCFA, Nouveau solde: 11057.81 FCFA.",
  orangeCardUsd:
    "Cher client, votre paiement de 1.18 USD chez NAME-CHEAP.COM* Z9S4ZH a été effectué avec succès. Nouveau solde 327.00 XAF. ID: 507434. Orange Money vous remercie. N'oubliez pas de recharger votre carte pour vos prochains paiements",
  orangeCardReload:
    "Votre carte prépayée virtuelle a été rechargée de 1000 XAF. Nouveau solde : 29394.01 XAF. Merci d'utiliser Orange Money.",
  orangePaymentSucces:
    'Paiement de WelcomePack en succes par 693460259 CHARLES LOUISIN. ID de transaction: MP260713.0920.B37256, Montant: 100, Nouveau solde: 30399.01.',
  orangeTransferOut:
    'Transfert de 693460259 YIMBNE NYEMB vers 694310793 YIMBNE NYEMB reussi. Details: ID transaction: PP260713.1232.D86363, Montant Transaction: 1100FCFA, Frais: 0 FCFA, Commission: 0 FCFA, Montant Net: 1100 FCFA, Nouveau Solde: 2200 FCFA.',
  mtnBundles:
    "Une transaction de 500 XAF effectuee par MTNC BUNDLES_FORFAITS   (MTN_Bundles) sur votre compte d'argent mobile s'est terminee avec succes a 2026-07-11 21:25:39. Le montant faisait l'objet d'une remise de 0 et de bons de reduction d'une valeur de 0. Message du destinataire du debit : . Votre nouveau solde : 42 XAF. Les frais s'elevaient a 0 XAF, les frais de fidelite a 0 et la recompense de fidelite a 0. Identifiant de transaction financiere : 17896121364. ID de transaction externe : 3759457086161032536.Prix Cassés chez MoMo pour tout le monde ! 0 F sur tes transferts et -25% sur tes retraits Hors Taxe. Disponible sur la MoMo App et au *126#.",
  mtnAirtime:
    'Votre paiement de 200 XAF a MTNC AIRTIME a ete effectue le 2026-06-25 19:04:18. Votre nouveau solde: 3602 XAF. Frais: 0 XAF. Message: -. Transaction Id: 17677469451. Prix Cassés chez MoMo pour tout le monde ! 0 F sur tes transferts et -25% sur tes retraits Hors Taxe. Disponible sur la MoMo App et au *126#.',
  mtnReceived:
    "Vous avez recu 10000 XAF de LOUISE SIPORA KOUMEN (237678834414) sur votre compte mobile money à 2026-06-24 12:44:33. Message de l'expéditeur: 1. Votre nouveau solde: 10004 XAF. FRAIS: FCFA 0. Financial Transaction Id: 17658394903.",
} as const

describe('Messages réels Orange Money', () => {
  it('paiement marchand (Montant + Solde)', () => {
    const p = parseMobileMoneySms(REAL.orangePayment)
    assert.ok(p)
    assert.equal(p!.amount, 2100)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'orange')
    assert.equal(p!.pattern, 'payment')
    assert.equal(p!.counterparty, 'Achat Max it?3')
    assert.equal(p!.transaction_id, 'MP260714.1658.D46780')
  })

  it('transfert reçu (identité téléphone)', () => {
    const p = parseMobileMoneySms(REAL.orangeTransferIn, {
      names: ['YIMBNE NYEMB'],
      phones: ['693460259'],
    })
    assert.ok(p)
    assert.equal(p!.amount, 4054)
    assert.equal(p!.type, 'income')
    assert.equal(p!.pattern, 'transfer_in')
    assert.equal(p!.counterparty, 'YIMBNE MBOMBOG')
    assert.equal(p!.transaction_id, 'PP260714.2117.B36023')
  })

  it('retrait agent (ignore frais / solde)', () => {
    const p = parseMobileMoneySms(REAL.orangeWithdrawal)
    assert.ok(p)
    assert.equal(p!.amount, 10000)
    assert.equal(p!.pattern, 'withdrawal')
    assert.equal(p!.counterparty, 'Agent 656939968')
    assert.equal(p!.transaction_id, 'CO260714.0958.B98633')
  })

  it('paiement carte USD (pas le solde XAF)', () => {
    const p = parseMobileMoneySms(REAL.orangeCardUsd)
    assert.ok(p)
    assert.equal(p!.amount, 1.18)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'orange')
    assert.equal(p!.pattern, 'payment')
    assert.match(p!.counterparty, /NAME-CHEAP/i)
    assert.equal(p!.transaction_id, '507434')
  })

  it('recharge carte prépayée', () => {
    const p = parseMobileMoneySms(REAL.orangeCardReload)
    assert.ok(p)
    assert.equal(p!.amount, 1000)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'orange')
    assert.equal(p!.pattern, 'payment')
    assert.match(p!.counterparty, /carte/i)
  })

  it('paiement "en succes" + Montant sans devise', () => {
    const p = parseMobileMoneySms(REAL.orangePaymentSucces)
    assert.ok(p)
    assert.equal(p!.amount, 100)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'orange')
    assert.equal(p!.counterparty, 'WelcomePack')
    assert.equal(p!.transaction_id, 'MP260713.0920.B37256')
  })

  it('transfert envoyé (identité)', () => {
    const p = parseMobileMoneySms(REAL.orangeTransferOut, {
      names: ['YIMBNE NYEMB'],
      phones: ['693460259'],
    })
    assert.ok(p)
    assert.equal(p!.amount, 1100)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.pattern, 'transfer_out')
    assert.equal(p!.counterparty, 'YIMBNE NYEMB')
  })
})

describe('Messages réels MTN MoMo', () => {
  it('débit bundles (ignore promo / solde)', () => {
    const p = parseMobileMoneySms(REAL.mtnBundles)
    assert.ok(p)
    assert.equal(p!.amount, 500)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'mtn')
    assert.equal(p!.pattern, 'payment')
    assert.match(p!.counterparty, /BUNDLES/i)
    assert.equal(p!.transaction_id, '17896121364')
  })

  it('paiement airtime', () => {
    const p = parseMobileMoneySms(REAL.mtnAirtime)
    assert.ok(p)
    assert.equal(p!.amount, 200)
    assert.equal(p!.type, 'expense')
    assert.equal(p!.operator, 'mtn')
    assert.equal(p!.counterparty, 'MTNC AIRTIME')
    assert.equal(p!.transaction_id, '17677469451')
  })

  it('réception d\'argent', () => {
    const p = parseMobileMoneySms(REAL.mtnReceived)
    assert.ok(p)
    assert.equal(p!.amount, 10000)
    assert.equal(p!.type, 'income')
    assert.equal(p!.operator, 'mtn')
    assert.equal(p!.pattern, 'transfer_in')
    assert.equal(p!.counterparty, 'LOUISE SIPORA KOUMEN')
    assert.equal(p!.sender_phone, '237678834414')
    assert.equal(p!.transaction_id, '17658394903')
  })
})

describe('Flexibilité (variantes proches)', () => {
  it('accepte accents (réussi / reçu)', () => {
    const p = parseMobileMoneySms(
      'Paiement de Boutique Café réussi par 690112233 JEAN DUPONT. Montant: 1500 FCFA. ID transaction: MP260101.0101.A11111'
    )
    assert.ok(p)
    assert.equal(p!.amount, 1500)
    assert.equal(p!.counterparty, 'Boutique Café')
  })

  it('montant collé à la devise (1100FCFA)', () => {
    const p = parseMobileMoneySms(
      'Transfert de 690000001 ALICE NGO vers 690000002 BOB KAMGA reussi. Montant Transaction: 2500FCFA. ID transaction: PP260101.0101.B22222'
    )
    assert.ok(p)
    assert.equal(p!.amount, 2500)
  })
})
