import { useNow } from '../hooks/useNow'
import { describeDuration, formatDuration, readClock } from './clock'
import type { ClockSession } from './clock'
import './room.css'

export const WAITING_TEXT = 'Waiting for both people to join'

/**
 * Interview clock shared by both roles: total time since both people joined, plus the briefing / debugging
 * split. Ticks every second until the session is completed, then freezes at completed_at.
 */
export default function SessionClock({ session, className }: { session: ClockSession; className?: string }) {
  const waiting = !session.started_at
  const done = !!session.completed_at
  const now = useNow(1000, !waiting && !done)
  const r = readClock(session, now)
  const cls = `room-clock${className ? ` ${className}` : ''}`

  if (r.total === null) {
    return (
      <div className={cls} role="timer" aria-live="off" aria-label={WAITING_TEXT}>
        <span className="room-muted">{WAITING_TEXT}</span>
      </div>
    )
  }

  return (
    <div className={cls} role="timer" aria-live="off" aria-label={`Total interview time ${describeDuration(r.total)}${r.frozen ? ', final' : ''}`}>
      <span className="room-badge">
        Total <span className="room-mono">{formatDuration(r.total)}</span>
      </span>
      <span className="room-muted" aria-hidden="true">
        Briefing <span className="room-mono">{r.briefing !== null ? formatDuration(r.briefing) : '--'}</span>
      </span>
      <span className="room-muted" aria-hidden="true">
        Debugging <span className="room-mono">{r.debugging !== null ? formatDuration(r.debugging) : '--'}</span>
      </span>
    </div>
  )
}
