import * as Y from 'yjs'
import type * as monacoNs from 'monaco-editor'
import type { Awareness } from 'y-protocols/awareness'
import { BASE_CURSOR_CSS, changesToOps, cursorCss, cursorKey, deltaToEdits } from './textEdits'

const BINDING_ORIGIN = Symbol('monaco-binding')
const STYLE_ID = 'collab-cursor-styles'
const injectedRules = new Set<string>()

function styleElement(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = BASE_CURSOR_CSS
    document.head.appendChild(el)
  }
  return el
}

function ensureCursorStyle(key: string, color: string, name: string): void {
  if (injectedRules.has(key)) return
  const el = styleElement()
  if (!el) return
  injectedRules.add(key)
  el.appendChild(document.createTextNode('\n' + cursorCss(key, color, name)))
}

interface AwarenessUser {
  name?: string
  color?: string
}

interface AwarenessSelection {
  anchor: unknown
  head: unknown
}

/**
 * Two-way binding between a Y.Text and a Monaco model (no y-monaco; works with the CDN-loaded monaco).
 * Local edits become incremental Y.Text ops; remote deltas are applied with model.applyEdits under an
 * `applying` guard so they are never echoed back. Remote cursors/selections come from awareness.
 * Returns the unbind function.
 */
export function bindMonaco(args: {
  ytext: Y.Text
  editor: monacoNs.editor.IStandaloneCodeEditor
  monaco: typeof import('monaco-editor')
  awareness: Awareness
  readOnly?: boolean
}): () => void {
  const { ytext, editor, monaco, awareness } = args
  const doc = ytext.doc
  const model = editor.getModel()
  if (!doc || !model) return () => undefined

  let applying = false
  let disposed = false

  // Normalise to LF so Monaco offsets equal Y.Text indexes, then take the Y.Text content as truth.
  if (model.getEOL() !== '\n') model.setEOL(monaco.editor.EndOfLineSequence.LF)
  const setFromY = () => {
    applying = true
    try {
      model.setValue(ytext.toString())
    } finally {
      applying = false
    }
  }
  if (model.getValue() !== ytext.toString()) setFromY()

  const prevReadOnly = editor.getOption(monaco.editor.EditorOption.readOnly)
  if (args.readOnly !== undefined) editor.updateOptions({ readOnly: args.readOnly })

  // ---- Monaco -> Y ----
  const contentSub = model.onDidChangeContent((e) => {
    if (applying || disposed) return
    doc.transact(() => {
      for (const op of changesToOps(e.changes)) {
        if (op.length > 0) ytext.delete(op.offset, op.length)
        if (op.text) ytext.insert(op.offset, op.text)
      }
    }, BINDING_ORIGIN)
  })

  // ---- Y -> Monaco ----
  const decorations = editor.createDecorationsCollection([])

  const renderRemoteCursors = () => {
    if (disposed) return
    const decs: monacoNs.editor.IModelDeltaDecoration[] = []
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return
      const user = state.user as AwarenessUser | undefined
      const sel = state.selection as AwarenessSelection | null | undefined
      if (!user || !sel) return
      let anchor: Y.AbsolutePosition | null
      let head: Y.AbsolutePosition | null
      try {
        anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(sel.anchor), doc)
        head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(sel.head), doc)
      } catch {
        return
      }
      if (!anchor || !head || anchor.type !== ytext || head.type !== ytext) return
      const name = user.name || 'Guest'
      const color = user.color || '#ff8800'
      const key = cursorKey(clientId, color, name)
      ensureCursorStyle(key, color, name)
      const max = model.getValueLength()
      const a = model.getPositionAt(Math.min(anchor.index, max))
      const h = model.getPositionAt(Math.min(head.index, max))
      if (anchor.index !== head.index) {
        decs.push({
          range: new monaco.Range(a.lineNumber, a.column, h.lineNumber, h.column),
          options: { className: `collab-sel-${key}`, stickiness: 1 },
        })
      }
      decs.push({
        range: new monaco.Range(h.lineNumber, h.column, h.lineNumber, h.column),
        options: {
          beforeContentClassName: `collab-cur-base collab-cur-${key} collab-lbl-${key}`,
          stickiness: 1,
          hoverMessage: { value: name },
        },
      })
    })
    decorations.set(decs)
  }

  const observer = (event: Y.YTextEvent) => {
    if (disposed) return
    if (event.transaction.origin === BINDING_ORIGIN) {
      renderRemoteCursors()
      return
    }
    const edits = deltaToEdits(event.delta as { retain?: number; insert?: unknown; delete?: number }[])
    if (edits.length > 0) {
      const monacoEdits = edits.map((ed) => {
        const s = model.getPositionAt(ed.offset)
        const t = model.getPositionAt(ed.offset + ed.length)
        return {
          range: new monaco.Range(s.lineNumber, s.column, t.lineNumber, t.column),
          text: ed.text,
          forceMoveMarkers: false,
        }
      })
      applying = true
      try {
        // applyEdits keeps remote changes out of the local undo stack and shifts the local cursor/selection.
        model.applyEdits(monacoEdits)
      } finally {
        applying = false
      }
    }
    // Self-heal: if the model ever diverges from the CRDT text, the CRDT wins.
    if (model.getValue() !== ytext.toString()) setFromY()
    renderRemoteCursors()
  }
  ytext.observe(observer)

  // ---- local cursor -> awareness ----
  const publishSelection = () => {
    if (applying || disposed) return
    const sel = editor.getSelection()
    if (!sel) return
    const anchorIdx = model.getOffsetAt(sel.getStartPosition())
    const headIdx = model.getOffsetAt(sel.getEndPosition())
    // Monaco's selection start/end are ordered; keep direction so the caret sits on the moving end.
    const [anchorOff, headOff] = sel.getDirection() === monaco.SelectionDirection.LTR ? [anchorIdx, headIdx] : [headIdx, anchorIdx]
    awareness.setLocalStateField('selection', {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, anchorOff)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, headOff)),
    })
  }
  const selSub = editor.onDidChangeCursorSelection(publishSelection)
  const onAwareness = () => renderRemoteCursors()
  awareness.on('change', onAwareness)
  publishSelection()
  renderRemoteCursors()

  return () => {
    if (disposed) return
    disposed = true
    contentSub.dispose()
    selSub.dispose()
    ytext.unobserve(observer)
    awareness.off('change', onAwareness)
    decorations.clear()
    // Drop our caret if it still points into this text.
    const mine = awareness.getLocalState()?.selection as AwarenessSelection | null | undefined
    if (mine) {
      try {
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(mine.head), doc)
        if (abs && abs.type === ytext) awareness.setLocalStateField('selection', null)
      } catch {
        awareness.setLocalStateField('selection', null)
      }
    }
    if (args.readOnly !== undefined) {
      try {
        editor.updateOptions({ readOnly: prevReadOnly })
      } catch {
        // editor already disposed
      }
    }
  }
}
