import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listPublicQuestions } from '../lib/api'
import type { Question } from '../types/db'
import { Card, ErrorMessage, Spinner } from '../components/ui'

function preview(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

export default function Home() {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const q = await listPublicQuestions()
        if (active) setQuestions(q)
      } catch (e) {
        if (active) setError((e as Error).message)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="stack-lg">
      <div className="stack">
        <h1>Practice realistic debugging interviews</h1>
        <p className="muted narrow-lg">
          An interviewer and an interviewee join the same live session. The interviewee debugs a small, broken
          codebase in the browser with an AI assistant while the interviewer watches, tracks bugs and writes a review.
          No account needed: pick a question, enter both emails, and each person gets a magic link.
        </p>
      </div>
      <section className="stack" aria-labelledby="questions-heading">
        <h2 id="questions-heading">Choose a question</h2>
        <ErrorMessage message={error} />
        {!questions && !error && <Spinner label="Loading questions" />}
        {questions?.length === 0 && (
          <Card>
            <p className="muted">No questions available yet.</p>
          </Card>
        )}
        {questions && questions.length > 0 && (
          <ul className="list">
            {questions.map((q) => (
              <li key={q.id}>
                <Link to={`/questions/${q.slug}`} className="card card-link stack">
                  <strong>{q.title}</strong>
                  <span className="muted small">{preview(q.prompt)}</span>
                  {q.constraints && <span className="small">Constraints: {preview(q.constraints, 120)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
