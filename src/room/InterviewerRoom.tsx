import { useCallback, useEffect, useMemo, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { useCollab, useYText } from '../collab'
import type { Collab } from '../collab'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { useRealtimeTable } from '../hooks/useRealtimeTable'
import { setPhase } from '../lib/api'
import type { AiMessage, BugState, BugStatus, QuestionBug, QuestionPrivate, QuestionReferenceFile, Session, SessionNote, TestRun } from '../types/db'
import CodeFiles from '../workspace/CodeFiles'
import { collabUserFor, isTestPath, languageForPath } from '../workspace/logic'
import { NotesEditor } from '../workspace/NotesEditor'
import StatusBadge from '../workspace/StatusBadge'
import TabPanels from '../workspace/TabPanels'
import { useFilePaths } from '../workspace/useFilePaths'
import WhiteboardPanel from '../workspace/WhiteboardPanel'
import { MessageBubble } from './ChatPanel'
import { BugList, Checklist, Followups, Notes as PrivateNotes } from './InterviewerSidebar'
import { sortByCreatedAt } from './listUtils'
import {
  addNote,
  deleteBugStatus,
  getQuestionPrivate,
  listAiMessages,
  listBugStatus,
  listNotes,
  listQuestionBugs,
  listReferenceFiles,
  listTestRuns,
  upsertBugStatus,
} from './roomApi'
import TestResultsPanel, { RunSummary } from './TestResultsPanel'
import SessionClock from './SessionClock'
import './room.css'

const msgKey = (r: Partial<AiMessage>) => r.id
const runKey = (r: Partial<TestRun>) => r.id
const bugKey = (r: Partial<BugStatus>) => r.bug_id
const noteKey = (r: Partial<SessionNote>) => r.id

/** Reference solution (left) vs the live shared code (right). */
function DiffTab({ collab, refFiles }: { collab: Collab; refFiles: QuestionReferenceFile[] }) {
  const theme = useMonacoTheme()
  const livePaths = useFilePaths(collab)
  const [diffPath, setDiffPath] = useState<string | null>(null)

  const diffPaths = useMemo(() => {
    const set = new Set<string>(refFiles.map((f) => f.path))
    for (const p of livePaths) if (!isTestPath(p)) set.add(p)
    return [...set].sort()
  }, [refFiles, livePaths])
  const current = diffPath && diffPaths.includes(diffPath) ? diffPath : (diffPaths[0] ?? null)
  const refContent = refFiles.find((f) => f.path === current)?.content ?? ''
  const live = useYText(current !== null ? collab.fileText(current) : undefined)

  return (
    <div className="room-editor-wrap">
      <div className="room-bar">
        <label htmlFor="diff-file">File</label>
        <select id="diff-file" className="room-input" style={{ width: 'auto' }} value={current ?? ''} onChange={(e) => setDiffPath(e.target.value)}>
          {diffPaths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="room-muted">Left: reference solution. Right: live shared code.</span>
      </div>
      <div className="room-editor">
        {current === null ? (
          <p className="room-muted" style={{ padding: 12 }}>
            Nothing to compare yet.
          </p>
        ) : (
          <DiffEditor
            height="100%"
            language={languageForPath(current)}
            theme={theme}
            original={refContent}
            modified={live}
            originalModelPath={`file:///diff-ref/${current}`}
            modifiedModelPath={`file:///diff-live/${current}`}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false }}
          />
        )}
      </div>
    </div>
  )
}

