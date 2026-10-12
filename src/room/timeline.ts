import type { AiMessage, BugStatus, RubricItem, SessionNote, TestRun } from '../types/db'

export type TimelineEntry =
  | { kind: 'test_run'; at: string; label: string; passing: boolean }
  | { kind: 'ai_prompt'; at: string; label: string }
  | { kind: 'bug'; at: string; label: string }
  | { kind: 'note'; at: string; label: string }

export interface TimelineInput {
  testRuns: readonly TestRun[]
  aiMessages: readonly AiMessage[]
  bugStatuses?: readonly BugStatus[]
  bugTitles?: Readonly<Record<string, string>>
  notes?: readonly SessionNote[]
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const r of input.testRuns) {
    const total = r.passed + r.failed + r.errored
    entries.push({
      kind: 'test_run',
      at: r.created_at,
      label: `Ran tests: ${r.passed}/${total} passed`,
      passing: r.failed === 0 && r.errored === 0 && r.passed > 0,
    })
  }
  for (const m of input.aiMessages) {
    if (m.role === 'user') entries.push({ kind: 'ai_prompt', at: m.created_at, label: `Asked AI: ${truncate(m.content, 90)}` })
  }
  for (const b of input.bugStatuses ?? []) {
    const title = input.bugTitles?.[b.bug_id] ?? 'Bug'
    entries.push({ kind: 'bug', at: b.updated_at, label: `${title} marked ${b.state}` })
  }
  for (const n of input.notes ?? []) entries.push({ kind: 'note', at: n.created_at, label: `Note: ${truncate(n.body, 90)}` })
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

export function countAiPrompts(messages: readonly AiMessage[]): number {
  return messages.filter((m) => m.role === 'user').length
}

/** Weighted mean of rubric scores (1-5) over the items that have been scored; null if none. */
export function weightedRubricScore(rubric: readonly RubricItem[], scores: Readonly<Record<string, number>>): number | null {
  let sum = 0
  let weight = 0
  for (const item of rubric) {
    const s = scores[item.id]
    if (typeof s !== 'number') continue
    const w = item.weight > 0 ? item.weight : 1
    sum += s * w
    weight += w
  }
  return weight === 0 ? null : Math.round((sum / weight) * 100) / 100
}
