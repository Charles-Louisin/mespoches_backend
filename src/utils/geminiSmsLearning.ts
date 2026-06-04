import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ParsedMobileMoney } from './mobileMoneySmsParser';

export type AiSmsEnrichment = {
  type?: 'income' | 'expense';
  description?: string;
  category_hint?: string;
  counterparty?: string;
  is_recurring?: boolean;
  recurrence_hint?: string;
  confidence?: number;
};

type HabitLean = {
  counterparty: string;
  pattern: string;
  type: string;
  description: string;
  validation_count: number;
  wallet_id?: { name?: string } | null;
  category_id?: { name?: string } | null;
};

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error('GEMINI_API_KEY non configurée');
  return new GoogleGenerativeAI(key);
}

/** Enrichit une proposition SMS avec l'historique des validations (Premium). */
export async function enrichPendingWithGemini(
  rawSms: string,
  parsed: ParsedMobileMoney,
  habits: HabitLean[]
): Promise<AiSmsEnrichment | null> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const habitLines = habits
    .slice(0, 25)
    .map(
      (h) =>
        `- ${h.counterparty} (${h.pattern}, ${h.type}, validé ${h.validation_count}x) → catégorie: ${typeof h.category_id === 'object' && h.category_id ? h.category_id.name : '—'}, poche: ${typeof h.wallet_id === 'object' && h.wallet_id ? h.wallet_id.name : '—'}, libellé: "${h.description}"`
    )
    .join('\n');

  const prompt = `Tu es l'assistant MES POCHES (Cameroun, XAF). Un SMS Mobile Money vient d'être parsé. L'utilisateur Premium a un historique de validations.

SMS brut:
"""
${rawSms}
"""

Parse actuel:
- type: ${parsed.type}
- montant: ${parsed.amount} FCFA
- contrepartie: ${parsed.counterparty}
- pattern: ${parsed.pattern}
- expéditeur: ${parsed.sender_name} (${parsed.sender_phone})
- destinataire: ${parsed.recipient_name} (${parsed.recipient_phone})

Habitudes apprises (validations passées):
${habitLines || '(aucune)'}

Corrige/améliore la proposition pour correspondre aux habitudes (même commerçant, transferts récurrents, libellés préférés).
Réponds UNIQUEMENT en JSON:
{
  "type": "income" | "expense",
  "description": "libellé court en français",
  "category_hint": "nom catégorie probable ou null",
  "counterparty": "nom contrepartie affiné",
  "is_recurring": true/false,
  "recurrence_hint": "ex: loyer mensuel, courses hebdo",
  "confidence": 0.0 à 1.0
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const data = JSON.parse(jsonMatch[0]) as AiSmsEnrichment;
  return data;
}

/** Analyse les récurrences dans l'historique SMS validé (Premium, optionnel). */
export async function analyzeSmsRecurrences(habits: HabitLean[]): Promise<string> {
  if (habits.length < 3) return '';

  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const summary = habits
    .map((h) => `${h.counterparty}: ${h.type}, ${h.validation_count} validations, ${h.description}`)
    .join('\n');

  const result = await model.generateContent(
    `Analyse ces habitudes Mobile Money et liste les récurrences probables (français, 3-5 puces courtes):\n${summary}`
  );
  return result.response.text().trim();
}
