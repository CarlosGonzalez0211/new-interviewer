import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { base64ToBytes, bytesToBase64, tryBase64ToBytes } from './b64'
import { createSaver } from './saver'
import { createBusRegistry } from './bus'
import type { BusConnectionCallbacks } from './bus'
import { applyEditsToString, changesToOps, cursorCss, cursorKey, deltaToEdits } from './textEdits'
import { filterElements, markKnown, mergeElements, shouldTakeRemote, takeChanged } from './wbMerge'
import type { VersionMap, WbElement } from './wbMerge'

describe('base64', () => {
  it('round-trips arbitrary and large byte arrays', () => {
    const small = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(small)))).toEqual(Array.from(small))
    const big = new Uint8Array(200_000).map((_, i) => i % 256)
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big)
    expect(bytesToBase64(new Uint8Array())).toBe('')
  })

  it('tryBase64ToBytes returns null for garbage', () => {
    expect(tryBase64ToBytes('***')).toBeNull()
    expect(tryBase64ToBytes(42)).toBeNull()
    expect(tryBase64ToBytes('AQID')).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('saver (debounce/flush)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces marks into one trailing save', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const s = createSaver({ delayMs: 2000, save })
    s.mark()
    await vi.advanceTimersByTimeAsync(1500)
    s.mark()
    await vi.advanceTimersByTimeAsync(1500)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(save).toHaveBeenCalledTimes(1)
    expect(s.isDirty()).toBe(false)
  })

  it('flush saves immediately and is a no-op when clean', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const s = createSaver({ delayMs: 2000, save })
    await s.flush()
    expect(save).not.toHaveBeenCalled()
    s.mark()
    await s.flush()
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps dirty after a failure and retries on the next flush', async () => {
    const onError = vi.fn()
    const save = vi.fn().mockRejectedValueOnce(new Error('rls')).mockResolvedValue(undefined)
    const s = createSaver({ delayMs: 10, save, onError })
    s.mark()
    await s.flush()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(s.isDirty()).toBe(true)
    await s.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(s.isDirty()).toBe(false)
  })

  it('edits made during a save trigger another save', async () => {
    let resolve!: () => void
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
      .mockResolvedValue(undefined)
    const s = createSaver({ delayMs: 10, save })
    s.mark()
    const p = s.flush()
    await Promise.resolve()
    s.mark()
    resolve()
    await p
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels the pending timer', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const s = createSaver({ delayMs: 100, save })
    s.mark()
    s.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
  })
})

const el = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): WbElement => ({
  id,
  version,
  versionNonce,
  ...extra,
})

describe('whiteboard merge', () => {
  it('higher version wins, lower versionNonce breaks ties', () => {
    expect(shouldTakeRemote(undefined, el('a', 1, 1))).toBe(true)
    expect(shouldTakeRemote(el('a', 2, 9), el('a', 3, 9))).toBe(true)
    expect(shouldTakeRemote(el('a', 3, 9), el('a', 2, 1))).toBe(false)
    expect(shouldTakeRemote(el('a', 2, 9), el('a', 2, 5))).toBe(true)
    expect(shouldTakeRemote(el('a', 2, 5), el('a', 2, 9))).toBe(false)
    expect(shouldTakeRemote(el('a', 2, 5), el('a', 2, 5))).toBe(false)
  })

  it('merge is commutative on the winner set and keeps deleted tombstones', () => {
    const a = [el('x', 2, 1, { isDeleted: true }), el('y', 1, 1)]
    const b = [el('x', 1, 1), el('y', 2, 3, { text: 'new' }), el('z', 1, 1)]
    const ab = mergeElements(a, b)
    const ba = mergeElements(b, a)
    const norm = (l: WbElement[]) => Object.fromEntries(l.map((e) => [e.id, e]))
    expect(norm(ab)).toEqual(norm(ba))
    expect(norm(ab).x.isDeleted).toBe(true)
    expect(norm(ab).y.text).toBe('new')
    expect(ab.map((e) => e.id)).toEqual(['x', 'y', 'z'])
  })

  it('takeChanged reports only changed elements and ignores applied remotes', () => {
    const known: VersionMap = new Map()
    const first = takeChanged(known, [el('a', 1, 1), el('b', 1, 1)])
    expect(first.map((e) => e.id)).toEqual(['a', 'b'])
    expect(takeChanged(known, [el('a', 1, 1), el('b', 1, 1)])).toEqual([])
    const changed = takeChanged(known, [el('a', 1, 1), el('b', 2, 7)])
    expect(changed.map((e) => e.id)).toEqual(['b'])
    markKnown(known, [el('c', 4, 4)])
    expect(takeChanged(known, [el('c', 4, 4)])).toEqual([])
    // same version, different nonce still counts as a change
    expect(takeChanged(known, [el('c', 4, 5)]).length).toBe(1)
  })

  it('filterElements drops malformed entries', () => {
    expect(filterElements([el('a', 1, 1), { id: 'b' }, null, 3])).toHaveLength(1)
    expect(filterElements('x')).toEqual([])
  })
})

