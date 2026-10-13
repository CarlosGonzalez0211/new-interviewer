import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export type CollabStatus = 'loading' | 'connecting' | 'live' | 'offline' | 'readonly'

export interface CollabUser {
  id: string
  name: string
  color: string
  role: 'interviewer' | 'interviewee'
}

export interface Collab {
  doc: Y.Doc
  awareness: Awareness
  status: CollabStatus
  /** false once the session is completed */
  editable: boolean
  fileText(path: string): Y.Text | undefined
  /** sorted */
  filePaths(): string[]
  notes: Y.Text
  /** force persistence now */
  flush(): Promise<void>
  destroy(): void
}
