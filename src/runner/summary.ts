import type { TestResult } from '../types/db'
import type { TestRunResult } from './types'

type Counts = Pick<TestRunResult, 'passed' | 'failed' | 'errored'>

/** Reduce a list of per-test results into counts (never trusts a harness-provided total). */
export function summarizeResults(results: readonly TestResult[]): Counts {
  let passed = 0
  let failed = 0
  let errored = 0
  for (const r of results) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else errored++
  }
  return { passed, failed, errored }
}

const STATUSES = new Set(['passed', 'failed', 'error'])

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Validate/normalise the JSON string returned by the Python harness. Throws on garbage. */
export function parseHarnessOutput(json: string): TestRunResult {
  const raw: unknown = JSON.parse(json)
  if (typeof raw !== 'object' || raw === null) throw new Error('Harness returned a non-object')
  const obj = raw as Record<string, unknown>
  const list = Array.isArray(obj.results) ? (obj.results as unknown[]) : []
  const results: TestResult[] = list.map((item) => {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const status = STATUSES.has(str(r.status)) ? (r.status as TestResult['status']) : 'error'
    return { file: str(r.file), name: str(r.name), status, message: str(r.message), traceback: str(r.traceback) }
  })
  return { ...summarizeResults(results), results, stdout: str(obj.stdout) }
}

export function timeoutResult(ms: number): TestRunResult {
  const message = `Test run timed out after ${Math.round(ms / 1000)}s (possible infinite loop). The runner was restarted.`
  const results: TestResult[] = [{ file: '(runner)', name: 'timeout', status: 'error', message, traceback: '' }]
  return { ...summarizeResults(results), results, stdout: '' }
}

export function runLabel(run: Counts): string {
  const total = run.passed + run.failed + run.errored
  return `${run.passed}/${total} passed`
}

export function allPassing(run: Counts): boolean {
  return run.failed === 0 && run.errored === 0 && run.passed > 0
}
