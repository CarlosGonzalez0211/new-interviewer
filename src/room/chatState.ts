import type { AiMessage } from '../types/db'
import { sortByCreatedAt } from './listUtils'

export interface PendingMessage {
  localId: string
  content: string
  created_at: string
}

/** Merge messages by id (later wins) and keep chronological order. */
export function mergeMessages(existing: readonly AiMessage[], incoming: readonly AiMessage[]): AiMessage[] {
  const byId = new Map<string, AiMessage>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  return sortByCreatedAt([...byId.values()])
}

/** Drop optimistic messages once a real stored user message with the same text exists (one-to-one). */
export function reconcilePending(pending: readonly PendingMessage[], messages: readonly AiMessage[]): PendingMessage[] {
  const realUserTexts = messages.filter((m) => m.role === 'user').map((m) => m.content)
  const remaining: PendingMessage[] = []
  const used = new Set<number>()
  for (const p of pending) {
    const idx = realUserTexts.findIndex((t, i) => !used.has(i) && t === p.content)
    if (idx === -1) remaining.push(p)
    else used.add(idx)
  }
  return remaining
}
