import { supabase } from './supabase'
import type { Question, Session, SessionPhase, SessionWithQuestion } from '../types/db'

function fail(action: string, error: { message?: string } | null | undefined): never {
  throw new Error(`${action}: ${error?.message ?? 'unknown error'}`)
}

const SESSION_SELECT = '*, question:questions(*)'

export async function getSession(id: string): Promise<SessionWithQuestion> {
  const { data, error } = await supabase
    .from('sessions')
    .select(SESSION_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) fail('Could not load the session', error)
  if (!data) throw new Error('Session not found or you do not have access to it')
  return data as unknown as SessionWithQuestion
}

export async function claimSession(id: string): Promise<Session> {
  const { data, error } = await supabase.rpc('claim_session', { p_session_id: id })
  if (error) fail('Could not join the session', error)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Could not join the session: no session returned')
  return row as Session
}

export function sessionLink(sessionId: string): string {
  return `${window.location.origin}/session/${sessionId}`
}

export interface CreateInterviewResult {
  session_id: string
  sent: { interviewer: boolean; interviewee: boolean }
  errors?: Record<string, string> | string[] | string
}

async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context
  if (ctx && typeof (ctx as Response).json === 'function') {
    const res = ctx as Response
    try {
      const body = (await res.clone().json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error) return body.error
    } catch {
      /* fall through */
    }
    if (res.status === 429) return 'Too many requests. Please wait a few minutes and try again.'
  }
  return (error as { message?: string } | null)?.message || 'Could not create the interview'
}

export async function createInterview(args: {
  questionId: string
  interviewerEmail: string
  intervieweeEmail: string
}): Promise<CreateInterviewResult> {
  const { data, error } = await supabase.functions.invoke('create-interview', {
    body: {
      question_id: args.questionId,
      interviewer_email: args.interviewerEmail.trim().toLowerCase(),
      interviewee_email: args.intervieweeEmail.trim().toLowerCase(),
    },
  })
  if (error) throw new Error(await functionErrorMessage(error))
  if (!data || typeof (data as CreateInterviewResult).session_id !== 'string') {
    const msg = (data as { error?: string } | null)?.error
    throw new Error(msg || 'Could not create the interview: unexpected response')
  }
  return data as CreateInterviewResult
}

export async function listPublicQuestions(): Promise<Question[]> {
  const { data, error } = await supabase.from('questions').select('*').order('title')
  if (error) fail('Could not load questions', error)
  return (data ?? []) as Question[]
}

export async function getQuestionBySlug(slug: string): Promise<Question | null> {
  const { data, error } = await supabase.from('questions').select('*').eq('slug', slug).maybeSingle()
  if (error) fail('Could not load the question', error)
  return (data as Question | null) ?? null
}

export async function listMySessions(): Promise<SessionWithQuestion[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select(SESSION_SELECT)
    .order('created_at', { ascending: false })
  if (error) fail('Could not load your sessions', error)
  return (data ?? []) as unknown as SessionWithQuestion[]
}

export async function setPhase(sessionId: string, phase: SessionPhase): Promise<Session> {
  const { data, error } = await supabase.rpc('set_phase', {
    p_session_id: sessionId,
    p_phase: phase,
  })
  if (error) fail('Could not change the session phase', error)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Could not change the session phase: no session returned')
  return row as Session
}
