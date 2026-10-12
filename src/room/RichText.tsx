import { useEffect, useRef, useState } from 'react'
import { parseBlocks, parseInline } from './markdownLite'
import './room.css'

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="room-code">
      <div className="room-code-head">
        <span>{lang || 'code'}</span>
        <button type="button" className="room-btn small" onClick={() => void copy()} aria-label="Copy code to clipboard">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.type === 'code' ? (
          <code key={i} className="inline">
            {part.text}
          </code>
        ) : part.type === 'bold' ? (
          <strong key={i}>{part.text}</strong>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** Renders a safe markdown subset (never uses innerHTML). */
export function RichText({ text }: { text: string }) {
  return (
    <div className="room-rich">
      {parseBlocks(text).map((block, i) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={i} code={block.code} lang={block.lang} />
          case 'heading':
            return (
              <h3 key={i}>
                <Inline text={block.text} />
              </h3>
            )
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} />
                  </li>
                ))}
              </Tag>
            )
          }
          default:
            return (
              <p key={i}>
                <Inline text={block.text} />
              </p>
            )
        }
      })}
    </div>
  )
}
