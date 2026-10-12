/// <reference lib="webworker" />
import harnessSource from './harness.py?raw'
import { parseHarnessOutput } from './summary'
import { WORK_ROOT } from './types'
import type { WorkerRequest, WorkerResponse } from './types'

const PYODIDE_VERSION = '0.27.7'
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
const HARNESS_DIR = '/home/pyodide/_harness'

interface PyodideFS {
  mkdirTree(path: string): void
  writeFile(path: string, data: string): void
  readdir(path: string): string[]
  stat(path: string): { mode: number }
  isDir(mode: number): boolean
  unlink(path: string): void
  rmdir(path: string): void
}
interface PyodideAPI {
  FS: PyodideFS
  runPython(code: string): unknown
}
interface PyodideModule {
  loadPyodide(options: { indexURL: string }): Promise<PyodideAPI>
}

const ctx = self as unknown as DedicatedWorkerGlobalScope
const post = (msg: WorkerResponse) => ctx.postMessage(msg)

/** Stream the big wasm file once so we can report real progress; loadPyodide then hits the HTTP cache. */
async function prefetchWithProgress(url: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) return
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    loaded += value.byteLength
    post({ type: 'progress', loaded, total, stage: 'Downloading Python runtime' })
  }
}

function clearDir(fs: PyodideFS, dir: string): void {
  for (const name of fs.readdir(dir)) {
    if (name === '.' || name === '..') continue
    const full = `${dir}/${name}`
    if (fs.isDir(fs.stat(full).mode)) {
      clearDir(fs, full)
      fs.rmdir(full)
    } else {
      fs.unlink(full)
    }
  }
}

function safeRelPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new Error(`Invalid file path: ${path}`)
  return parts.join('/')
}

async function init(): Promise<PyodideAPI> {
  post({ type: 'progress', loaded: 0, total: 0, stage: 'Starting' })
  try {
    await prefetchWithProgress(`${INDEX_URL}pyodide.asm.wasm`)
  } catch {
    // Progress is best-effort; loadPyodide fetches on its own.
  }
  post({ type: 'progress', loaded: 0, total: 0, stage: 'Initialising Python' })
  const mod = (await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`)) as PyodideModule
  const pyodide = await mod.loadPyodide({ indexURL: INDEX_URL })
  pyodide.FS.mkdirTree(HARNESS_DIR)
  pyodide.FS.writeFile(`${HARNESS_DIR}/harness.py`, harnessSource)
  pyodide.FS.mkdirTree(WORK_ROOT)
  return pyodide
}

const ready: Promise<PyodideAPI> = init()
ready.then(
  () => post({ type: 'ready' }),
  (e: unknown) => post({ type: 'error', id: null, message: e instanceof Error ? e.message : String(e) }),
)

function runTests(pyodide: PyodideAPI, files: Record<string, string>): string {
  const fs = pyodide.FS
  fs.mkdirTree(WORK_ROOT)
  clearDir(fs, WORK_ROOT)
  for (const [path, content] of Object.entries(files)) {
    const rel = safeRelPath(path)
    if (!rel) continue
    const full = `${WORK_ROOT}/${rel}`
    fs.mkdirTree(full.slice(0, full.lastIndexOf('/')))
    fs.writeFile(full, content)
  }
  const out = pyodide.runPython(
    [
      'import sys',
      `if ${JSON.stringify(HARNESS_DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(HARNESS_DIR)})`,
      'import harness',
      `harness.run(${JSON.stringify(WORK_ROOT)})`,
    ].join('\n'),
  )
  if (typeof out !== 'string') throw new Error('Harness did not return a JSON string')
  return out
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type !== 'run') return
  ready.then(
    (pyodide) => {
      try {
        post({ type: 'result', id: msg.id, result: parseHarnessOutput(runTests(pyodide, msg.files)) })
      } catch (e) {
        post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
      }
    },
    (e: unknown) => post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) }),
  )
})
