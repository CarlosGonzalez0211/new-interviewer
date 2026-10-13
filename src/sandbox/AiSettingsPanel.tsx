import { useState } from 'react'
import { testGeminiKey } from './fake/ai'
import { DEFAULT_GEMINI_MODEL, getAiSettings, saveAiSettings } from './settings'

/** Top-bar popover for the optional Gemini key. The key is stored in localStorage only and never logged. */
export default function AiSettingsPanel() {
  const initial = getAiSettings()
  const [key, setKey] = useState(initial.apiKey ?? '')
  const [model, setModel] = useState(initial.model)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const enabled = !!getAiSettings().apiKey

  const save = () => {
    saveAiSettings({ apiKey: key, model })
    setStatus({ kind: 'ok', text: key.trim() ? 'Saved in this browser.' : 'Key removed. The assistant gives canned replies.' })
  }

  const test = async () => {
    setBusy(true)
    setStatus({ kind: 'info', text: 'Testing…' })
    const result = await testGeminiKey({ apiKey: key.trim() || null, model: model.trim() || DEFAULT_GEMINI_MODEL })
    setStatus(result.ok ? { kind: 'ok', text: 'The key works.' } : { kind: 'err', text: result.error })
    setBusy(false)
  }

  return (
    <details className="sb-ai">
      <summary className="sb-btn">AI settings{enabled ? ' (key set)' : ''}</summary>
      <form
        className="sb-ai-pop"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="sb-field">
          <span>Gemini API key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" />
        </label>
        <label className="sb-field">
          <span>Model</span>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_GEMINI_MODEL} />
        </label>
        <div className="sb-row">
          <button type="submit" className="sb-btn primary">
            Save
          </button>
          <button type="button" className="sb-btn" disabled={busy || !key.trim()} onClick={() => void test()}>
            Test key
          </button>
          <button
            type="button"
            className="sb-btn"
            onClick={() => {
              setKey('')
              saveAiSettings({ apiKey: null })
              setStatus({ kind: 'ok', text: 'Key removed.' })
            }}
          >
            Clear
          </button>
        </div>
        {status && (
          <p className={`sb-note ${status.kind}`} role="status">
            {status.text}
          </p>
        )}
        <p className="sb-note">
          The key stays in this browser (localStorage) and is sent only to Google&apos;s Gemini API. Without a key the
          assistant answers with a canned message.
        </p>
      </form>
    </details>
  )
}
