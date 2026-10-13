import { describe, expect, it } from 'vitest'
import { describeDuration, finalDuration, formatDuration, readClock, timeToFirstRun } from './clock'

const T0 = Date.parse('2026-10-15T10:00:00Z')
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString()

describe('formatDuration', () => {
  it('formats m:ss under an hour and h:mm:ss above', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(999)).toBe('0:00')
    expect(formatDuration(5_000)).toBe('0:05')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59:59')
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03')
    expect(formatDuration(10 * 3_600_000)).toBe('10:00:00')
  })
  it('clamps negative and non-finite values', () => {
    expect(formatDuration(-5000)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('describeDuration', () => {
  it('speaks the duration', () => {
    expect(describeDuration(0)).toBe('0 seconds')
    expect(describeDuration(61_000)).toBe('1 minute 1 second')
    expect(describeDuration(3_600_000 + 5_000)).toBe('1 hour 5 seconds')
  })
})

describe('readClock', () => {
  it('has no total while waiting for both people', () => {
    const r = readClock({ started_at: null, debugging_started_at: null, completed_at: null }, T0)
    expect(r).toEqual({ total: null, briefing: null, debugging: null, frozen: false })
  })

  it('runs briefing against now before debugging starts', () => {
    const r = readClock({ started_at: iso(0), debugging_started_at: null, completed_at: null }, T0 + 90_000)
    expect(r.total).toBe(90_000)
    expect(r.briefing).toBe(90_000)
    expect(r.debugging).toBeNull()
    expect(r.frozen).toBe(false)
  })

  it('splits briefing and debugging while in progress', () => {
    const r = readClock({ started_at: iso(0), debugging_started_at: iso(120), completed_at: null }, T0 + 500_000)
    expect(r).toEqual({ total: 500_000, briefing: 120_000, debugging: 380_000, frozen: false })
  })

  it('freezes at completed_at regardless of now', () => {
    const s = { started_at: iso(0), debugging_started_at: iso(100), completed_at: iso(1000) }
    const a = readClock(s, T0 + 2_000_000)
    const b = readClock(s, T0 + 9_000_000)
    expect(a).toEqual(b)
    expect(a).toEqual({ total: 1_000_000, briefing: 100_000, debugging: 900_000, frozen: true })
  })

  it('clamps negatives when the client clock is behind the server', () => {
    const r = readClock({ started_at: iso(100), debugging_started_at: iso(200), completed_at: null }, T0)
    expect(r).toEqual({ total: 0, briefing: 100_000, debugging: 0, frozen: false })
    expect(readClock({ started_at: iso(100), debugging_started_at: null, completed_at: null }, T0).total).toBe(0)
  })

  it('ignores unparseable timestamps', () => {
    expect(readClock({ started_at: 'nope', debugging_started_at: null, completed_at: null }, T0).total).toBeNull()
  })

  it('crosses the hour boundary', () => {
    const r = readClock({ started_at: iso(0), debugging_started_at: iso(60), completed_at: iso(3661) }, T0)
    expect(formatDuration(r.total!)).toBe('1:01:01')
    expect(formatDuration(r.debugging!)).toBe('1:00:01')
  })
})

describe('timeToFirstRun / finalDuration', () => {
  it('uses the earliest run after debugging started', () => {
    expect(timeToFirstRun({ debugging_started_at: iso(10) }, [iso(70), iso(40)])).toBe(30_000)
    expect(timeToFirstRun({ debugging_started_at: iso(10) }, [])).toBeNull()
    expect(timeToFirstRun({ debugging_started_at: null }, [iso(40)])).toBeNull()
    expect(timeToFirstRun({ debugging_started_at: iso(50) }, [iso(40)])).toBe(0)
  })
  it('final duration only for completed, started sessions', () => {
    expect(finalDuration({ started_at: iso(0), debugging_started_at: iso(5), completed_at: iso(125) })).toBe(125_000)
    expect(finalDuration({ started_at: iso(0), debugging_started_at: null, completed_at: null })).toBeNull()
    expect(finalDuration({ started_at: null, debugging_started_at: null, completed_at: iso(5) })).toBeNull()
  })
})
