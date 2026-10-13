import type { Collab, CollabUser } from '../collab'
import type { SessionPhase } from '../types/db'
import { NotesEditor, NotesReadOnly } from './NotesEditor'
import TabPanels from './TabPanels'
import WhiteboardPanel from './WhiteboardPanel'

export interface WorkspaceTabsProps {
  collab: Collab | null
  session: { id: string; phase: SessionPhase }
  user: CollabUser
  readOnly?: boolean
  /** Render the notes as plain text instead of an editor (review). */
  renderedNotes?: boolean
  error?: string | null
}

/** Notes | Whiteboard. The whiteboard chunk loads on first open and the panel stays mounted afterwards. */
export default function WorkspaceTabs({ collab, session, user, readOnly, renderedNotes, error }: WorkspaceTabsProps) {
  if (error) {
    return (
      <p className="room-error" role="alert">
        Shared workspace unavailable: {error}
      </p>
    )
  }
  return (
    <TabPanels
      label="Shared workspace"
      className="ws-workspace"
      tabs={[
        {
          id: 'notes',
          label: 'Notes',
          render: () =>
            collab ? (
              renderedNotes ? (
                <NotesReadOnly collab={collab} />
              ) : (
                <NotesEditor collab={collab} readOnly={readOnly} />
              )
            ) : (
              <p className="room-muted" role="status">
                Loading notes…
              </p>
            ),
        },
        { id: 'whiteboard', label: 'Whiteboard', render: () => <WhiteboardPanel session={session} user={user} readOnly={readOnly} /> },
      ]}
    />
  )
}
