// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const schemaSql = readFileSync(join(here, '../migrations/20261009000000_schema.sql'), 'utf8')

const ALICE = { id: '00000000-0000-0000-0000-00000000000a', email: 'alice@example.com' }
const BOB = { id: '00000000-0000-0000-0000-00000000000b', email: 'bob@example.com' }
const CAROL = { id: '00000000-0000-0000-0000-00000000000c', email: 'carol@example.com' }
type User = typeof ALICE

const Q = '11111111-1111-1111-1111-111111111111'
const BUG = '22222222-2222-2222-2222-222222222222'

let db: PGlite

/** Run sql as a Supabase-like role. user=null => no JWT claims. */
async function as<T = Record<string, unknown>>(
  role: 'anon' | 'authenticated' | 'service_role',
  user: User | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const claims = user ? JSON.stringify({ sub: user.id, email: user.email, role }) : ''
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims])
  await db.exec(`set role ${role}`)
  try {
    const res = await db.query<T>(sql, params)
    return res.rows
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claims', '', false)`)
  }
}
const asUser = <T = Record<string, unknown>>(u: User, sql: string, p: unknown[] = []) =>
  as<T>('authenticated', u, sql, p)

/** Alice interviewer, Bob (mixed-case invite) interviewee, claimed. Returns session id. */
async function newSession(): Promise<string> {
  const [s] = await asUser<{ id: string }>(
    ALICE,
    `select * from create_session($1, 'interviewer', 'Bob@Example.COM')`,
    [Q],
  )
  await asUser(BOB, `select * from claim_session($1)`, [s.id])
  return s.id
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, service_role;
  `)
  await db.exec(schemaSql)
  // Supabase grants service_role everything via default privileges; emulate.
  await db.exec('grant all on all tables in schema public to service_role')
  await db.exec(`
    insert into questions (id, slug, title, prompt, constraints) values ('${Q}', 'raffle', 'Raffle', 'Do it', 'None');
    insert into question_private (question_id, checklist, followups, rubric) values ('${Q}', '["a"]', '["b"]', '[{"id":"r","label":"R","weight":1}]');
    insert into question_files (question_id, path, content, kind) values
      ('${Q}', 'raffle.py', 'buggy code', 'buggy'), ('${Q}', 'test_raffle.py', 'tests', 'test');
    insert into question_reference_files (question_id, path, content) values ('${Q}', 'raffle.py', 'correct code');
    insert into question_bugs (id, question_id, title) values ('${BUG}', '${Q}', 'Bug one');
  `)
})
afterAll(async () => {
  await db.close()
})

const PRIVATE_TABLES = [
  'question_private',
  'question_files',
  'question_reference_files',
  'question_bugs',
  'bug_status',
  'session_notes',
]

async function seedPrivateRows(sid: string) {
  await db.query(`insert into bug_status (session_id, bug_id, state) values ($1, $2, 'found')`, [sid, BUG])
  await db.query(`insert into session_notes (session_id, author_id, body) values ($1, $2, 'secret')`, [sid, ALICE.id])
}

describe('(1)+(2) private data visibility', () => {
  for (const phase of ['briefing', 'debugging'] as const) {
    it(`interviewee sees nothing private in ${phase}; interviewer sees it`, async () => {
      const sid = await newSession()
      await seedPrivateRows(sid)
      if (phase === 'debugging') await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])

      for (const t of PRIVATE_TABLES) {
        const bobRows = await asUser(BOB, `select * from ${t}`)
        expect(bobRows, `interviewee must not read ${t}`).toHaveLength(0)
        const aliceRows = await asUser(ALICE, `select * from ${t}`)
        expect(aliceRows.length, `interviewer must read ${t}`).toBeGreaterThan(0)
      }
      // review is not visible to the interviewee before completion either
      await db.query(`insert into session_reviews (session_id, score) values ($1, 4)`, [sid])
      expect(await asUser(BOB, `select * from session_reviews where session_id = $1`, [sid])).toHaveLength(0)
      expect(await asUser(ALICE, `select * from session_reviews where session_id = $1`, [sid])).toHaveLength(1)
    })
  }

  it('interviewee can read the public question fields and the review once completed', async () => {
    const sid = await newSession()
    expect(await asUser(BOB, `select title, prompt, constraints from questions`)).toHaveLength(1)
    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    await asUser(ALICE, `select * from set_phase($1, 'completed')`, [sid])
    await asUser(ALICE, `insert into session_reviews (session_id, score) values ($1, 5)`, [sid])
    expect(await asUser(BOB, `select * from session_reviews where session_id = $1`, [sid])).toHaveLength(1)
  })

  it('interviewee cannot write private tables', async () => {
    const sid = await newSession()
    await expect(asUser(BOB, `insert into session_notes (session_id, author_id, body) values ($1, $2, 'x')`, [sid, BOB.id])).rejects.toThrow()
    await expect(asUser(BOB, `insert into bug_status (session_id, bug_id, state) values ($1, $2, 'found')`, [sid, BUG])).rejects.toThrow()
    await expect(asUser(BOB, `insert into questions (slug, title, prompt) values ('x','x','x')`)).rejects.toThrow()
  })
})

describe('(3) third user', () => {
  it('cannot see the session, files or any session data', async () => {
    const sid = await newSession()
    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    await db.query(`insert into test_runs (session_id) values ($1)`, [sid])
    await db.query(`insert into ai_messages (session_id, role, content) values ($1, 'user', 'hi')`, [sid])
    for (const t of ['sessions', 'session_files', 'test_runs', 'ai_messages', 'bug_status', 'session_notes', ...PRIVATE_TABLES]) {
      expect(await asUser(CAROL, `select * from ${t}`), t).toHaveLength(0)
    }
    await expect(asUser(CAROL, `select * from set_phase($1, 'completed')`, [sid])).rejects.toThrow()
    await expect(asUser(CAROL, `select * from claim_session($1)`, [sid])).rejects.toThrow()
  })
})

describe('create_session', () => {
  it('validates input and lowercases emails', async () => {
    const [s] = await asUser<any>(ALICE, `select * from create_session($1, 'interviewee', ' Bob@Example.com ')`, [Q])
    expect(s.interviewee_id).toBe(ALICE.id)
    expect(s.interviewer_id).toBeNull()
    expect(s.interviewer_email).toBe('bob@example.com')
    expect(s.interviewee_email).toBe(ALICE.email)
    expect(s.created_by).toBe(ALICE.id)
    // creator can see their session
    expect(await asUser(ALICE, `select id from sessions where id = $1`, [s.id])).toHaveLength(1)

    await expect(asUser(ALICE, `select * from create_session($1, 'boss', 'b@x.com')`, [Q])).rejects.toThrow(/role/)
    await expect(asUser(ALICE, `select * from create_session($1, 'interviewer', '  ')`, [Q])).rejects.toThrow(/email/)
    await expect(asUser(ALICE, `select * from create_session($1, 'interviewer', 'ALICE@example.com')`, [Q])).rejects.toThrow(/differ/)
    await expect(
      asUser(ALICE, `select * from create_session('99999999-9999-9999-9999-999999999999', 'interviewer', 'b@x.com')`),
    ).rejects.toThrow(/question/)
    await expect(asUser(ALICE, `insert into sessions (question_id, created_by, interviewer_email, interviewee_email) values ($1, $2, 'a', 'b')`, [Q, ALICE.id])).rejects.toThrow()
  })
})

describe('(4) claim_session', () => {
  it('works with matching email (case-insensitive) and fails otherwise', async () => {
    const [s] = await asUser<any>(ALICE, `select * from create_session($1, 'interviewer', 'bob@example.com')`, [Q])
    await expect(asUser(CAROL, `select * from claim_session($1)`, [s.id])).rejects.toThrow(/no open slot/)
    const upperBob = { ...BOB, email: 'BOB@Example.com' }
    const [c] = await asUser<any>(upperBob, `select * from claim_session($1)`, [s.id])
    expect(c.interviewee_id).toBe(BOB.id)
    // idempotent for the same user
    const [again] = await asUser<any>(BOB, `select * from claim_session($1)`, [s.id])
    expect(again.interviewee_id).toBe(BOB.id)
    // slot taken: another account with same email cannot take it
    const other = { id: '00000000-0000-0000-0000-0000000000dd', email: 'bob@example.com' }
    await expect(asUser(other, `select * from claim_session($1)`, [s.id])).rejects.toThrow(/no open slot/)
    await expect(asUser(BOB, `select * from claim_session('99999999-9999-9999-9999-999999999999')`)).rejects.toThrow(/not found/)
  })
})

describe('(5) set_phase', () => {
  it('copies files, is interviewer-only and forward-only', async () => {
    const sid = await newSession()
    expect(await asUser(BOB, `select * from session_files where session_id = $1`, [sid])).toHaveLength(0)
    await expect(asUser(BOB, `select * from set_phase($1, 'debugging')`, [sid])).rejects.toThrow(/interviewer/)

    const [d] = await asUser<any>(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    expect(d.phase).toBe('debugging')
    expect(d.debugging_started_at).not.toBeNull()
    const files = await asUser<any>(BOB, `select path, content, kind from session_files where session_id = $1 order by path`, [sid])
    expect(files).toEqual([
      { path: 'raffle.py', content: 'buggy code', kind: 'code' },
      { path: 'test_raffle.py', content: 'tests', kind: 'test' },
    ])
    // reference never copied
    expect(files.some((f) => f.content === 'correct code')).toBe(false)

    await expect(asUser(ALICE, `select * from set_phase($1, 'briefing')`, [sid])).rejects.toThrow(/invalid phase/)
    await expect(asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])).rejects.toThrow(/invalid phase/)
    const [c] = await asUser<any>(ALICE, `select * from set_phase($1, 'completed')`, [sid])
    expect(c.phase).toBe('completed')
    expect(c.completed_at).not.toBeNull()
    await expect(asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])).rejects.toThrow(/invalid phase/)

    // cannot skip briefing -> completed
    const sid2 = await newSession()
    await expect(asUser(ALICE, `select * from set_phase($1, 'completed')`, [sid2])).rejects.toThrow(/invalid phase/)
    // direct update denied
    await expect(asUser(ALICE, `update sessions set phase = 'completed' where id = $1`, [sid2])).rejects.toThrow()
  })
})

describe('(6) session_files writes', () => {
  it('interviewee updates content only in debugging, never other sessions or other columns', async () => {
    const sid = await newSession()
    const other = await newSession()
    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [other])

    // other session: Bob is interviewee in both, so make sure a different Bob-less session is untouchable
    const [foreign] = await asUser<any>(CAROL, `select * from create_session($1, 'interviewer', 'dave@example.com')`, [Q])
    await asUser(CAROL, `select * from set_phase($1, 'debugging')`, [foreign.id])
    await db.query(`insert into session_files (session_id, path, content, kind) values ($1, 'f.py', 'orig', 'code')`, [foreign.id])

    // briefing: no files exist yet, and nothing is updatable
    await db.query(`insert into session_files (session_id, path, content, kind) values ($1, 'brief.py', 'orig', 'code')`, [sid])
    let r = await asUser(BOB, `update session_files set content = 'hack' where session_id = $1 returning path`, [sid])
    expect(r).toHaveLength(0)

    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    r = await asUser(BOB, `update session_files set content = 'fixed' where session_id = $1 and path = 'raffle.py' returning path`, [sid])
    expect(r).toHaveLength(1)
    const [row] = await db.query<any>(`select content from session_files where session_id = $1 and path = 'raffle.py'`, [sid]).then((x) => x.rows)
    expect(row.content).toBe('fixed')

    // others' files
    r = await asUser(BOB, `update session_files set content = 'hack' where session_id = $1 returning path`, [foreign.id])
    expect(r).toHaveLength(0)
    const [f] = (await db.query<any>(`select content from session_files where session_id = $1 and path = 'f.py'`, [foreign.id])).rows
    expect(f.content).toBe('orig')

    // interviewer cannot edit, no insert/delete/path change for anyone
    r = await asUser(ALICE, `update session_files set content = 'hack' where session_id = $1 returning path`, [sid])
    expect(r).toHaveLength(0)
    await expect(asUser(BOB, `insert into session_files (session_id, path, content, kind) values ($1, 'n.py', 'x', 'code')`, [sid])).rejects.toThrow()
    await expect(asUser(BOB, `delete from session_files where session_id = $1`, [sid])).rejects.toThrow()
    await expect(asUser(BOB, `update session_files set path = 'z.py' where session_id = $1`, [sid])).rejects.toThrow()

    // completed: locked again
    await asUser(ALICE, `select * from set_phase($1, 'completed')`, [sid])
    r = await asUser(BOB, `update session_files set content = 'late' where session_id = $1 returning path`, [sid])
    expect(r).toHaveLength(0)
  })

  it('test_runs insert only by interviewee during debugging', async () => {
    const sid = await newSession()
    const ins = `insert into test_runs (session_id, passed, failed) values ($1, 1, 2)`
    await expect(asUser(BOB, ins, [sid])).rejects.toThrow()
    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    await expect(asUser(ALICE, ins, [sid])).rejects.toThrow()
    await expect(asUser(CAROL, ins, [sid])).rejects.toThrow()
    await asUser(BOB, ins, [sid])
    expect(await asUser(ALICE, `select * from test_runs where session_id = $1`, [sid])).toHaveLength(1)
    expect(await asUser(BOB, `select * from test_runs where session_id = $1`, [sid])).toHaveLength(1)
  })
})

describe('(7) ai_messages', () => {
  it('clients cannot insert; service role can; participants can read', async () => {
    const sid = await newSession()
    await asUser(ALICE, `select * from set_phase($1, 'debugging')`, [sid])
    const ins = `insert into ai_messages (session_id, role, content) values ($1, 'user', 'hello')`
    await expect(asUser(BOB, ins, [sid])).rejects.toThrow()
    await expect(asUser(ALICE, ins, [sid])).rejects.toThrow()
    await as('service_role', null, ins, [sid])
    expect(await asUser(BOB, `select * from ai_messages where session_id = $1`, [sid])).toHaveLength(1)
    expect(await asUser(ALICE, `select * from ai_messages where session_id = $1`, [sid])).toHaveLength(1)
    expect(await asUser(CAROL, `select * from ai_messages`)).toHaveLength(0)
  })
})

describe('(8) anon', () => {
  it('can read nothing and call nothing', async () => {
    const tables = [
      'questions', 'question_private', 'question_files', 'question_reference_files', 'question_bugs',
      'sessions', 'session_files', 'test_runs', 'ai_messages', 'bug_status', 'session_notes', 'session_reviews',
    ]
    for (const t of tables) {
      await expect(as('anon', null, `select * from ${t}`), t).rejects.toThrow(/permission denied/)
    }
    await expect(as('anon', null, `select * from create_session($1, 'interviewer', 'x@y.com')`, [Q])).rejects.toThrow(/permission denied/)
    await expect(as('anon', null, `select * from claim_session($1)`, [Q])).rejects.toThrow(/permission denied/)
    await expect(as('anon', null, `select * from set_phase($1, 'debugging')`, [Q])).rejects.toThrow(/permission denied/)
  })
})