export default function InterviewerRoom({ session, userId }: { session: Session; userId: string }) {
  const sessionId = session.id

  const user = useMemo(() => collabUserFor({ userId, role: 'interviewer', email: session.interviewer_email }), [userId, session.interviewer_email])
  const collabSession = useMemo(() => ({ id: sessionId, phase: session.phase }), [sessionId, session.phase])
  const { collab, error: collabError } = useCollab(collabSession, user)

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [priv, setPriv] = useState<QuestionPrivate | null>(null)
  const [bugs, setBugs] = useState<QuestionBug[]>([])
  const [refFiles, setRefFiles] = useState<QuestionReferenceFile[]>([])
  const [staticError, setStaticError] = useState<string | null>(null)
  const [bugError, setBugError] = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)

  const loadAi = useCallback(() => listAiMessages(sessionId), [sessionId])
  const ai = useRealtimeTable<AiMessage>({ table: 'ai_messages', sessionId, load: loadAi, keyOf: msgKey, sort: sortByCreatedAt })
  const loadRuns = useCallback(() => listTestRuns(sessionId), [sessionId])
  const runs = useRealtimeTable<TestRun>({ table: 'test_runs', sessionId, load: loadRuns, keyOf: runKey, sort: sortByCreatedAt })
  const loadBugStatus = useCallback(() => listBugStatus(sessionId), [sessionId])
  const bugStatus = useRealtimeTable<BugStatus>({ table: 'bug_status', sessionId, load: loadBugStatus, keyOf: bugKey })
  const loadNotes = useCallback(() => listNotes(sessionId), [sessionId])
  const notes = useRealtimeTable<SessionNote>({ table: 'session_notes', sessionId, load: loadNotes, keyOf: noteKey, sort: sortByCreatedAt })

  // Interviewer-only data (RLS guarantees the interviewee can never read these).
  useEffect(() => {
    let cancelled = false
    setStaticError(null)
    Promise.all([getQuestionPrivate(session.question_id), listQuestionBugs(session.question_id), listReferenceFiles(session.question_id)])
      .then(([p, b, r]) => {
        if (cancelled) return
        setPriv(p)
        setBugs(b)
        setRefFiles(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setStaticError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [session.question_id])

  const startedAt = session.debugging_started_at

  const latestRun = runs.items.length > 0 ? runs.items[runs.items.length - 1] : null
  const selectedRun = runs.items.find((r) => r.id === selectedRunId) ?? latestRun

  const setBug = async (bugId: string, state: BugState | null) => {
    setBugError(null)
    try {
      if (state === null) {
        bugStatus.removeLocal({ session_id: sessionId, bug_id: bugId })
        await deleteBugStatus(sessionId, bugId)
      } else {
        bugStatus.upsertLocal({ session_id: sessionId, bug_id: bugId, state, updated_at: new Date().toISOString() })
        await upsertBugStatus(sessionId, bugId, state)
      }
    } catch (e) {
      setBugError(e instanceof Error ? e.message : 'Could not update the bug')
      void bugStatus.reload().catch(() => undefined)
    }
  }

  const completeInterview = async () => {
    if (!window.confirm('Complete the interview? The session will be locked and the review opens for both of you.')) return
    setCompleting(true)
    setCompleteError(null)
    try {
      // Persist the latest shared code/notes/whiteboard before the workspace turns read-only.
      await collab?.flush().catch(() => undefined)
      await setPhase(sessionId, 'completed')
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not complete the interview')
      setCompleting(false)
    }
  }

  return (
    <div className="room room-full" aria-label="Interviewer room">
      <div className="room-bar">
        <StatusBadge status={collab?.status ?? 'loading'} />
        <span className="spacer" />
        <SessionClock session={session} />
        <button type="button" className="room-btn danger" onClick={() => void completeInterview()} disabled={completing}>
          {completing ? 'Completing…' : 'Complete interview'}
        </button>
      </div>
      {completeError && (
        <p className="room-error" role="alert">
          {completeError}
        </p>
      )}
      {(staticError || collabError) && (
        <p className="room-error" role="alert">
          {collabError ?? staticError}
        </p>
      )}

      <div className="room-split interviewer">
        <div className="room-col">
          {!collab && !collabError && (
            <p className="room-muted" role="status">
              Loading workspace…
            </p>
          )}
          {collab && (
            <TabPanels
              label="Interview views"
              className="ws-fill"
              tabs={[
                { id: 'live', label: 'Live code (editable)', render: () => <CodeFiles collab={collab} label="Live code" /> },
                { id: 'notes', label: 'Shared notes', render: () => <NotesEditor collab={collab} /> },
                { id: 'whiteboard', label: 'Whiteboard', render: () => <WhiteboardPanel session={collabSession} user={user} /> },
                { id: 'diff', label: 'Diff vs reference', render: () => <DiffTab collab={collab} refFiles={refFiles} /> },
                {
                  id: 'ai',
                  label: `AI transcript${ai.items.length > 0 ? ` (${ai.items.length})` : ''}`,
                  render: () => (
                    <div className="room-chat-list room-scroll" role="log" aria-live="polite" aria-label="AI transcript">
                      {ai.error && <p className="room-error">{ai.error}</p>}
                      {!ai.loading && ai.items.length === 0 && <p className="room-muted">The interviewee has not used the AI assistant yet.</p>}
                      {ai.items.map((m) => (
                        <MessageBubble key={m.id} role={m.role} content={m.content} at={m.created_at} model={m.model} />
                      ))}
                    </div>
                  ),
                },
                {
                  id: 'tests',
                  label: `Test runs${runs.items.length > 0 ? ` (${runs.items.length})` : ''}`,
                  render: () => (
                    <div className="room-scroll room-col">
                      {runs.error && <p className="room-error">{runs.error}</p>}
                      {runs.items.length > 0 && (
                        <ul className="room-timeline" aria-label="Test run history">
                          {runs.items
                            .slice()
                            .reverse()
                            .map((r, i) => (
                              <li key={r.id}>
                                <time dateTime={r.created_at}>#{runs.items.length - i}</time>
                                <button type="button" className="room-btn small" aria-pressed={selectedRun?.id === r.id} onClick={() => setSelectedRunId(r.id)}>
                                  <RunSummary run={r} />
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                      <TestResultsPanel run={selectedRun} emptyText="The interviewee has not run the tests yet." />
                    </div>
                  ),
                },
              ]}
            />
          )}
        </div>

        <aside className="room-col room-scroll" aria-label="Interviewer panel">
          <section className="room-card">
            <h2>Guided checklist</h2>
            <Checklist sessionId={sessionId} items={priv?.checklist ?? []} />
          </section>
          <section className="room-card">
            <h2>Bugs</h2>
            <BugList bugs={bugs} statuses={bugStatus.items} onSet={(id, st) => void setBug(id, st)} error={bugError ?? bugStatus.error} />
          </section>
          <section className="room-card">
            <h2>Suggested follow-ups</h2>
            <Followups priv={priv} />
          </section>
          <section className="room-card" aria-labelledby="private-notes-title">
            <h2 id="private-notes-title">Private interviewer notes</h2>
            <p className="room-muted">Only you can see these. The &quot;Shared notes&quot; tab is the one both of you edit.</p>
            <PrivateNotes notes={notes.items} startedAt={startedAt} onAdd={async (body) => notes.upsertLocal(await addNote(sessionId, userId, body))} />
          </section>
        </aside>
      </div>
    </div>
  )
}
