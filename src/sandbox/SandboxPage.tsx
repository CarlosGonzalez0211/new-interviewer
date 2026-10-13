import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { User } from '@supabase/supabase-js'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/context'
import { resetSupabaseBackend, setSupabaseBackend } from '../lib/supabase'
import RoomPage from '../pages/RoomPage'
import type { Question, SessionPhase } from '../types/db'
import { SANDBOX_INTERVIEWEE, SANDBOX_INTERVIEWER } from './identity'
import type { SandboxUser } from './identity'
import { clearSessionStorage, createSandboxRuntime } from './runtime'
import type { SandboxRuntime } from './runtime'
import AiSettingsPanel from './AiSettingsPanel'
import './sandbox.css'

type View = 'both' | 'interviewer' | 'interviewee'

const PHASES: { id: SessionPhase; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'debugging', label: 'Debugging' },
  { id: 'completed', label: 'Completed' },
]

let resetTimer: ReturnType<typeof setTimeout> | undefined
let runtimeSingleton: SandboxRuntime | null = null
/** One in-memory backend per page load; leaving and re-entering /sandbox keeps the session, a reload wipes it. */
function getRuntime(): SandboxRuntime {
  runtimeSingleton ??= createSandboxRuntime()
  return runtimeSingleton
}

function authFor(u: SandboxUser): AuthState {
  const user = {
    id: u.id,
    email: u.email,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: { name: u.name },
    created_at: '2026-01-01T00:00:00.000Z',
  } as User
  return { session: null, user, loading: false, signOut: async () => undefined }
}

function Pane({ user, sessionId, label }: { user: SandboxUser; sessionId: string; label: string }) {
  const auth = useMemo(() => authFor(user), [user])
  return (
    <section className="sb-pane" aria-label={`${label} pane`} data-testid={`pane-${label.toLowerCase()}`}>
      <header className="sb-pane-head">
        <strong>{label}</strong>
        <span className="muted small">{user.email}</span>
      </header>
      <div className="sb-pane-body">
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[`/session/${sessionId}`]}>
            <Routes>
              <Route path="/session/:id" element={<RoomPage />} />
              <Route path="*" element={<p className="muted">This sandbox pane only shows the session room.</p>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </div>
    </section>
  )
}

function useSessionPhase(runtime: SandboxRuntime, sessionId: string): SessionPhase {
  const subscribe = useCallback(
    (notify: () => void) =>
      runtime.fake.db.onChange((c) => {
        if (c.table === 'sessions') notify()
      }),
    [runtime],
  )
  const read = useCallback(
    () => (runtime.fake.db.find('sessions', { id: sessionId })?.phase as SessionPhase | undefined) ?? 'briefing',
    [runtime, sessionId],
  )
  return useSyncExternalStore(subscribe, read)
}

function SandboxInner({ runtime }: { runtime: SandboxRuntime }) {
  const [questions] = useState<Question[]>(() => runtime.questions())
  const [questionId, setQuestionId] = useState<string>(() => questions[0]?.id ?? '')
  const [view, setView] = useState<View>('both')
  const [epoch, setEpoch] = useState(0)
  const [sessionId, setSessionId] = useState<string>(() => runtime.createSession(questions[0]?.id ?? '').id)
  const [error, setError] = useState<string | null>(null)
  const phase = useSessionPhase(runtime, sessionId)

  const startSession = useCallback(
    (qid: string, wipe: boolean) => {
      clearSessionStorage(sessionId)
      if (wipe) runtime.reset()
      setSessionId(runtime.createSession(qid).id)
      setEpoch((n) => n + 1)
      setError(null)
    },
    [runtime, sessionId],
  )

  const jump = (target: SessionPhase) => {
    runtime.jumpTo(sessionId, target).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const phaseIndex = PHASES.findIndex((p) => p.id === phase)

  return (
    <div className="sb-root">
      <div className="sb-banner" role="status">
        Sandbox — nothing is saved to the server
      </div>
      <div className="sb-bar">
        <label className="sb-field">
          <span>Question</span>
          <select
            value={questionId}
            onChange={(e) => {
              setQuestionId(e.target.value)
              startSession(e.target.value, true)
            }}
          >
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title}
              </option>
            ))}
          </select>
        </label>

        <ol className="sb-steps" aria-label="Interview phase">
          {PHASES.map((p, i) => (
            <li key={p.id} className={i === phaseIndex ? 'current' : i < phaseIndex ? 'done' : ''} aria-current={i === phaseIndex ? 'step' : undefined}>
              {i + 1}. {p.label}
            </li>
          ))}
        </ol>

        <div className="sb-actions">
          <button type="button" className="sb-btn" disabled={phase !== 'briefing'} onClick={() => jump('debugging')}>
            Jump to debugging
          </button>
          <button type="button" className="sb-btn" disabled={phase === 'completed'} onClick={() => jump('completed')}>
            Jump to completed
          </button>
          <button type="button" className="sb-btn primary" onClick={() => startSession(questionId, true)}>
            New sandbox session
          </button>
        </div>

        <div className="sb-seg" role="group" aria-label="Layout">
          {(['both', 'interviewer', 'interviewee'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'both' ? 'Side by side' : v === 'interviewer' ? 'Interviewer' : 'Interviewee'}
            </button>
          ))}
        </div>

        <AiSettingsPanel />
      </div>
      {error && (
        <p className="sb-error" role="alert">
          {error}
        </p>
      )}

      <div className={`sb-panes sb-${view}`} key={`${sessionId}:${epoch}`}>
        {view !== 'interviewee' && <Pane user={SANDBOX_INTERVIEWER} sessionId={sessionId} label="Interviewer" />}
        {view !== 'interviewer' && <Pane user={SANDBOX_INTERVIEWEE} sessionId={sessionId} label="Interviewee" />}
      </div>
    </div>
  )
}

/**
 * Public demo mode. Installs the in-memory Supabase replacement for as long as the page is mounted, then renders
 * the real RoomPage twice (interviewer and interviewee) against it.
 */
export default function SandboxPage() {
  const runtime = getRuntime()
  // Install during the first render so child effects (which run before this component's effects) already
  // talk to the fake. Installing is idempotent, so StrictMode's double render is harmless.
  setSupabaseBackend(runtime.fake.client)

  useEffect(() => {
    if (resetTimer) {
      clearTimeout(resetTimer)
      resetTimer = undefined
    }
    setSupabaseBackend(runtime.fake.client) // re-install after StrictMode's simulated unmount
    return () => {
      // Deferred so children can still call removeChannel() on the fake while unmounting.
      resetTimer = setTimeout(() => {
        resetTimer = undefined
        resetSupabaseBackend()
      }, 0)
    }
  }, [runtime])

  return <SandboxInner runtime={runtime} />
}
