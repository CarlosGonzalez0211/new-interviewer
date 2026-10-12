import { useCallback, useEffect, useMemo, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { useNow } from '../hooks/useNow'
import { useRealtimeTable } from '../hooks/useRealtimeTable'
import { useSessionChannel } from '../hooks/useSessionChannel'
import type { ChannelStatus } from '../hooks/useSessionChannel'
import { setPhase } from '../lib/api'
import type { AiMessage, BugState, BugStatus, QuestionBug, QuestionPrivate, QuestionReferenceFile, Session, SessionFile, SessionNote, TestRun } from '../types/db'
import { MessageBubble } from './ChatPanel'
import { BugList, Checklist, Followups, Notes } from './InterviewerSidebar'
import { sortByCreatedAt } from './listUtils'
import { applyActiveFile, applyBaseline, applyCursor, applyFileEdit, emptyMirror } from './mirror'
import type { MirrorState } from './mirror'
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
  loadSessionFiles,
  upsertBugStatus,
} from './roomApi'
import TestResultsPanel, { RunSummary } from './TestResultsPanel'
import { elapsedSince, formatClock, formatElapsed } from './time'
import './room.css'

type Tab = 'live' | 'diff' | 'ai' | 'tests'
type CodeEditor = Parameters<OnMount>[0]

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live code' },
  { id: 'diff', label: 'Diff vs reference' },
  { id: 'ai', label: 'AI transcript' },
  { id: 'tests', label: 'Test runs' },
]

const STATUS_DOT: Record<ChannelStatus, string> = { connecting: 'warn pulse', connected: 'ok', error: 'bad', closed: 'bad' }
const LIVE_WINDOW_MS = 10_000

const fileKey = (r: Partial<SessionFile>) => r.path
const msgKey = (r: Partial<AiMessage>) => r.id
const runKey = (r: Partial<TestRun>) => r.id
const bugKey = (r: Partial<BugStatus>) => r.bug_id
const noteKey = (r: Partial<SessionNote>) => r.id