describe('text edits <-> Y.Text', () => {
  it('delta edits reproduce the new text (fuzz against a mirrored string)', () => {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 60; round++) {
      const doc = new Y.Doc()
      const t = doc.getText('t')
      t.insert(0, 'hello world\nline two\nline three')
      let mirror = t.toString()
      t.observe((e) => {
        mirror = applyEditsToString(mirror, deltaToEdits(e.delta as never))
      })
      for (let i = 0; i < 15; i++) {
        doc.transact(() => {
          const ops = 1 + rnd(3)
          for (let k = 0; k < ops; k++) {
            const len = t.length
            if (rnd(2) === 0 || len === 0) t.insert(rnd(len + 1), 'xyz\n'.slice(0, 1 + rnd(4)))
            else {
              const from = rnd(len)
              t.delete(from, 1 + rnd(Math.min(4, len - from)))
            }
          }
        })
        expect(mirror).toBe(t.toString())
      }
    }
  })

  it('monaco changes replay onto Y.Text in a valid order', () => {
    const doc = new Y.Doc()
    const t = doc.getText('t')
    t.insert(0, 'abcdef')
    // multi-cursor edit: replace "b" with "BB" and delete "e", offsets relative to the old text
    doc.transact(() => {
      for (const op of changesToOps([
        { rangeOffset: 1, rangeLength: 1, text: 'BB' },
        { rangeOffset: 4, rangeLength: 1, text: '' },
      ])) {
        if (op.length) t.delete(op.offset, op.length)
        if (op.text) t.insert(op.offset, op.text)
      }
    })
    expect(t.toString()).toBe('aBBcdf')
  })

  it('builds safe css for names and colors', () => {
    const css = cursorCss(cursorKey(7, '#abc', 'Ana "x"\n'), '#abc', 'Ana "x"\n')
    expect(css).toContain('content:"Ana \\"x\\" "')
    expect(cursorCss('k', 'red;}body{display:none', 'n')).not.toContain('display:none')
    expect(cursorKey(1, '#fff', 'a')).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

describe('bus registry', () => {
  it('shares one connection per session, defers close, reuses it across a StrictMode remount', async () => {
    vi.useFakeTimers()
    const closes: string[] = []
    const cbs: BusConnectionCallbacks[] = []
    const reg = createBusRegistry((id, cb) => {
      cbs.push(cb)
      return { send: () => true, close: () => closes.push(id) }
    }, 30)
    const h1 = reg.acquire('s1')
    const h2 = reg.acquire('s1')
    expect(cbs).toHaveLength(1)
    const seen: string[] = []
    h1.onEvent((e) => seen.push(`h1:${e}`))
    h2.onEvent((e) => seen.push(`h2:${e}`))
    cbs[0].onEvent('y_update', {})
    expect(seen).toEqual(['h1:y_update', 'h2:y_update'])
    h1.release()
    h2.release()
    const h3 = reg.acquire('s1') // remount within the grace period
    await vi.advanceTimersByTimeAsync(100)
    expect(closes).toEqual([])
    expect(cbs).toHaveLength(1)
    h3.release()
    await vi.advanceTimersByTimeAsync(100)
    expect(closes).toEqual(['s1'])
    expect(reg.size()).toBe(0)
    vi.useRealTimers()
  })

  it('send is refused while disconnected and status handlers fire immediately', () => {
    const cbs: BusConnectionCallbacks[] = []
    const reg = createBusRegistry((_id, cb) => {
      cbs.push(cb)
      return { send: () => true, close: () => undefined }
    })
    const h = reg.acquire('s2')
    const states: boolean[] = []
    h.onConnected((c) => states.push(c))
    expect(h.send('x', {})).toBe(false)
    cbs[0].onConnected(true)
    expect(h.send('x', {})).toBe(true)
    cbs[0].onConnected(false)
    expect(states).toEqual([false, true, false])
  })
})
