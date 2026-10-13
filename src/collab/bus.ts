/**
 * Ref-counted shared connection to the private channel `session:<id>`. The Yjs doc hook and the whiteboard hook
 * both use it, so only one Supabase channel exists per session (two channels with the same topic would clobber
 * each other). Teardown is deferred a tick so StrictMode's mount/unmount/mount reuses the same connection.
 */
export interface BusConnection {
  send(event: string, payload: unknown): boolean
  close(): void
}

export interface BusConnectionCallbacks {
  onEvent(event: string, payload: unknown): void
  onConnected(connected: boolean): void
}

export type BusConnectionFactory = (sessionId: string, cb: BusConnectionCallbacks) => BusConnection

export type BusEventHandler = (event: string, payload: unknown) => void
export type BusStatusHandler = (connected: boolean) => void

export interface BusHandle {
  readonly connected: boolean
  send(event: string, payload: unknown): boolean
  /** Subscribe to every incoming event. Returns unsubscribe. */
  onEvent(handler: BusEventHandler): () => void
  /** Subscribe to connection changes; invoked immediately with the current state. Returns unsubscribe. */
  onConnected(handler: BusStatusHandler): () => void
  release(): void
}

interface Entry {
  conn: BusConnection
  refs: number
  connected: boolean
  events: Set<BusEventHandler>
  statuses: Set<BusStatusHandler>
  closeTimer: ReturnType<typeof setTimeout> | null
}

export function createBusRegistry(factory: BusConnectionFactory, graceMs = 30) {
  const entries = new Map<string, Entry>()

  /**
   * `scope` separates connections for the same session inside one JS context (the sandbox runs interviewer and
   * interviewee side by side). The real app always has one user per page, so the scope never changes anything.
   */
  function acquire(sessionId: string, scope = ''): BusHandle {
    const key = scope ? `${scope}|${sessionId}` : sessionId
    let entry = entries.get(key)
    if (!entry) {
      const created: Entry = {
        conn: undefined as unknown as BusConnection,
        refs: 0,
        connected: false,
        events: new Set(),
        statuses: new Set(),
        closeTimer: null,
      }
      created.conn = factory(sessionId, {
        onEvent: (e, p) => {
          for (const h of [...created.events]) h(e, p)
        },
        onConnected: (c) => {
          created.connected = c
          for (const h of [...created.statuses]) h(c)
        },
      })
      entries.set(key, created)
      entry = created
    }
    const e = entry
    if (e.closeTimer !== null) {
      clearTimeout(e.closeTimer)
      e.closeTimer = null
    }
    e.refs++
    let released = false
    const myEvents = new Set<BusEventHandler>()
    const myStatuses = new Set<BusStatusHandler>()
    return {
      get connected() {
        return e.connected
      },
      send: (event, payload) => (e.connected ? e.conn.send(event, payload) : false),
      onEvent(h) {
        e.events.add(h)
        myEvents.add(h)
        return () => {
          e.events.delete(h)
          myEvents.delete(h)
        }
      },
      onConnected(h) {
        e.statuses.add(h)
        myStatuses.add(h)
        h(e.connected)
        return () => {
          e.statuses.delete(h)
          myStatuses.delete(h)
        }
      },
      release() {
        if (released) return
        released = true
        for (const h of myEvents) e.events.delete(h)
        for (const h of myStatuses) e.statuses.delete(h)
        e.refs--
        if (e.refs <= 0) {
          e.closeTimer = setTimeout(() => {
            if (e.refs > 0) return
            e.conn.close()
            if (entries.get(key) === e) entries.delete(key)
          }, graceMs)
        }
      },
    }
  }

  return { acquire, size: () => entries.size }
}
