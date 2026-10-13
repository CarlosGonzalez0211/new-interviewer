import { DbException, dbError } from './db'
import type { DbError, FakeDb, Row } from './db'

export interface QueryResult<T = unknown> {
  data: T | null
  error: DbError | null
  count: number | null
  status: number
  statusText: string
}

type Filter = (row: Row) => boolean
type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'
type Mode = 'many' | 'single' | 'maybeSingle'

const singular = (table: string) => table.replace(/s$/, '')

/** Compare two column values the way Postgres orders them (nulls last ascending). */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

function splitTop(spec: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of spec) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Project rows to the requested select string, resolving `alias:table(cols)` joins through `<table>_id` keys. */
export function project(db: FakeDb, table: string, rows: Row[], spec: string): Row[] {
  const items = splitTop(spec || '*')
  return rows.map((row) => {
    const out: Row = {}
    for (const item of items) {
      const join = /^(?:(\w+):)?(\w+)(?:![\w]+)?\((.*)\)$/s.exec(item)
      if (join) {
        const [, alias, target, inner] = join
        const key = alias || target
        const fk = `${singular(target)}_id`
        if (fk in row) {
          const found = db.rawRows(target).find((r) => r.id === row[fk])
          out[key] = found ? project(db, target, [found], inner)[0] : null
        } else {
          const back = `${singular(table)}_id`
          const kids = db.rawRows(target).filter((r) => r[back] === row.id)
          out[key] = project(db, target, kids, inner)
        }
      } else if (item === '*') {
        Object.assign(out, row)
      } else {
        out[item] = row[item] ?? null
      }
    }
    return structuredClone(out)
  })
}

/**
 * A thenable query builder over FakeDb covering the supabase-js (PostgREST) surface the app uses:
 * select/insert/update/upsert/delete + eq/neq/gt/gte/lt/lte/in/is/match + order/limit + single/maybeSingle + count/head.
 */
export class FakeQuery<T = unknown> implements PromiseLike<QueryResult<T>> {
  private op: Op = 'select'
  private selectSpec: string | null = null
  private values: Row[] = []
  private patch: Row = {}
  private onConflict: string | undefined
  private filters: Filter[] = []
  private orders: { col: string; asc: boolean }[] = []
  private limitN: number | null = null
  private mode: Mode = 'many'
  private wantCount = false
  private head = false

  private db: FakeDb
  private table: string

  constructor(db: FakeDb, table: string) {
    this.db = db
    this.table = table
  }

  select(columns = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this.selectSpec = columns
    if (opts?.count) this.wantCount = true
    if (opts?.head) this.head = true
    return this
  }

  insert(values: Row | Row[]): this {
    this.op = 'insert'
    this.values = Array.isArray(values) ? values : [values]
    return this
  }

  upsert(values: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = 'upsert'
    this.values = Array.isArray(values) ? values : [values]
    this.onConflict = opts?.onConflict
    return this
  }

  update(patch: Row): this {
    this.op = 'update'
    this.patch = patch
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  private where(f: Filter): this {
    this.filters.push(f)
    return this
  }

  eq(col: string, val: unknown): this {
    return this.where((r) => (r[col] ?? null) === (val ?? null))
  }
  neq(col: string, val: unknown): this {
    return this.where((r) => (r[col] ?? null) !== (val ?? null))
  }
  gt(col: string, val: unknown): this {
    return this.where((r) => r[col] != null && compare(r[col], val) > 0)
  }
  gte(col: string, val: unknown): this {
    return this.where((r) => r[col] != null && compare(r[col], val) >= 0)
  }
  lt(col: string, val: unknown): this {
    return this.where((r) => r[col] != null && compare(r[col], val) < 0)
  }
  lte(col: string, val: unknown): this {
    return this.where((r) => r[col] != null && compare(r[col], val) <= 0)
  }
  in(col: string, vals: readonly unknown[]): this {
    return this.where((r) => vals.includes(r[col]))
  }
  is(col: string, val: null | boolean): this {
    return this.where((r) => (r[col] ?? null) === val)
  }
  match(query: Row): this {
    for (const [k, v] of Object.entries(query)) this.eq(k, v)
    return this
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending ?? true })
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  single(): this {
    this.mode = 'single'
    return this
  }

  maybeSingle(): this {
    this.mode = 'maybeSingle'
    return this
  }

  private matching(): Row[] {
    let rows = this.db.rawRows(this.table).filter((r) => this.filters.every((f) => f(r)))
    if (this.orders.length) {
      const orders = this.orders
      rows = [...rows].sort((a, b) => {
        for (const o of orders) {
          const c = compare(a[o.col], b[o.col])
          if (c !== 0) return o.asc ? c : -c
        }
        return 0
      })
    }
    return rows
  }

  private run(): QueryResult<T> {
    const ok = (data: unknown, count: number | null = null): QueryResult<T> => ({
      data: data as T | null,
      error: null,
      count,
      status: this.op === 'insert' || this.op === 'upsert' ? 201 : 200,
      statusText: 'OK',
    })
    const fail = (error: DbError, status = 400): QueryResult<T> => ({
      data: null,
      error,
      count: null,
      status,
      statusText: 'Error',
    })

    try {
      let produced: Row[]
      let total: number | null = null
      if (this.op === 'select') {
        let rows = this.matching()
        total = rows.length
        if (this.limitN !== null) rows = rows.slice(0, this.limitN)
        if (this.head) return ok(null, this.wantCount ? total : null)
        produced = project(this.db, this.table, rows, this.selectSpec ?? '*')
        return this.finish(produced, ok, fail, this.wantCount ? total : null)
      }

      let written: Row[]
      if (this.op === 'insert') {
        written = this.values.map((v) => this.db.insert(this.table, v))
      } else if (this.op === 'upsert') {
        written = this.values.map((v) => this.db.upsert(this.table, v, this.onConflict))
      } else if (this.op === 'update') {
        written = this.matching().map((r) => this.db.updateRow(this.table, r, this.patch))
      } else {
        written = this.matching().map((r) => this.db.deleteRow(this.table, r))
      }
      if (this.selectSpec === null) return ok(null)
      produced = project(this.db, this.table, written, this.selectSpec)
      return this.finish(produced, ok, fail, null)
    } catch (e) {
      if (e instanceof DbException) return fail(e.error, e.error.code === '42P01' ? 404 : 409)
      return fail(dbError(e instanceof Error ? e.message : String(e), 'XX000'), 500)
    }
  }

  private finish(
    rows: Row[],
    ok: (data: unknown, count?: number | null) => QueryResult<T>,
    fail: (e: DbError, status?: number) => QueryResult<T>,
    count: number | null,
  ): QueryResult<T> {
    if (this.mode === 'many') return ok(rows, count)
    if (rows.length === 1) return ok(rows[0], count)
    if (rows.length === 0 && this.mode === 'maybeSingle') return ok(null, count)
    return fail(
      {
        message: 'JSON object requested, multiple (or no) rows returned',
        code: 'PGRST116',
        details: `The result contains ${rows.length} rows`,
        hint: null,
      },
      406,
    )
  }

  then<R1 = QueryResult<T>, R2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected)
  }
}
