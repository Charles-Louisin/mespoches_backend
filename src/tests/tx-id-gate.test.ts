import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hasTransactionId } from '../services/pendingTransactionService'

describe('Notifications : ID de transaction obligatoire', () => {
  it('garde les mouvements confirmés (Orange Money, MTN MoMo)', () => {
    assert.equal(
      hasTransactionId(
        'Paiement de Achat Max it?3 reussi par 693460259 YIMBNE NYEMB. ID transaction:MP260714.1658.D46780, Montant:2100 FCFA. Solde: 11057.81 FCFA.'
      ),
      true
    )
    assert.equal(
      hasTransactionId(
        "Retrait d'argent reussi. Montant: 10000 FCFA, No de transaction CO260714.0958.B98633, Nouveau solde: 11057.81 FCFA."
      ),
      true
    )
    assert.equal(
      hasTransactionId(
        "Une transaction de 500 XAF effectuee par MTNC BUNDLES_FORFAITS. Identifiant de transaction financiere : 17896121364."
      ),
      true
    )
    assert.equal(hasTransactionId('Orange Money\nPaiement de 1.18 USD effectué. ID: 507434.'), true)
  })

  it('ignore les demandes de paiement, codes et promos (pas d’ID)', () => {
    assert.equal(
      hasTransactionId(
        'Vous allez payer 2500 FCFA à BOUTIQUE ABC. Confirmez avec votre code secret en tapant #150*50#.'
      ),
      false
    )
    assert.equal(hasTransactionId('Votre code de validation est 4821. Montant : 15000 FCFA.'), false)
    assert.equal(hasTransactionId('Prix cassés chez MoMo : 0 F sur tes transferts !'), false)
    assert.equal(hasTransactionId('Wave: Vous avez payé 2500 F à Boulangerie Centrale'), false)
  })
})
