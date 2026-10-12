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
