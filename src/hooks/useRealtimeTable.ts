import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { applyChange, mergeLoaded } from '../room/listUtils'

export interface RealtimeTableOptions<T> {
  table: string
  sessionId: string
  load: () => Promise<T[]>
  /** Primary-key string of a (possibly partial, for deletes) row. */
  keyOf: (row: Partial<T>) => string | undefined
  /** Optional ordering applied after every change. */
  sort?: (rows: T[]) => T[]
}

export interface RealtimeTable<T> {
  items: T[]
  loading: boolean
  error: string | null
  /** Optimistic local helpers; realtime echoes are idempotent upserts. */
  upsertLocal: (row: T) => void
  removeLocal: (row: Partial<T>) => void
  /** Re-fetch and merge (safety net if a realtime event was missed). */
  reload: () => Promise<void>
}

let channelCounter = 0

/**
 * Loads a per-session table and keeps it live through postgres_changes.
 * Inserts/updates are filtered server-side; deletes cannot be filtered by Postgres so they are matched client-side.
 */
export function useRealtimeTable<T>(opts: RealtimeTableOptions<T>): RealtimeTable<T> {
  const { table, sessionId } = opts
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const localOps = useRef<{ reload: () => Promise<void>; upsert: (row: T) => void; remove: (row: Partial<T>) => void } | null>(null)
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let live: T[] = []
    let loaded = false
    setLoading(true)
    setError(null)
    setItems([])

    const order = (rows: T[]) => (optsRef.current.sort ? optsRef.current.sort(rows) : rows)
    const keyOf = (row: Partial<T>) => optsRef.current.keyOf(row)

    const push = (next: T[]) => {
      live = next
      if (loaded) setItems(order(next))
    }

    const name = `rt:${table}:${sessionId}:${++channelCounter}`
    const channel = supabase
      .channel(name)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table, filter: `session_id=eq.${sessionId}` },
        (p) => push(applyChange(live, { type: 'upsert', row: p.new as unknown as T }, keyOf)),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table, filter: `session_id=eq.${sessionId}` },
        (p) => push(applyChange(live, { type: 'upsert', row: p.new as unknown as T }, keyOf)),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (p) => {
        const old = p.old as Record<string, unknown>
        if (typeof old.session_id === 'string' && old.session_id !== sessionId) return
        push(applyChange(live, { type: 'delete', row: old as Partial<T> }, keyOf))
      })
      .subscribe()

    optsRef.current
      .load()
      .then((rows) => {
        if (cancelled) return
        loaded = true
        // Rows that arrived live while loading win over the snapshot.
        const merged = mergeLoaded(live, rows, (r) => keyOf(r) ?? '')
        live = merged
        setItems(order(merged))
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        loaded = true
        setItems(order(live))
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })

    // Expose local mutation through the same live buffer.
    localOps.current = {
      reload: async () => {
        const rows = await optsRef.current.load()
        if (cancelled) return
        push(mergeLoaded(live, rows, (r) => keyOf(r) ?? ''))
      },
      upsert: (row) => push(applyChange(live, { type: 'upsert', row }, keyOf)),
      remove: (row) => push(applyChange(live, { type: 'delete', row }, keyOf)),
    }

    return () => {
      cancelled = true
      localOps.current = null
      void supabase.removeChannel(channel)
    }
  }, [table, sessionId])

  const upsertLocal = useCallback((row: T) => localOps.current?.upsert(row), [])
  const removeLocal = useCallback((row: Partial<T>) => localOps.current?.remove(row), [])

  const reload = useCallback(async () => {
    await localOps.current?.reload()
  }, [])

  return { items, loading, error, upsertLocal, removeLocal, reload }
}
