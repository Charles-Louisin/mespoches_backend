/**
 * @deprecated Utiliser ImageAnalysisService / AIService (OpenRouter).
 * Conservé pour compatibilité d'imports existants.
 */
import { imageAnalysisService, formatAiError } from '../services/ai';

export type AiReceiptItem = {
  description: string;
  amount: number;
  type: 'income' | 'expense';
  date?: string;
};

export type AiReceiptResult = {
  items: AiReceiptItem[];
  rawSummary: string;
};

export async function parseReceiptImage(
  base64Data: string,
  mimeType: string
): Promise<AiReceiptResult> {
  const analysis = await imageAnalysisService.analyze(base64Data, mimeType);
  return {
    items: analysis.items.map((i) => ({
      description: i.description,
      amount: i.amount,
      type: i.type,
      date: i.date || undefined,
    })),
    rawSummary: analysis.summary,
  };
}

export { formatAiError as formatGeminiError };
