import { useMemo, useState } from 'react'
import { useCollab } from '../collab'
import { usePythonRunner } from '../hooks/usePythonRunner'
import type { Session } from '../types/db'
import type { TestRunResult } from '../runner/types'
import CodeFiles from '../workspace/CodeFiles'
import { collabUserFor } from '../workspace/logic'
import { NotesEditor } from '../workspace/NotesEditor'
import StatusBadge from '../workspace/StatusBadge'
import TabPanels from '../workspace/TabPanels'
import WhiteboardPanel from '../workspace/WhiteboardPanel'
import ChatPanel from './ChatPanel'
import { insertTestRun } from './roomApi'
import TestResultsPanel from './TestResultsPanel'
import './room.css'

export default function IntervieweeRoom({ session, userId }: { session: Session; userId: string }) {
  const sessionId = session.id
  const runner = usePythonRunner()

  const user = useMemo(() => collabUserFor({ userId, role: 'interviewee', email: session.interviewee_email }), [userId, session.interviewee_email])
  const collabSession = useMemo(() => ({ id: sessionId, phase: session.phase }), [sessionId, session.phase])
  const { collab, error: collabError } = useCollab(collabSession, user)

  const [lastRun, setLastRun] = useState<TestRunResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [running, setRunningLocal] = useState(false)

  const runTests = async () => {
    if (running || !runner.ready || !collab) return
    setRunningLocal(true)
    setRunError(null)
    setRecordError(null)
    try {
      // Current shared contents (what the interviewer sees too), not a stale copy.
      const files: Record<string, string> = {}
      for (const p of collab.filePaths()) files[p] = collab.fileText(p)?.toString() ?? ''
      const result = await runner.run(files)
      setLastRun(result)
      try {
        await insertTestRun(sessionId, result)
      } catch (e) {
        setRecordError(e instanceof Error ? e.message : 'Could not record the run')
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Test run failed')
    } finally {
      setRunningLocal(false)
    }
  }

  const pct = runner.progress && runner.progress.total > 0 ? Math.min(100, Math.round((runner.progress.loaded / runner.progress.total) * 100)) : null

  return (
    <div className="room room-full" aria-label="Debugging room">
      <div className="room-bar">
        <button type="button" className="room-btn primary" onClick={() => void runTests()} disabled={!runner.ready || running || !collab}>
          {running ? 'Running…' : 'Run tests'}
        </button>
        {runner.loading && (
          <span className="room-muted" role="status">
            {runner.progress?.stage ?? 'Loading Python'}
            {pct !== null ? ` ${pct}%` : '…'}
          </span>
        )}
        {runner.loading && (
          <div
            className="room-progress"
            style={{ width: 120 }}
            role="progressbar"
            aria-label="Python runtime download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <div style={{ width: `${pct ?? 15}%` }} />
          </div>
        )}
        {runner.loadError && (
          <span className="room-error" role="alert">
            Python failed to load: {runner.loadError}{' '}
            <button type="button" className="room-btn small" onClick={runner.restart}>
              Retry
            </button>
          </span>
        )}
        <span className="spacer" />
        <StatusBadge status={collab?.status ?? 'loading'} />
      </div>

      <div className="room-split">
        <div className="room-col">
          {collabError && (
            <p className="room-error" role="alert">
              {collabError}
            </p>
          )}
          {!collab && !collabError && (
            <p className="room-muted" role="status">
              Loading files…
            </p>
          )}
          {collab && (
            <TabPanels
              label="Workspace"
              className="ws-fill"
              tabs={[
                { id: 'code', label: 'Code', render: () => <CodeFiles collab={collab} label="Code" /> },
                { id: 'notes', label: 'Notes', render: () => <NotesEditor collab={collab} /> },
                { id: 'whiteboard', label: 'Whiteboard', render: () => <WhiteboardPanel session={collabSession} user={user} /> },
              ]}
            />
          )}
        </div>

        <div className="room-col">
          <section className="room-card room-scroll" style={{ maxHeight: '38%' }} aria-label="Test results" aria-live="polite">
            <h2>Test results</h2>
            {runError && (
              <p className="room-error" role="alert">
                {runError}
              </p>
            )}
            {recordError && (
              <p className="room-error" role="alert">
                Result shown below but not shared with the interviewer: {recordError}
              </p>
            )}
            <TestResultsPanel run={lastRun ? { ...lastRun } : null} emptyText="Run the tests to see results here." />
          </section>
          <ChatPanel sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}
