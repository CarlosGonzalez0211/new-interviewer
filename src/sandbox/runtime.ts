import { createFakeSupabase } from './fake/fakeSupabase'
import type { FakeSupabase, FakeSupabaseOptions } from './fake/fakeSupabase'
import { SANDBOX_INTERVIEWEE, SANDBOX_INTERVIEWER } from './identity'
import { bundledQuestionSources, seedQuestions } from './seed'
import type { QuestionSources } from './seed'
import type { Question, Session, SessionPhase } from '../types/db'

export interface SandboxRuntime {
  fake: FakeSupabase
  questions(): Question[]
  /** New session for this question with BOTH participants already attached (no claim needed). */
  createSession(questionId: string): Session
  /** Wipe the fake database, reseed the questions and return the fresh question list. */
  reset(): void
  /** Convenience: move forward through set_phase (one step at a time, like the real RPC). */
  jumpTo(sessionId: string, phase: SessionPhase): Promise<void>
}

const ORDER: SessionPhase[] = ['briefing', 'debugging', 'completed']

export function createSandboxRuntime(
  sources: QuestionSources = bundledQuestionSources(),
  options: FakeSupabaseOptions = {},
): SandboxRuntime {
  const fake = createFakeSupabase({ currentUser: SANDBOX_INTERVIEWER, ...options })
  seedQuestions(fake.db, sources)

  return {
    fake,
    questions() {
      return (fake.db.all('questions') as unknown as Question[]).sort((a, b) => a.title.localeCompare(b.title))
    },
    createSession(questionId) {
      return fake.db.insert('sessions', {
        question_id: questionId,
        created_by: SANDBOX_INTERVIEWER.id,
        interviewer_id: SANDBOX_INTERVIEWER.id,
        interviewee_id: SANDBOX_INTERVIEWEE.id,
        interviewer_email: SANDBOX_INTERVIEWER.email,
        interviewee_email: SANDBOX_INTERVIEWEE.email,
      }) as unknown as Session
    },
    reset() {
      fake.db.clear()
      seedQuestions(fake.db, sources)
    },
    async jumpTo(sessionId, phase) {
      const cur = fake.db.find('sessions', { id: sessionId })?.phase as SessionPhase | undefined
      if (!cur) throw new Error('Session not found')
      for (let i = ORDER.indexOf(cur) + 1; i <= ORDER.indexOf(phase); i++) {
        const { error } = await fake.raw.rpc('set_phase', { p_session_id: sessionId, p_phase: ORDER[i] })
        if (error) throw new Error(error.message)
      }
    },
  }
}

/** Remove browser storage entries that mention this session id (e.g. the interviewer's checklist ticks). */
export function clearSessionStorage(sessionId: string): void {
  for (const getStore of [() => globalThis.localStorage, () => globalThis.sessionStorage]) {
    try {
      const store = getStore()
      if (!store) continue
      const doomed: string[] = []
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)
        if (k && k.includes(sessionId)) doomed.push(k)
      }
      for (const k of doomed) store.removeItem(k)
    } catch {
      // storage unavailable
    }
  }
}
