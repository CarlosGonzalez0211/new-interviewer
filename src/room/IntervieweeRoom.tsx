import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { usePythonRunner } from '../hooks/usePythonRunner'
import { useSessionChannel } from '../hooks/useSessionChannel'
import type { ChannelStatus } from '../hooks/useSessionChannel'
import { supabase } from '../lib/supabase'
import type { Session, SessionFile } from '../types/db'
import type { TestRunResult } from '../runner/types'
import ChatPanel from './ChatPanel'
import { nextSeq } from './mirror'
import { createPersistor } from './persistence'
import type { Persistor, PersistState } from './persistence'
import { insertTestRun, loadSessionFiles, saveFileKeepalive, updateSessionFile } from './roomApi'
import TestResultsPanel from './TestResultsPanel'
import './room.css'

const SAVE_DELAY_MS = 2000

const STATUS_LABEL: Record<ChannelStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected to interviewer channel',
  error: 'Live sync unavailable',
  closed: 'Live sync disconnected',
}
const STATUS_DOT: Record<ChannelStatus, string> = { connecting: 'warn pulse', connected: 'ok', error: 'bad', closed: 'bad' }

const SAVE_LABEL: Record<PersistState, string> = { idle: 'All changes saved', dirty: 'Unsaved changes…', saving: 'Saving…', error: 'Save failed, will retry' }
const SAVE_DOT: Record<PersistState, string> = { idle: 'ok', dirty: 'warn', saving: 'warn pulse', error: 'bad' }

