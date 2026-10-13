import * as Y from 'yjs'
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { bytesToBase64, tryBase64ToBytes } from './b64'
import { ORIGIN_REMOTE, isLocalOrigin } from './origins'
import type { YAwarenessEvent, YSyncReplyEvent, YSyncRequestEvent, YUpdateEvent } from '../types/realtime'

export interface Transport {
  /** Returns false when the message could not be sent (offline). */
  send(event: string, payload: unknown): boolean
}

export interface DocSyncOptions {
  doc: Y.Doc
  awareness: Awareness
  selfId: string
  transport: Transport
  /** false => local doc updates are not broadcast (completed session). */
  canWrite?: () => boolean
}

type SyncRequestPayload = YSyncRequestEvent & { back?: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Yjs over a broadcast transport. Local transaction origins are broadcast as `y_update`; remote updates are applied
 * with ORIGIN_REMOTE and never re-broadcast. Sync step 1/2 (state vectors) runs on `start()`, which the owner calls
 * again after every reconnect.
 */
export class DocSync {
  private readonly doc: Y.Doc
  private readonly awareness: Awareness
  private readonly selfId: string
  private readonly transport: Transport
  private readonly canWrite: () => boolean
  private destroyed = false

  constructor(opts: DocSyncOptions) {
    this.doc = opts.doc
    this.awareness = opts.awareness
    this.selfId = opts.selfId
    this.transport = opts.transport
    this.canWrite = opts.canWrite ?? (() => true)
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.destroyed || !isLocalOrigin(origin) || !this.canWrite()) return
    const payload: YUpdateEvent = { update: bytesToBase64(update), from: this.selfId }
    this.transport.send('y_update', payload)
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (this.destroyed || origin !== 'local') return
    this.sendAwareness([...added, ...updated, ...removed])
  }

  private sendAwareness(clients: number[]) {
    if (clients.length === 0) return
    const payload: YAwarenessEvent = {
      update: bytesToBase64(encodeAwarenessUpdate(this.awareness, clients)),
      from: this.selfId,
    }
    this.transport.send('y_awareness', payload)
  }

  /** Sync step 1 + our presence. Call on every (re)connect. */
  start(): void {
    if (this.destroyed) return
    this.sendSyncRequest(false)
    this.sendAwareness([this.awareness.clientID])
  }

  private sendSyncRequest(back: boolean) {
    const payload: SyncRequestPayload = {
      stateVector: bytesToBase64(Y.encodeStateVector(this.doc)),
      from: this.selfId,
      ...(back ? { back: true } : {}),
    }
    this.transport.send('y_sync_request', payload)
  }

  /** Feed an incoming broadcast event. Returns true when it was a collab (y_*) event. */
  handle(event: string, payload: unknown): boolean {
    if (this.destroyed) return false
    if (!event.startsWith('y_')) return false
    if (!isObj(payload)) return true
    const from = typeof payload.from === 'string' ? payload.from : null
    switch (event) {
      case 'y_update': {
        if (from === this.selfId) return true
        const bytes = tryBase64ToBytes(payload.update)
        if (bytes) this.applyRemote(bytes)
        return true
      }
      case 'y_sync_request': {
        if (!from || from === this.selfId) return true
        const sv = tryBase64ToBytes(payload.stateVector)
        if (!sv) return true
        let diff: Uint8Array
        try {
          diff = Y.encodeStateAsUpdate(this.doc, sv)
        } catch {
          return true
        }
        const reply: YSyncReplyEvent = { update: bytesToBase64(diff), to: from, from: this.selfId }
        this.transport.send('y_sync_reply', reply)
        // Pull whatever the requester has that we lack (once: the answer to this is flagged `back`).
        if (payload.back !== true) this.sendSyncRequest(true)
        this.sendAwareness([this.awareness.clientID])
        return true
      }
      case 'y_sync_reply': {
        if (payload.to !== this.selfId) return true
        const bytes = tryBase64ToBytes(payload.update)
        if (bytes) this.applyRemote(bytes)
        return true
      }
      case 'y_awareness': {
        if (from === this.selfId) return true
        const bytes = tryBase64ToBytes(payload.update)
        if (bytes) {
          try {
            applyAwarenessUpdate(this.awareness, bytes, ORIGIN_REMOTE)
          } catch {
            // malformed awareness: ignore
          }
        }
        return true
      }
      default:
        return true
    }
  }

  private applyRemote(update: Uint8Array) {
    try {
      Y.applyUpdate(this.doc, update, ORIGIN_REMOTE)
    } catch {
      // corrupt update: ignore; the next sync round repairs state
    }
  }

  destroy(): void {
    if (this.destroyed) return
    try {
      removeAwarenessStates(this.awareness, [this.awareness.clientID], 'local')
    } catch {
      // ignore
    }
    this.destroyed = true
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
  }
}
