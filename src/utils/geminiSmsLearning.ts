import { aiService } from '../services/ai';
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

/** Enrichit une proposition SMS avec l'historique des validations (Premium). */
export async function enrichPendingWithGemini(
  rawSms: string,
  parsed: ParsedMobileMoney,
  habits: HabitLean[]
): Promise<AiSmsEnrichment | null> {
  const habitLines = habits
    .slice(0, 25)
    .map(
      (h) =>
        `- ${h.counterparty} (${h.pattern}, ${h.type}, validé ${h.validation_count}x) → catégorie: ${typeof h.category_id === 'object' && h.category_id ? h.category_id.name : '—'}, poche: ${typeof h.wallet_id === 'object' && h.wallet_id ? h.wallet_id.name : '—'}, libellé: "${h.description}"`
    )
    .join('\n');

  const parsedSummary = [
    `- type: ${parsed.type}`,
    `- montant: ${parsed.amount} FCFA`,
    `- contrepartie: ${parsed.counterparty}`,
    `- pattern: ${parsed.pattern}`,
    `- expéditeur: ${parsed.sender_name} (${parsed.sender_phone})`,
    `- destinataire: ${parsed.recipient_name} (${parsed.recipient_phone})`,
  ].join('\n');

  try {
    const data = await aiService.enrichSms(rawSms, parsedSummary, habitLines);
    if (!data) return null;
    return data as AiSmsEnrichment;
  } catch {
    return null;
  }
}

/** Analyse les récurrences dans l'historique SMS validé (Premium, optionnel). */
export async function analyzeSmsRecurrences(habits: HabitLean[]): Promise<string> {
  if (habits.length < 3) return '';

  const summary = habits
    .map((h) => `${h.counterparty}: ${h.type}, ${h.validation_count} validations, ${h.description}`)
    .join('\n');

  try {
    const { json } = await aiService.completeJson({
      purpose: 'sms_recurrence',
      modality: 'text',
      messages: [
        {
          role: 'user',
          content: `Analyse ces habitudes Mobile Money. Réponds UNIQUEMENT en JSON: {"analysis":"3-5 puces courtes en français"}\n${summary}`,
        },
      ],
    });
    const analysis = (json as { analysis?: string }).analysis;
    return analysis || '';
  } catch {
    return '';
  }
}
