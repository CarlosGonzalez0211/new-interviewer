import { describe, expect, it } from 'vitest'
import { canEditFile, collabUserFor, isReadOnly, isTestPath, languageForPath, markVisited, nextTabId, pickActivePath, sameList } from './logic'

describe('workspace logic', () => {
  it('detects test files', () => {
    expect(isTestPath('test_raffle.py')).toBe(true)
    expect(isTestPath('pkg/test_x.py')).toBe(true)
    expect(isTestPath('raffle_test.py')).toBe(true)
    expect(isTestPath('tests/helpers.py')).toBe(true)
    expect(isTestPath('raffle.py')).toBe(false)
    expect(isTestPath('latest.py')).toBe(false)
  })

  it('derives read-only', () => {
    expect(isReadOnly(undefined, true)).toBe(false)
    expect(isReadOnly(true, true)).toBe(true)
    expect(isReadOnly(false, false)).toBe(true)
    expect(canEditFile('a.py', undefined, true)).toBe(true)
    expect(canEditFile('test_a.py', undefined, true)).toBe(false)
    expect(canEditFile('a.py', undefined, false)).toBe(false)
  })

  it('picks the active file', () => {
    expect(pickActivePath([], null)).toBeNull()
    expect(pickActivePath(['a.py', 'test_a.py'], 'test_a.py')).toBe('test_a.py')
    expect(pickActivePath(['test_a.py', 'z.py'], null)).toBe('z.py')
    expect(pickActivePath(['test_a.py'], 'gone.py')).toBe('test_a.py')
    expect(pickActivePath(['a.py', 'b.py'], 'gone.py')).toBe('a.py')
  })

  it('compares lists', () => {
    expect(sameList(['a'], ['a'])).toBe(true)
    expect(sameList(['a'], ['b'])).toBe(false)
    expect(sameList(['a'], ['a', 'b'])).toBe(false)
  })

  it('navigates tabs by keyboard', () => {
    const ids = ['code', 'notes', 'board']
    expect(nextTabId(ids, 'code', 'ArrowRight')).toBe('notes')
    expect(nextTabId(ids, 'board', 'ArrowRight')).toBe('code')
    expect(nextTabId(ids, 'code', 'ArrowLeft')).toBe('board')
    expect(nextTabId(ids, 'notes', 'Home')).toBe('code')
    expect(nextTabId(ids, 'notes', 'End')).toBe('board')
    expect(nextTabId(ids, 'notes', 'x')).toBe('notes')
    expect(nextTabId([], 'a', 'Home')).toBe('a')
  })

  it('tracks visited panels immutably', () => {
    const s0 = new Set<string>(['a'])
    expect(markVisited(s0, 'a')).toBe(s0)
    const s1 = markVisited(s0, 'b')
    expect(s1).not.toBe(s0)
    expect([...s1]).toEqual(['a', 'b'])
    expect(s0.has('b')).toBe(false)
  })

  it('builds collab users', () => {
    expect(collabUserFor({ userId: 'u', role: 'interviewer', email: 'ana@x.io' })).toMatchObject({ id: 'u', name: 'ana', role: 'interviewer' })
    expect(collabUserFor({ userId: 'u', role: 'interviewee', email: null }).name).toBe('Interviewee')
  })

  it('maps languages', () => {
    expect(languageForPath('a/b.py')).toBe('python')
    expect(languageForPath('README')).toBe('plaintext')
  })
})
