import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVoiceNote } from '../utils/voiceTransactionParser'

describe('Parser vocal français', () => {
  it('dépense taxi avec montant', () => {
    const p = parseVoiceNote("j'ai payé le taxi 1500")
    assert.equal(p.detected, true)
    assert.equal(p.type, 'expense')
    assert.equal(p.amount, 1500)
    assert.equal(p.category_hint, 'Transport')
    assert.ok(p.confidence >= 0.85)
  })

  it('revenu reçu de quelqu’un', () => {
    const p = parseVoiceNote('reçu 20000 de Jean')
    assert.equal(p.detected, true)
    assert.equal(p.type, 'income')
    assert.equal(p.amount, 20000)
    assert.ok(p.description.toLowerCase().includes('jean'))
  })

  it('montant en milliers avec espace', () => {
    const p = parseVoiceNote("j'ai dépensé 5 000 au marché")
    assert.equal(p.amount, 5000)
    assert.equal(p.type, 'expense')
    assert.equal(p.category_hint, 'Alimentation')
  })

  it('montant avec k', () => {
    const p = parseVoiceNote("payé 5k d'essence")
    assert.equal(p.amount, 5000)
    assert.equal(p.category_hint, 'Transport')
  })

  it('salaire', () => {
    const p = parseVoiceNote("j'ai reçu mon salaire 150000")
    assert.equal(p.type, 'income')
    assert.equal(p.amount, 150000)
  })

  it('correction de montant', () => {
    const p = parseVoiceNote("j'ai payé 3000 non pas 3000, 3500")
    assert.equal(p.amount, 3500)
  })

  it('hier', () => {
    const p = parseVoiceNote("hier j'ai acheté du pain 500")
    assert.ok(p.date)
    assert.equal(p.amount, 500)
  })

  it('sans montant → non détecté', () => {
    const p = parseVoiceNote("j'ai payé le taxi")
    assert.equal(p.detected, false)
  })

  it('annulation', () => {
    const p = parseVoiceNote('annule')
    assert.equal(p.detected, false)
  })

  it('infinitifs STT : payer / acheter', () => {
    const a = parseVoiceNote("j'ai payer le taxi 1500")
    assert.equal(a.type, 'expense')
    assert.equal(a.amount, 1500)
    const b = parseVoiceNote("j'ai acheter du pain 500")
    assert.equal(b.type, 'expense')
    assert.equal(b.amount, 500)
  })

  it('on m’a donné → revenu', () => {
    const p = parseVoiceNote("on m'a donné 10000")
    assert.equal(p.type, 'income')
    assert.equal(p.amount, 10000)
  })

  it('crédit téléphone n’est pas un revenu', () => {
    const p = parseVoiceNote("j'ai payé crédit téléphone 1000")
    assert.equal(p.type, 'expense')
    assert.equal(p.amount, 1000)
  })

  it('j’ai vendu → revenu', () => {
    const p = parseVoiceNote("j'ai vendu 20000")
    assert.equal(p.type, 'income')
    assert.equal(p.amount, 20000)
  })
})
