import type { TestResult } from '../types/db'

/** Result of one test run (the shape inserted into `test_runs`, minus server columns). */
export interface TestRunResult {
  passed: number
  failed: number
  errored: number
  results: TestResult[]
  stdout: string
}

export const RUN_TIMEOUT_MS = 10_000
export const WORK_ROOT = '/home/pyodide/work'

export type WorkerRequest = { type: 'run'; id: number; files: Record<string, string> }

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number; stage: string }
  | { type: 'ready' }
  | { type: 'result'; id: number; result: TestRunResult }
  | { type: 'error'; id: number | null; message: string }
