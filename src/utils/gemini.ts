import { GoogleGenerativeAI } from '@google/generative-ai';

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

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error('GEMINI_API_KEY non configurée sur le serveur');
  }
  return new GoogleGenerativeAI(key);
}

const RECEIPT_PROMPT = `Tu es un assistant comptable pour l'application MES POCHES (Cameroun, devise XAF/FCFA).
Analyse l'image (ticket, facture, reçu, liste de courses manuscrite ou imprimée).
Extrais chaque ligne de dépense ou revenu identifiable.

Réponds UNIQUEMENT en JSON valide, sans markdown, format:
{
  "summary": "brève description de l'image",
  "items": [
    {
      "description": "libellé court",
      "amount": 1500,
      "type": "expense",
      "date": "2026-05-27 ou null"
    }
  ]
}

Règles:
- amount en nombre (pas de texte), devise XAF
- type: "expense" ou "income"
- Si montant illisible, ignore la ligne
- Maximum 30 lignes`;

export async function parseReceiptImage(base64Data: string, mimeType: string): Promise<AiReceiptResult> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await model.generateContent([
    { text: RECEIPT_PROMPT },
    {
      inlineData: {
        mimeType: mimeType || 'image/jpeg',
        data: base64Data.replace(/^data:[^;]+;base64,/, ''),
      },
    },
  ]);

  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Réponse IA illisible');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    summary?: string;
    items?: AiReceiptItem[];
  };

  const items: AiReceiptItem[] = (parsed.items || [])
    .filter((i) => i.description && Number(i.amount) > 0)
    .map((i) => ({
      description: String(i.description).slice(0, 200),
      amount: Number(i.amount),
      type: (i.type === 'income' ? 'income' : 'expense') as 'income' | 'expense',
      date: i.date || undefined,
    }));

  if (items.length === 0) {
    throw new Error('Aucune transaction détectée sur l\'image');
  }

  return {
    items,
    rawSummary: parsed.summary || 'Scan reçu',
  };
}