export default function IntervieweeRoom({ session, userId }: { session: Session; userId: string }) {
  const sessionId = session.id
  const theme = useMonacoTheme()
  const runner = usePythonRunner()

  const [files, setFiles] = useState<SessionFile[]>([])
  const [contents, setContents] = useState<Record<string, string>>({})
  const [activePath, setActivePath] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(true)
  const [saveState, setSaveState] = useState<PersistState>('idle')
  const [lastRun, setLastRun] = useState<TestRunResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)

  const contentsRef = useRef<Record<string, string>>({})
  const savedRef = useRef<Record<string, string>>({})
  const activeRef = useRef<string | null>(null)
  const kindsRef = useRef<Record<string, SessionFile['kind']>>({})
  const seqRef = useRef(0)
  const persistorRef = useRef<Persistor | null>(null)
  const tokenRef = useRef<string | null>(null)
  const sendRef = useRef<ReturnType<typeof useSessionChannel>['send'] | null>(null)

  const emitEdit = useCallback(
    (path: string, content: string) => {
      seqRef.current = nextSeq(seqRef.current, Date.now())
      sendRef.current?.('file_edit', { path, content, seq: seqRef.current, from: userId })
    },
    [userId],
  )

  const broadcastAll = useCallback(() => {
    for (const [path, content] of Object.entries(contentsRef.current)) emitEdit(path, content)
    if (activeRef.current) sendRef.current?.('active_file', { path: activeRef.current, from: userId })
  }, [emitEdit, userId])

  const channel = useSessionChannel(sessionId, { onSyncRequest: broadcastAll, onSubscribed: broadcastAll })
  useEffect(() => {
    sendRef.current = channel.send
  }, [channel.send])

  // Load working files.
  useEffect(() => {
    let cancelled = false
    setLoadingFiles(true)
    setLoadError(null)
    loadSessionFiles(sessionId)
      .then((rows) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        const kinds: Record<string, SessionFile['kind']> = {}
        for (const r of rows) {
          map[r.path] = r.content
          kinds[r.path] = r.kind
        }
        contentsRef.current = map
        savedRef.current = { ...map }
        kindsRef.current = kinds
        const first = rows.find((r) => r.kind === 'code') ?? rows[0]
        activeRef.current = first?.path ?? null
        setFiles(rows)
        setContents(map)
        setActivePath(first?.path ?? null)
        setLoadingFiles(false)
        broadcastAll()
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoadingFiles(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, broadcastAll])

  // Cache the access token so beforeunload can fire a keepalive save synchronously.
  useEffect(() => {
    let cancelled = false
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) tokenRef.current = data.session?.access_token ?? null
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      tokenRef.current = s?.access_token ?? null
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  // Debounced durable persistence + flush on unmount / page close.
  useEffect(() => {
    const persistor = createPersistor({
      delayMs: SAVE_DELAY_MS,
      onState: (s) => setSaveState(s),
      save: async (paths) => {
        await Promise.all(
          paths
            .filter((p) => kindsRef.current[p] === 'code')
            .map(async (p) => {
              const content = contentsRef.current[p]
              await updateSessionFile(sessionId, p, content)
              savedRef.current[p] = content
            }),
        )
      },
    })
    persistorRef.current = persistor
    const onUnload = () => {
      const token = tokenRef.current
      if (!token) return
      for (const p of persistor.dirtyKeys()) {
        if (kindsRef.current[p] === 'code') saveFileKeepalive(sessionId, p, contentsRef.current[p], token)
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void persistor.flush()
      persistor.dispose()
      persistorRef.current = null
    }
  }, [sessionId])

  const onChange = useCallback(
    (value: string | undefined) => {
      const path = activeRef.current
      if (path === null || value === undefined) return
      if (kindsRef.current[path] !== 'code') return
      if (contentsRef.current[path] === value) return
      contentsRef.current = { ...contentsRef.current, [path]: value }
      setContents(contentsRef.current)
      emitEdit(path, value)
      persistorRef.current?.mark(path)
    },
    [emitEdit],
  )

  const disposables = useRef<{ dispose: () => void }[]>([])
  useEffect(
    () => () => {
      for (const d of disposables.current) d.dispose()
      disposables.current = []
    },
    [],
  )

  const onMount: OnMount = useCallback(
    (editor) => {
      for (const d of disposables.current) d.dispose()
      disposables.current = [
        editor.onDidChangeCursorSelection((e) => {
          const path = activeRef.current
          if (!path) return
          const s = e.selection
          const hasSelection = s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn
          sendRef.current?.('cursor', {
            path,
            line: s.positionLineNumber,
            column: s.positionColumn,
            ...(hasSelection
              ? { selection: { startLine: s.startLineNumber, startColumn: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn } }
              : {}),
            from: userId,
          })
        }),
      ]
    },
    [userId],
  )

  const selectFile = (path: string) => {
    activeRef.current = path
    setActivePath(path)
    sendRef.current?.('active_file', { path, from: userId })
  }

  const [running, setRunningLocal] = useState(false)
  const runTests = async () => {
    if (running || !runner.ready) return
    setRunningLocal(true)
    setRunError(null)
    setRecordError(null)
    try {
      const result = await runner.run(contentsRef.current)
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
  const active = activePath ? files.find((f) => f.path === activePath) : undefined
  const readOnly = active?.kind === 'test'

  return (
    <div className="room room-full" aria-label="Debugging room">
      <div className="room-bar">
        <button type="button" className="room-btn primary" onClick={() => void runTests()} disabled={!runner.ready || running || loadingFiles}>
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
        <span className="room-badge" title={STATUS_LABEL[channel.status]}>
          <span className={`room-dot ${STATUS_DOT[channel.status]}`} aria-hidden="true" />
          {STATUS_LABEL[channel.status]}
        </span>
        <span className="room-badge">
          <span className={`room-dot ${SAVE_DOT[saveState]}`} aria-hidden="true" />
          {SAVE_LABEL[saveState]}
        </span>
      </div>

      <div className="room-split">
        <div className="room-col">
          {loadingFiles && <p className="room-muted">Loading files…</p>}
          {loadError && (
            <p className="room-error" role="alert">
              {loadError}
            </p>
          )}
          {!loadingFiles && !loadError && files.length === 0 && <p className="room-muted">No files in this session yet.</p>}
          {files.length > 0 && (
            <div className="room-editor-wrap">
              <div className="room-tabs" role="tablist" aria-label="Files">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    role="tab"
                    id={`tab-${f.path}`}
                    aria-selected={f.path === activePath}
                    className="room-tab file"
                    onClick={() => selectFile(f.path)}
                  >
                    {f.path}
                    {f.kind === 'test' ? ' (read-only)' : ''}
                  </button>
                ))}
              </div>
              <div className="room-editor" role="tabpanel" aria-label={activePath ? `Editor for ${activePath}` : 'Editor'}>
                {activePath !== null && (
                  <Editor
                    height="100%"
                    language="python"
                    theme={theme}
                    path={`file:///interviewee/${activePath}`}
                    value={contents[activePath] ?? ''}
                    onChange={onChange}
                    onMount={onMount}
                    options={{ readOnly, minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4 }}
                  />
                )}
              </div>
            </div>
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
