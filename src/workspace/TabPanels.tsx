import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { markVisited, nextTabId } from './logic'

export interface TabDef {
  id: string
  label: string
  /** Rendered on first visit and then kept mounted (hidden) so editors/whiteboard keep their state. */
  render: () => ReactNode
}

export default function TabPanels({ tabs, label, initial, className }: { tabs: TabDef[]; label: string; initial?: string; className?: string }) {
  const uid = useId()
  const ids = tabs.map((t) => t.id)
  const [active, setActive] = useState(initial && ids.includes(initial) ? initial : (ids[0] ?? ''))
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([active]))
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const current = ids.includes(active) ? active : (ids[0] ?? '')
  const select = (id: string) => {
    setActive(id)
    setVisited((v) => markVisited(v, id))
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const next = nextTabId(ids, current, e.key)
    if (next !== current) {
      e.preventDefault()
      select(next)
      refs.current[next]?.focus()
    }
  }

  return (
    <div className={`ws-tabs ${className ?? ''}`}>
      <div className="room-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.id}`}
            aria-selected={t.id === current}
            aria-controls={`${uid}-panel-${t.id}`}
            tabIndex={t.id === current ? 0 : -1}
            className="room-tab"
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => {
        const isActive = t.id === current
        return (
          <div
            key={t.id}
            id={`${uid}-panel-${t.id}`}
            role="tabpanel"
            aria-labelledby={`${uid}-tab-${t.id}`}
            hidden={!isActive}
            className="ws-tabpanel"
          >
            {(isActive || visited.has(t.id)) && t.render()}
          </div>
        )
      })}
    </div>
  )
}
