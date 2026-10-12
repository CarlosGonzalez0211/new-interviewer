import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { sessionChannelName } from '../types/realtime'
import type { ActiveFileEvent, CursorEvent, FileEditEvent, SyncRequestEvent } from '../types/realtime'
import { parseActiveFile, parseCursor, parseFileEdit, parseSyncRequest } from '../room/protocol'

export type ChannelStatus = 'connecting' | 'connected' | 'error' | 'closed'

export interface BroadcastEvents {
  file_edit: FileEditEvent
  cursor: CursorEvent
  active_file: ActiveFileEvent
  sync_request: SyncRequestEvent
}

export interface ChannelHandlers {
  onFileEdit?: (ev: FileEditEvent) => void
  onCursor?: (ev: CursorEvent) => void
  onActiveFile?: (ev: ActiveFileEvent) => void
  onSyncRequest?: (ev: SyncRequestEvent) => void
  /** Called every time the channel (re)joins successfully. */
  onSubscribed?: () => void
}

export interface SessionChannel {
  status: ChannelStatus
  /** Returns false when the channel is not connected (event dropped). */
  send: <K extends keyof BroadcastEvents>(event: K, payload: BroadcastEvents[K]) => boolean
}

/**
 * Private broadcast channel `session:<id>`. StrictMode safe: a cancelled effect never creates a channel,
 * and any stale channel with the same topic is removed before a new one is made.
 */
export function useSessionChannel(sessionId: string, handlers: ChannelHandlers): SessionChannel {
  const [status, setStatus] = useState<ChannelStatus>('connecting')
  const channelRef = useRef<RealtimeChannel | null>(null)
  const connectedRef = useRef(false)
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    let cancelled = false
    let channel: RealtimeChannel | null = null
    setStatus('connecting')
    connectedRef.current = false

    void (async () => {
      try {
        await supabase.realtime.setAuth()
      } catch {
        if (!cancelled) setStatus('error')
        return
      }
      if (cancelled) return
      const topic = sessionChannelName(sessionId)
      const stale = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`)
      if (stale) await supabase.removeChannel(stale)
      if (cancelled) return

      const ch = supabase.channel(topic, { config: { private: true, broadcast: { self: false } } })
      ch.on('broadcast', { event: 'file_edit' }, ({ payload }) => {
        const ev = parseFileEdit(payload)
        if (ev) handlersRef.current.onFileEdit?.(ev)
      })
        .on('broadcast', { event: 'cursor' }, ({ payload }) => {
          const ev = parseCursor(payload)
          if (ev) handlersRef.current.onCursor?.(ev)
        })
        .on('broadcast', { event: 'active_file' }, ({ payload }) => {
          const ev = parseActiveFile(payload)
          if (ev) handlersRef.current.onActiveFile?.(ev)
        })
        .on('broadcast', { event: 'sync_request' }, ({ payload }) => {
          const ev = parseSyncRequest(payload)
          if (ev) handlersRef.current.onSyncRequest?.(ev)
        })
        .subscribe((s) => {
          if (cancelled) return
          if (s === 'SUBSCRIBED') {
            connectedRef.current = true
            setStatus('connected')
            handlersRef.current.onSubscribed?.()
          } else {
            connectedRef.current = false
            setStatus(s === 'CLOSED' ? 'closed' : 'error')
          }
        })
      channel = ch
      channelRef.current = ch
    })()

    return () => {
      cancelled = true
      connectedRef.current = false
      channelRef.current = null
      if (channel) void supabase.removeChannel(channel)
    }
  }, [sessionId])

  const send = useCallback(<K extends keyof BroadcastEvents>(event: K, payload: BroadcastEvents[K]): boolean => {
    const ch = channelRef.current
    if (!ch || !connectedRef.current) return false
    void ch.send({ type: 'broadcast', event, payload })
    return true
  }, [])

  return { status, send }
}