export default function InterviewerRoom({ session, userId }: { session: Session; userId: string }) {
  const sessionId = session.id
  const theme = useMonacoTheme()
  const now = useNow(1000)

  const [tab, setTab] = useState<Tab>('live')
  const [mirror, setMirror] = useState<MirrorState>(emptyMirror)
  const [followActive, setFollowActive] = useState(true)
  const [manualPath, setManualPath] = useState<string | null>(null)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [editor, setEditor] = useState<CodeEditor | null>(null)

  const [priv, setPriv] = useState<QuestionPrivate | null>(null)
  const [bugs, setBugs] = useState<QuestionBug[]>([])
  const [refFiles, setRefFiles] = useState<QuestionReferenceFile[]>([])
  const [staticError, setStaticError] = useState<string | null>(null)
  const [bugError, setBugError] = useState<string | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)

  // Realtime broadcast overlay.
  const channel = useSessionChannel(sessionId, {
    onFileEdit: (ev) => setMirror((m) => applyFileEdit(m, ev, Date.now())),
    onCursor: (ev) => setMirror((m) => applyCursor(m, ev, Date.now())),
    onActiveFile: (ev) => setMirror((m) => applyActiveFile(m, ev, Date.now())),
    onSubscribed: () => sendSyncRequest(),
  })
  const { send } = channel
  const sendSyncRequest = useCallback(() => {
    send('sync_request', { from: userId })
  }, [send, userId])

  // Durable baseline (and later DB updates) for paths not yet seen over broadcast.
  const loadFiles = useCallback(() => loadSessionFiles(sessionId), [sessionId])
  const filesTable = useRealtimeTable<SessionFile>({ table: 'session_files', sessionId, load: loadFiles, keyOf: fileKey })
  useEffect(() => {
    setMirror((m) => applyBaseline(m, filesTable.items))
  }, [filesTable.items])

  const kinds = useMemo(() => {
    const k: Record<string, SessionFile['kind']> = {}
    for (const f of filesTable.items) k[f.path] = f.kind
    return k
  }, [filesTable.items])

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

  const paths = useMemo(() => Object.keys(mirror.files).sort(), [mirror.files])
  const livePath = followActive ? (mirror.activePath ?? paths[0] ?? null) : (manualPath ?? mirror.activePath ?? paths[0] ?? null)
  const liveContent = livePath !== null ? (mirror.files[livePath] ?? '') : ''

  const diffPaths = useMemo(() => {
    const set = new Set<string>(refFiles.map((f) => f.path))
    for (const p of paths) if (kinds[p] !== 'test') set.add(p)
    return [...set].sort()
  }, [refFiles, paths, kinds])
  const currentDiffPath = diffPath && diffPaths.includes(diffPath) ? diffPath : (diffPaths[0] ?? null)
  const refContent = refFiles.find((f) => f.path === currentDiffPath)?.content ?? ''
  const diffLive = currentDiffPath !== null ? (mirror.files[currentDiffPath] ?? '') : ''

  // Remote cursor + selection decorations on the read-only mirror.
  const cursor = mirror.cursor
  useEffect(() => {
    if (!editor || !cursor || cursor.path !== livePath) return
    const sel = cursor.selection
    const collection = editor.createDecorationsCollection([
      {
        range: { startLineNumber: cursor.line, startColumn: cursor.column, endLineNumber: cursor.line, endColumn: cursor.column },
        options: { beforeContentClassName: 'room-remote-caret', isWholeLine: false },
      },
      { range: { startLineNumber: cursor.line, startColumn: 1, endLineNumber: cursor.line, endColumn: 1 }, options: { isWholeLine: true, className: 'room-remote-line' } },
      ...(sel
        ? [
            {
              range: { startLineNumber: sel.startLine, startColumn: sel.startColumn, endLineNumber: sel.endLine, endColumn: sel.endColumn },
              options: { className: 'room-remote-selection' },
            },
          ]
        : []),
    ])
    if (followActive) editor.revealLineInCenterIfOutsideViewport(cursor.line)
    return () => collection.clear()
  }, [editor, cursor, livePath, liveContent, followActive])

  const startedAt = session.debugging_started_at
  const elapsed = elapsedSince(startedAt, session.completed_at ?? now)
  const liveAgo = mirror.lastUpdate !== null ? now - mirror.lastUpdate : null
  const isLive = channel.status === 'connected' && liveAgo !== null && liveAgo < LIVE_WINDOW_MS

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
      await setPhase(sessionId, 'completed')
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not complete the interview')
      setCompleting(false)
    }
  }

  return (
    <div className="room room-full" aria-label="Interviewer room">
      <div className="room-bar">
        <span className="room-badge" role="status">
          <span className={`room-dot ${isLive ? 'ok pulse' : STATUS_DOT[channel.status]}`} aria-hidden="true" />
          {channel.status !== 'connected'
            ? channel.status === 'connecting'
              ? 'Connecting…'
              : 'Live sync unavailable'
            : isLive
              ? 'Live'
              : mirror.lastUpdate === null
                ? 'Waiting for edits'
                : 'Idle'}
        </span>
        {mirror.lastUpdate !== null && <span className="room-muted">Last update {formatClock(mirror.lastUpdate)}</span>}
        <button type="button" className="room-btn small" onClick={sendSyncRequest} disabled={channel.status !== 'connected'}>
          Resync
        </button>
        <span className="spacer" />
        <span className="room-badge" aria-label="Elapsed time since debugging started">
          Elapsed <span className="room-mono">{elapsed !== null ? formatElapsed(elapsed) : '--:--'}</span>
        </span>
        <button type="button" className="room-btn danger" onClick={() => void completeInterview()} disabled={completing}>
          {completing ? 'Completing…' : 'Complete interview'}
        </button>
      </div>
      {completeError && (
        <p className="room-error" role="alert">
          {completeError}
        </p>
      )}
      {staticError && (
        <p className="room-error" role="alert">
          {staticError}
        </p>
      )}

      <div className="room-split interviewer">
        <div className="room-col">
          <div className="room-tabs" role="tablist" aria-label="Interview views">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`itab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="itab-panel"
                className="room-tab"
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'ai' && ai.items.length > 0 ? ` (${ai.items.length})` : ''}
                {t.id === 'tests' && runs.items.length > 0 ? ` (${runs.items.length})` : ''}
              </button>
            ))}
          </div>

          <div id="itab-panel" role="tabpanel" aria-labelledby={`itab-${tab}`} className="room-editor-wrap">
            {tab === 'live' && (
              <>
                <div className="room-tabs" role="tablist" aria-label="Files">
                  {paths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={p === livePath}
                      className="room-tab file"
                      onClick={() => {
                        setFollowActive(false)
                        setManualPath(p)
                      }}
                    >
                      {p}
                    </button>
                  ))}
                  <span className="spacer" style={{ flex: 1 }} />
                  <label className="room-muted" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '0 8px' }}>
                    <input type="checkbox" checked={followActive} onChange={(e) => setFollowActive(e.target.checked)} />
                    Follow interviewee
                  </label>
                </div>
                <div className="room-editor">
                  {livePath === null ? (
                    <p className="room-muted" style={{ padding: 12 }}>
                      {filesTable.loading ? 'Loading files…' : 'No files yet.'}
                    </p>
                  ) : (
                    <Editor
                      height="100%"
                      language="python"
                      theme={theme}
                      path={`file:///live/${livePath}`}
                      value={liveContent}
                      onMount={(ed) => setEditor(ed)}
                      options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, automaticLayout: true }}
                    />
                  )}
                </div>
              </>
            )}

            {tab === 'diff' && (
              <>
                <div className="room-bar">
                  <label htmlFor="diff-file">File</label>
                  <select id="diff-file" className="room-input" style={{ width: 'auto' }} value={currentDiffPath ?? ''} onChange={(e) => setDiffPath(e.target.value)}>
                    {diffPaths.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <span className="room-muted">Left: reference solution. Right: interviewee&apos;s live code.</span>
                </div>
                <div className="room-editor">
                  {currentDiffPath === null ? (
                    <p className="room-muted" style={{ padding: 12 }}>
                      Nothing to compare yet.
                    </p>
                  ) : (
                    <DiffEditor
                      height="100%"
                      language="python"
                      theme={theme}
                      original={refContent}
                      modified={diffLive}
                      originalModelPath={`file:///diff-ref/${currentDiffPath}`}
                      modifiedModelPath={`file:///diff-live/${currentDiffPath}`}
                      options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false }}
                    />
                  )}
                </div>
              </>
            )}

            {tab === 'ai' && (
              <div className="room-chat-list room-scroll" role="log" aria-live="polite" aria-label="AI transcript">
                {ai.error && <p className="room-error">{ai.error}</p>}
                {!ai.loading && ai.items.length === 0 && <p className="room-muted">The interviewee has not used the AI assistant yet.</p>}
                {ai.items.map((m) => (
                  <MessageBubble key={m.id} role={m.role} content={m.content} at={m.created_at} />
                ))}
              </div>
            )}

            {tab === 'tests' && (
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
                          <button
                            type="button"
                            className="room-btn small"
                            aria-pressed={selectedRun?.id === r.id}
                            onClick={() => setSelectedRunId(r.id)}
                          >
                            <RunSummary run={r} />
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
                <TestResultsPanel run={selectedRun} emptyText="The interviewee has not run the tests yet." />
              </div>
            )}
          </div>
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
          <section className="room-card">
            <h2>Notes</h2>
            <Notes notes={notes.items} startedAt={startedAt} onAdd={async (body) => notes.upsertLocal(await addNote(sessionId, userId, body))} />
          </section>
        </aside>
      </div>
    </div>
  )
}
