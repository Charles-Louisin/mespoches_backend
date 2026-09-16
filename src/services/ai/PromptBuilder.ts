import type { OpenRouterChatMessage } from './types'

/**
 * Construit les prompts strictement JSON (aucune prose).
 */
export class PromptBuilder {
  buildImageAnalysisPrompt(): string {
    return `Tu es l'assistant comptable de MES POCHES (Cameroun, XAF/FCFA).
Analyse l'image financière fournie. Le document peut être : reçu de caisse, facture, capture d'écran, SMS Mobile Money, SMS bancaire, liste de courses manuscrite, note manuscrite, ou tout document financier.
Reconnais AUTOMATIQUEMENT le type de document. Ne pose aucune question.

Réponds UNIQUEMENT avec un JSON valide. Aucun texte. Aucune explication. Aucun markdown.

Format exact:
{
  "document_type": "receipt|invoice|screenshot|sms_mobile_money|sms_bank|handwritten_list|handwritten_note|other_financial",
  "summary": "brève description du ticket (ex: Courses Carrefour)",
  "confidence": 0.0,
  "items": [
    {
      "description": "libellé court",
      "amount": 2000,
      "quantity": 2,
      "unit_amount": 1000,
      "type": "expense",
      "date": "2026-05-27",
      "currency": "XAF",
      "confidence": 0.0
    }
  ]
}

Règles:
- Pour un ticket de caisse / courses / facture multi-lignes : liste CHAQUE article dans items (pas une seule ligne totale)
- amount = montant TOTAL de la ligne (quantity × unit_amount). Ex: babouche 1000 × 2 → amount=2000, quantity=2, unit_amount=1000
- quantity: entier >= 1 (défaut 1). unit_amount: prix unitaire si connu, sinon null
- amount en nombre (ex: 1500), jamais de texte ni de devise dans amount
- type: "expense" ou "income" — mets le bon type sur CHAQUE ligne
- Si le document mélange dépenses ET revenus, garde les deux types (le serveur créera 2 transactions)
- date: "YYYY-MM-DD" ou null (jamais la chaîne "ou null")
- Si montant illisible, ignore la ligne
- Maximum 30 items
- confidence global entre 0 et 1`
  }

  buildNotificationAnalysisPrompt(notificationText: string): string {
    return `Tu es l'assistant MES POCHES (Cameroun, Afrique centrale, XAF/FCFA).
Analyse UNIQUEMENT le texte de notification financière suivant et extrais la transaction.

Texte:
"""
${notificationText}
"""

Réponds UNIQUEMENT avec un JSON valide. Aucun texte. Aucune explication. Aucun markdown.

Format exact:
{
  "detected": true,
  "amount": 5000,
  "currency": "XAF",
  "type": "expense",
  "date": "2026-07-14T10:00:00.000Z",
  "sender": "nom ou null",
  "recipient": "nom ou null",
  "merchant": "nom ou null",
  "description": "libellé court en français",
  "operator": "orange|mtn|wave|bank|unknown",
  "pattern": "transfer_out|transfer_in|payment|withdrawal|deposit|unknown",
  "confidence": 0.0,
  "generalized_pattern": "motif regex ou description généralisée réutilisable, ou null"
}

Règles:
- Si aucune transaction monétaire claire: detected=false, amount=null, confidence=0
- amount en nombre positif
- date: ISO ou null (jamais la chaîne "ou null")
- type: income (crédit/reçu) ou expense (débit/envoyé/paiement/retrait)
- Devise par défaut XAF/FCFA si absente`
  }

  buildSmsEnrichmentPrompt(rawSms: string, parsedSummary: string, habitsBlock: string): string {
    return `Tu es l'assistant MES POCHES (Cameroun, XAF). Un SMS Mobile Money a été parsé. L'utilisateur Premium a un historique de validations.

SMS brut:
"""
${rawSms}
"""

Parse actuel:
${parsedSummary}

Habitudes apprises:
${habitsBlock || '(aucune)'}

Corrige/améliore la proposition.
Réponds UNIQUEMENT en JSON:
{
  "type": "income",
  "description": "libellé court en français",
  "category_hint": "nom catégorie ou null",
  "counterparty": "nom contrepartie",
  "is_recurring": false,
  "recurrence_hint": "hint ou null",
  "confidence": 0.0
}`
  }

  imageMessages(prompt: string, dataUrl: string): OpenRouterChatMessage[] {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ]
  }

  buildVoiceTransactionPrompt(spokenText: string): string {
    return `Tu es l'assistant MES POCHES (Cameroun, XAF/FCFA).
L'utilisateur dicte une ou plusieurs transactions (note vocale transcrite).

Texte:
"""
${spokenText}
"""

Réponds UNIQUEMENT avec un JSON valide. Aucun markdown.

Format exact:
{
  "detected": true,
  "confidence": 0.0,
  "transactions": [
    {
      "type": "expense",
      "description": "libellé court en français",
      "category_hint": "nom catégorie ou null",
      "date": "2026-07-30",
      "confidence": 0.0,
      "items": [
        { "description": "tomates", "amount": 1500, "quantity": 1, "unit_amount": 1500, "type": "expense" }
      ]
    }
  ]
}

Règles:
- type: "expense" (dépense/achat/paiement) ou "income" (revenu/salaire/reçu)
- Une entrée dans transactions par TYPE distinct. Si l'utilisateur parle d'une dépense ET d'un revenu, renvoie 2 objets (expense + income)
- Plusieurs montants/articles du même type → UNE transaction avec plusieurs items
- amount de chaque transaction = somme des items (ou le montant unique)
- items: toujours renseigner si plus d'une ligne ; sinon items peut être [{description, amount, type}]
- Si montant ou intention peu claire: detected=false, transactions=[]
- date: YYYY-MM-DD ou null (aujourd'hui si non précisé côté serveur)
`
  }

  buildMonthBriefingPrompt(snapshot: string): string {
    return `Tu es le conseiller financier de MES POCHES (Cameroun, XAF/FCFA).
À partir du snapshot JSON du mois, rédige un briefing court, concret, sans jargon.

Snapshot:
${snapshot}

Réponds UNIQUEMENT en JSON valide:
{
  "headline": "titre court (max 8 mots)",
  "mood": "good|watch|alert",
  "summary": "2 ou 3 phrases en français, tutoiement",
  "highlights": ["point positif 1", "point 2"],
  "alerts": ["alerte 1 si besoin"],
  "tips": ["action concrète 1", "action 2"]
}

Règles:
- mood good si le solde du mois est positif et les budgets tiennent
- mood alert si dépassement de budget, épargne en retard, ou dépenses en forte hausse
- mood watch sinon
- highlights 0 à 3, alerts 0 à 3, tips 2 à 3
- Pas de markdown, pas de montants inventés, utilise uniquement le snapshot
- Ton direct, utile, jamais moralisateur`
  }

  textMessages(prompt: string): OpenRouterChatMessage[] {
    return [{ role: 'user', content: prompt }]
  }
}

export const promptBuilder = new PromptBuilder()
