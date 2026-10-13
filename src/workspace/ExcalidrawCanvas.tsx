import { useEffect, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { WhiteboardHandle } from '../collab'

const UI_OPTIONS = {
  tools: { image: false },
  canvasActions: { loadScene: false, saveToActiveFile: false },
} as const

interface MinimalApi {
  updateScene(scene: Record<string, unknown>): void
}

export interface ExcalidrawCanvasProps {
  wb: WhiteboardHandle
  viewMode: boolean
  theme: 'light' | 'dark'
}

/** Lives in its own chunk: the only module that imports Excalidraw and its CSS. */
export default function ExcalidrawCanvas({ wb, viewMode, theme }: ExcalidrawCanvasProps) {
  const [api, setApi] = useState<MinimalApi | null>(null)
  const { collaborators, bindApi } = wb

  useEffect(() => {
    if (!api) return
    api.updateScene({ collaborators })
  }, [api, collaborators])

  return (
    <Excalidraw
      initialData={(wb.initialData ?? undefined) as never}
      theme={theme}
      viewModeEnabled={viewMode}
      isCollaborating={!viewMode}
      UIOptions={UI_OPTIONS}
      langCode="en"
      excalidrawAPI={(a) => {
        setApi(a as unknown as MinimalApi)
        bindApi(a)
      }}
      onChange={(elements, appState) => wb.onChange(elements, appState as unknown as Record<string, unknown>)}
      onPointerUpdate={(p) => wb.onPointerUpdate({ pointer: { x: p.pointer.x, y: p.pointer.y }, button: p.button ?? 'up' })}
    />
  )
}
