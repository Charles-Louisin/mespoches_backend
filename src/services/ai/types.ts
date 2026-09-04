/** Formats JSON attendus des modèles (contrats stables pour PromptBuilder). */

export type AiDocumentType =
  | 'receipt'
  | 'invoice'
  | 'screenshot'
  | 'sms_mobile_money'
  | 'sms_bank'
  | 'handwritten_list'
  | 'handwritten_note'
  | 'other_financial'

export type AiImageItem = {
  description: string
  amount: number
  quantity?: number
  unit_amount?: number | null
  type: 'income' | 'expense'
  date?: string | null
  currency?: string
  confidence?: number
}

/** Réponse JSON image — format canonique MES POCHES. */
export type AiImageExtraction = {
  document_type: AiDocumentType
  summary: string
  confidence: number
  items: AiImageItem[]
}

/** Réponse JSON notification — format canonique MES POCHES. */
export type AiNotificationExtraction = {
  detected: boolean
  amount: number | null
  currency: string | null
  type: 'income' | 'expense' | null
  date: string | null
  sender: string | null
  recipient: string | null
  merchant: string | null
  description: string | null
  operator: 'orange' | 'mtn' | 'wave' | 'bank' | 'unknown' | null
  pattern:
    | 'transfer_out'
    | 'transfer_in'
    | 'payment'
    | 'withdrawal'
    | 'deposit'
    | 'unknown'
    | null
  confidence: number
  /** Motif généralisé réutilisable pour enrichir le parser */
  generalized_pattern?: string | null
}

export type OpenRouterChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user'
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
    }

export type OpenRouterCompletionResult = {
  content: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
}

export type AiCallLog = {
  purpose: string
  model: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  confidence?: number
  fallbackReason?: string
  success: boolean
  error?: string
}
