import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { createSession, listQuestions, sendMagicLink, sessionLink } from '../lib/api'
import type { Question, Role } from '../types/db'
import { Button, Card, ErrorMessage, Spinner } from '../components/ui'

const EMAIL_RE = /^\S+@\S+\.\S+$/

export default function NewSession() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [questionId, setQuestionId] = useState('')
  const [myRole, setMyRole] = useState<Role>('interviewee')
  const [otherEmail, setOtherEmail] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ id: string; mailError: string | null } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    listQuestions()
      .then((q) => {
        if (active) setQuestions(q)
      })
      .catch((e: Error) => {
        if (active) setLoadError(e.message)
      })
    return () => {
      active = false
    }
  }, [])

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {}
    const email = otherEmail.trim().toLowerCase()
    if (!questionId) errs.question = 'Pick a question.'
    if (!email) errs.email = 'Enter the other person’s email.'
    else if (!EMAIL_RE.test(email)) errs.email = 'Enter a valid email address.'
    else if (email === user?.email?.toLowerCase()) errs.email = 'Invite someone other than yourself.'
    return errs
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    setSubmitError(null)
    if (Object.keys(errs).length > 0) return
    setBusy(true)
    let id: string
    try {
      const session = await createSession({ questionId, myRole, otherEmail })
      id = session.id
    } catch (err) {
      setSubmitError((err as Error).message)
      setBusy(false)
      return
    }
    // The session now exists; a mail failure must not lose it.
    let mailError: string | null = null
    try {
      await sendMagicLink(otherEmail, id)
    } catch (err) {
      mailError = (err as Error).message
    }
    setBusy(false)
    setCreated({ id, mailError })
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (created) {
    const link = sessionLink(created.id)
    return (
      <Card className="narrow-lg stack">
        <h1>{created.mailError ? 'Session created, email not sent' : 'Invite sent'}</h1>
        {created.mailError ? (
          <ErrorMessage
            message={`The session exists, but the sign-in email to ${otherEmail.trim()} could not be sent: ${created.mailError}. Share the direct link below instead. They must sign in with that same email.`}
          />
        ) : (
          <p role="status">
            {otherEmail.trim()} received an email with a sign-in link that opens this session. You can also share the
            direct link.
          </p>
        )}
        <label className="field">
          <span>Direct link</span>
          <div className="row">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="grow" />
            <Button variant="secondary" onClick={() => void copy(link)}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </label>
        <div className="row">
          <Button onClick={() => navigate(`/session/${created.id}`)}>Open session</Button>
          <Button variant="ghost" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <form className="stack-lg narrow-lg" onSubmit={onSubmit} noValidate>
      <div>
        <h1>New interview</h1>
        <p className="muted">Pick a question, choose your role, and invite the other person by email.</p>
      </div>

      <fieldset className="stack">
        <legend>Question</legend>
        <ErrorMessage message={loadError} />
        {!questions && !loadError && <Spinner label="Loading questions" />}
        {questions?.length === 0 && <p className="muted">No questions available. Run the seed migration.</p>}
        <div className="stack">
          {questions?.map((q) => (
            <label key={q.id} className={`choice ${questionId === q.id ? 'selected' : ''}`}>
              <input
                type="radio"
                name="question"
                value={q.id}
                checked={questionId === q.id}
                onChange={() => setQuestionId(q.id)}
              />
              <span>
                <strong>{q.title}</strong>
                <span className="muted small block">
                  {q.prompt.length > 180 ? `${q.prompt.slice(0, 180).trimEnd()}…` : q.prompt}
                </span>
              </span>
            </label>
          ))}
        </div>
        <ErrorMessage message={errors.question} />
      </fieldset>

      <fieldset className="stack">
        <legend>Your role</legend>
        <div className="row">
          {(['interviewee', 'interviewer'] as Role[]).map((r) => (
            <label key={r} className={`choice ${myRole === r ? 'selected' : ''}`}>
              <input type="radio" name="role" value={r} checked={myRole === r} onChange={() => setMyRole(r)} />
              <span>
                <strong>{r === 'interviewer' ? 'Interviewer' : 'Interviewee'}</strong>
                <span className="muted small block">
                  {r === 'interviewer' ? 'Watch, guide and review.' : 'Debug the code.'}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span>{myRole === 'interviewer' ? 'Interviewee email' : 'Interviewer email'}</span>
        <input
          type="email"
          value={otherEmail}
          onChange={(e) => setOtherEmail(e.target.value)}
          placeholder="friend@example.com"
          aria-invalid={!!errors.email}
        />
        <ErrorMessage message={errors.email} />
      </label>

      <ErrorMessage message={submitError} />
      <div className="row">
        <Button type="submit" loading={busy}>
          Create and send invite
        </Button>
        <Button variant="ghost" onClick={() => navigate('/')}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
