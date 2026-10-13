import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { clientIdForPath, ensureFilesSeeded, seedFileUpdate } from './seed'

const FILES = [
  { path: 'solution.py', content: 'def f():\n    return 1\n' },
  { path: 'test_solution.py', content: 'def test_f():\n    pass\n' },
]
const files = (d: Y.Doc) => d.getMap<Y.Text>('files')

// persisted yjs_state with notes only (written by a client during briefing)
const writer = new Y.Doc()
writer.getText('notes').insert(0, 'my notes')
const BRIEFING_STATE = Y.encodeStateAsUpdate(writer)

function briefingDoc(): Y.Doc {
  const d = new Y.Doc()
  Y.applyUpdate(d, BRIEFING_STATE)
  return d
}

describe('late file seeding after the briefing -> debugging flip', () => {
  it('two clients seeding concurrently converge to exactly one copy of each file', () => {
    const a = briefingDoc()
    const b = briefingDoc()
    expect(ensureFilesSeeded(a, FILES)).toEqual(['solution.py', 'test_solution.py'])
    expect(ensureFilesSeeded(b, [...FILES].reverse())).toEqual(['solution.py', 'test_solution.py'])
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    for (const d of [a, b]) {
      expect([...files(d).keys()].sort()).toEqual(['solution.py', 'test_solution.py'])
      expect(files(d).get('solution.py')!.toString()).toBe(FILES[0].content)
      expect(files(d).get('test_solution.py')!.toString()).toBe(FILES[1].content)
      expect(d.getText('notes').toString()).toBe('my notes')
    }
  })

  it('is a no-op when the path already exists (never overwrites edits)', () => {
    const d = new Y.Doc()
    ensureFilesSeeded(d, FILES)
    files(d).get('solution.py')!.insert(0, '# edited\n')
    expect(ensureFilesSeeded(d, FILES)).toEqual([])
    expect(files(d).get('solution.py')!.toString()).toBe('# edited\n' + FILES[0].content)
  })

  it('only adds the missing paths', () => {
    const d = new Y.Doc()
    ensureFilesSeeded(d, [FILES[0]])
    expect(ensureFilesSeeded(d, FILES)).toEqual(['test_solution.py'])
  })

  it('per-path seed is byte-stable and never uses clientID 0 or 1', () => {
    expect(Array.from(seedFileUpdate('a.py', 'x'))).toEqual(Array.from(seedFileUpdate('a.py', 'x')))
    for (const p of ['a', 'b.py', 'solution.py', '', 'ünï/cødé']) expect(clientIdForPath(p)).toBeGreaterThanOrEqual(2)
    expect(clientIdForPath('a.py')).not.toBe(clientIdForPath('b.py'))
  })
})
