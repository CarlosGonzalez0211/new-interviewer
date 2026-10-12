/** Which of the current files differ from what was last saved. */
export function changedPaths(saved: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): string[] {
  return Object.keys(current).filter((p) => saved[p] !== current[p])
}

export type PersistState = 'idle' | 'dirty' | 'saving' | 'error'

export interface PersistorOptions {
  delayMs: number
  save: (keys: string[]) => Promise<void>
  onState?: (state: PersistState, error?: Error) => void
}

export interface Persistor {
  /** Mark a key dirty and (re)start the trailing timer. */
  mark: (key: string) => void
  /** Save everything pending now. Resolves once all queued saves finished; never rejects. */
  flush: () => Promise<void>
  dirtyKeys: () => string[]
  /** Stops the timer. Does NOT flush (call flush first if wanted). */
  dispose: () => void
}

/** Trailing debounce with serialised saves; failed keys stay dirty so the next flush retries them. */
export function createPersistor(opts: PersistorOptions): Persistor {
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let inflight = 0
  let disposed = false

  const emit = (state: PersistState, error?: Error) => opts.onState?.(state, error)

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const runOnce = async () => {
    if (dirty.size === 0) return
    const keys = [...dirty]
    dirty.clear()
    inflight++
    emit('saving')
    try {
      await opts.save(keys)
      inflight--
      emit(dirty.size > 0 || inflight > 0 ? 'dirty' : 'idle')
    } catch (e) {
      inflight--
      for (const k of keys) dirty.add(k)
      emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }

  const flush = () => {
    clearTimer()
    chain = chain.then(runOnce)
    return chain
  }

  return {
    mark(key) {
      if (disposed) return
      dirty.add(key)
      emit('dirty')
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, opts.delayMs)
    },
    flush,
    dirtyKeys: () => [...dirty],
    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
