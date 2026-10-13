import { buildGeminiRequest, GeminiError, parseGeminiResponse } from '../../../supabase/functions/ai-chat/gemini.ts'
import {
  buildSystemInstruction,
  HISTORY_LIMIT,
  trimHistory,
} from '../../../supabase/functions/ai-chat/prompt.ts'
import type { CodeFile, HistoryMessage } from '../../../supabase/functions/ai-chat/prompt.ts'
import { parseChatRequest } from '../../../supabase/functions/ai-chat/validate.ts'
import {
  buildAttemptChain,
  collectModels,
  effectiveModel,
  FALLBACK_MODELS,
  isRetryable,
} from '../../../supabase/functions/ai-chat/models.ts'
import type { FakeDb, Row } from './db'
import type { AiSettings } from '../settings'

export interface FunctionResult {
  status: number
  body: unknown
}

export interface AiDeps {
  getSettings(): AiSettings
  fetchImpl?: typeof fetch
}

export const CANNED_REPLY =
  'The AI assistant is not enabled in this sandbox yet, so this is a canned reply. ' +
  'To chat with the real assistant, open "AI settings" in the sandbox top bar, paste a Google Gemini API key ' +
  '(it stays in this browser and is sent only to Google) and send your message again. ' +
  'Your message was recorded, and the interviewer pane can already see it in the transcript.'

function fnError(status: number, message: string): FunctionResult {
  return { status, body: { error: message } }
}

/** Map a failed Gemini HTTP exchange to the user-facing error (never includes the key). */
function upstreamError(status: number, e: unknown): FunctionResult {
  if (e instanceof GeminiError && e.kind === 'rate_limited') {
    return fnError(429, 'The AI service is busy. Please try again shortly.')
  }
  if (status === 400 || status === 401 || status === 403) {
    return fnError(502, `Google rejected the request (HTTP ${status}). Check the Gemini key and model in AI settings.`)
  }
  if (e instanceof GeminiError && e.kind === 'blocked') {
    return fnError(502, 'The AI service blocked this request. Try rephrasing your message.')
  }
  return fnError(502, 'The AI service is unavailable. Please try again.')
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Browser equivalent of supabase/functions/ai-chat: same pure prompt/Gemini modules, same request/response
 * shape, but it reads the fake DB and calls Google directly from the browser with the key from localStorage.
 */
export async function handleAiChat(db: FakeDb, body: unknown, deps: AiDeps): Promise<FunctionResult> {
  if (typeof body === 'object' && body !== null && (body as { action?: unknown }).action === 'models') {
    return handleModels(deps)
  }
  const parsed = parseChatRequest(body)
  if (!parsed.ok) return fnError(400, parsed.error)
  const { session_id, message, model: requestedModel } = parsed.value

  const session = db.find('sessions', { id: session_id })
  if (!session) return fnError(404, 'Session not found.')
  if (session.phase !== 'debugging') return fnError(403, 'The assistant is only available during the debugging phase.')
  const question = db.find('questions', { id: session.question_id })
  if (!question) return fnError(404, 'Question not found.')

  const files: CodeFile[] = db
    .all('session_files')
    .filter((r) => r.session_id === session_id)
    .map((r) => ({ path: String(r.path), content: String(r.content ?? ''), kind: String(r.kind ?? 'code') }))
  const history: HistoryMessage[] = db
    .all('ai_messages')
    .filter((r) => r.session_id === session_id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-HISTORY_LIMIT)
    .map((r) => ({ role: r.role === 'model' ? 'model' : 'user', content: String(r.content ?? '') }))

  const store = (role: 'user' | 'model', content: string, model?: string): Row =>
    db.insert('ai_messages', { session_id, role, content, model: model ?? null })

  const { apiKey, model: defaultModel } = deps.getSettings()
  if (!apiKey) {
    store('user', message)
    const saved = store('model', CANNED_REPLY)
    return { status: 200, body: { reply: CANNED_REPLY, message_id: saved.id, model: null, fallback_used: false } }
  }

  const systemInstruction = buildSystemInstruction(
    { title: String(question.title), prompt: String(question.prompt), constraints: String(question.constraints ?? '') },
    files,
  )
  const primary = requestedModel ?? defaultModel
  const attempts = buildAttemptChain(primary)
  const fetchImpl = deps.fetchImpl ?? fetch

  // Same chain as the Edge Function (primary twice, then fallbacks), minus the pause between the first two.
  let reply = ''
  let answeredBy = effectiveModel(primary)
  for (let i = 0; i < attempts.length; i++) {
    let status = 0
    try {
      const req = buildGeminiRequest({ apiKey, model: attempts[i], systemInstruction, history: trimHistory(history), userMessage: message })
      const res = await fetchImpl(req.url, req.init)
      status = res.status
      reply = parseGeminiResponse(res.status, await readJson(res))
      answeredBy = effectiveModel(attempts[i])
      break
    } catch (e) {
      if (e instanceof GeminiError) {
        if (isRetryable(e) && i < attempts.length - 1) continue
        return upstreamError(status, e)
      }
      return fnError(502, 'Could not reach Google. Check your network connection and try again.')
    }
  }

  store('user', message)
  const saved = store('model', reply, answeredBy)
  return {
    status: 200,
    body: { reply, message_id: saved.id, model: answeredBy, fallback_used: answeredBy !== effectiveModel(primary) },
  }
}

/** `{ action: 'models' }`: real ListModels from the browser with the stored key, else the static fallback list. */
async function handleModels(deps: AiDeps): Promise<FunctionResult> {
  const { apiKey, model } = deps.getSettings()
  const fetchImpl = deps.fetchImpl ?? fetch
  let models = null
  if (apiKey) {
    try {
      models = await collectModels(async (url) => {
        const res = await fetchImpl(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } })
        return { status: res.status, json: await readJson(res) }
      })
    } catch {
      models = null
    }
  }
  if (!models) return { status: 200, body: { models: FALLBACK_MODELS, default: model, degraded: true } }
  return { status: 200, body: { models, default: model } }
}

/** Tiny real call used by the "Test key" button. Never logs or returns the key. */
export async function testGeminiKey(
  settings: AiSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!settings.apiKey) return { ok: false, error: 'Enter a Gemini API key first.' }
  const req = buildGeminiRequest({
    apiKey: settings.apiKey,
    model: settings.model,
    systemInstruction: 'Reply with the single word: ok',
    history: [],
    userMessage: 'ping',
  })
  let status = 0
  try {
    const res = await fetchImpl(req.url, req.init)
    status = res.status
    parseGeminiResponse(res.status, await readJson(res))
    return { ok: true }
  } catch (e) {
    if (e instanceof GeminiError && e.kind === 'rate_limited') {
      return { ok: false, error: 'Rate limited by Google. The key works, try again shortly.' }
    }
    if (status === 400 || status === 401 || status === 403) {
      return { ok: false, error: `Google rejected the key or model (HTTP ${status}).` }
    }
    if (status === 404) return { ok: false, error: 'Model not found (HTTP 404). Check the model name.' }
    if (status) return { ok: false, error: `Google returned HTTP ${status}.` }
    return { ok: false, error: 'Could not reach Google. Check your network connection.' }
  }
}
