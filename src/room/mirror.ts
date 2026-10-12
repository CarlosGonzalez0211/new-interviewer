import type { ActiveFileEvent, CursorEvent, FileEditEvent } from '../types/realtime'

/** Interviewer-side view of the interviewee's workspace, built from DB baseline + broadcast overlay. */
export interface MirrorState {
  files: Record<string, string>
  /** Highest broadcast seq seen per path; paths without an entry only hold the DB baseline. */
  seqs: Record<string, number>
  activePath: string | null
  cursor: CursorEvent | null
  lastUpdate: number | null
}

export const emptyMirror: MirrorState = { files: {}, seqs: {}, activePath: null, cursor: null, lastUpdate: null }

/** Seed from durable storage. Never overwrites content that already arrived over broadcast. */
export function applyBaseline(state: MirrorState, rows: readonly { path: string; content: string }[]): MirrorState {
  let files = state.files
  for (const row of rows) {
    if (row.path in state.seqs) continue
    if (files === state.files) files = { ...state.files }
    files[row.path] = row.content
  }
  return files === state.files ? state : { ...state, files }
}

/** Apply a live edit. Out-of-order (older seq) events for the same path are dropped. */
export function applyFileEdit(state: MirrorState, ev: FileEditEvent, now: number): MirrorState {
  const prevSeq = state.seqs[ev.path]
  if (prevSeq !== undefined && ev.seq < prevSeq) return state
  return {
    ...state,
    files: { ...state.files, [ev.path]: ev.content },
    seqs: { ...state.seqs, [ev.path]: ev.seq },
    lastUpdate: now,
    activePath: state.activePath ?? ev.path,
  }
}

export function applyActiveFile(state: MirrorState, ev: ActiveFileEvent, now: number): MirrorState {
  if (state.activePath === ev.path) return { ...state, lastUpdate: now }
  return { ...state, activePath: ev.path, lastUpdate: now }
}

export function applyCursor(state: MirrorState, ev: CursorEvent, now: number): MirrorState {
  return { ...state, cursor: ev, lastUpdate: now }
}

/** Build the next outgoing seq: strictly increasing and survives page reloads (time-based floor). */
export function nextSeq(previous: number, now: number): number {
  return Math.max(previous + 1, now)
}
