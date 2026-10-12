import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { safeNext } from '../auth/safeNext'
import { supabase } from '../lib/supabase'
import { Button, Card, ErrorMessage, Spinner } from '../components/ui'

export default function Login() {
  const { user, loading } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    )
  }
  if (user) return <Navigate to={next} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      setError('Enter a valid email address.')
      return
    }
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: `${window.location.origin}${next}` },
    })
    setBusy(false)
    if (err) {
      setError(
        /rate limit/i.test(err.message)
          ? 'Too many sign-in emails were sent recently. Wait a few minutes and try again.'
          : err.message,
      )
      return
    }
    setSent(true)
  }

  return (
    <div className="center-screen">
      <Card className="narrow">
        <h1>Interview Lab</h1>
        {sent ? (
          <div className="stack" role="status">
            <h2>Check your inbox</h2>
            <p>
              We sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to continue.
            </p>
            <Button variant="secondary" onClick={() => setSent(false)}>
              Use a different email
            </Button>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit} noValidate>
            <p className="muted">Sign in with a magic link. No password needed.</p>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
              />
            </label>
            <ErrorMessage message={error} />
            <Button type="submit" loading={busy}>
              Send magic link
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
