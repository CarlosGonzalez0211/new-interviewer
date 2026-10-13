import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { DocSync } from './docSync'
import { applySeed, seedDocFromFiles } from './seed'
import { ORIGIN_REMOTE } from './origins'
import { applyAwarenessB64, encodeAwarenessB64 } from './awarenessCodec'
import { bytesToBase64 } from './b64'

/** In-memory broadcast channel: delivers to every other online peer, with an optional manual queue. */
class Hub {
  peers = new Map<string, { sync: DocSync; online: boolean }>()
  queue: { to: string; event: string; payload: unknown }[] = []
  manual = false
  log: string[] = []

  add(id: string, doc: Y.Doc, awareness = new Awareness(doc)) {
    const transport = {
      send: (event: string, payload: unknown) => {
        const self = this.peers.get(id)
        if (!self || !self.online) return false
        this.log.push(`${id}:${event}`)
        for (const [pid, p] of this.peers) {
          if (pid === id || !p.online) continue
          this.queue.push({ to: pid, event, payload: JSON.parse(JSON.stringify(payload)) })
        }
        if (!this.manual) this.drain()
        return true
      },
    }
    const sync = new DocSync({ doc, awareness, selfId: id, transport })
    this.peers.set(id, { sync, online: true })
    return { sync, awareness }
  }

  drain() {
    let guard = 0
    while (this.queue.length > 0 && guard++ < 10000) {
      const m = this.queue.shift()!
      const p = this.peers.get(m.to)
      if (p?.online) p.sync.handle(m.event, m.payload)
    }
  }
}

const text = (d: Y.Doc, path: string) => d.getMap<Y.Text>('files').get(path)!.toString()
const FILES = [
  { path: 'b.py', content: 'def b():\n    pass\n' },
  { path: 'a.py', content: 'def a():\n    return 1\n' },
]

function pair() {
  const hub = new Hub()
  const d1 = new Y.Doc()
  const d2 = new Y.Doc()
  applySeed(d1, FILES, 'notes')
  applySeed(d2, FILES, 'notes')
  const a = hub.add('A', d1)
  const b = hub.add('B', d2)
  a.sync.start()
  b.sync.start()
  hub.drain()
  return { hub, d1, d2, a, b }
}

describe('seed', () => {
  it('is byte-deterministic regardless of input order', () => {
    const s1 = seedDocFromFiles(FILES, 'n')
    const s2 = seedDocFromFiles([...FILES].reverse(), 'n')
    expect(bytesToBase64(s1)).toBe(bytesToBase64(s2))
  })

  it('is idempotent when two clients seed and then merge: no duplicated text', () => {
    const d1 = new Y.Doc()
    const d2 = new Y.Doc()
    applySeed(d1, FILES, 'hello')
    applySeed(d2, FILES, 'hello')
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2))
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
    for (const d of [d1, d2]) {
      expect(text(d, 'a.py')).toBe(FILES[1].content)
      expect(text(d, 'b.py')).toBe(FILES[0].content)
      expect(d.getText('notes').toString()).toBe('hello')
      expect([...d.getMap('files').keys()].sort()).toEqual(['a.py', 'b.py'])
    }
    // applying the seed twice on the same doc is also a no-op
    applySeed(d1, FILES, 'hello')
    expect(text(d1, 'a.py')).toBe(FILES[1].content)
  })

  it('merges edits made on top of one seed into a doc restored from another seed apply', () => {
    const d1 = new Y.Doc()
    applySeed(d1, FILES, '')
    d1.getMap<Y.Text>('files').get('a.py')!.insert(0, '# hi\n')
    const d2 = new Y.Doc()
    applySeed(d2, FILES, '')
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
    expect(text(d2, 'a.py')).toBe('# hi\n' + FILES[1].content)
  })
})

