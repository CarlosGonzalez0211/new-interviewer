import { FunctionsHttpError } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SANDBOX_INTERVIEWER } from '../identity'
import type { SandboxUser } from '../identity'
import { getAiSettings } from '../settings'
import { handleAiChat } from './ai'
import type { AiDeps, FunctionResult } from './ai'
import { DbException, FakeDb, dbError, nowIso } from './db'
import type { DbError, Row } from './db'
import { FakeQuery } from './query'
import { FakeChannel, RealtimeHub } from './realtime'
import type { FakeChannelConfig } from './realtime'

export type FunctionHandler = (body: unknown) => Promise<FunctionResult>

export interface FakeSupabaseOptions {
  /** Identity used by RPCs that depend on auth.uid() (create_session / claim_session) and by auth.* */
  currentUser?: SandboxUser
  /** Override AI settings / fetch (tests). */
  ai?: Partial<AiDeps>
  /** Extra or replacement edge functions. */
  functions?: Record<string, FunctionHandler>
}

const PHASES = ['briefing', 'debugging', 'completed'] as const

function rpcFail(message: string, code: string): { data: null; error: DbError } {
  return { data: null, error: dbError(message, code) }
}

/**
 * In-memory stand-in for the supabase-js client, covering exactly the surface this app uses. Rows live in a FakeDb,
 * `channel()` goes through a RealtimeHub, and `functions.invoke('ai-chat')` runs the browser AI handler.
 */
