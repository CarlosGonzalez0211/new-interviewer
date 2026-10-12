/** Tiny, dependency-free markdown subset: fenced code, headings, lists, paragraphs, inline `code` and **bold**. */

export type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string }

export type Inline = { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'bold'; text: string }

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,4})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/

export function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length > 0) blocks.push({ type: 'paragraph', text: para.join('\n') })
    para = []
  }
  const flushList = () => {
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flushPara()
      flushList()
      const code: string[] = []
      i++
      // An unterminated fence (e.g. a truncated reply) runs to the end of the text.
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      blocks.push({ type: 'code', lang: fence[1].toLowerCase(), code: code.join('\n') })
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushPara()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    const item = bullet ?? ordered
    if (item) {
      flushPara()
      const isOrdered = ordered !== null
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) list = { ordered: isOrdered, items: [] }
      list.items.push(item[1])
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return blocks
}

export function parseInline(input: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: input.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] })
    else out.push({ type: 'bold', text: m[2] })
    last = m.index + m[0].length
  }
  if (last < input.length) out.push({ type: 'text', text: input.slice(last) })
  return out
}
