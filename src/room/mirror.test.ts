import { describe, expect, it } from 'vitest'
import { applyActiveFile, applyBaseline, applyCursor, applyFileEdit, emptyMirror, nextSeq } from './mirror'

const edit = (path: string, content: string, seq: number) => ({ path, content, seq, from: 'u' })

describe('mirror', () => {
  it('applies live edits and tracks last update + active file', () => {
    const s = applyFileEdit(emptyMirror, edit('a.py', 'x', 1), 100)
    expect(s.files).toEqual({ 'a.py': 'x' })
    expect(s.lastUpdate).toBe(100)
    expect(s.activePath).toBe('a.py')
  })

  it('drops older (out-of-order) edits but accepts equal/newer', () => {
    let s = applyFileEdit(emptyMirror, edit('a.py', 'new', 5), 1)
    s = applyFileEdit(s, edit('a.py', 'old', 4), 2)
    expect(s.files['a.py']).toBe('new')
    expect(s.lastUpdate).toBe(1)
    s = applyFileEdit(s, edit('a.py', 'newer', 5), 3)
    expect(s.files['a.py']).toBe('newer')
  })

  it('baseline never overwrites broadcast content but fills the rest', () => {
    let s = applyFileEdit(emptyMirror, edit('a.py', 'live', 1), 1)
    s = applyBaseline(s, [
      { path: 'a.py', content: 'db' },
      { path: 'b.py', content: 'db-b' },
    ])
    expect(s.files).toEqual({ 'a.py': 'live', 'b.py': 'db-b' })
  })

  it('baseline updates paths that only have baseline content', () => {
    let s = applyBaseline(emptyMirror, [{ path: 'b.py', content: '1' }])
    s = applyBaseline(s, [{ path: 'b.py', content: '2' }])
    expect(s.files['b.py']).toBe('2')
  })

  it('baseline returns same object when nothing changes', () => {
    const s = applyFileEdit(emptyMirror, edit('a.py', 'live', 1), 1)
    expect(applyBaseline(s, [{ path: 'a.py', content: 'db' }])).toBe(s)
  })

  it('tracks active file and cursor', () => {
    let s = applyActiveFile(emptyMirror, { path: 'c.py', from: 'u' }, 7)
    expect(s.activePath).toBe('c.py')
    s = applyCursor(s, { path: 'c.py', line: 2, column: 3, from: 'u' }, 8)
    expect(s.cursor?.line).toBe(2)
    expect(s.lastUpdate).toBe(8)
  })

  it('nextSeq is strictly increasing and time-floored', () => {
    expect(nextSeq(10, 5)).toBe(11)
    expect(nextSeq(10, 500)).toBe(500)
    expect(nextSeq(500, 500)).toBe(501)
  })
})
