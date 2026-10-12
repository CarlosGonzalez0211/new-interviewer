import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedPaths, createPersistor } from './persistence'

describe('changedPaths', () => {
  it('reports modified and new paths only', () => {
    expect(changedPaths({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' }).sort()).toEqual(['b', 'c'])
    expect(changedPaths({ a: '1' }, { a: '1' })).toEqual([])
  })
})

describe('createPersistor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces with a trailing timer and batches keys', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const p = createPersistor({ delayMs: 2000, save })
    p.mark('a')
    await vi.advanceTimersByTimeAsync(1500)
    p.mark('b')
    p.mark('a')
    await vi.advanceTimersByTimeAsync(1500)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].sort()).toEqual(['a', 'b'])
    expect(p.dirtyKeys()).toEqual([])
  })

  it('flush saves immediately and cancels the timer', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const p = createPersistor({ delayMs: 2000, save })
    p.mark('a')
    await p.flush()
    expect(save).toHaveBeenCalledWith(['a'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush with nothing dirty is a no-op', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    await createPersistor({ delayMs: 10, save }).flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps keys dirty after a failure and retries on next flush', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const states: string[] = []
    const p = createPersistor({ delayMs: 10, save, onState: (s) => states.push(s) })
    p.mark('a')
    await p.flush()
    expect(p.dirtyKeys()).toEqual(['a'])
    expect(states).toContain('error')
    await p.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(p.dirtyKeys()).toEqual([])
    expect(states[states.length - 1]).toBe('idle')
  })

  it('dispose stops pending timers but a prior flush still works', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const p = createPersistor({ delayMs: 100, save })
    p.mark('a')
    const done = p.flush()
    p.dispose()
    await done
    expect(save).toHaveBeenCalledTimes(1)
    p.mark('b')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('serialises concurrent saves', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const save = vi.fn().mockImplementation(
      (keys: string[]) =>
        new Promise<void>((resolve) => {
          order.push(`start:${keys.join(',')}`)
          release = () => {
            order.push(`end:${keys.join(',')}`)
            resolve()
          }
        }),
    )
    const p = createPersistor({ delayMs: 1000, save })
    p.mark('a')
    const f1 = p.flush()
    await vi.advanceTimersByTimeAsync(0)
    p.mark('b')
    const f2 = p.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['start:a'])
    release()
    await f1
    await vi.advanceTimersByTimeAsync(0)
    release()
    await f2
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })
})
