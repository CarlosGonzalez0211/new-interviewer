/** Browser-only sandbox settings. The Gemini key lives in localStorage and is sent only to Google. */
export const GEMINI_KEY_STORAGE = 'sandbox.geminiKey'
export const GEMINI_MODEL_STORAGE = 'sandbox.geminiModel'
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

export interface AiSettings {
  apiKey: string | null
  model: string
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function getAiSettings(): AiSettings {
  const key = read(GEMINI_KEY_STORAGE)?.trim()
  const model = read(GEMINI_MODEL_STORAGE)?.trim()
  return { apiKey: key ? key : null, model: model || DEFAULT_GEMINI_MODEL }
}

export function saveAiSettings(next: { apiKey?: string | null; model?: string }): void {
  try {
    const ls = globalThis.localStorage
    if (!ls) return
    if (next.apiKey !== undefined) {
      if (next.apiKey && next.apiKey.trim()) ls.setItem(GEMINI_KEY_STORAGE, next.apiKey.trim())
      else ls.removeItem(GEMINI_KEY_STORAGE)
    }
    if (next.model !== undefined) {
      if (next.model.trim() && next.model.trim() !== DEFAULT_GEMINI_MODEL) ls.setItem(GEMINI_MODEL_STORAGE, next.model.trim())
      else ls.removeItem(GEMINI_MODEL_STORAGE)
    }
  } catch {
    // storage unavailable: settings simply do not persist
  }
}
