import { supabase } from './supabase'
import type { Question, Role, Session, SessionPhase, SessionWithQuestion } from '../types/db'

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

export async function createSession(args: {
  questionId: string
  myRole: Role
  otherEmail: string
}): Promise<Session> {
  const { data, error } = await supabase.rpc('create_session', {
    p_question_id: args.questionId,
    p_my_role: args.myRole,
    p_other_email: args.otherEmail.trim().toLowerCase(),
  })
  if (error) fail('Could not create the session', error)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Could not create the session: no session returned')
  return row as Session
}

export function sessionLink(sessionId: string): string {
  return `${window.location.origin}/session/${sessionId}`
}

export async function sendMagicLink(email: string, sessionId: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: sessionLink(sessionId) },
  })
  if (error) fail('Could not send the sign-in email', error)
}

export async function listQuestions(): Promise<Question[]> {
  const { data, error } = await supabase.from('questions').select('*').order('title')
  if (error) fail('Could not load questions', error)
  return (data ?? []) as Question[]
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
