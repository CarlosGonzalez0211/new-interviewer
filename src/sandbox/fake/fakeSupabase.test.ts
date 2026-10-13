import { describe, expect, it, vi } from 'vitest'
import { SANDBOX_INTERVIEWEE, SANDBOX_INTERVIEWER } from '../identity'
import { CANNED_REPLY } from './ai'
import { createFakeSupabase } from './fakeSupabase'
import { stableUuid } from './ids'

const Q = stableUuid('q', '1')
const Q2 = stableUuid('q', '2')

function setup(options: Parameters<typeof createFakeSupabase>[0] = {}) {
  const fake = createFakeSupabase(options)
  const c = fake.raw
  fake.db.insert('questions', { id: Q, slug: 'a', title: 'Alpha', prompt: 'P', constraints: 'C' })
  fake.db.insert('questions', { id: Q2, slug: 'b', title: 'Beta', prompt: 'P2' })
  fake.db.insert('question_files', { question_id: Q, path: 'a.py', content: 'buggy a', kind: 'buggy' })
  fake.db.insert('question_files', { question_id: Q, path: 'test_a.py', content: 'tests', kind: 'test' })
  fake.db.insert('question_files', { question_id: Q2, path: 'other.py', content: 'x', kind: 'buggy' })
  return { fake, c }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('fake query layer', () => {
  it('filters, orders, limits and projects', async () => {
    const { c } = setup()
    const all = await c.from('questions').select('*').order('title', { ascending: false })
    expect(all.error).toBeNull()
    expect((all.data as { slug: string }[]).map((r) => r.slug)).toEqual(['b', 'a'])

    const one = await c.from('questions').select('slug, title').eq('slug', 'a').maybeSingle()
    expect(one.data).toEqual({ slug: 'a', title: 'Alpha' })

    const none = await c.from('questions').select('*').eq('slug', 'zzz').maybeSingle()
    expect(none.data).toBeNull()
    expect(none.error).toBeNull()

    const inQ = await c.from('questions').select('slug').in('slug', ['a', 'zzz'])
    expect(inQ.data).toEqual([{ slug: 'a' }])

    const limited = await c.from('questions').select('slug').order('slug').limit(1)
    expect(limited.data).toEqual([{ slug: 'a' }])

    const single = await c.from('questions').select('*').single()
    expect(single.data).toBeNull()
    expect(single.error?.code).toBe('PGRST116')
  })

  it('gte/lte/neq/is work on numbers and nulls', async () => {
    const { fake, c } = setup()
    const sid = stableUuid('s')
    for (const n of [1, 2, 3]) fake.db.insert('test_runs', { session_id: sid, passed: n })
    const r = await c.from('test_runs').select('passed').gte('passed', 2).neq('passed', 3)
    expect(r.data).toEqual([{ passed: 2 }])
    fake.db.insert('sessions', { question_id: Q })
    const open = await c.from('sessions').select('id').is('interviewer_id', null)
    expect((open.data as unknown[]).length).toBe(1)
  })

  it('resolves joins like "*, question:questions(*)"', async () => {
    const { fake, c } = setup()
    const s = fake.db.insert('sessions', { question_id: Q })
    const { data } = await c.from('sessions').select('*, question:questions(*)').eq('id', s.id).maybeSingle()
    expect((data as { question: { title: string } }).question.title).toBe('Alpha')
  })

  it('count with head returns the count and no rows', async () => {
    const { c } = setup()
    const r = await c.from('questions').select('*', { count: 'exact', head: true })
    expect(r.data).toBeNull()
    expect(r.count).toBe(2)
  })

  it('inserts with defaults and returns the row with select().single()', async () => {
    const { c } = setup()
    const r = await c.from('ai_messages').insert({ session_id: stableUuid('s'), role: 'user', content: 'hi' }).select().single()
    const row = r.data as { id: string; created_at: string }
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof row.created_at).toBe('string')
  })

  it('rejects duplicate primary keys', async () => {
    const { c } = setup()
    const r = await c.from('questions').insert({ id: Q, slug: 'dup', title: 'x', prompt: 'p' })
    expect(r.error?.code).toBe('23505')
  })

  it('upsert merges on the conflict key and only touches provided columns', async () => {
    const { fake, c } = setup()
    const sid = stableUuid('s')
    await c.from('session_workspace').upsert({ session_id: sid, notes: 'n1', yjs_state: 'abc' }, { onConflict: 'session_id' })
    await c.from('session_workspace').upsert({ session_id: sid, notes: 'n2' }, { onConflict: 'session_id' })
    const rows = fake.db.all('session_workspace')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ notes: 'n2', yjs_state: 'abc' })

    await c.from('bug_status').upsert({ session_id: sid, bug_id: 'b1', state: 'found' }, { onConflict: 'session_id,bug_id' })
    await c.from('bug_status').upsert({ session_id: sid, bug_id: 'b1', state: 'fixed' }, { onConflict: 'session_id,bug_id' })
    await c.from('bug_status').upsert({ session_id: sid, bug_id: 'b2', state: 'found' }, { onConflict: 'session_id,bug_id' })
    const bs = fake.db.all('bug_status')
    expect(bs).toHaveLength(2)
    expect(bs.find((r) => r.bug_id === 'b1')?.state).toBe('fixed')

    await c.from('session_reviews').upsert({ session_id: sid, score: 4, summary: 's', rubric_scores: { a: 1 } }, { onConflict: 'session_id' })
    await c.from('session_reviews').upsert({ session_id: sid, score: 5 }, { onConflict: 'session_id' })
    expect(fake.db.all('session_reviews')).toHaveLength(1)
    expect(fake.db.all('session_reviews')[0]).toMatchObject({ score: 5, summary: 's' })
  })

  it('update and delete honour filters, and updated_at is touched', async () => {
    const { fake, c } = setup()
    const sid = stableUuid('s')
    fake.db.insert('session_files', { session_id: sid, path: 'a.py', content: '1', kind: 'code' })
    fake.db.insert('session_files', { session_id: sid, path: 'b.py', content: '2', kind: 'code' })
    const before = fake.db.find('session_files', { path: 'a.py' })!.updated_at
    await c.from('session_files').update({ content: 'new' }).eq('session_id', sid).eq('path', 'a.py')
    const a = fake.db.find('session_files', { path: 'a.py' })!
    expect(a.content).toBe('new')
    expect(a.updated_at).not.toBe(before)
    expect(fake.db.find('session_files', { path: 'b.py' })!.content).toBe('2')
    await c.from('session_files').delete().eq('path', 'b.py')
    expect(fake.db.all('session_files')).toHaveLength(1)
  })

  it('returns data clones, not live references', async () => {
    const { c } = setup()
    const r = await c.from('questions').select('*').eq('slug', 'a').single()
    ;(r.data as { title: string }).title = 'mutated'
    const again = await c.from('questions').select('title').eq('slug', 'a').single()
    expect((again.data as { title: string }).title).toBe('Alpha')
  })
})

