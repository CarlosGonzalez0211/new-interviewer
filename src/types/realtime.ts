export interface FileEditEvent {
  path: string
  content: string
  seq: number
  from: string
}

export interface CursorEvent {
  path: string
  line: number
  column: number
  selection?: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  from: string
}

export interface ActiveFileEvent {
  path: string
  from: string
}

export interface SyncRequestEvent {
  from: string
}

export const sessionChannelName = (sessionId: string) => `session:${sessionId}`

// ---- Collaborative workspace (Yjs + whiteboard) ----

/** Yjs document update (local origin only). `update` is base64. */
export interface YUpdateEvent {
  update: string
  from: string
}

/** Yjs sync step 1: the sender's state vector (base64). */
export interface YSyncRequestEvent {
  stateVector: string
  from: string
}

/** Yjs sync step 2: the diff the requester is missing (base64), addressed to `to`. */
export interface YSyncReplyEvent {
  update: string
  to: string
  from: string
}

/** y-protocols awareness update (base64). */
export interface YAwarenessEvent {
  update: string
  from: string
}

/** Whiteboard: only the changed elements (by version). */
export interface WbUpdateEvent {
  elements: unknown[]
  from: string
}

export interface WbPointerEvent {
  x: number
  y: number
  tool: string
  from: string
}

export interface WbSyncRequestEvent {
  from: string
}

export interface WbSyncReplyEvent {
  elements: unknown[]
  to: string
  from: string
}
