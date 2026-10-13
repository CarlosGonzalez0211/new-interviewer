import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The "real" client must never be touched while the sandbox backend is installed: make any use of it throw.
const realClientUsed = vi.hoisted(() => ({ count: 0 }))
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
  const trap = new Proxy(
    {},
    {
      get(_t, prop) {
        realClientUsed.count++
        throw new Error(`real Supabase client used (${String(prop)}) while the sandbox backend is active`)
      },
    },
  )
  return { ...actual, createClient: () => trap }
})

import { startCollabSession } from '../collab/collabSession'
import type { CollabHandle } from '../collab/collabSession'
import { invokeAiChat, listAiMessages } from '../room/roomApi'
import { getQuestionBySlug, getSession, listPublicQuestions, setPhase } from '../lib/api'
import { isSupabaseBackendSwapped, resetSupabaseBackend, setSupabaseBackend, supabase } from '../lib/supabase'
import { SANDBOX_INTERVIEWEE, SANDBOX_INTERVIEWER } from './identity'
import { bundledQuestionSources, seedQuestions } from './seed'
import { createSandboxRuntime } from './runtime'
import { FakeDb } from './fake/db'

const FIXTURE = {
  'demo/question.json': JSON.stringify({
    title: 'Demo',
    prompt: 'Fix it',
    constraints: 'None',
    checklist: ['c1'],
    followups: ['f1'],
    rubric: [{ id: 'r', label: 'R', weight: 1 }],
    bugs: [{ title: 'b', description: 'd', file_path: 'a.py', hint: 'h' }],
  }),
  'demo/buggy/a.py': 'def a():\r\n    return 1\r\n',
  'demo/tests/test_a.py': 'def test_a():\n    assert True\n',
  'demo/reference/a.py': 'def a():\n    return 2\n',
  'demo/acceptance/test_hidden.py': 'def test_h():\n    assert True\n',
}

beforeEach(() => {
  realClientUsed.count = 0
})

afterEach(() => {
  resetSupabaseBackend()
  vi.unstubAllGlobals()
})

describe('seed', () => {
  it('maps question sources like build_seed.py', () => {
    const db = new FakeDb()
    expect(seedQuestions(db, FIXTURE)).toEqual(['demo'])
    const q = db.all('questions')[0]
    expect(q).toMatchObject({ slug: 'demo', title: 'Demo', constraints: 'None', language: 'python' })
    expect(db.all('question_private')[0]).toMatchObject({ checklist: ['c1'], followups: ['f1'] })
    expect(db.all('question_files').map((f) => [f.path, f.kind])).toEqual([
      ['a.py', 'buggy'],
      ['test_a.py', 'test'],
    ])
    expect(db.all('question_files')[0].content).toBe('def a():\n    return 1\n') // CRLF normalised
    expect(db.all('question_reference_files').map((f) => f.path)).toEqual(['a.py', 'acceptance/test_hidden.py'])
    expect(db.all('question_bugs')).toHaveLength(1)
  })

  it('ids are stable across runs', () => {
    const a = new FakeDb()
    const b = new FakeDb()
    seedQuestions(a, FIXTURE)
    seedQuestions(b, FIXTURE)
    expect(a.all('questions')[0].id).toBe(b.all('questions')[0].id)
    expect(a.all('question_files').map((f) => f.id)).toEqual(b.all('question_files').map((f) => f.id))
  })

  it('import.meta.glob picks up every real question under supabase/questions', () => {
    const db = new FakeDb()
    const slugs = seedQuestions(db, bundledQuestionSources())
    expect(slugs).toEqual(expect.arrayContaining(['magic-hedge', 'potluck-raffle', 'rate-limiter']))
    const raffle = db.all('questions').find((q) => q.slug === 'potluck-raffle')!
    const files = db.all('question_files').filter((f) => f.question_id === raffle.id)
    expect(files.some((f) => f.kind === 'buggy' && f.path === 'raffle.py')).toBe(true)
    expect(files.some((f) => f.kind === 'test')).toBe(true)
    const hedge = db.all('questions').find((q) => q.slug === 'magic-hedge')!
    expect(
      db.all('question_reference_files').some((f) => f.question_id === hedge.id && String(f.path).startsWith('acceptance/')),
    ).toBe(true)
  })
})

describe('app code against the sandbox backend (no real Supabase)', () => {
  it('lib/api and roomApi run on the fake and never touch the real client or the network', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const rt = createSandboxRuntime(FIXTURE)
    setSupabaseBackend(rt.fake.client)
    expect(isSupabaseBackendSwapped()).toBe(true)

    const questions = await listPublicQuestions()
    expect(questions.map((q) => q.slug)).toEqual(['demo'])
    expect((await getQuestionBySlug('demo'))?.title).toBe('Demo')

    const session = rt.createSession(questions[0].id)
    expect(session.interviewer_id).toBe(SANDBOX_INTERVIEWER.id)
    expect(session.interviewee_id).toBe(SANDBOX_INTERVIEWEE.id)
    const loaded = await getSession(session.id)
    expect(loaded.question.title).toBe('Demo')

    await setPhase(session.id, 'debugging')
    const reply = await invokeAiChat(session.id, 'hi')
    expect(reply.reply).toMatch(/not enabled/)
    expect(await listAiMessages(session.id)).toHaveLength(2)

    expect(realClientUsed.count).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the live binding follows swaps: reset restores the (trapped) real client', () => {
    const rt = createSandboxRuntime(FIXTURE)
    setSupabaseBackend(rt.fake.client)
    expect(() => supabase.from('questions')).not.toThrow()
    resetSupabaseBackend()
    expect(isSupabaseBackendSwapped()).toBe(false)
    expect(() => supabase.from('questions')).toThrow(/real Supabase client used/)
  })
})

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('collab over the fake bus', () => {
  it('two collab instances converge on edits made on either side', async () => {
    const rt = createSandboxRuntime(FIXTURE)
    setSupabaseBackend(rt.fake.client)
    const session = rt.createSession(rt.questions()[0].id)
    await rt.jumpTo(session.id, 'debugging')

    const handles: CollabHandle[] = []
    const start = async (u: typeof SANDBOX_INTERVIEWER, role: 'interviewer' | 'interviewee') => {
      const h = await startCollabSession({
        sessionId: session.id,
        phase: 'debugging',
        user: { id: u.id, name: u.name, color: '#fff', role },
        onChange: () => undefined,
      })
      handles.push(h)
      return h
    }
    const a = await start(SANDBOX_INTERVIEWER, 'interviewer')
    const b = await start(SANDBOX_INTERVIEWEE, 'interviewee')
    await waitFor(() => a.collab.status === 'live' && b.collab.status === 'live')

    expect(a.collab.filePaths()).toEqual(['a.py', 'test_a.py'])
    const ta = a.collab.fileText('a.py')!
    const tb = b.collab.fileText('a.py')!
    expect(ta.toString()).toBe('def a():\n    return 1\n')

    ta.insert(0, '# from interviewer\n')
    await waitFor(() => tb.toString().startsWith('# from interviewer\n'))

    // concurrent edits on both sides
    ta.insert(ta.length, '# tail A\n')
    tb.insert(tb.length, '# tail B\n')
    await waitFor(() => ta.toString() === tb.toString() && ta.toString().includes('tail A') && ta.toString().includes('tail B'))

    // notes too
    b.collab.notes.insert(0, 'shared note')
    await waitFor(() => a.collab.notes.toString() === 'shared note')

    for (const h of handles) h.destroy()
    expect(realClientUsed.count).toBe(0)
  })
})