export function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const db = new FakeDb()
  const hub = new RealtimeHub(db)
  const state = { currentUser: options.currentUser ?? SANDBOX_INTERVIEWER }
  const authListeners = new Set<(event: string, session: unknown) => void>()

  const sessionFor = (u: SandboxUser) => ({
    // Empty on purpose: keepalive-on-unload code treats a falsy token as "nothing to send".
    access_token: '',
    refresh_token: '',
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: u.id,
      email: u.email,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  })

  // ---- RPCs (mirror supabase/migrations/20261009000000_schema.sql) ----
  const rpcs: Record<string, (args: Record<string, unknown>) => { data: unknown; error: DbError | null }> = {
    create_session(args) {
      const me = state.currentUser
      const role = args.p_my_role
      const other = String(args.p_other_email ?? '').trim().toLowerCase()
      if (role !== 'interviewer' && role !== 'interviewee') {
        return rpcFail('invalid role: must be interviewer or interviewee', '22023')
      }
      if (!other) return rpcFail('other email is required', '22023')
      if (other === me.email.toLowerCase()) return rpcFail('other email must differ from your own', '22023')
      if (!db.find('questions', { id: args.p_question_id })) return rpcFail('question not found', '22023')
      const row = db.insert('sessions', {
        question_id: args.p_question_id,
        created_by: me.id,
        interviewer_id: role === 'interviewer' ? me.id : null,
        interviewee_id: role === 'interviewee' ? me.id : null,
        interviewer_email: role === 'interviewer' ? me.email.toLowerCase() : other,
        interviewee_email: role === 'interviewee' ? me.email.toLowerCase() : other,
      })
      return { data: row, error: null }
    },

    claim_session(args) {
      const me = state.currentUser
      const row = db.rawRows('sessions').find((r) => r.id === args.p_session_id)
      if (!row) return rpcFail('session not found', 'P0002')
      if (me.id === row.interviewer_id || me.id === row.interviewee_id) return { data: structuredClone(row), error: null }
      const email = me.email.toLowerCase()
      if (row.interviewer_id == null && row.interviewer_email === email) {
        return { data: db.updateRow('sessions', row, { interviewer_id: me.id }), error: null }
      }
      if (row.interviewee_id == null && row.interviewee_email === email) {
        return { data: db.updateRow('sessions', row, { interviewee_id: me.id }), error: null }
      }
      return rpcFail('no open slot for this account on this session', '42501')
    },

    set_phase(args) {
      const row = db.rawRows('sessions').find((r) => r.id === args.p_session_id)
      if (!row) return rpcFail('session not found', 'P0002')
      const next = args.p_phase
      const cur = String(row.phase)
      const forward =
        (cur === 'briefing' && next === 'debugging') || (cur === 'debugging' && next === 'completed')
      if (!PHASES.includes(next as (typeof PHASES)[number]) || !forward) {
        return rpcFail(`invalid phase transition ${cur} -> ${String(next)}`, '22023')
      }
      if (next === 'debugging') {
        const sessionId = String(row.id)
        for (const qf of db.rawRows('question_files').filter((f) => f.question_id === row.question_id)) {
          const exists = db
            .rawRows('session_files')
            .some((f) => f.session_id === sessionId && f.path === qf.path)
          if (exists) continue // on conflict do nothing
          db.insert('session_files', {
            session_id: sessionId,
            path: qf.path,
            content: qf.content,
            kind: qf.kind === 'buggy' ? 'code' : 'test',
          })
        }
        return { data: db.updateRow('sessions', row, { phase: next, debugging_started_at: nowIso() }), error: null }
      }
      return { data: db.updateRow('sessions', row, { phase: next, completed_at: nowIso() }), error: null }
    },
  }

  // ---- edge functions ----
  const aiDeps: AiDeps = { getSettings: getAiSettings, ...options.ai }
  const functions: Record<string, FunctionHandler> = {
    'ai-chat': (body) => handleAiChat(db, body, aiDeps),
    ...options.functions,
  }

  // ---- channels ----
  const channels = new Set<FakeChannel>()

  const client = {
    from: (table: string) => new FakeQuery(db, table),

    rpc(name: string, args: Record<string, unknown> = {}) {
      return Promise.resolve().then(() => {
        const fn = rpcs[name]
        if (!fn) return rpcFail(`function public.${name} does not exist`, '42883')
        try {
          return fn(args)
        } catch (e) {
          if (e instanceof DbException) return { data: null, error: e.error }
          throw e
        }
      })
    },

    channel(name: string, opts?: FakeChannelConfig) {
      const ch = new FakeChannel(name, opts, hub, (c) => channels.delete(c))
      channels.add(ch)
      return ch
    },

    // Deliberately empty: with a real client a same-topic channel would be replaced; here every channel is
    // independent so the interviewer and interviewee panes never evict each other.
    getChannels: () => [] as FakeChannel[],

    async removeChannel(ch: FakeChannel) {
      await ch.unsubscribe()
      return 'ok' as const
    },

    async removeAllChannels() {
      await Promise.all([...channels].map((c) => c.unsubscribe()))
      return []
    },

    realtime: {
      setAuth: async (_token?: string) => undefined,
    },

    auth: {
      async getSession() {
        return { data: { session: sessionFor(state.currentUser) }, error: null }
      },
      async getUser() {
        return { data: { user: sessionFor(state.currentUser).user }, error: null }
      },
      onAuthStateChange(cb: (event: string, session: unknown) => void) {
        authListeners.add(cb)
        queueMicrotask(() => {
          if (authListeners.has(cb)) cb('INITIAL_SESSION', sessionFor(state.currentUser))
        })
        return { data: { subscription: { id: 'sandbox', callback: cb, unsubscribe: () => authListeners.delete(cb) } } }
      },
      async signOut() {
        return { error: null }
      },
      async signInWithOtp() {
        return { data: {}, error: { message: 'Sign-in is disabled in the sandbox.' } }
      },
    },

    functions: {
      async invoke(name: string, opts?: { body?: unknown }) {
        const fn = functions[name]
        if (!fn) {
          const res = new Response(JSON.stringify({ error: `Function ${name} is not available in the sandbox.` }), { status: 404 })
          return { data: null, error: new FunctionsHttpError(res) }
        }
        const out = await fn(opts?.body)
        if (out.status >= 200 && out.status < 300) return { data: out.body, error: null }
        const res = new Response(JSON.stringify(out.body), {
          status: out.status,
          headers: { 'Content-Type': 'application/json' },
        })
        return { data: null, error: new FunctionsHttpError(res) }
      },
    },
  }

  return {
    /** Install with setSupabaseBackend(). */
    client: client as unknown as SupabaseClient,
    raw: client,
    db,
    hub,
    state,
    /** Who auth.uid() is for RPCs and auth.getSession(). */
    setCurrentUser(u: SandboxUser) {
      state.currentUser = u
    },
    /** Insert a row, bypassing RLS (test / seed helper). */
    insert(table: string, row: Row): Row {
      return db.insert(table, row)
    },
  }
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>
