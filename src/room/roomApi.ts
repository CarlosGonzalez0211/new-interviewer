import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type {
  AiMessage,
  BugStatus,
  QuestionBug,
  QuestionPrivate,
  QuestionReferenceFile,
  SessionNote,
  SessionReview,
  TestRun,
} from '../types/db'
import type { BugState } from '../types/db'
import type { TestRunResult } from '../runner/types'
import { parseModelList } from './modelPicker'
import type { ModelList } from './modelPicker'

function fail(action: string, error: { message?: string } | null | undefined): never {
  throw new Error(`${action}: ${error?.message ?? 'unknown error'}`)
}

export async function insertTestRun(sessionId: string, result: TestRunResult): Promise<TestRun> {
  const { data, error } = await supabase
    .from('test_runs')
    .insert({
      session_id: sessionId,
      passed: result.passed,
      failed: result.failed,
      errored: result.errored,
      results: result.results,
      stdout: result.stdout,
    })
    .select()
    .single()
  if (error) fail('Could not record the test run', error)
  return data as TestRun
}

export async function listTestRuns(sessionId: string): Promise<TestRun[]> {
  const { data, error } = await supabase
    .from('test_runs')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) fail('Could not load test runs', error)
  return (data ?? []) as TestRun[]
}

export async function listAiMessages(sessionId: string): Promise<AiMessage[]> {
  const { data, error } = await supabase
    .from('ai_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) fail('Could not load the AI conversation', error)
  return (data ?? []) as AiMessage[]
}

export interface AiChatReply {
  reply: string
  message_id: string
  /** Model that actually answered. */
  model: string | null
  /** True when the requested/default model failed and another one answered. */
  fallback_used: boolean
}

/** Turn a functions.invoke error into a readable message (reads the { error } body of HTTP errors). */
async function describeInvokeError(error: Error): Promise<string> {
  let detail = error.message
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.json()
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        detail = body.error
      }
    } catch {
      // keep generic message
    }
  }
  return detail
}

let modelListPromise: Promise<ModelList> | null = null

/** Usable Gemini models from the ai-chat function (Google ListModels). Cached per page load; failures are not cached. */
export function loadAiModels(): Promise<ModelList> {
  if (modelListPromise) return modelListPromise
  const p = (async () => {
    const { data, error } = await supabase.functions.invoke('ai-chat', { body: { action: 'models' } })
    if (error) throw new Error(await describeInvokeError(error))
    const list = parseModelList(data)
    if (!list) throw new Error('Unexpected models response')
    return list
  })()
  modelListPromise = p
  // A degraded list (Google unreachable) or a failure should be retried on the next mount.
  p.then(
    (l) => {
      if (l.degraded && modelListPromise === p) modelListPromise = null
    },
    () => {
      if (modelListPromise === p) modelListPromise = null
    },
  )
  return p
}

export async function invokeAiChat(sessionId: string, message: string, model?: string | null): Promise<AiChatReply> {
  const body: Record<string, unknown> = { session_id: sessionId, message }
  if (model) body.model = model
  const { data, error } = await supabase.functions.invoke('ai-chat', { body })
  if (error) throw new Error(await describeInvokeError(error))
  const d = data as Partial<AiChatReply> | null
  if (!d || typeof d.reply !== 'string') throw new Error('The AI assistant returned an unexpected response')
  return {
    reply: d.reply,
    message_id: String(d.message_id ?? ''),
    model: typeof d.model === 'string' && d.model ? d.model : null,
    fallback_used: d.fallback_used === true,
  }
}

export async function getQuestionPrivate(questionId: string): Promise<QuestionPrivate | null> {
  const { data, error } = await supabase.from('question_private').select('*').eq('question_id', questionId).maybeSingle()
  if (error) fail('Could not load interviewer notes', error)
  if (!data) return null
  const row = data as Partial<QuestionPrivate>
  return {
    question_id: questionId,
    checklist: Array.isArray(row.checklist) ? row.checklist : [],
    followups: Array.isArray(row.followups) ? row.followups : [],
    rubric: Array.isArray(row.rubric) ? row.rubric : [],
  }
}

export async function listQuestionBugs(questionId: string): Promise<QuestionBug[]> {
  const { data, error } = await supabase.from('question_bugs').select('*').eq('question_id', questionId)
  if (error) fail('Could not load the bug list', error)
  return (data ?? []) as QuestionBug[]
}

export async function listReferenceFiles(questionId: string): Promise<QuestionReferenceFile[]> {
  const { data, error } = await supabase
    .from('question_reference_files')
    .select('*')
    .eq('question_id', questionId)
    .order('path')
  if (error) fail('Could not load the reference solution', error)
  return (data ?? []) as QuestionReferenceFile[]
}

export async function listBugStatus(sessionId: string): Promise<BugStatus[]> {
  const { data, error } = await supabase.from('bug_status').select('*').eq('session_id', sessionId)
  if (error) fail('Could not load bug status', error)
  return (data ?? []) as BugStatus[]
}

export async function upsertBugStatus(sessionId: string, bugId: string, state: BugState): Promise<BugStatus> {
  const { data, error } = await supabase
    .from('bug_status')
    .upsert(
      { session_id: sessionId, bug_id: bugId, state, updated_at: new Date().toISOString() },
      { onConflict: 'session_id,bug_id' },
    )
    .select()
    .single()
  if (error) fail('Could not update the bug', error)
  return data as BugStatus
}

export async function deleteBugStatus(sessionId: string, bugId: string): Promise<void> {
  const { error } = await supabase.from('bug_status').delete().eq('session_id', sessionId).eq('bug_id', bugId)
  if (error) fail('Could not clear the bug', error)
}

export async function listNotes(sessionId: string): Promise<SessionNote[]> {
  const { data, error } = await supabase
    .from('session_notes')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) fail('Could not load notes', error)
  return (data ?? []) as SessionNote[]
}

export async function addNote(sessionId: string, authorId: string, body: string): Promise<SessionNote> {
  const { data, error } = await supabase
    .from('session_notes')
    .insert({ session_id: sessionId, author_id: authorId, body })
    .select()
    .single()
  if (error) fail('Could not save the note', error)
  return data as SessionNote
}

export async function getReview(sessionId: string): Promise<SessionReview | null> {
  const { data, error } = await supabase.from('session_reviews').select('*').eq('session_id', sessionId).maybeSingle()
  if (error) fail('Could not load the review', error)
  return (data as SessionReview | null) ?? null
}

export async function upsertReview(
  sessionId: string,
  review: { score: number | null; summary: string; rubric_scores: Record<string, number> },
): Promise<SessionReview> {
  const { data, error } = await supabase
    .from('session_reviews')
    .upsert(
      { session_id: sessionId, ...review, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' },
    )
    .select()
    .single()
  if (error) fail('Could not save the review', error)
  return data as SessionReview
}
