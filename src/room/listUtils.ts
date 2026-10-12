/** Pure helpers for keeping a list in sync with Postgres change events. */

export type ChangeEvent<T> =
  | { type: 'upsert'; row: T }
  | { type: 'delete'; row: Partial<T> }

export function applyChange<T>(items: readonly T[], ev: ChangeEvent<T>, keyOf: (row: Partial<T>) => string | undefined): T[] {
  const key = keyOf(ev.row)
  if (key === undefined) return items.slice()
  if (ev.type === 'delete') return items.filter((it) => keyOf(it) !== key)
  const idx = items.findIndex((it) => keyOf(it) === key)
  if (idx === -1) return [...items, ev.row]
  const next = items.slice()
  next[idx] = ev.row
  return next
}

/** Merge a freshly loaded snapshot with rows that arrived live in the meantime (live wins). */
export function mergeLoaded<T>(live: readonly T[], loaded: readonly T[], keyOf: (row: T) => string): T[] {
  const liveKeys = new Set(live.map(keyOf))
  return [...loaded.filter((r) => !liveKeys.has(keyOf(r))), ...live]
}

export function sortByCreatedAt<T extends { created_at: string }>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}
