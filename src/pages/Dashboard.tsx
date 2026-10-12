import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { listMySessions } from '../lib/api'
import type { SessionWithQuestion } from '../types/db'
import { Badge, Card, ErrorMessage, Spinner } from '../components/ui'
import type { BadgeTone } from '../components/ui/Badge'

const PHASE_TONE: Record<string, BadgeTone> = { briefing: 'amber', debugging: 'blue', completed: 'green' }

export default function Dashboard() {
  const { user } = useAuth()
  const [sessions, setSessions] = useState<SessionWithQuestion[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listMySessions()
      .then((s) => {
        if (active) setSessions(s)
      })
      .catch((e: Error) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [])

  const myEmail = user?.email?.toLowerCase()

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Your interviews</h1>
          <p className="muted">Sessions you created or were invited to.</p>
        </div>
        <Link to="/" className="btn btn-primary">
          Start a new interview
        </Link>
      </div>
      <ErrorMessage message={error} />
      {!sessions && !error && <Spinner label="Loading sessions" />}
      {sessions && sessions.length === 0 && (
        <Card>
          <p>No interviews yet. Pick a question on the home page and enter two emails to start one.</p>
        </Card>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="list">
          {sessions.map((s) => {
            const isInterviewer = s.interviewer_id ? s.interviewer_id === user?.id : s.interviewer_email === myEmail
            const role = isInterviewer ? 'interviewer' : 'interviewee'
            const other = isInterviewer ? s.interviewee_email : s.interviewer_email
            return (
              <li key={s.id}>
                <Link to={`/session/${s.id}`} className="card card-link row">
                  <div className="grow">
                    <strong>{s.question?.title ?? 'Question'}</strong>
                    <div className="muted small">
                      With {other || 'unknown'} · {new Date(s.created_at).toLocaleString()}
                    </div>
                  </div>
                  <Badge tone={isInterviewer ? 'purple' : 'neutral'}>{role}</Badge>
                  <Badge tone={PHASE_TONE[s.phase] ?? 'neutral'}>{s.phase}</Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
