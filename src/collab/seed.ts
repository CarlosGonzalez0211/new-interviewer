import * as Y from 'yjs'
import { ORIGIN_SEED } from './origins'

export interface SeedFile {
  path: string
  content: string
}

/**
 * Deterministic seed update: a throwaway doc with a FIXED clientID inserts every file (path order) and the notes
 * in ONE transaction. Every client builds byte-identical items, so applying the seed on several clients and then
 * merging never duplicates text.
 */
export function seedDocFromFiles(files: readonly SeedFile[], notes: string): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = 1
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  doc.transact(() => {
    const map = doc.getMap<Y.Text>('files')
    for (const f of sorted) {
      const t = new Y.Text()
      t.insert(0, f.content)
      map.set(f.path, t)
    }
    const n = doc.getText('notes')
    if (notes) n.insert(0, notes)
  })
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

export function applySeed(doc: Y.Doc, files: readonly SeedFile[], notes: string): void {
  Y.applyUpdate(doc, seedDocFromFiles(files, notes), ORIGIN_SEED)
}

/** Stable 32-bit FNV-1a hash of a path, mapped to a Yjs clientID that is never 0 or 1 (1 is the initial seed). */
export function clientIdForPath(path: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 0xfffffffd) + 2
}

/** Deterministic update that adds ONE file: same bytes on every client for the same (path, content). */
export function seedFileUpdate(path: string, content: string): Uint8Array {
  const tmp = new Y.Doc()
  tmp.clientID = clientIdForPath(path)
  tmp.transact(() => {
    const t = new Y.Text()
    t.insert(0, content)
    tmp.getMap<Y.Text>('files').set(path, t)
  })
  const update = Y.encodeStateAsUpdate(tmp)
  tmp.destroy()
  return update
}

/**
 * Add every file missing from doc.getMap('files'). Existing paths are never touched. Concurrent calls on several
 * clients are idempotent (identical per-path structs). Returns the paths that were added.
 */
export function ensureFilesSeeded(doc: Y.Doc, files: readonly SeedFile[]): string[] {
  const map = doc.getMap<Y.Text>('files')
  const added: string[] = []
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (map.has(f.path)) continue
    Y.applyUpdate(doc, seedFileUpdate(f.path, f.content), ORIGIN_SEED)
    added.push(f.path)
  }
  return added
}
