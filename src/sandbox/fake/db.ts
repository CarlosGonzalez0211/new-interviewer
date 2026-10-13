import { uuid } from './ids'

export type Row = Record<string, unknown>
export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE'

export interface DbChange {
  table: string
  type: ChangeType
  new: Row | null
  old: Row | null
}

export interface DbError {
  message: string
  code: string
  details: string | null
  hint: string | null
}

export function dbError(message: string, code: string): DbError {
  return { message, code, details: null, hint: null }
}

/** Thrown inside the fake for constraint violations; the query layer turns it into `{ error }`. */
export class DbException extends Error {
  readonly error: DbError
  constructor(message: string, code: string) {
    super(message)
    this.error = dbError(message, code)
  }
}

interface TableDef {
  /** Primary key columns (in order). */
  pk: string[]
  /** Column defaults; functions are evaluated per insert. */
  defaults: Record<string, () => unknown>
  /** Columns refreshed with now() on every update (mirrors the `updated_at` triggers). */
  touch?: string[]
}

let lastTick = 0
/** Strictly increasing ISO timestamps, so ordering by created_at is stable even within one millisecond. */
export function nowIso(): string {
  const t = Math.max(Date.now(), lastTick + 1)
  lastTick = t
  return new Date(t).toISOString()
}

const idDefault = { id: () => uuid() }
const createdAt = { created_at: nowIso }

export const TABLES: Record<string, TableDef> = {
  questions: { pk: ['id'], defaults: { ...idDefault, constraints: () => '', language: () => 'python' } },
  question_private: {
    pk: ['question_id'],
    defaults: { checklist: () => [], followups: () => [], rubric: () => [] },
  },
  question_files: { pk: ['id'], defaults: { ...idDefault } },
  question_reference_files: { pk: ['id'], defaults: { ...idDefault } },
  question_bugs: { pk: ['id'], defaults: { ...idDefault, hint: () => '' } },
  sessions: {
    pk: ['id'],
    defaults: {
      ...idDefault,
      ...createdAt,
      phase: () => 'briefing',
      interviewer_id: () => null,
      interviewee_id: () => null,
      debugging_started_at: () => null,
      completed_at: () => null,
    },
  },
  session_files: {
    pk: ['session_id', 'path'],
    defaults: { updated_at: nowIso, kind: () => 'code' },
    touch: ['updated_at'],
  },
  session_workspace: {
    pk: ['session_id'],
    defaults: { notes: () => '', yjs_state: () => null, whiteboard: () => null, updated_at: nowIso },
    touch: ['updated_at'],
  },
  test_runs: {
    pk: ['id'],
    defaults: {
      ...idDefault,
      ...createdAt,
      passed: () => 0,
      failed: () => 0,
      errored: () => 0,
      results: () => [],
      stdout: () => '',
    },
  },
  ai_messages: { pk: ['id'], defaults: { ...idDefault, ...createdAt } },
  bug_status: { pk: ['session_id', 'bug_id'], defaults: { updated_at: nowIso }, touch: ['updated_at'] },
  session_notes: { pk: ['id'], defaults: { ...idDefault, ...createdAt } },
  session_reviews: {
    pk: ['session_id'],
    defaults: { score: () => null, summary: () => '', rubric_scores: () => ({}), updated_at: nowIso },
    touch: ['updated_at'],
  },
}

const clone = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v))

/**
 * In-memory tables. Rows live in plain Maps keyed by table, then by primary-key string. Every mutation emits a
 * DbChange to the registered listeners (the fake realtime layer turns those into postgres_changes events).
 */
export class FakeDb {
  private tables = new Map<string, Map<string, Row>>()
  private listeners = new Set<(c: DbChange) => void>()

  constructor() {
    this.clear()
  }

  /** Drop every row (listeners stay registered). No change events are emitted. */
  clear(): void {
    this.tables = new Map(Object.keys(TABLES).map((t) => [t, new Map<string, Row>()]))
  }

  onChange(fn: (c: DbChange) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(c: DbChange) {
    for (const l of [...this.listeners]) l({ ...c, new: clone(c.new), old: clone(c.old) })
  }

  private table(name: string): { rows: Map<string, Row>; def: TableDef } {
    const def = TABLES[name]
    const rows = this.tables.get(name)
    if (!def || !rows) throw new DbException(`relation "public.${name}" does not exist`, '42P01')
    return { rows, def }
  }

  private keyOf(def: TableDef, row: Row): string {
    return JSON.stringify(def.pk.map((c) => row[c] ?? null))
  }

  /** All rows (cloned), insertion order. */
  all(name: string): Row[] {
    return [...this.table(name).rows.values()].map(clone)
  }

  /** Stored rows without cloning: callers must treat them as read-only. */
  rawRows(name: string): Row[] {
    return [...this.table(name).rows.values()]
  }

  find(name: string, where: Row): Row | undefined {
    return this.all(name).find((r) => Object.entries(where).every(([k, v]) => r[k] === v))
  }

  private complete(def: TableDef, input: Row): Row {
    const row: Row = {}
    for (const [k, v] of Object.entries(def.defaults)) row[k] = v()
    for (const [k, v] of Object.entries(input)) if (v !== undefined) row[k] = clone(v)
    for (const col of def.pk) {
      if (row[col] === undefined || row[col] === null) {
        throw new DbException(`null value in column "${col}" violates not-null constraint`, '23502')
      }
    }
    return row
  }

  insert(name: string, input: Row): Row {
    const { rows, def } = this.table(name)
    const row = this.complete(def, input)
    const key = this.keyOf(def, row)
    if (rows.has(key)) {
      throw new DbException(`duplicate key value violates unique constraint "${name}_pkey"`, '23505')
    }
    rows.set(key, row)
    this.emit({ table: name, type: 'INSERT', new: row, old: null })
    return clone(row)
  }

  /** Merge `patch` into a stored row. Returns the updated clone. */
  updateRow(name: string, row: Row, patch: Row): Row {
    const { rows, def } = this.table(name)
    const oldKey = this.keyOf(def, row)
    const old = clone(row)
    const next: Row = { ...row }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = clone(v)
    for (const col of def.touch ?? []) if (!(col in patch)) next[col] = nowIso()
    const newKey = this.keyOf(def, next)
    if (newKey !== oldKey) {
      if (rows.has(newKey)) {
        throw new DbException(`duplicate key value violates unique constraint "${name}_pkey"`, '23505')
      }
      rows.delete(oldKey)
    }
    rows.set(newKey, next)
    this.emit({ table: name, type: 'UPDATE', new: next, old })
    return clone(next)
  }

  deleteRow(name: string, row: Row): Row {
    const { rows, def } = this.table(name)
    rows.delete(this.keyOf(def, row))
    this.emit({ table: name, type: 'DELETE', new: null, old: row })
    return clone(row)
  }

  /** Insert, or merge into the existing row with the same conflict key (PostgREST on_conflict + merge-duplicates). */
  upsert(name: string, input: Row, onConflict?: string): Row {
    const { def } = this.table(name)
    const cols = onConflict ? onConflict.split(',').map((c) => c.trim()).filter(Boolean) : def.pk
    const target = this.rawRows(name).find((r) => cols.every((c) => r[c] === input[c]))
    if (target) return this.updateRow(name, target, input)
    return this.insert(name, input)
  }
}