describe('rpc', () => {
  it('create_session / claim_session follow the reserved-email model', async () => {
    const { fake, c } = setup({ currentUser: SANDBOX_INTERVIEWER })
    const made = await c.rpc('create_session', { p_question_id: Q, p_my_role: 'interviewer', p_other_email: 'Guest@Example.com ' })
    const row = made.data as { id: string; interviewer_id: string; interviewee_id: string | null; interviewee_email: string }
    expect(row.interviewer_id).toBe(SANDBOX_INTERVIEWER.id)
    expect(row.interviewee_id).toBeNull()
    expect(row.interviewee_email).toBe('guest@example.com')

    fake.setCurrentUser({ id: stableUuid('guest'), email: 'guest@example.com', name: 'G' })
    const claimed = await c.rpc('claim_session', { p_session_id: row.id })
    expect((claimed.data as { interviewee_id: string }).interviewee_id).toBe(stableUuid('guest'))

    fake.setCurrentUser({ id: stableUuid('stranger'), email: 'x@example.com', name: 'X' })
    expect((await c.rpc('claim_session', { p_session_id: row.id })).error).not.toBeNull()
    expect((await c.rpc('create_session', { p_question_id: Q, p_my_role: 'nope', p_other_email: 'a@b.c' })).error).not.toBeNull()
    expect((await c.rpc('missing_fn', {})).error?.code).toBe('42883')
  })

  it('set_phase copies buggy and test files with kind code/test, once, forward only', async () => {
    const { fake, c } = setup()
    const s = fake.db.insert('sessions', { question_id: Q })
    const sid = s.id as string

    const back = await c.rpc('set_phase', { p_session_id: sid, p_phase: 'completed' })
    expect(back.error?.message).toMatch(/invalid phase transition/)

    const res = await c.rpc('set_phase', { p_session_id: sid, p_phase: 'debugging' })
    expect((res.data as { phase: string; debugging_started_at: string }).phase).toBe('debugging')
    expect((res.data as { debugging_started_at: string }).debugging_started_at).toBeTruthy()
    const files = fake.db.all('session_files').filter((f) => f.session_id === sid)
    expect(files.map((f) => [f.path, f.kind]).sort()).toEqual([
      ['a.py', 'code'],
      ['test_a.py', 'test'],
    ])
    expect(files.find((f) => f.path === 'a.py')!.content).toBe('buggy a')

    expect((await c.rpc('set_phase', { p_session_id: sid, p_phase: 'debugging' })).error).not.toBeNull()
    expect((await c.rpc('set_phase', { p_session_id: sid, p_phase: 'briefing' })).error).not.toBeNull()

    const done = await c.rpc('set_phase', { p_session_id: sid, p_phase: 'completed' })
    expect((done.data as { completed_at: string }).completed_at).toBeTruthy()
    expect((await c.rpc('set_phase', { p_session_id: sid, p_phase: 'debugging' })).error).not.toBeNull()
    expect(fake.db.all('session_files').filter((f) => f.session_id === sid)).toHaveLength(2)
  })
})

