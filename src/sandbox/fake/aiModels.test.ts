import { describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from './fakeSupabase'
import { stableUuid } from './ids'

const Q = stableUuid('q', 'models')

function setup(options: Parameters<typeof createFakeSupabase>[0] = {}) {
  const fake = createFakeSupabase(options)
  fake.db.insert('questions', { id: Q, slug: 'a', title: 'Alpha', prompt: 'P', constraints: 'C' })
  fake.db.insert('question_files', { question_id: Q, path: 'a.py', content: 'buggy a', kind: 'buggy' })
  return { fake, c: fake.raw }
}

const okReply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })
const listed = (name: string, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods })

async function debuggingSession(fake: ReturnType<typeof setup>['fake']) {
  const s = fake.db.insert('sessions', { question_id: Q })
  await fake.raw.rpc('set_phase', { p_session_id: s.id, p_phase: 'debugging' })
  return s.id as string
}

const asFetch = (fn: unknown) => fn as unknown as typeof fetch

describe('sandbox ai-chat: model picker', () => {
  it('models without a key returns the static fallback list as degraded and never calls fetch', async () => {
    const fetchImpl = vi.fn()
    const { c } = setup({ ai: { getSettings: () => ({ apiKey: null, model: 'm' }), fetchImpl: asFetch(fetchImpl) } })
    const out = await c.functions.invoke('ai-chat', { body: { action: 'models' } })
    const data = out.data as { models: { id: string }[]; default: string; degraded?: boolean }
    expect(data.models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'])
    expect(data.degraded).toBe(true)
    expect(data.default).toBe('m')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('models with a key calls ListModels (key in a header) and applies the shared filter', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            models: [
              listed('gemini-2.5-pro'),
              listed('gemini-3.8-flash'),
              listed('gemini-embedding-001', ['embedContent']),
              listed('gemini-2.5-flash-image'),
            ],
          }),
          { status: 200 },
        ),
    )
    const { c } = setup({ ai: { getSettings: () => ({ apiKey: 'k-1', model: 'gemini-3.8-flash' }), fetchImpl: asFetch(fetchImpl) } })
    const out = await c.functions.invoke('ai-chat', { body: { action: 'models' } })
    const data = out.data as { models: { id: string }[]; default: string; degraded?: boolean }
    expect(data.models.map((m) => m.id)).toEqual(['gemini-3.8-flash', 'gemini-2.5-pro'])
    expect(data.degraded).toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200')
    expect(url).not.toContain('k-1')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k-1')
  })

  it('models degrades to the static list when Google fails', async () => {
    const { c } = setup({
      ai: { getSettings: () => ({ apiKey: 'k', model: 'm' }), fetchImpl: asFetch(async () => new Response('{}', { status: 403 })) },
    })
    const data = (await c.functions.invoke('ai-chat', { body: { action: 'models' } })).data as { degraded?: boolean; models: unknown[] }
    expect(data.degraded).toBe(true)
    expect(data.models).toHaveLength(3)
  })

  it('uses the requested model first, reports it and stores it on the model row', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => okReply('hi'))
    const { fake, c } = setup({ ai: { getSettings: () => ({ apiKey: 'k', model: 'gemini-default' }), fetchImpl: asFetch(fetchImpl) } })
    const sid = await debuggingSession(fake)
    const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'q', model: 'gemini-picked' } })
    expect(out.data).toMatchObject({ reply: 'hi', model: 'gemini-picked', fallback_used: false })
    expect(fetchImpl.mock.calls[0][0]).toContain('/models/gemini-picked:generateContent')
    expect(fake.db.all('ai_messages').map((r) => r.model)).toEqual([null, 'gemini-picked'])
  })

  it('defaults to the settings model and reports fallback_used when another model answers', async () => {
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) =>
      url.includes('/gemini-flash-lite-latest:') ? okReply('from lite') : new Response('{}', { status: 503 }),
    )
    const { fake, c } = setup({ ai: { getSettings: () => ({ apiKey: 'k', model: 'gemini-default' }), fetchImpl: asFetch(fetchImpl) } })
    const sid = await debuggingSession(fake)
    const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'q' } })
    expect(out.data).toMatchObject({ reply: 'from lite', model: 'gemini-flash-lite-latest', fallback_used: true })
    expect(fetchImpl.mock.calls[0][0]).toContain('/gemini-default:')
    expect(fake.db.all('ai_messages').at(-1)?.model).toBe('gemini-flash-lite-latest')
  })

  it('rejects an invalid model with 400', async () => {
    const { fake, c } = setup()
    const sid = await debuggingSession(fake)
    const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'q', model: '../x' } })
    expect((out.error as unknown as { context: Response }).context.status).toBe(400)
  })

  it('the canned reply path reports no model', async () => {
    const { fake, c } = setup({ ai: { getSettings: () => ({ apiKey: null, model: 'm' }) } })
    const sid = await debuggingSession(fake)
    const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'q', model: 'gemini-picked' } })
    expect(out.data).toMatchObject({ model: null, fallback_used: false })
    expect(fake.db.all('ai_messages').at(-1)?.model).toBeNull()
  })
})
