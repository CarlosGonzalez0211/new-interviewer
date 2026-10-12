import type { TestRun } from '../types/db'
import { formatClock } from './time'
import './room.css'

type RunView = Pick<TestRun, 'passed' | 'failed' | 'errored' | 'results' | 'stdout'> & { created_at?: string }

export function RunSummary({ run }: { run: Pick<TestRun, 'passed' | 'failed' | 'errored'> & { created_at?: string } }) {
  const total = run.passed + run.failed + run.errored
  const green = run.failed === 0 && run.errored === 0 && run.passed > 0
  return (
    <span className="room-badge" role="status">
      <span className={`room-dot ${green ? 'ok' : 'bad'}`} aria-hidden="true" />
      {run.passed}/{total} passed
      {run.failed > 0 && <span>, {run.failed} failed</span>}
      {run.errored > 0 && <span>, {run.errored} errors</span>}
      {run.created_at && <span className="room-muted">at {formatClock(run.created_at)}</span>}
    </span>
  )
}

export default function TestResultsPanel({ run, emptyText }: { run: RunView | null; emptyText?: string }) {
  if (!run) return <p className="room-muted">{emptyText ?? 'No test runs yet.'}</p>
  return (
    <div className="room-results">
      <RunSummary run={run} />
      {run.results.map((r, i) => (
        <details key={`${r.file}:${r.name}:${i}`} className={`room-result ${r.status}`} open={r.status !== 'passed' && run.results.length <= 6}>
          <summary>
            <span className={`room-status ${r.status}`}>{r.status}</span>
            <span className="room-mono">{r.name}</span>
            <span className="room-muted">{r.file}</span>
          </summary>
          {r.message && <pre className="room-pre">{r.message}</pre>}
          {r.traceback && <pre className="room-pre">{r.traceback}</pre>}
          {!r.message && !r.traceback && <p className="room-muted">No details.</p>}
        </details>
      ))}
      {run.stdout && (
        <details className="room-result">
          <summary>
            <span className="room-status">stdout</span>
          </summary>
          <pre className="room-pre">{run.stdout}</pre>
        </details>
      )}
    </div>
  )
}
