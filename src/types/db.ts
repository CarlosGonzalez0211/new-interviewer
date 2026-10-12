export type Role = 'interviewer' | 'interviewee'
export type SessionPhase = 'briefing' | 'debugging' | 'completed'
export type BugState = 'found' | 'fixed'

export interface Question {
  id: string
  slug: string
  title: string
  prompt: string
  constraints: string
  language: string
}

export interface RubricItem {
  id: string
  label: string
  weight: number
}

export interface QuestionPrivate {
  question_id: string
  checklist: string[]
  followups: string[]
  rubric: RubricItem[]
}

export interface QuestionFile {
  id: string
  question_id: string
  path: string
  content: string
  kind: 'buggy' | 'test'
}

export interface QuestionReferenceFile {
  id: string
  question_id: string
  path: string
  content: string
}

export interface QuestionBug {
  id: string
  question_id: string
  title: string
  description: string
  file_path: string
  hint: string
}

export interface Session {
  id: string
  question_id: string
  created_by: string
  interviewer_id: string | null
  interviewee_id: string | null
  interviewer_email: string
  interviewee_email: string
  phase: SessionPhase
  created_at: string
  debugging_started_at: string | null
  completed_at: string | null
}

export interface SessionWithQuestion extends Session {
  question: Question
}

export interface SessionFile {
  session_id: string
  path: string
  content: string
  kind: 'code' | 'test'
  updated_at: string
}

export interface TestResult {
  file: string
  name: string
  status: 'passed' | 'failed' | 'error'
  message: string
  traceback: string
}

export interface TestRun {
  id: string
  session_id: string
  passed: number
  failed: number
  errored: number
  results: TestResult[]
  stdout: string
  created_at: string
}

export interface AiMessage {
  id: string
  session_id: string
  role: 'user' | 'model'
  content: string
  created_at: string
}

export interface BugStatus {
  session_id: string
  bug_id: string
  state: BugState
  updated_at: string
}

export interface SessionNote {
  id: string
  session_id: string
  author_id: string
  body: string
  created_at: string
}

export interface SessionReview {
  session_id: string
  score: number | null
  summary: string
  rubric_scores: Record<string, number>
  updated_at: string
}
