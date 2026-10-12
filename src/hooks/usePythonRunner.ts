import { useCallback, useEffect, useRef, useState } from 'react'
import { RUN_TIMEOUT_MS } from '../runner/types'
import type { TestRunResult, WorkerRequest, WorkerResponse } from '../runner/types'
import { timeoutResult } from '../runner/summary'

export interface RunnerProgress {
  loaded: number
  total: number
  stage: string
}

export interface PythonRunner {
  ready: boolean
  loading: boolean
  running: boolean
  progress: RunnerProgress | null
  /** Set when the worker failed to load Pyodide (e.g. offline). */
  loadError: string | null
  run: (files: Record<string, string>) => Promise<TestRunResult>
  /** Retry after a load failure. */
  restart: () => void
}

interface Pending {
  id: number
  resolve: (r: TestRunResult) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Owns a Pyodide web worker. Runs are hard-limited to RUN_TIMEOUT_MS: on timeout the worker is
 * terminated and recreated (the only way to stop an infinite loop) and a synthetic error result is returned.
 */
export function usePythonRunner(): PythonRunner {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  const idRef = useRef(0)
  const generationRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RunnerProgress | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [restartCount, setRestartCount] = useState(0)

  const settle = useCallback((fn: (p: Pending) => void) => {
    const p = pendingRef.current
    if (!p) return
    clearTimeout(p.timer)
    pendingRef.current = null
    setRunning(false)
    fn(p)
  }, [])

  const spawn = useCallback(() => {
    const generation = ++generationRef.current
    const worker = new Worker(new URL('../runner/pyodide.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setReady(false)
    setLoadError(null)
    setProgress({ loaded: 0, total: 0, stage: 'Starting' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (generation !== generationRef.current) return
      const msg = event.data
      if (msg.type === 'progress') {
        setProgress({ loaded: msg.loaded, total: msg.total, stage: msg.stage })
      } else if (msg.type === 'ready') {
        setReady(true)
        setProgress(null)
      } else if (msg.type === 'result') {
        if (pendingRef.current?.id === msg.id) settle((p) => p.resolve(msg.result))
      } else if (msg.id === null) {
        setLoadError(msg.message)
        setProgress(null)
      } else if (pendingRef.current?.id === msg.id) {
        settle((p) => p.reject(new Error(msg.message)))
      }
    }
    worker.onerror = (event) => {
      if (generation !== generationRef.current) return
      const message = event.message || 'The Python worker crashed'
      setLoadError(message)
      setProgress(null)
      settle((p) => p.reject(new Error(message)))
    }
  }, [settle])

  useEffect(() => {
    spawn()
    return () => {
      generationRef.current++
      workerRef.current?.terminate()
      workerRef.current = null
      settle((p) => p.reject(new Error('Runner closed')))
    }
  }, [spawn, restartCount, settle])

  const run = useCallback(
    (files: Record<string, string>): Promise<TestRunResult> => {
      const worker = workerRef.current
      if (!worker) return Promise.reject(new Error('Python runner is not available'))
      if (!ready) return Promise.reject(new Error('Python runner is still loading'))
      if (pendingRef.current) return Promise.reject(new Error('A test run is already in progress'))
      const id = ++idRef.current
      return new Promise<TestRunResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Infinite loop or very slow code: kill the worker and start a fresh one.
          settle((p) => p.resolve(timeoutResult(RUN_TIMEOUT_MS)))
          workerRef.current?.terminate()
          spawn()
        }, RUN_TIMEOUT_MS)
        pendingRef.current = { id, resolve, reject, timer }
        setRunning(true)
        const req: WorkerRequest = { type: 'run', id, files }
        worker.postMessage(req)
      })
    },
    [ready, settle, spawn],
  )

  const restart = useCallback(() => setRestartCount((n) => n + 1), [])

  return { ready, loading: !ready && loadError === null, running, progress, loadError, run, restart }
}