describe('realtime', () => {
  it('broadcast reaches other subscribers on the same topic but not the sender', async () => {
    const { c } = setup()
    const a = c.channel('session:1', { config: { private: true, broadcast: { self: false } } })
    const b = c.channel('session:1', { config: { private: true, broadcast: { self: false } } })
    const other = c.channel('session:2')
    const gotA = vi.fn()
    const gotB = vi.fn()
    const gotOther = vi.fn()
    a.on('broadcast', { event: 'ping' }, gotA)
    b.on('broadcast', { event: 'ping' }, gotB)
    other.on('broadcast', { event: 'ping' }, gotOther)
    const statuses: string[] = []
    a.subscribe((s) => statuses.push(s))
    b.subscribe()
    other.subscribe()
    await tick()
    expect(statuses).toEqual(['SUBSCRIBED'])

    expect(await a.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } })).toBe('ok')
    await tick()
    expect(gotA).not.toHaveBeenCalled()
    expect(gotB).toHaveBeenCalledWith({ type: 'broadcast', event: 'ping', payload: { n: 1 } })
    expect(gotOther).not.toHaveBeenCalled()
  })

  it('config.broadcast.self echoes to the sender; unsubscribe stops delivery', async () => {
    const { c } = setup()
    const a = c.channel('t', { config: { broadcast: { self: true } } })
    const b = c.channel('t')
    const gotA = vi.fn()
    const gotB = vi.fn()
    a.on('broadcast', { event: 'e' }, gotA).subscribe()
    b.on('broadcast', { event: 'e' }, gotB).subscribe()
    await a.send({ type: 'broadcast', event: 'e', payload: 1 })
    await tick()
    expect(gotA).toHaveBeenCalledTimes(1)
    expect(gotB).toHaveBeenCalledTimes(1)
    await c.removeChannel(b)
    await a.send({ type: 'broadcast', event: 'e', payload: 2 })
    await tick()
    expect(gotB).toHaveBeenCalledTimes(1)
  })

  it('postgres_changes honours event, table and filter, and carries new/old rows', async () => {
    const { fake, c } = setup()
    const sid = stableUuid('s1')
    const other = stableUuid('s2')
    const inserts = vi.fn()
    const updates = vi.fn()
    const deletes = vi.fn()
    c.channel('x')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_messages', filter: `session_id=eq.${sid}` }, inserts)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'session_files', filter: `session_id=eq.${sid}` }, updates)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'session_files' }, deletes)
      .subscribe()

    await c.from('ai_messages').insert({ session_id: sid, role: 'user', content: 'mine' })
    await c.from('ai_messages').insert({ session_id: other, role: 'user', content: 'not mine' })
    fake.db.insert('session_files', { session_id: sid, path: 'a.py', content: '1', kind: 'code' })
    await c.from('session_files').update({ content: '2' }).eq('session_id', sid).eq('path', 'a.py')
    await c.from('session_files').delete().eq('session_id', sid)
    await tick()

    expect(inserts).toHaveBeenCalledTimes(1)
    expect(inserts.mock.calls[0][0]).toMatchObject({ eventType: 'INSERT', table: 'ai_messages', new: { content: 'mine' } })
    expect(updates).toHaveBeenCalledTimes(1)
    expect(updates.mock.calls[0][0]).toMatchObject({ eventType: 'UPDATE', new: { content: '2' }, old: { content: '1' } })
    expect(deletes).toHaveBeenCalledTimes(1)
    expect(deletes.mock.calls[0][0].old).toMatchObject({ path: 'a.py' })
  })

  it('a set_phase UPDATE reaches a sessions subscriber with filter id=eq.<id>', async () => {
    const { fake, c } = setup()
    const s = fake.db.insert('sessions', { question_id: Q })
    const cb = vi.fn()
    c.channel('room')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${s.id}` }, cb)
      .subscribe()
    await c.rpc('set_phase', { p_session_id: s.id, p_phase: 'debugging' })
    await tick()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].new.phase).toBe('debugging')
  })

  it('auth returns a fixed sandbox user and no token', async () => {
    const { c } = setup({ currentUser: SANDBOX_INTERVIEWEE })
    const { data } = await c.auth.getSession()
    expect(data.session.user.email).toBe('interviewee@sandbox.test')
    expect(data.session.access_token).toBe('')
    await c.realtime.setAuth()
    expect(c.getChannels()).toEqual([])
  })
})

describe('functions.invoke("ai-chat")', () => {
  async function debuggingSession(fake: ReturnType<typeof setup>['fake']) {
    const s = fake.db.insert('sessions', { question_id: Q })
    await fake.raw.rpc('set_phase', { p_session_id: s.id, p_phase: 'debugging' })
    return s.id as string
  }

  it('without a key stores the exchange and answers with the canned reply', async () => {
    const { fake, c } = setup({ ai: { getSettings: () => ({ apiKey: null, model: 'm' }) } })
    const sid = await debuggingSession(fake)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'hello' } })
      expect(out.error).toBeNull()
      const data = out.data as { reply: string; message_id: string }
      expect(data.reply).toBe(CANNED_REPLY)
      const rows = fake.db.all('ai_messages')
      expect(rows.map((r) => r.role)).toEqual(['user', 'model'])
      expect(rows[1].id).toBe(data.message_id)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('with a key calls Gemini with the current files, question and history, then stores both messages', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Try a deque.' }] } }] }), { status: 200 }),
    )
    const { fake, c } = setup({
      ai: { getSettings: () => ({ apiKey: 'test-key-123', model: 'gemini-test' }), fetchImpl: fetchImpl as unknown as typeof fetch },
    })
    const sid = await debuggingSession(fake)
    // The candidate edits a file; the assistant must see the edited content.
    await c.from('session_files').update({ content: 'EDITED CONTENT' }).eq('session_id', sid).eq('path', 'a.py')
    fake.db.insert('ai_messages', { session_id: sid, role: 'user', content: 'earlier q' })
    fake.db.insert('ai_messages', { session_id: sid, role: 'model', content: 'earlier a' })

    const events: unknown[] = []
    c.channel('t').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_messages', filter: `session_id=eq.${sid}` }, (p) => events.push(p.new)).subscribe()

    const out = await c.functions.invoke('ai-chat', { body: { session_id: sid, message: 'why is it slow?' } })
    expect(out.error).toBeNull()
    expect((out.data as { reply: string }).reply).toBe('Try a deque.')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-123')
    expect(url).not.toContain('test-key-123')
    const body = JSON.parse(String(init.body)) as {
      systemInstruction: { parts: { text: string }[] }
      contents: { role: string; parts: { text: string }[] }[]
    }
    const system = body.systemInstruction.parts[0].text
    expect(system).toContain('EDITED CONTENT')
    expect(system).toContain('Alpha')
    expect(system).toContain('=== test_a.py (test file) ===')
    expect(body.contents.map((m) => [m.role, m.parts[0].text])).toEqual([
      ['user', 'earlier q'],
      ['model', 'earlier a'],
      ['user', 'why is it slow?'],
    ])

    const stored = fake.db.all('ai_messages').slice(-2)
    expect(stored.map((r) => [r.role, r.content])).toEqual([
      ['user', 'why is it slow?'],
      ['model', 'Try a deque.'],
    ])
    await tick()
    expect(events).toHaveLength(2) // transcript subscribers (the interviewer pane) are notified
  })

  it('maps upstream failures to the { error } shape the ChatPanel reads', async () => {
    const mk = (status: number) =>
      createFakeSupabase({
        ai: {
          getSettings: () => ({ apiKey: 'k', model: 'm' }),
          fetchImpl: (async () => new Response('{}', { status })) as unknown as typeof fetch,
        },
      })
    for (const [status, expected, text] of [
      [429, 429, /busy/],
      [400, 502, /rejected/],
      [500, 502, /unavailable/],
    ] as const) {
      const fake = mk(status)
      fake.db.insert('questions', { id: Q, slug: 'a', title: 'A', prompt: 'P' })
      const s = fake.db.insert('sessions', { question_id: Q, phase: 'debugging' })
      const out = await fake.raw.functions.invoke('ai-chat', { body: { session_id: s.id, message: 'x' } })
      expect(out.data).toBeNull()
      const ctx = (out.error as unknown as { context: Response }).context
      expect(ctx.status).toBe(expected)
      expect(((await ctx.json()) as { error: string }).error).toMatch(text)
      expect(fake.db.all('ai_messages')).toHaveLength(0)
    }
  })

  it('validates the request and the phase', async () => {
    const { fake, c } = setup()
    const s = fake.db.insert('sessions', { question_id: Q })
    const bad = await c.functions.invoke('ai-chat', { body: { session_id: 'nope', message: 'x' } })
    expect((bad.error as unknown as { context: Response }).context.status).toBe(400)
    const early = await c.functions.invoke('ai-chat', { body: { session_id: s.id, message: 'x' } })
    expect((early.error as unknown as { context: Response }).context.status).toBe(403)
  })
})
