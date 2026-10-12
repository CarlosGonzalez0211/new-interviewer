import type { ActiveFileEvent, CursorEvent, FileEditEvent, SyncRequestEvent } from '../types/realtime'

/** Runtime validation for broadcast payloads (they arrive as untyped JSON from another browser). */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseFileEdit(v: unknown): FileEditEvent | null {
  if (!isRecord(v)) return null
  const { path, content, seq, from } = v
  if (typeof path !== 'string' || typeof content !== 'string' || typeof seq !== 'number' || typeof from !== 'string') return null
  return { path, content, seq, from }
}

export function parseActiveFile(v: unknown): ActiveFileEvent | null {
  if (!isRecord(v)) return null
  const { path, from } = v
  if (typeof path !== 'string' || typeof from !== 'string') return null
  return { path, from }
}

export function parseSyncRequest(v: unknown): SyncRequestEvent | null {
  if (!isRecord(v) || typeof v.from !== 'string') return null
  return { from: v.from }
}

export function parseCursor(v: unknown): CursorEvent | null {
  if (!isRecord(v)) return null
  const { path, line, column, from, selection } = v
  if (typeof path !== 'string' || typeof line !== 'number' || typeof column !== 'number' || typeof from !== 'string') return null
  const ev: CursorEvent = { path, line, column, from }
  if (isRecord(selection)) {
    const { startLine, startColumn, endLine, endColumn } = selection
    if (
      typeof startLine === 'number' &&
      typeof startColumn === 'number' &&
      typeof endLine === 'number' &&
      typeof endColumn === 'number'
    ) {
      ev.selection = { startLine, startColumn, endLine, endColumn }
    }
  }
  return ev
}
