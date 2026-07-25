import { LOW_CONFIDENCE_THRESHOLD } from '../../config/aiModels'
import { logAiCall } from './aiLogger'
import { aiService, AIService } from './AIService'
import type { AiImageExtraction } from './types'

export type ImageAnalysisResult = AiImageExtraction & {
  lowConfidence: boolean
  warning?: string
}

/**
 * Analyse intelligente d'images financières (reçus, SMS capturés, notes…).
 */
export class ImageAnalysisService {
  constructor(private readonly ai: AIService = aiService) {}

  async analyze(base64: string, mimeType: string): Promise<ImageAnalysisResult> {
    const extraction = await this.ai.analyzeImage(base64, mimeType)

    const lowConfidence = extraction.confidence < LOW_CONFIDENCE_THRESHOLD

    logAiCall({
      purpose: 'image_analysis_result',
      model: 'n/a',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      confidence: extraction.confidence,
      success: true,
    })

    return {
      ...extraction,
      lowConfidence,
      warning: lowConfidence
        ? 'Certaines informations n\'ont pas pu être reconnues avec certitude.'
        : undefined,
    }
  }
}

export const imageAnalysisService = new ImageAnalysisService()
