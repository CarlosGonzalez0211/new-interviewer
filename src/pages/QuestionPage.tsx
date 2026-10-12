import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { createInterview, getQuestionBySlug, sessionLink, type CreateInterviewResult } from '../lib/api'
import type { Question } from '../types/db'
import { Button, Card, ErrorMessage, Spinner } from '../components/ui'

const EMAIL_RE = /^\S+@\S+\.\S+$/

export default function QuestionPage() {
  const { slug = '' } = useParams()
  const [question, setQuestion] = useState<Question | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [interviewerEmail, setInterviewerEmail] = useState('')
  const [intervieweeEmail, setIntervieweeEmail] = useState('')
  const [errors, setErrors] = useState<{ interviewer?: string; interviewee?: string }>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CreateInterviewResult | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    setQuestion(undefined)
    setLoadError(null)
    getQuestionBySlug(slug)
      .then((q) => {
        if (active) setQuestion(q)
      })
      .catch((e: Error) => {
        if (active) setLoadError(e.message)
      })
    return () => {
      active = false
    }
  }, [slug])

  function validate() {
    const errs: { interviewer?: string; interviewee?: string } = {}
    const a = interviewerEmail.trim().toLowerCase()
    const b = intervieweeEmail.trim().toLowerCase()
    if (!a) errs.interviewer = 'Enter the interviewer’s email.'
    else if (!EMAIL_RE.test(a)) errs.interviewer = 'Enter a valid email address.'
    if (!b) errs.interviewee = 'Enter the interviewee’s email.'
    else if (!EMAIL_RE.test(b)) errs.interviewee = 'Enter a valid email address.'
    else if (a && a === b) errs.interviewee = 'The two emails must be different.'
    return errs
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!question) return
    const errs = validate()
    setErrors(errs)
    setSubmitError(null)
    if (errs.interviewer || errs.interviewee) return
    setBusy(true)
    try {
      setResult(await createInterview({ questionId: question.id, interviewerEmail, intervieweeEmail }))
    } catch (err) {
      setSubmitError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (loadError) return <ErrorMessage message={loadError} />
  if (question === undefined) return <Spinner label="Loading question" />
  if (question === null) {
    return (
      <Card className="narrow-lg stack">
        <h1>Question not found</h1>
        <Link to="/" className="btn btn-secondary">
          Back to questions
        </Link>
      </Card>
    )
  }

  if (result) {
    const link = sessionLink(result.session_id)
    const rows: { label: string; email: string; ok: boolean }[] = [
      { label: 'Interviewer', email: interviewerEmail.trim(), ok: result.sent.interviewer },
      { label: 'Interviewee', email: intervieweeEmail.trim(), ok: result.sent.interviewee },
    ]
    const allSent = rows.every((r) => r.ok)
    return (
      <Card className="narrow-lg stack">
        <h1>{allSent ? 'Magic links sent to both people' : 'Interview created'}</h1>
        {!allSent && (
          <ErrorMessage message="At least one email could not be sent. Share the direct link below with that person instead." />
        )}
        <ul className="list" aria-label="Email status">
          {rows.map((r) => (
            <li key={r.label} className="row">
              <span className="grow">
                {r.label}: <strong>{r.email}</strong>
              </span>
              <span className={`badge ${r.ok ? 'badge-green' : 'badge-amber'}`}>{r.ok ? 'sent' : 'not sent'}</span>
            </li>
          ))}
        </ul>
        <p role="status">
          Each person opens their own link and signs in with that same email. The interview opens for them after
          sign-in.
        </p>
        <label className="field">
          <span>Direct session link</span>
          <div className="row">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="grow" />
            <Button variant="secondary" onClick={() => void copy(link)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </label>
        <Link to="/" className="btn btn-ghost">
          Back to questions
        </Link>
      </Card>
    )
  }

  return (
    <div className="stack-lg narrow-lg">
      <div className="stack">
        <Link to="/" className="muted small">
          ← All questions
        </Link>
        <h1>{question.title}</h1>
        <p style={{ whiteSpace: 'pre-wrap' }}>{question.prompt}</p>
        {question.constraints && (
          <div className="stack">
            <h2>Constraints</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{question.constraints}</p>
          </div>
        )}
      </div>

      <form className="stack" onSubmit={onSubmit} noValidate aria-label="Start an interview">
        <h2>Start an interview</h2>
        <label className="field">
          <span>Interviewer email</span>
          <input
            type="email"
            autoComplete="email"
            value={interviewerEmail}
            onChange={(e) => setInterviewerEmail(e.target.value)}
            placeholder="interviewer@example.com"
            aria-invalid={!!errors.interviewer}
          />
          <ErrorMessage message={errors.interviewer} />
        </label>
        <label className="field">
          <span>Interviewee email</span>
          <input
            type="email"
            autoComplete="off"
            value={intervieweeEmail}
            onChange={(e) => setIntervieweeEmail(e.target.value)}
            placeholder="interviewee@example.com"
            aria-invalid={!!errors.interviewee}
          />
          <ErrorMessage message={errors.interviewee} />
        </label>
        <ErrorMessage message={submitError} />
        <div>
          <Button type="submit" loading={busy}>
            Send magic links
          </Button>
        </div>
      </form>
    </div>
  )
}
