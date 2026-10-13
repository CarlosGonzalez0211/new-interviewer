/** Pure helpers for the AI model picker (storage, option merging, response parsing). */

export interface ModelOption {
  id: string
  label: string
}

export interface ModelList {
  models: ModelOption[]
  /** Server's effective default model id (what "Default" resolves to), if known. */
  default: string | null
  /** True when the list is the static fallback because Google's ListModels could not be used. */
  degraded: boolean
}

/** Shown when the models call fails; mirrors the edge function's own fallback. */
export const STATIC_MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)' },
]

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/

export const modelStorageKey = (sessionId: string) => `ai-model:${sessionId}`

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The remembered model id for a session, or '' (= server default). Never throws. */
export function readStoredModel(sessionId: string, storage: StorageLike | null = defaultStorage()): string {
  try {
    const v = storage?.getItem(modelStorageKey(sessionId))
    return v && MODEL_ID_RE.test(v) ? v : ''
  } catch {
    return ''
  }
}

/** Remember the choice ('' clears it, meaning Default). Never throws. */
export function writeStoredModel(sessionId: string, model: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    if (!storage) return
    if (model) storage.setItem(modelStorageKey(sessionId), model)
    else storage.removeItem(modelStorageKey(sessionId))
  } catch {
    // storage unavailable: the choice just does not persist
  }
}

/** Validate the `{ models, default, degraded }` payload; returns null when it is unusable. */
export function parseModelList(data: unknown): ModelList | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { models?: unknown; default?: unknown; degraded?: unknown }
  if (!Array.isArray(d.models)) return null
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const m of d.models) {
    if (typeof m !== 'object' || m === null) continue
    const { id, label } = m as { id?: unknown; label?: unknown }
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: typeof label === 'string' && label.trim() ? label : id })
  }
  if (models.length === 0) return null
  return {
    models,
    default: typeof d.default === 'string' && d.default ? d.default : null,
    degraded: d.degraded === true,
  }
}

/** Options for the <select>: the loaded list, plus the remembered/selected id if Google no longer lists it. */
export function mergeModelOptions(list: readonly ModelOption[], selected: string): ModelOption[] {
  if (!selected || list.some((m) => m.id === selected)) return [...list]
  return [{ id: selected, label: `${selected} (not listed)` }, ...list]
}

export function defaultOptionLabel(defaultId: string | null): string {
  return defaultId ? `Default (${defaultId})` : 'Default'
}

export function fallbackNotice(answeredBy: string | null | undefined): string {
  return `The selected model was unavailable; answered by ${answeredBy || 'another model'}.`
}
