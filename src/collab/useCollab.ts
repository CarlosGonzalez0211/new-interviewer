import { useEffect, useReducer, useRef, useState } from 'react'
import type { SessionPhase } from '../types/db'
import { startCollabSession } from './collabSession'
import type { CollabHandle } from './collabSession'
import type { Collab, CollabUser } from './types'

/**
 * One shared Yjs doc (files + notes) per session id. Keyed by session id, NOT phase: the phase flipping from
 * briefing to debugging keeps the same doc. The returned `collab` object is stable; its `status`/`editable`
 * fields are mutated and this hook re-renders its host when they change.
 */
export function useCollab(
  session: { id: string; phase: SessionPhase },
  user: CollabUser,
): { collab: Collab | null; error: string | null } {
  const [result, setResult] = useState<{ collab: Collab | null; error: string | null }>({ collab: null, error: null })
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const handleRef = useRef<CollabHandle | null>(null)
  const phaseRef = useRef(session.phase)
  const userRef = useRef(user)

  useEffect(() => {
    phaseRef.current = session.phase
    handleRef.current?.setPhase(session.phase)
  }, [session.phase])

  useEffect(() => {
    userRef.current = user
    handleRef.current?.setUser(user)
  }, [user])

  useEffect(() => {
    let cancelled = false
    let handle: CollabHandle | null = null
    setResult({ collab: null, error: null })
    startCollabSession({
      sessionId: session.id,
      phase: phaseRef.current,
      user: userRef.current,
      onChange: () => {
        if (!cancelled) bump()
      },
    })
      .then((h) => {
        if (cancelled) {
          h.destroy()
          return
        }
        handle = h
        handleRef.current = h
        h.setPhase(phaseRef.current)
        setResult({ collab: h.collab, error: null })
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ collab: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
      if (handleRef.current === handle) handleRef.current = null
      handle?.destroy()
    }
    // user.id/session.id identify the connection; name/color changes go through setUser
  }, [session.id, user.id])

  return result
}
