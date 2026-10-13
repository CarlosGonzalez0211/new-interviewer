import { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { bindMonaco } from '../collab'
import { useMonacoTheme } from '../hooks/useMonacoTheme'

type CodeEditor = Parameters<NonNullable<React.ComponentProps<typeof Editor>['onMount']>>[0]

interface Mounted {
  ytext: Y.Text
  editor: CodeEditor
  monaco: Monaco
}

export interface YTextEditorProps {
  ytext: Y.Text
  awareness: Awareness
  readOnly: boolean
  language: string
  ariaLabel: string
  prose?: boolean
}

const keys = new WeakMap<Y.Text, number>()
let counter = 0
/** A stable per-Y.Text id, used as the React key so each shared text gets its own editor instance. */
function ytextKey(t: Y.Text): number {
  let k = keys.get(t)
  if (k === undefined) {
    k = ++counter
    keys.set(t, k)
  }
  return k
}

/**
 * Monaco editor bound to a shared Y.Text. Remounts (via `key`) when the text changes so a
 * binding never points at a disposed editor; the binding is released in the effect cleanup.
 */
export default function YTextEditor({ ytext, awareness, readOnly, language, ariaLabel, prose }: YTextEditorProps) {
  const theme = useMonacoTheme()
  const [mounted, setMounted] = useState<Mounted | null>(null)

  useEffect(() => {
    if (!mounted || mounted.ytext !== ytext) return
    const unbind = bindMonaco({ ytext, editor: mounted.editor, monaco: mounted.monaco, awareness, readOnly })
    return () => {
      try {
        unbind()
      } catch {
        // The editor may already be disposed during unmount.
      }
    }
  }, [mounted, ytext, awareness, readOnly])

  return (
    <Editor
      key={`${language}:${ytextKey(ytext)}`}
      height="100%"
      language={language}
      theme={theme}
      defaultValue=""
      loading={<p className="room-muted" style={{ padding: 12 }}>Loading editor…</p>}
      onMount={(editor, monaco) => setMounted({ ytext, editor, monaco })}
      options={{
        readOnly,
        ariaLabel,
        minimap: { enabled: false },
        fontSize: 14,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        ...(prose ? { wordWrap: 'on', lineNumbers: 'off', renderLineHighlight: 'none', folding: false } : {}),
      }}
    />
  )
}
