import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { BugState, BugStatus, QuestionBug, QuestionPrivate, SessionNote } from '../types/db'
import { elapsedSince, formatClock, formatElapsed } from './time'
import './room.css'

function storageKey(sessionId: string) {
  return `interview-checklist:${sessionId}`
}

function readChecked(sessionId: string): Record<number, boolean> {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<number, boolean>) : {}
  } catch {
    return {}
  }
}

export function Checklist({ sessionId, items }: { sessionId: string; items: string[] }) {
  const [checked, setChecked] = useState<Record<number, boolean>>(() => readChecked(sessionId))
  useEffect(() => {
    setChecked(readChecked(sessionId))
  }, [sessionId])

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = { ...prev, [i]: !prev[i] }
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(next))
      } catch {
        // storage unavailable: state still works in memory
      }
      return next
    })
  }

  if (items.length === 0) return <p className="room-muted">No checklist for this question.</p>
  return (
    <ul className="room-list">
      {items.map((item, i) => (
        <li key={i}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!checked[i]} onChange={() => toggle(i)} />
            <span>{item}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

export function BugList({
  bugs,
  statuses,
  onSet,
  error,
}: {
  bugs: QuestionBug[]
  statuses: BugStatus[]
  onSet: (bugId: string, state: BugState | null) => void
  error: string | null
}) {
  const stateOf = (id: string): BugState | null => statuses.find((s) => s.bug_id === id)?.state ?? null
  if (bugs.length === 0) return <p className="room-muted">No bugs listed for this question.</p>
  return (
    <div className="room-col" style={{ gap: 8 }}>
      {error && (
        <p className="room-error" role="alert">
          {error}
        </p>
      )}
      {bugs.map((bug) => {
        const state = stateOf(bug.id)
        return (
          <div className="room-bug" key={bug.id}>
            <strong>{bug.title}</strong>
            <span className="room-muted room-mono">{bug.file_path}</span>
            <details>
              <summary className="room-muted">Details and hint</summary>
              <p>{bug.description}</p>
              {bug.hint && <p className="room-muted">Hint: {bug.hint}</p>}
            </details>
            <div className="room-bug-toggles">
              <label>
                <input type="checkbox" checked={state !== null} onChange={() => onSet(bug.id, state === null ? 'found' : null)} />
                Found
              </label>
              <label>
                <input type="checkbox" checked={state === 'fixed'} onChange={() => onSet(bug.id, state === 'fixed' ? 'found' : 'fixed')} />
                Fixed
              </label>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function Notes({
  notes,
  startedAt,
  onAdd,
}: {
  notes: SessionNote[]
  startedAt: string | null
  onAdd: (body: string) => Promise<void>
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(text)
      setBody('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="room-col" style={{ gap: 8 }}>
      <form onSubmit={(e) => void submit(e)} className="room-field">
        <label htmlFor="note-body" className="room-muted">
          Add a timestamped note
        </label>
        <textarea id="note-body" className="room-input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
        <button type="submit" className="room-btn" disabled={busy || body.trim() === ''}>
          Add note
        </button>
        {error && (
          <p className="room-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <ul className="room-timeline" aria-label="Notes">
        {notes
          .slice()
          .reverse()
          .map((n) => {
            const rel = elapsedSince(startedAt, n.created_at)
            return (
              <li key={n.id}>
                <time dateTime={n.created_at}>{rel !== null ? `+${formatElapsed(rel)}` : formatClock(n.created_at)}</time>
                <span style={{ whiteSpace: 'pre-wrap' }}>{n.body}</span>
              </li>
            )
          })}
        {notes.length === 0 && <li className="room-muted">No notes yet.</li>}
      </ul>
    </div>
  )
}

export function Followups({ priv }: { priv: QuestionPrivate | null }) {
  if (!priv || priv.followups.length === 0) return <p className="room-muted">No suggested follow-ups.</p>
  return (
    <ul className="room-list">
      {priv.followups.map((f, i) => (
        <li key={i}>
          <span aria-hidden="true">&bull;</span>
          <span>{f}</span>
        </li>
      ))}
    </ul>
  )
}
