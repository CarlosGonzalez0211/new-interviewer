// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Any use of the real Supabase client fails the test.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
  const trap = new Proxy({}, { get: (_t, p) => { throw new Error(`real Supabase client used (${String(p)})`) } })
  return { ...actual, createClient: () => trap }
})

// Monaco and Excalidraw need a real browser: stub them with inert elements.
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-stub" />,
  Editor: () => <div data-testid="monaco-stub" />,
  DiffEditor: () => <div data-testid="monaco-diff-stub" />,
  useMonaco: () => null,
  loader: { config: () => undefined, init: () => Promise.resolve(null) },
}))
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => <div data-testid="excalidraw-stub" />,
  reconcileElements: (_l: unknown, r: unknown) => r,
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))

import { isSupabaseBackendSwapped } from '../lib/supabase'
import SandboxPage from './SandboxPage'

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia
}

// The Pyodide worker is not available in jsdom: an inert stand-in that never reports ready.
class InertWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}
;(globalThis as { Worker?: unknown }).Worker = InertWorker

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SandboxPage', () => {
  it('renders both panes with the real room, banner and stepper, and flips phase live for both', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<SandboxPage />)
    expect(isSupabaseBackendSwapped()).toBe(true)
    expect(screen.getByText(/nothing is saved to the server/i)).toBeTruthy()

    // Question picker lists every seeded question.
    const picker = screen.getByLabelText('Question') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.text)).toEqual(
      expect.arrayContaining(['API Rate Limiter', 'Potluck Raffle']),
    )

    const interviewer = await screen.findByTestId('pane-interviewer')
    const interviewee = await screen.findByTestId('pane-interviewee')
    await within(interviewer).findByRole('button', { name: /Reveal code/ })
    await within(interviewee).findByText(/Waiting for the interviewer/)
    expect(document.querySelector('.sb-steps li.current')?.textContent).toContain('Briefing')

    // The interviewer's real Reveal control moves both panes (fake RPC + fake postgres_changes).
    fireEvent.click(within(interviewer).getByRole('button', { name: /Reveal code/ }))
    await waitFor(() => expect(document.querySelector('.sb-steps li.current')?.textContent).toContain('Debugging'))
    await within(interviewee).findByRole('button', { name: /Run tests/ }, { timeout: 5000 })
    await within(interviewer).findByRole('button', { name: /Complete interview/ })

    // Convenience jump to the end.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Jump to completed' }))
    })
    await waitFor(() => expect(document.querySelector('.sb-steps li.current')?.textContent).toContain('Completed'))
    await within(interviewee).findByText(/Review:/, undefined, { timeout: 5000 })

    // Layout toggle shows one pane full width.
    fireEvent.click(screen.getByRole('button', { name: 'Interviewer' }))
    expect(screen.queryByTestId('pane-interviewee')).toBeNull()
    expect(screen.getByTestId('pane-interviewer')).toBeTruthy()

    expect(fetchSpy).not.toHaveBeenCalled()
  }, 30000)

  it('New sandbox session resets to the briefing phase', async () => {
    render(<SandboxPage />)
    await screen.findByTestId('pane-interviewer')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Jump to debugging' }))
    })
    await waitFor(() => expect(document.querySelector('.sb-steps li.current')?.textContent).toContain('Debugging'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New sandbox session' }))
    })
    await waitFor(() => expect(document.querySelector('.sb-steps li.current')?.textContent).toContain('Briefing'))
  }, 30000)
})
