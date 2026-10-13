import { describe, expect, it } from 'vitest'
import type { AiMessage, BugStatus, TestRun } from '../types/db'
import { mergeMessages, reconcilePending } from './chatState'
import { applyChange, mergeLoaded } from './listUtils'
import { elapsedSince, formatElapsed } from './time'
import { buildTimeline, countAiPrompts, weightedRubricScore } from './timeline'
import { allPassing, parseHarnessOutput, summarizeResults, timeoutResult } from '../runner/summary'

const msg = (id: string, role: 'user' | 'model', content: string, at: string): AiMessage => ({ id, session_id: 's', role, content, created_at: at })

describe('summary', () => {
  it('summarizes results', () => {
    const r = (status: 'passed' | 'failed' | 'error') => ({ file: 'f', name: 'n', status, message: '', traceback: '' })
    expect(summarizeResults([r('passed'), r('passed'), r('failed'), r('error')])).toEqual({ passed: 2, failed: 1, errored: 1 })
  })

  it('parses harness JSON and normalises junk', () => {
    const out = parseHarnessOutput(
      JSON.stringify({
        results: [{ file: 'test_a.py', name: 'test_x', status: 'passed' }, { file: 'test_a.py', name: 'test_y', status: 'weird', message: 5 }],
        stdout: 'hi',
      }),
    )
    expect(out.passed).toBe(1)
    expect(out.errored).toBe(1)
    expect(out.results[1].status).toBe('error')
    expect(out.results[1].message).toBe('')
    expect(out.stdout).toBe('hi')
    expect(() => parseHarnessOutput('null')).toThrow()
    expect(parseHarnessOutput('{}')).toEqual({ passed: 0, failed: 0, errored: 0, results: [], stdout: '' })
  })

  it('timeout result is an errored run', () => {
    const t = timeoutResult(10000)
    expect(t.errored).toBe(1)
    expect(t.results[0].message).toContain('10s')
    expect(allPassing(t)).toBe(false)
    expect(allPassing({ passed: 3, failed: 0, errored: 0 })).toBe(true)
  })
})

describe('listUtils', () => {
  const key = (r: Partial<{ id: string; v: number }>) => r.id
  it('upserts and deletes by key', () => {
    let items = [{ id: 'a', v: 1 }]
    items = applyChange(items, { type: 'upsert', row: { id: 'b', v: 2 } }, key)
    items = applyChange(items, { type: 'upsert', row: { id: 'a', v: 9 } }, key)
    expect(items).toEqual([{ id: 'a', v: 9 }, { id: 'b', v: 2 }])
    items = applyChange(items, { type: 'delete', row: { id: 'a' } }, key)
    expect(items).toEqual([{ id: 'b', v: 2 }])
  })

  it('delete on composite-less partial rows with unknown key is ignored', () => {
    expect(applyChange([{ id: 'a', v: 1 }], { type: 'delete', row: {} }, key)).toEqual([{ id: 'a', v: 1 }])
  })

  it('mergeLoaded lets live rows win', () => {
    const merged = mergeLoaded([{ id: 'a', v: 2 }], [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], (r) => r.id)
    expect(merged).toEqual([{ id: 'b', v: 1 }, { id: 'a', v: 2 }])
  })

  it('bug status delete works with the bug_id key', () => {
    const k = (r: Partial<BugStatus>) => r.bug_id
    const cur: BugStatus[] = [{ session_id: 's', bug_id: 'x', state: 'found', updated_at: '' }]
    expect(applyChange(cur, { type: 'delete', row: { session_id: 's', bug_id: 'x' } }, k)).toEqual([])
  })
})

describe('chatState', () => {
  it('merges by id and sorts chronologically', () => {
    const merged = mergeMessages([msg('2', 'model', 'b', '2024-01-01T00:00:02Z')], [msg('1', 'user', 'a', '2024-01-01T00:00:01Z'), msg('2', 'model', 'b2', '2024-01-01T00:00:02Z')])
    expect(merged.map((m) => m.id)).toEqual(['1', '2'])
    expect(merged[1].content).toBe('b2')
  })

  it('reconciles optimistic messages one-to-one', () => {
    const pending = [
      { localId: 'l1', content: 'hi', created_at: '' },
      { localId: 'l2', content: 'hi', created_at: '' },
    ]
    const real = [msg('1', 'user', 'hi', '2024-01-01T00:00:01Z'), msg('2', 'model', 'hi', '2024-01-01T00:00:02Z')]
    expect(reconcilePending(pending, real).map((p) => p.localId)).toEqual(['l2'])
  })
})

describe('time', () => {
  it('formats elapsed', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
    expect(formatElapsed(-5)).toBe('00:00')
    expect(formatElapsed(Number.NaN)).toBe('00:00')
  })
  it('elapsedSince handles null/invalid', () => {
    expect(elapsedSince(null, 5)).toBeNull()
    expect(elapsedSince('2024-01-01T00:00:00Z', '2024-01-01T00:00:10Z')).toBe(10_000)
    expect(elapsedSince('nope', 5)).toBeNull()
  })
})

describe('timeline', () => {
  it('builds a chronological timeline and counts prompts', () => {
    const run: TestRun = { id: 'r', session_id: 's', passed: 2, failed: 0, errored: 0, results: [], stdout: '', created_at: '2024-01-01T00:00:03Z' }
    const msgs = [msg('1', 'user', 'how do I   fix it?', '2024-01-01T00:00:01Z'), msg('2', 'model', 'like so', '2024-01-01T00:00:02Z')]
    const bug: BugStatus = { session_id: 's', bug_id: 'b', state: 'found', updated_at: '2024-01-01T00:00:04Z' }
    const tl = buildTimeline({ testRuns: [run], aiMessages: msgs, bugStatuses: [bug], bugTitles: { b: 'Off by one' } })
    expect(tl.map((t) => t.kind)).toEqual(['ai_prompt', 'test_run', 'bug'])
    expect(tl[0].label).toBe('Asked AI: how do I fix it?')
    expect(tl[1]).toMatchObject({ passing: true })
    expect(tl[2].label).toBe('Off by one marked found')
    expect(countAiPrompts(msgs)).toBe(1)
  })

  it('weighted rubric score ignores unscored items', () => {
    const rubric = [
      { id: 'a', label: 'A', weight: 3 },
      { id: 'b', label: 'B', weight: 1 },
      { id: 'c', label: 'C', weight: 1 },
    ]
    expect(weightedRubricScore(rubric, { a: 4, b: 2 })).toBe(3.5)
    expect(weightedRubricScore(rubric, {})).toBeNull()
  })
})
