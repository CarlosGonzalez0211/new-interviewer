import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { sessionChannelName } from '../types/realtime'
import { createBusRegistry } from './bus'
import type { BusConnection, BusConnectionCallbacks } from './bus'

export const COLLAB_EVENTS = [
  'y_update',
  'y_sync_request',
  'y_sync_reply',
  'y_awareness',
  'wb_update',
  'wb_pointer',
  'wb_sync_request',
  'wb_sync_reply',
] as const

function connect(sessionId: string, cb: BusConnectionCallbacks): BusConnection {
  // Pin the client for the life of this connection: close() must remove the channel from the client that created it,
  // even if the active backend was swapped meanwhile (sandbox demo mode).
  const client = supabase
  let cancelled = false
  let connected = false
  let channel: RealtimeChannel | null = null

  void (async () => {
    try {
      await client.realtime.setAuth()
    } catch {
      if (!cancelled) cb.onConnected(false)
      return
    }
    if (cancelled) return
    const topic = sessionChannelName(sessionId)
    const stale = client.getChannels().find((c) => c.topic === `realtime:${topic}`)
    if (stale) await client.removeChannel(stale)
    if (cancelled) return

    const ch = client.channel(topic, { config: { private: true, broadcast: { self: false } } })
    for (const event of COLLAB_EVENTS) {
      ch.on('broadcast', { event }, ({ payload }) => cb.onEvent(event, payload))
    }
    ch.subscribe((s) => {
      if (cancelled) return
      const now = s === 'SUBSCRIBED'
      if (now !== connected) {
        connected = now
        cb.onConnected(now)
      }
    })
    channel = ch
  })()

  return {
    send(event, payload) {
      if (!channel || !connected) return false
      void channel.send({ type: 'broadcast', event, payload })
      return true
    },
    close() {
      cancelled = true
      connected = false
      if (channel) void client.removeChannel(channel)
      channel = null
    },
  }
}

/** Process-wide registry: one Supabase channel per session shared by useCollab and useWhiteboard. */
export const sessionBus = createBusRegistry(connect)
