import type { DbChange, FakeDb, Row } from './db'

export type ChannelStatus = 'SUBSCRIBED' | 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT'

interface BroadcastBinding {
  kind: 'broadcast'
  event: string
  cb: (msg: { type: 'broadcast'; event: string; payload: unknown }) => void
}

interface PgFilter {
  event: string
  schema?: string
  table?: string
  filter?: string
}

interface PgBinding {
  kind: 'pg'
  filter: PgFilter
  cb: (payload: PostgresChangesPayload) => void
}

export interface PostgresChangesPayload {
  schema: 'public'
  table: string
  commit_timestamp: string
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Row
  old: Row
  errors: null
}

const defer = (fn: () => void) => queueMicrotask(fn)

/** `col=eq.value` / `col=in.(a,b)` filter strings as accepted by Supabase Realtime. */
export function matchesRealtimeFilter(filter: string | undefined, row: Row | null): boolean {
  if (!filter) return true
  if (!row) return false
  const m = /^([^=]+)=(eq|neq|in|gt|gte|lt|lte)\.(.*)$/.exec(filter)
  if (!m) return true
  const [, col, op, raw] = m
  const v = row[col]
  const s = v === null || v === undefined ? '' : String(v)
  switch (op) {
    case 'eq':
      return s === raw
    case 'neq':
      return s !== raw
    case 'in':
      return raw
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map((x) => x.trim().replace(/^"|"$/g, ''))
        .includes(s)
    case 'gt':
      return Number(s) > Number(raw)
    case 'gte':
      return Number(s) >= Number(raw)
    case 'lt':
      return Number(s) < Number(raw)
    default:
      return Number(s) <= Number(raw)
  }
}

/** Shared message bus + postgres_changes fan-out for every FakeChannel of one fake client. */
export class RealtimeHub {
  private joined = new Map<string, Set<FakeChannel>>()
  private pgChannels = new Set<FakeChannel>()

  constructor(db: FakeDb) {
    db.onChange((c) => this.dispatchChange(c))
  }

  join(ch: FakeChannel) {
    let set = this.joined.get(ch.name)
    if (!set) this.joined.set(ch.name, (set = new Set()))
    set.add(ch)
    this.pgChannels.add(ch)
  }

  leave(ch: FakeChannel) {
    this.joined.get(ch.name)?.delete(ch)
    this.pgChannels.delete(ch)
  }

  allChannels(): FakeChannel[] {
    return [...this.pgChannels]
  }

  /** Deliver to every other subscribed channel with the same name (and to the sender iff broadcast.self). */
  broadcast(from: FakeChannel, event: string, payload: unknown) {
    const peers = this.joined.get(from.name)
    if (!peers) return
    // JSON round trip, exactly what crosses the wire.
    const wire = payload === undefined ? undefined : (JSON.parse(JSON.stringify(payload)) as unknown)
    for (const ch of [...peers]) {
      if (ch === from && !from.selfBroadcast) continue
      for (const b of ch.bindings) {
        if (b.kind === 'broadcast' && (b.event === event || b.event === '*')) {
          const cb = b.cb
          defer(() => {
            if (ch.state === 'joined') cb({ type: 'broadcast', event, payload: wire })
          })
        }
      }
    }
  }

  private dispatchChange(c: DbChange) {
    const commit = new Date().toISOString()
    for (const ch of [...this.pgChannels]) {
      for (const b of ch.bindings) {
        if (b.kind !== 'pg') continue
        const f = b.filter
        if (f.table && f.table !== c.table) continue
        if (f.schema && f.schema !== 'public') continue
        if (f.event !== '*' && f.event !== c.type) continue
        // Postgres cannot filter DELETE events (the row is gone), same as the real service.
        if (c.type !== 'DELETE' && !matchesRealtimeFilter(f.filter, c.new)) continue
        const payload: PostgresChangesPayload = {
          schema: 'public',
          table: c.table,
          commit_timestamp: commit,
          eventType: c.type,
          new: (c.new ?? {}) as Row,
          old: (c.old ?? {}) as Row,
          errors: null,
        }
        const cb = b.cb
        defer(() => {
          if (ch.state === 'joined') cb(payload)
        })
      }
    }
  }
}

export interface FakeChannelConfig {
  config?: { private?: boolean; broadcast?: { self?: boolean; ack?: boolean } }
}

/** The part of RealtimeChannel the app uses. */
export class FakeChannel {
  readonly topic: string
  readonly bindings: (BroadcastBinding | PgBinding)[] = []
  state: 'closed' | 'joined' = 'closed'
  readonly selfBroadcast: boolean
  readonly name: string
  private hub: RealtimeHub
  private onClose: (ch: FakeChannel) => void

  constructor(
    name: string,
    opts: FakeChannelConfig | undefined,
    hub: RealtimeHub,
    onClose: (ch: FakeChannel) => void,
  ) {
    this.name = name
    this.hub = hub
    this.onClose = onClose
    this.topic = `realtime:${name}`
    this.selfBroadcast = !!opts?.config?.broadcast?.self
  }

  on(type: 'broadcast', filter: { event: string }, cb: BroadcastBinding['cb']): this
  on(type: 'postgres_changes', filter: PgFilter, cb: PgBinding['cb']): this
  on(type: string, filter: { event: string } & Partial<PgFilter>, cb: (p: never) => void): this {
    if (type === 'broadcast') {
      this.bindings.push({ kind: 'broadcast', event: filter.event, cb: cb as BroadcastBinding['cb'] })
    } else if (type === 'postgres_changes') {
      this.bindings.push({ kind: 'pg', filter, cb: cb as PgBinding['cb'] })
    }
    return this
  }

  subscribe(cb?: (status: ChannelStatus, err?: Error) => void): this {
    if (this.state !== 'joined') {
      this.state = 'joined'
      this.hub.join(this)
    }
    if (cb) defer(() => cb(this.state === 'joined' ? 'SUBSCRIBED' : 'CLOSED'))
    return this
  }

  async send(msg: { type: string; event: string; payload?: unknown }): Promise<'ok' | 'error'> {
    if (this.state !== 'joined') return 'error'
    if (msg.type === 'broadcast') this.hub.broadcast(this, msg.event, msg.payload)
    return 'ok'
  }

  async unsubscribe(): Promise<'ok'> {
    if (this.state === 'joined') {
      this.state = 'closed'
      this.hub.leave(this)
    }
    this.onClose(this)
    return 'ok'
  }
}
