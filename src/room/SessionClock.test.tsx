// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionClock from './SessionClock'

const T0 = Date.parse('2026-10-15T10:00:00Z')
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SessionClock', () => {
  it('shows a waiting message when started_at is null', () => {
    render(<SessionClock session={{ started_at: null, debugging_started_at: null, completed_at: null }} />)
    const timer = screen.getByRole('timer')
    expect(timer.getAttribute('aria-live')).toBe('off')
    expect(timer.getAttribute('aria-label')).toBe('Waiting for both people to join')
    expect(timer.textContent).toContain('Waiting for both people to join')
  })

  it('ticks every second while in progress and shows the phase split', () => {
    render(<SessionClock session={{ started_at: iso(-65), debugging_started_at: iso(-5), completed_at: null }} />)
    const timer = screen.getByRole('timer')
    expect(timer.textContent).toContain('Total 1:05')
    expect(timer.textContent).toContain('Briefing 1:00')
    expect(timer.textContent).toContain('Debugging 0:05')
    expect(timer.getAttribute('aria-label')).toBe('Total interview time 1 minute 5 seconds')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByRole('timer').textContent).toContain('Total 1:08')
    expect(screen.getByRole('timer').textContent).toContain('Debugging 0:08')
  })

  it('is frozen at completed_at once completed', () => {
    render(<SessionClock session={{ started_at: iso(-3700), debugging_started_at: iso(-3000), completed_at: iso(-100) }} />)
    const text = () => screen.getByRole('timer').textContent
    expect(text()).toContain('Total 1:00:00')
    expect(text()).toContain('Briefing 11:40')
    expect(text()).toContain('Debugging 48:20')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(text()).toContain('Total 1:00:00')
    expect(vi.getTimerCount()).toBe(0)
  })
})
