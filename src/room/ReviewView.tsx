import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useRealtimeTable } from '../hooks/useRealtimeTable'
import type { AiMessage, BugStatus, Question, QuestionBug, QuestionPrivate, Role, Session, SessionNote, SessionReview, TestRun } from '../types/db'
import { MessageBubble } from './ChatPanel'
import { sortByCreatedAt } from './listUtils'
import {
  getQuestionPrivate,
  getReview,
  listAiMessages,
  listBugStatus,
  listNotes,
  listQuestionBugs,
  listTestRuns,
  upsertReview,
} from './roomApi'
import { formatClock, formatElapsed, elapsedSince } from './time'
import { buildTimeline, countAiPrompts, weightedRubricScore } from './timeline'
import './room.css'

const reviewKey = (r: Partial<SessionReview>) => r.session_id
const runKey = (r: Partial<TestRun>) => r.id
const msgKey = (r: Partial<AiMessage>) => r.id
const bugStatusKey = (r: Partial<BugStatus>) => r.bug_id
const noteKey = (r: Partial<SessionNote>) => r.id

const SCORES = [1, 2, 3, 4, 5]

function ScoreSelect({ id, label, value, onChange }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="room-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="room-input" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">Not scored</option>
        {SCORES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  )
}

function ReviewForm({ sessionId, rubric, review }: { sessionId: string; rubric: QuestionPrivate['rubric']; review: SessionReview | null }) {
  const [score, setScore] = useState<number | null>(review?.score ?? null)
  const [summary, setSummary] = useState(review?.summary ?? '')
  const [rubricScores, setRubricScores] = useState<Record<string, number>>(review?.rubric_scores ?? {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(review?.updated_at ?? null)

  const weighted = useMemo(() => weightedRubricScore(rubric, rubricScores), [rubric, rubricScores])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const saved = await upsertReview(sessionId, { score, summary, rubric_scores: rubricScores })
      setSavedAt(saved.updated_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the review')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="room-card" onSubmit={(e) => void submit(e)} aria-labelledby="review-form-title">
      <h2 id="review-form-title">Your review</h2>
      <ScoreSelect id="review-score" label="Overall score (1-5)" value={score} onChange={setScore} />
      {rubric.length > 0 && (
        <fieldset style={{ border: '1px solid var(--rm-border)', borderRadius: 8, padding: 10 }}>
          <legend>Rubric</legend>
          <div className="room-col">
            {rubric.map((item) => (
              <ScoreSelect
                key={item.id}
                id={`rubric-${item.id}`}
                label={`${item.label} (weight ${item.weight})`}
                value={rubricScores[item.id] ?? null}
                onChange={(v) =>
                  setRubricScores((prev) => {
                    const next = { ...prev }
                    if (v === null) delete next[item.id]
                    else next[item.id] = v
                    return next
                  })
                }
              />
            ))}
          </div>
          {weighted !== null && <p className="room-muted">Weighted rubric average: {weighted}</p>}
        </fieldset>
      )}
      <div className="room-field">
        <label htmlFor="review-summary">Summary and feedback</label>
        <textarea id="review-summary" className="room-input" rows={6} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="submit" className="room-btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save review'}
        </button>
        {savedAt && !busy && <span className="room-muted">Saved {formatClock(savedAt)}</span>}
      </div>
      {error && (
        <p className="room-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export default function ReviewView({ session, question, role }: { session: Session; question: Question; role: Role }) {
  const sessionId = session.id
  const isInterviewer = role === 'interviewer'

  const loadRuns = useCallback(() => listTestRuns(sessionId), [sessionId])
  const runs = useRealtimeTable<TestRun>({ table: 'test_runs', sessionId, load: loadRuns, keyOf: runKey, sort: sortByCreatedAt })
  const loadAi = useCallback(() => listAiMessages(sessionId), [sessionId])
  const ai = useRealtimeTable<AiMessage>({ table: 'ai_messages', sessionId, load: loadAi, keyOf: msgKey, sort: sortByCreatedAt })
  const loadReview = useCallback(async () => {
    const r = await getReview(sessionId)
    return r ? [r] : []
  }, [sessionId])
  const reviews = useRealtimeTable<SessionReview>({ table: 'session_reviews', sessionId, load: loadReview, keyOf: reviewKey })

  // Interviewer-only tables: the interviewee's queries would be rejected by RLS, so never issue them.
  const loadBugStatus = useCallback(() => (isInterviewer ? listBugStatus(sessionId) : Promise.resolve<BugStatus[]>([])), [isInterviewer, sessionId])
  const bugStatus = useRealtimeTable<BugStatus>({ table: 'bug_status', sessionId, load: loadBugStatus, keyOf: bugStatusKey })
  const loadNotes = useCallback(() => (isInterviewer ? listNotes(sessionId) : Promise.resolve<SessionNote[]>([])), [isInterviewer, sessionId])
  const notes = useRealtimeTable<SessionNote>({ table: 'session_notes', sessionId, load: loadNotes, keyOf: noteKey, sort: sortByCreatedAt })

  const [bugs, setBugs] = useState<QuestionBug[]>([])
  const [priv, setPriv] = useState<QuestionPrivate | null>(null)
  const [staticError, setStaticError] = useState<string | null>(null)
  useEffect(() => {
    if (!isInterviewer) return
    let cancelled = false
    Promise.all([listQuestionBugs(question.id), getQuestionPrivate(question.id)])
      .then(([b, p]) => {
        if (cancelled) return
        setBugs(b)
        setPriv(p)
      })
      .catch((e: unknown) => {
        if (!cancelled) setStaticError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [isInterviewer, question.id])

  const review = reviews.items[0] ?? null
  const bugTitles = useMemo(() => Object.fromEntries(bugs.map((b) => [b.id, b.title])), [bugs])
  const timeline = useMemo(
    () =>
      buildTimeline({
        testRuns: runs.items,
        aiMessages: ai.items,
        bugStatuses: isInterviewer ? bugStatus.items : [],
        bugTitles,
        notes: isInterviewer ? notes.items : [],
      }),
    [runs.items, ai.items, bugStatus.items, bugTitles, notes.items, isInterviewer],
  )

  const total = session.completed_at ? elapsedSince(session.debugging_started_at, session.completed_at) : null
  const lastRun = runs.items.length > 0 ? runs.items[runs.items.length - 1] : null
  const lastSummary = lastRun ? `${lastRun.passed}/${lastRun.passed + lastRun.failed + lastRun.errored} passed` : 'No runs'
  const bugFound = bugStatus.items.length
  const bugFixed = bugStatus.items.filter((b) => b.state === 'fixed').length
  const hasPublishedReview = review !== null && (review.score !== null || review.summary.trim() !== '')

  return (
    <div className="room room-narrow" aria-label="Review">
      <header>
        <h1 style={{ fontSize: 24 }}>Review: {question.title}</h1>
        <p className="room-muted">Interview completed{session.completed_at ? ` ${new Date(session.completed_at).toLocaleString()}` : ''}</p>
      </header>

      <div className="room-stats">
        <div className="room-stat">
          <strong>{total !== null ? formatElapsed(total) : '--:--'}</strong>
          <span className="room-muted">Debugging time</span>
        </div>
        <div className="room-stat">
          <strong>{runs.items.length}</strong>
          <span className="room-muted">Test runs ({lastSummary})</span>
        </div>
        <div className="room-stat">
          <strong>{countAiPrompts(ai.items)}</strong>
          <span className="room-muted">AI prompts</span>
        </div>
        {isInterviewer && (
          <div className="room-stat">
            <strong>
              {bugFixed}/{bugs.length || bugFound}
            </strong>
            <span className="room-muted">Bugs fixed ({bugFound} found)</span>
          </div>
        )}
      </div>

      {(runs.error || ai.error || staticError) && (
        <p className="room-error" role="alert">
          {runs.error ?? ai.error ?? staticError}
        </p>
      )}

      {isInterviewer ? (
        <ReviewForm key={review?.updated_at ?? 'new'} sessionId={sessionId} rubric={priv?.rubric ?? []} review={review} />
      ) : (
        <section className="room-card" aria-labelledby="final-review">
          <h2 id="final-review">Interviewer&apos;s review</h2>
          {hasPublishedReview ? (
            <>
              {review.score !== null && (
                <p>
                  Overall score: <strong>{review.score}/5</strong>
                </p>
              )}
              {review.summary.trim() !== '' && <p style={{ whiteSpace: 'pre-wrap' }}>{review.summary}</p>}
            </>
          ) : (
            <p className="room-muted" role="status">
              The interviewer has not published a review yet. This page updates automatically.
            </p>
          )}
        </section>
      )}

      {isInterviewer && bugs.length > 0 && (
        <section className="room-card" aria-labelledby="bug-outcome">
          <h2 id="bug-outcome">Bug outcome</h2>
          <ul className="room-list">
            {bugs.map((b) => {
              const st = bugStatus.items.find((s) => s.bug_id === b.id)?.state
              return (
                <li key={b.id}>
                  <span className={`room-badge`}>{st ?? 'missed'}</span>
                  <span>{b.title}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="room-card" aria-labelledby="timeline">
        <h2 id="timeline">Timeline</h2>
        {timeline.length === 0 ? (
          <p className="room-muted">Nothing recorded.</p>
        ) : (
          <ul className="room-timeline">
            {timeline.map((t, i) => {
              const rel = elapsedSince(session.debugging_started_at, t.at)
              return (
                <li key={i}>
                  <time dateTime={t.at}>{rel !== null ? `+${formatElapsed(rel)}` : formatClock(t.at)}</time>
                  <span>
                    {t.kind === 'test_run' && <span className={`room-dot ${t.passing ? 'ok' : 'bad'}`} aria-hidden="true" />} {t.label}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {isInterviewer && (
        <details className="room-card">
          <summary>AI transcript ({ai.items.length} messages)</summary>
          <div className="room-chat-list">
            {ai.items.map((m) => (
              <MessageBubble key={m.id} role={m.role} content={m.content} at={m.created_at} />
            ))}
            {ai.items.length === 0 && <p className="room-muted">No AI conversation.</p>}
          </div>
        </details>
      )}

      <p>
        <Link to="/">Back to dashboard</Link>
      </p>
    </div>
  )
}
