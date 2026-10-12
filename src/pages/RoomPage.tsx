import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { claimSession, getSession } from '../lib/api'
import { supabase } from '../lib/supabase'
import type { Role, SessionWithQuestion } from '../types/db'
import { Button, ErrorMessage, Spinner } from '../components/ui'
import BriefingView from '../room/BriefingView'
import IntervieweeRoom from '../room/IntervieweeRoom'
import InterviewerRoom from '../room/InterviewerRoom'
import ReviewView from '../room/ReviewView'

export default function RoomPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const userId = user?.id
  const [session, setSession] = useState<SessionWithQuestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Initial load, claiming the reserved slot when the user is not yet a participant.
  useEffect(() => {
    if (!id || !userId) return
    let active = true
    ;(async () => {
      let s: SessionWithQuestion | null = null
      try {
        s = await getSession(id)
      } catch {
        s = null
      }
      const isParticipant = !!s && (s.interviewer_id === userId || s.interviewee_id === userId)
      if (!isParticipant) {
        await claimSession(id)
        s = await getSession(id)
      }
      if (active && s) setSession(s)
    })().catch((e: Error) => {
      if (active) setError(e.message)
    })
    return () => {
      active = false
    }
  }, [id, userId, attempt])

  const refetch = useCallback(async () => {
    if (!id) return
    try {
      const s = await getSession(id)
      if (mounted.current) setSession(s)
    } catch (e) {
      if (mounted.current) setError((e as Error).message)
    }
  }, [id])

  // Live phase changes.
  const joined = !!session
  useEffect(() => {
    if (!id || !joined) return
    const channel = supabase
      .channel(`room-sessions:${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${id}` },
        () => {
          void refetch()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [id, joined, refetch])

  if (error && !session) {
    return (
      <div className="stack narrow-lg">
        <h1>Cannot open this session</h1>
        <ErrorMessage message={error} />
        <p className="muted">Make sure you are signed in with the email address the invitation was sent to.</p>
        <div className="row">
          <Button variant="secondary" onClick={() => {
              setError(null)
              setAttempt((n) => n + 1)
            }}>
            Try again
          </Button>
          <Link to="/" className="btn btn-ghost">
            Dashboard
          </Link>
        </div>
      </div>
    )
  }
  if (!session || session.id !== id || !userId) return <Spinner label="Joining session" />

  const role: Role = session.interviewer_id === userId ? 'interviewer' : 'interviewee'
  const { question, ...sessionRow } = session

  switch (session.phase) {
    case 'briefing':
      return <BriefingView session={sessionRow} question={question} role={role} />
    case 'debugging':
      return role === 'interviewee' ? (
        <IntervieweeRoom session={sessionRow} userId={userId} />
      ) : (
        <InterviewerRoom session={sessionRow} userId={userId} />
      )
    case 'completed':
      return <ReviewView session={sessionRow} question={question} role={role} />
    default:
      return <ErrorMessage message={`Unknown session phase: ${String(session.phase)}`} />
  }
}
