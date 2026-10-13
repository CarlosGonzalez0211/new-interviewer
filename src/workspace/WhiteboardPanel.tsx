import { Component, Suspense, lazy, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useWhiteboard } from '../collab'
import type { CollabUser } from '../collab'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import type { SessionPhase } from '../types/db'
import { isReadOnly } from './logic'

// The Excalidraw chunk (and its CSS) loads only when this panel first renders.
const Canvas = lazy(() => import('./ExcalidrawCanvas'))

class Boundary extends Component<{ children: ReactNode; onRetry: () => void }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  render() {
    if (this.state.error === null) return this.props.children
    return (
      <div className="ws-center" role="alert">
        <p className="room-error">The whiteboard failed to load: {this.state.error}</p>
        <button
          type="button"
          className="room-btn small"
          onClick={() => {
            this.setState({ error: null })
            this.props.onRetry()
          }}
        >
          Retry
        </button>
      </div>
    )
  }
}

export interface WhiteboardPanelProps {
  session: { id: string; phase: SessionPhase }
  user: CollabUser
  readOnly?: boolean
}

export function WhiteboardPanel({ session, user, readOnly }: WhiteboardPanelProps) {
  const stable = useMemo(() => ({ id: session.id, phase: session.phase }), [session.id, session.phase])
  const wb = useWhiteboard(stable, user)
  const theme = useMonacoTheme()
  const [attempt, setAttempt] = useState(0)
  const ro = isReadOnly(readOnly, wb.editable)
  const empty = wb.initialData !== null && wb.initialData.elements.length === 0

  let body: ReactNode
  if (wb.initialData === null) {
    body = (
      <p className="room-muted ws-center" role="status">
        Loading whiteboard…
      </p>
    )
  } else if (ro && empty) {
    body = <p className="room-muted ws-center">The whiteboard is empty.</p>
  } else {
    body = (
      <Boundary key={attempt} onRetry={() => setAttempt((n) => n + 1)}>
        <Suspense
          fallback={
            <p className="room-muted ws-center" role="status">
              Loading whiteboard…
            </p>
          }
        >
          <Canvas wb={wb} viewMode={ro} theme={theme === 'vs-dark' ? 'dark' : 'light'} />
        </Suspense>
      </Boundary>
    )
  }

  return (
    <div className="ws-panel">
      <p className="room-muted ws-hint">{ro ? 'Whiteboard (read-only)' : 'Shared whiteboard: both of you can draw'}</p>
      <div className="ws-board" role="region" aria-label="Whiteboard">
        {body}
      </div>
    </div>
  )
}

export default WhiteboardPanel
