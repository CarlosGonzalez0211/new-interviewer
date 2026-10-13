import type { Session } from '../types/db'

export type ClockSession = Pick<Session, 'started_at' | 'debugging_started_at' | 'completed_at'>

export interface ClockReading {
  /** started_at -> completed_at (or now). Null until both participants have joined. */
  total: number | null
  /** started_at -> debugging_started_at (or completed_at / now while still in briefing). */
  briefing: number | null
  /** debugging_started_at -> completed_at (or now). Null before debugging begins. */
  debugging: number | null
  /** True once the session is completed (the reading no longer changes). */
  frozen: boolean
}

function wholeSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
}

/** m:ss under an hour, h:mm:ss from one hour up. Negative / non-finite values clamp to 0:00. */
export function formatDuration(ms: number): string {
  const total = wholeSeconds(ms)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const ss = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Screen-reader friendly form, e.g. "1 hour 2 minutes 5 seconds". */
export function describeDuration(ms: number): string {
  const total = wholeSeconds(ms)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (h > 0) parts.push(part(h, 'hour'))
  if (m > 0) parts.push(part(m, 'minute'))
  if (s > 0 || parts.length === 0) parts.push(part(s, 'second'))
  return parts.join(' ')
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

const span = (from: number | null, to: number): number | null => (from === null ? null : Math.max(0, to - from))

/**
 * Pure clock reading for a session at `nowMs`. Once completed, `completed_at` replaces `now`, so the
 * reading is frozen. Negative spans (client clock behind the server) clamp to 0.
 */
export function readClock(session: ClockSession, nowMs: number): ClockReading {
  const started = toMs(session.started_at)
  const debugging = toMs(session.debugging_started_at)
  const completed = toMs(session.completed_at)
  const end = completed ?? nowMs
  return {
    total: span(started, end),
    briefing: span(started, debugging ?? end),
    debugging: span(debugging, end),
    frozen: completed !== null,
  }
}

/** ms from debugging start to the earliest test run, or null when unknown. */
export function timeToFirstRun(session: Pick<Session, 'debugging_started_at'>, runCreatedAts: readonly string[]): number | null {
  const start = toMs(session.debugging_started_at)
  if (start === null) return null
  let first: number | null = null
  for (const iso of runCreatedAts) {
    const t = toMs(iso)
    if (t !== null && (first === null || t < first)) first = t
  }
  return first === null ? null : Math.max(0, first - start)
}

/** Total duration of a completed session, or null when it is not completed or never started. */
export function finalDuration(session: ClockSession): number | null {
  if (!session.completed_at) return null
  return readClock(session, 0).total
}