describe('DocSync convergence', () => {
  it('propagates local edits live and does not echo remote updates', () => {
    const { hub, d1, d2 } = pair()
    hub.log.length = 0
    d1.getMap<Y.Text>('files').get('a.py')!.insert(0, 'X')
    expect(text(d2, 'a.py').startsWith('X')).toBe(true)
    // exactly one y_update broadcast (from A); B applying it must not re-broadcast
    expect(hub.log.filter((l) => l.endsWith('y_update'))).toEqual(['A:y_update'])
  })

  it('converges on concurrent edits to the same file', () => {
    const { hub, d1, d2 } = pair()
    hub.manual = true
    d1.getMap<Y.Text>('files').get('a.py')!.insert(0, 'AAA')
    d2.getMap<Y.Text>('files').get('a.py')!.insert(0, 'BBB')
    d2.getMap<Y.Text>('files').get('a.py')!.delete(5, 3)
    hub.manual = false
    hub.drain()
    expect(text(d1, 'a.py')).toBe(text(d2, 'a.py'))
    expect(text(d1, 'a.py')).toContain('AAA')
    expect(text(d1, 'a.py')).toContain('BBB')
  })

  it('converges on interleaved typing', () => {
    const { d1, d2 } = pair()
    const t1 = d1.getMap<Y.Text>('files').get('b.py')!
    const t2 = d2.getMap<Y.Text>('files').get('b.py')!
    const base = t1.length
    for (let i = 0; i < 20; i++) {
      t1.insert(base, 'a' + i)
      t2.insert(0, 'b' + i)
      if (i % 3 === 0) d2.getText('notes').insert(0, String(i))
    }
    expect(text(d1, 'b.py')).toBe(text(d2, 'b.py'))
    expect(d1.getText('notes').toString()).toBe(d2.getText('notes').toString())
    expect(Y.encodeStateVector(d1)).toEqual(Y.encodeStateVector(d2))
  })

  it('late joiner catches up through state-vector sync (both directions)', () => {
    const hub = new Hub()
    const d1 = new Y.Doc()
    applySeed(d1, FILES, '')
    const a = hub.add('A', d1)
    d1.getMap<Y.Text>('files').get('a.py')!.insert(0, '# edited before join\n')
    d1.getText('notes').insert(0, 'live notes')

    const d2 = new Y.Doc()
    applySeed(d2, FILES, '')
    d2.getMap<Y.Text>('files').get('b.py')!.insert(0, '# joiner local\n') // joiner had unsynced edits
    const b = hub.add('B', d2)
    b.sync.start()
    hub.drain()
    void a

    expect(text(d2, 'a.py')).toBe('# edited before join\n' + FILES[1].content)
    expect(d2.getText('notes').toString()).toBe('live notes')
    expect(text(d1, 'b.py')).toBe('# joiner local\n' + FILES[0].content)
  })

  it('reconnect re-runs sync and merges edits made while offline', () => {
    const { hub, d1, d2, a, b } = pair()
    hub.peers.get('B')!.online = false
    d1.getMap<Y.Text>('files').get('a.py')!.insert(0, 'from A\n')
    d2.getMap<Y.Text>('files').get('a.py')!.insert(0, 'from B\n')
    expect(text(d1, 'a.py')).not.toBe(text(d2, 'a.py'))
    hub.peers.get('B')!.online = true
    b.sync.start()
    hub.drain()
    void a
    expect(text(d1, 'a.py')).toBe(text(d2, 'a.py'))
    expect(text(d1, 'a.py')).toContain('from A')
    expect(text(d1, 'a.py')).toContain('from B')
  })

  it('does not loop forever on sync handshakes', () => {
    const { hub } = pair()
    expect(hub.queue.length).toBe(0)
    expect(hub.log.filter((l) => l.endsWith('y_sync_request')).length).toBeLessThanOrEqual(4)
  })

  it('ignores malformed payloads', () => {
    const { a, d1 } = pair()
    const before = text(d1, 'a.py')
    expect(a.sync.handle('y_update', { update: '!!!not base64', from: 'X' })).toBe(true)
    expect(a.sync.handle('y_update', null)).toBe(true)
    expect(a.sync.handle('y_sync_request', { stateVector: 5, from: 'X' })).toBe(true)
    expect(a.sync.handle('other', {})).toBe(false)
    expect(text(d1, 'a.py')).toBe(before)
  })

  it('stops broadcasting when canWrite is false', () => {
    const sent: string[] = []
    const doc = new Y.Doc()
    new DocSync({
      doc,
      awareness: new Awareness(doc),
      selfId: 'A',
      transport: { send: (e) => (sent.push(e), true) },
      canWrite: () => false,
    })
    doc.getText('notes').insert(0, 'x')
    expect(sent.filter((e) => e === 'y_update')).toEqual([])
  })

  it('does not re-broadcast updates applied with the remote origin', () => {
    const sent: string[] = []
    const doc = new Y.Doc()
    new DocSync({ doc, awareness: new Awareness(doc), selfId: 'A', transport: { send: (e) => (sent.push(e), true) } })
    const other = new Y.Doc()
    other.getText('notes').insert(0, 'hi')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), ORIGIN_REMOTE)
    expect(sent).toEqual([])
  })
})

describe('awareness', () => {
  it('round-trips through base64', () => {
    const d1 = new Y.Doc()
    const d2 = new Y.Doc()
    const a1 = new Awareness(d1)
    const a2 = new Awareness(d2)
    a1.setLocalState({ user: { name: 'Ana', color: '#ff0000' }, selection: { anchor: 1, head: 2 } })
    applyAwarenessB64(a2, encodeAwarenessB64(a1, [a1.clientID]), 'test')
    expect(a2.getStates().get(a1.clientID)).toEqual({
      user: { name: 'Ana', color: '#ff0000' },
      selection: { anchor: 1, head: 2 },
    })
    a1.destroy()
    a2.destroy()
  })

  it('shares presence through the hub and removes it on destroy', () => {
    const { a, b, hub } = pair()
    a.awareness.setLocalStateField('user', { name: 'Ana', color: '#f00' })
    expect(b.awareness.getStates().get(a.awareness.clientID)?.user).toEqual({ name: 'Ana', color: '#f00' })
    a.sync.destroy()
    hub.drain()
    expect(b.awareness.getStates().has(a.awareness.clientID)).toBe(false)
  })
})
