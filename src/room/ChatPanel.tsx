import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useRealtimeTable } from '../hooks/useRealtimeTable'
import type { AiMessage } from '../types/db'
import { reconcilePending } from './chatState'
import type { PendingMessage } from './chatState'
import { sortByCreatedAt } from './listUtils'
import { defaultOptionLabel, fallbackNotice, mergeModelOptions, readStoredModel, STATIC_MODELS, writeStoredModel } from './modelPicker'
import type { ModelList } from './modelPicker'
import { invokeAiChat, listAiMessages, loadAiModels } from './roomApi'
import { RichText } from './RichText'
import { formatClock } from './time'
import './room.css'

const keyOf = (m: Partial<AiMessage>) => m.id

export function MessageBubble({ role, content, at, pending, model }: { role: 'user' | 'model'; content: string; at: string; pending?: boolean; model?: string | null }) {
  return (
    <div className={`room-msg ${role}${pending ? ' pending' : ''}`}>
      <div className="room-msg-meta">
        {role === 'user' ? 'Interviewee' : 'AI assistant'} · {pending ? 'sending…' : formatClock(at)}
      </div>
      {role === 'model' ? <RichText text={content} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>}
      {role === 'model' && model && <div className="room-msg-model">answered by {model}</div>}
    </div>
  )
}

/** AI pair-programming chat for the interviewee. */
export default function ChatPanel({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const load = useCallback(() => listAiMessages(sessionId), [sessionId])
  const table = useRealtimeTable<AiMessage>({ table: 'ai_messages', sessionId, load, keyOf, sort: sortByCreatedAt })
  const { items: messages, upsertLocal, reload } = table
  const [pendingRaw, setPending] = useState<PendingMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failedText, setFailedText] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The remembered choice is per session; a choice made in this panel wins over storage until the session changes.
  const [choice, setChoice] = useState<{ sessionId: string; model: string } | null>(null)
  const stored = useMemo(() => readStoredModel(sessionId), [sessionId])
  const model = choice && choice.sessionId === sessionId ? choice.model : stored
  const [modelList, setModelList] = useState<ModelList | null>(null)
  const [modelsLoading, setModelsLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Loaded once per page (roomApi caches the request); a failure falls back to the static list.
  useEffect(() => {
    let cancelled = false
    loadAiModels()
      .then((list) => {
        if (!cancelled) setModelList(list)
      })
      .catch(() => {
        if (!cancelled) setModelList({ models: STATIC_MODELS, default: null, degraded: true })
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const modelOptions = useMemo(() => mergeModelOptions(modelList?.models ?? STATIC_MODELS, model), [modelList, model])

  const onModelChange = (next: string) => {
    setChoice({ sessionId, model: next })
    writeStoredModel(sessionId, next)
  }

  const pending = useMemo(() => reconcilePending(pendingRaw, messages), [pendingRaw, messages])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending.length, sending])

  const send = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || sending || disabled) return
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setPending((p) => [...p, { localId, content: text, created_at: new Date().toISOString() }])
    // Retry resends the failed text; keep whatever the user has typed meanwhile.
    if (override === undefined || input.trim() === text) setInput('')
    setError(null)
    setFailedText(null)
    setNotice(null)
    setSending(true)
    try {
      const res = await invokeAiChat(sessionId, text, model || null)
      if (!mounted.current) return
      if (res.message_id) {
        upsertLocal({
          id: res.message_id,
          session_id: sessionId,
          role: 'model',
          content: res.reply,
          created_at: new Date().toISOString(),
          model: res.model,
        })
      }
      if (res.fallback_used) setNotice(fallbackNotice(res.model))
      // Pulls the stored user message too, so the optimistic bubble is replaced even if realtime lags.
      await reload().catch(() => undefined)
    } catch (e) {
      if (!mounted.current) return
      setPending((p) => p.filter((m) => m.localId !== localId))
      setInput((cur) => (cur.trim() === '' ? text : cur))
      setFailedText(text)
      setError(e instanceof Error ? e.message : 'The AI assistant failed')
    } finally {
      if (mounted.current) setSending(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void send()
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <section className="room-card room-chat" aria-label="AI assistant">
      <div className="room-chat-head">
        <h2>AI assistant</h2>
        <div className="room-model-picker">
          <label htmlFor={`chat-model-${sessionId}`}>Model</label>
          <select
            id={`chat-model-${sessionId}`}
            className="room-input"
            value={model}
            disabled={modelsLoading}
            aria-busy={modelsLoading}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">{defaultOptionLabel(modelList?.default ?? null)}</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {modelsLoading && <span className="room-spinner" role="status" aria-label="Loading models" />}
        </div>
      </div>
      {modelList?.degraded && !modelsLoading && <p className="room-muted room-model-note">Showing a short model list; the full list could not be loaded.</p>}
      <div className="room-chat-list" ref={listRef} role="log" aria-live="polite" aria-label="Conversation">
        {table.loading && <p className="room-muted">Loading conversation…</p>}
        {table.error && <p className="room-error" role="alert">{table.error}</p>}
        {!table.loading && messages.length === 0 && pending.length === 0 && (
          <p className="room-muted">Ask the assistant anything about the code. It can see your current files but not the answers.</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} at={m.created_at} model={m.model} />
        ))}
        {pending.map((m) => (
          <MessageBubble key={m.localId} role="user" content={m.content} at={m.created_at} pending />
        ))}
        {sending && (
          <p className="room-muted" role="status">
            AI is thinking…
          </p>
        )}
      </div>
      {notice && (
        <p className="room-muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="room-chat-error">
          <p className="room-error" role="alert">
            {error}
          </p>
          {failedText && (
            <button type="button" className="room-btn small" disabled={sending || disabled} onClick={() => void send(failedText)}>
              Retry
            </button>
          )}
        </div>
      )}
      <form className="room-chat-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={`chat-input-${sessionId}`} style={{ position: 'absolute', left: -9999 }}>
          Message to the AI assistant
        </label>
        <textarea
          id={`chat-input-${sessionId}`}
          className="room-input"
          rows={2}
          value={input}
          placeholder="Ask about the code… (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
        />
        <button type="submit" className="room-btn primary" disabled={sending || disabled || input.trim() === ''}>
          Send
        </button>
      </form>
    </section>
  )
}
