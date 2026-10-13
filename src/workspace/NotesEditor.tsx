import { useYText } from '../collab'
import type { Collab } from '../collab'
import { RichText } from '../room/RichText'
import { isReadOnly } from './logic'
import YTextEditor from './YTextEditor'

export function NotesEditor({ collab, readOnly }: { collab: Collab; readOnly?: boolean }) {
  const ro = isReadOnly(readOnly, collab.editable)
  return (
    <div className="ws-panel">
      <p className="room-muted ws-hint">{ro ? 'Shared notes (read-only)' : 'Shared notes: both of you can edit'}</p>
      <div className="room-editor ws-fill">
        <YTextEditor ytext={collab.notes} awareness={collab.awareness} readOnly={ro} language="markdown" ariaLabel="Shared notes" prose />
      </div>
    </div>
  )
}

/** Rendered (non-Monaco) read-only notes, used in the review. */
export function NotesReadOnly({ collab }: { collab: Collab }) {
  const text = useYText(collab.notes)
  return (
    <div className="ws-panel ws-scroll" aria-label="Shared notes (read-only)">
      {text.trim() === '' ? <p className="room-muted">No shared notes were written.</p> : <RichText text={text} />}
    </div>
  )
}

export default NotesEditor
