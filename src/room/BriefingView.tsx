import { useEffect, useMemo, useState } from 'react'
import { useCollab } from '../collab'
import { setPhase } from '../lib/api'
import type { Question, QuestionPrivate, Role, Session } from '../types/db'
import { collabUserFor } from '../workspace/logic'
import StatusBadge from '../workspace/StatusBadge'
import WorkspaceTabs from '../workspace/WorkspaceTabs'
import { RichText } from './RichText'
import { getQuestionPrivate } from './roomApi'
import './room.css'

export default function BriefingView({ session, question, role }: { session: Session; question: Question; role: Role }) {
  const [priv, setPriv] = useState<QuestionPrivate | null>(null)
  const [privError, setPrivError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const email = role === 'interviewer' ? session.interviewer_email : session.interviewee_email
  const userId = (role === 'interviewer' ? session.interviewer_id : session.interviewee_id) ?? role
  const user = useMemo(() => collabUserFor({ userId, role, email }), [userId, role, email])
  const collabSession = useMemo(() => ({ id: session.id, phase: session.phase }), [session.id, session.phase])
  const { collab, error: collabError } = useCollab(collabSession, user)

  useEffect(() => {
    if (role !== 'interviewer') return
    let cancelled = false
    setPrivError(null)
    getQuestionPrivate(question.id)
      .then((p) => {
        if (!cancelled) setPriv(p)
      })
      .catch((e: unknown) => {
        if (!cancelled) setPrivError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [role, question.id])

  const reveal = async () => {
    if (!window.confirm('Reveal the code to the interviewee and start the debugging phase? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      await collab?.flush().catch(() => undefined)
      await setPhase(session.id, 'debugging')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the debugging phase')
      setBusy(false)
    }
  }

  return (
    <div className="room room-wide" aria-label="Briefing">
      <header>
        <h1 style={{ fontSize: 24 }}>{question.title}</h1>
        <p className="room-muted">Briefing &middot; {question.language}</p>
      </header>

      <div className="brief-grid">
        <div className="room-col brief-info">
          <section className="room-card" aria-labelledby="brief-prompt">
            <h2 id="brief-prompt">Problem</h2>
            <RichText text={question.prompt} />
          </section>

          {question.constraints.trim() !== '' && (
            <section className="room-card" aria-labelledby="brief-constraints">
              <h2 id="brief-constraints">Constraints</h2>
              <RichText text={question.constraints} />
            </section>
          )}

          {role === 'interviewee' && (
            <section className="room-card" role="status" aria-live="polite">
              <h2>Waiting for the interviewer</h2>
              <p>Explain your approach to the interviewer. Use the notes and whiteboard to sketch your plan; code will appear when they start.</p>
            </section>
          )}

          {role === 'interviewer' && (
            <>
              {privError && (
                <p className="room-error" role="alert">
                  {privError}
                </p>
              )}
              <section className="room-card" aria-labelledby="brief-checklist">
                <h2 id="brief-checklist">What to look for (private)</h2>
                {priv && priv.checklist.length > 0 ? (
                  <ul className="room-list">
                    {priv.checklist.map((item, i) => (
                      <li key={i}>
                        <span aria-hidden="true">&bull;</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="room-muted">{priv ? 'No checklist for this question.' : 'Loading…'}</p>
                )}
              </section>
              <section className="room-card" aria-labelledby="brief-followups">
                <h2 id="brief-followups">Suggested follow-up questions (private)</h2>
                {priv && priv.followups.length > 0 ? (
                  <ol style={{ margin: 0, paddingLeft: 22 }}>
                    {priv.followups.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="room-muted">{priv ? 'No follow-ups for this question.' : 'Loading…'}</p>
                )}
              </section>
              <div>
                <button type="button" className="room-btn primary" onClick={() => void reveal()} disabled={busy} style={{ padding: '10px 18px', fontSize: 15 }}>
                  {busy ? 'Starting…' : 'Reveal code & start debugging'}
                </button>
                {error && (
                  <p className="room-error" role="alert" style={{ marginTop: 8 }}>
                    {error}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <section className="room-card brief-workspace" aria-labelledby="brief-workspace">
          <h2 id="brief-workspace">
            Shared workspace <StatusBadge status={collab?.status ?? 'loading'} />
          </h2>
          <WorkspaceTabs collab={collab} session={collabSession} user={user} error={collabError} />
        </section>
      </div>
    </div>
  )
}
