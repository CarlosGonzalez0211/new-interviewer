import { useState } from 'react'
import type { Collab } from '../collab'
import { canEditFile, isTestPath, languageForPath, nextTabId, pickActivePath } from './logic'
import { useFilePaths } from './useFilePaths'
import YTextEditor from './YTextEditor'

/** File tabs + a shared-Y.Text Monaco editor. Test files are always read-only. */
export default function CodeFiles({ collab, readOnly, label }: { collab: Collab; readOnly?: boolean; label: string }) {
  const paths = useFilePaths(collab)
  const [chosen, setChosen] = useState<string | null>(null)
  const active = pickActivePath(paths, chosen)
  const ytext = active !== null ? collab.fileText(active) : undefined
  const editable = active !== null && canEditFile(active, readOnly, collab.editable)

  if (paths.length === 0) {
    return (
      <p className="room-muted" style={{ padding: 12 }} role="status">
        {collab.status === 'loading' || collab.status === 'connecting' ? 'Loading files…' : 'No files in this session yet.'}
      </p>
    )
  }

  return (
    <div className="room-editor-wrap">
      <div
        className="room-tabs"
        role="tablist"
        aria-label={`${label} files`}
        onKeyDown={(e) => {
          if (active === null) return
          const next = nextTabId(paths, active, e.key)
          if (next !== active) {
            e.preventDefault()
            setChosen(next)
          }
        }}
      >
        {paths.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={p === active}
            tabIndex={p === active ? 0 : -1}
            className="room-tab file"
            onClick={() => setChosen(p)}
          >
            {p}
            {isTestPath(p) ? ' (read-only)' : ''}
          </button>
        ))}
      </div>
      <div className="room-editor" role="tabpanel" aria-label={active ? `Editor for ${active}` : 'Editor'}>
        {active !== null && ytext && (
          <YTextEditor
            ytext={ytext}
            awareness={collab.awareness}
            readOnly={!editable}
            language={languageForPath(active)}
            ariaLabel={`${label}: ${active}${editable ? '' : ' (read-only)'}`}
          />
        )}
      </div>
    </div>
  )
}
