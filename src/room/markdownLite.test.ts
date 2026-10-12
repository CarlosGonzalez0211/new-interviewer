import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './markdownLite'

describe('parseBlocks', () => {
  it('splits text and fenced code', () => {
    const blocks = parseBlocks('Try this:\n```python\nprint(1)\n```\nDone.')
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Try this:' },
      { type: 'code', lang: 'python', code: 'print(1)' },
      { type: 'paragraph', text: 'Done.' },
    ])
  })

  it('treats an unterminated fence as code to the end', () => {
    expect(parseBlocks('```\nx = 1\ny = 2')).toEqual([{ type: 'code', lang: '', code: 'x = 1\ny = 2' }])
  })

  it('keeps blank lines inside code blocks', () => {
    const [b] = parseBlocks('```py\na\n\nb\n```')
    expect(b).toEqual({ type: 'code', lang: 'py', code: 'a\n\nb' })
  })

  it('parses bullet and ordered lists and headings', () => {
    const blocks = parseBlocks('## Title\n- one\n- two\n\n1. a\n2) b')
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: 'Title' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
      { type: 'list', ordered: true, items: ['a', 'b'] },
    ])
  })

  it('handles CRLF and empty input', () => {
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('a\r\nb')).toEqual([{ type: 'paragraph', text: 'a\nb' }])
  })
})

describe('parseInline', () => {
  it('extracts inline code and bold', () => {
    expect(parseInline('use `foo()` and **care**!')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'foo()' },
      { type: 'text', text: ' and ' },
      { type: 'bold', text: 'care' },
      { type: 'text', text: '!' },
    ])
  })

  it('leaves unmatched markers as text', () => {
    expect(parseInline('a ` b')).toEqual([{ type: 'text', text: 'a ` b' }])
  })
})
