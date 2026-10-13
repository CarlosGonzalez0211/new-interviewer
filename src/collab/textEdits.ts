/** Pure conversions between Y.Text deltas and Monaco-style offset edits (all offsets in UTF-16 code units). */
export interface TextEdit {
  /** offset in the text BEFORE the edit */
  offset: number
  length: number
  text: string
}

export interface DeltaOp {
  retain?: number
  insert?: unknown
  delete?: number
}

/** Y.Text delta -> edits expressed against the pre-image text (so they can be applied together). */
export function deltaToEdits(delta: readonly DeltaOp[]): TextEdit[] {
  const edits: TextEdit[] = []
  let pos = 0
  for (const op of delta) {
    if (typeof op.retain === 'number') {
      pos += op.retain
    } else if (typeof op.insert === 'string') {
      const last = edits[edits.length - 1]
      if (last && last.offset + last.length === pos) last.text += op.insert
      else edits.push({ offset: pos, length: 0, text: op.insert })
    } else if (typeof op.delete === 'number') {
      const last = edits[edits.length - 1]
      if (last && last.offset + last.length === pos) last.length += op.delete
      else edits.push({ offset: pos, length: op.delete, text: '' })
      pos += op.delete
    }
  }
  return edits
}

/** Monaco content-change entries -> operations to replay on Y.Text, ordered so earlier offsets stay valid. */
export function changesToOps(
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[],
): TextEdit[] {
  return changes
    .map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }))
    .sort((a, b) => b.offset - a.offset)
}

/** Apply pre-image edits to a string (used in tests and as a consistency fallback). */
export function applyEditsToString(s: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset)
  let out = s
  for (const e of sorted) out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length)
  return out
}

const CSS_ID = /[^a-zA-Z0-9_-]/g

export function cursorKey(clientId: number, color: string, name: string): string {
  let h = 0
  const src = `${color}|${name}`
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0
  return `${clientId}-${(h >>> 0).toString(36)}`.replace(CSS_ID, '_')
}

const cssString = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')}"`

/** CSS rules for one remote user's selection, caret and name label. */
export function cursorCss(key: string, color: string, name: string): string {
  const safeColor = /^[#a-zA-Z0-9(),.%\s-]+$/.test(color) ? color : '#888'
  return [
    `.collab-sel-${key}{background:color-mix(in srgb, ${safeColor} 28%, transparent);}`,
    `.collab-cur-${key}{border-left:2px solid ${safeColor};margin-left:-1px;}`,
    `.collab-lbl-${key}::after{content:${cssString(name)};position:absolute;top:-1.35em;left:-1px;` +
      `background:${safeColor};color:#fff;font-size:10px;line-height:1.3;padding:0 4px;border-radius:3px 3px 3px 0;` +
      `white-space:nowrap;pointer-events:none;z-index:5;font-family:system-ui,sans-serif;font-weight:600;}`,
  ].join('\n')
}

export const BASE_CURSOR_CSS = `.collab-cur-base{position:relative;}`
