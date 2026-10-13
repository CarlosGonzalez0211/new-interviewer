export interface SaverOptions {
  delayMs: number
  save: () => Promise<void>
  onError?: (e: Error) => void
}

export interface Saver {
  /** Mark dirty and (re)start the trailing timer. */
  mark(): void
  /** Save now if dirty. Resolves when done; never rejects (errors go to onError, state stays dirty). */
  flush(): Promise<void>
  isDirty(): boolean
  /** Stop timers. Does not flush. */
  dispose(): void
}

/** Trailing debounce with serialised saves. A failed save leaves the saver dirty so the next flush retries. */
export function createSaver(opts: SaverOptions): Saver {
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const run = async () => {
    // Anything marked while a save is in flight re-dirties and is picked up by the loop (bounded by failure).
    while (dirty) {
      dirty = false
      try {
        await opts.save()
      } catch (e) {
        dirty = true
        opts.onError?.(e instanceof Error ? e : new Error(String(e)))
        return
      }
    }
  }

  const flush = () => {
    clearTimer()
    chain = chain.then(run)
    return chain
  }

  return {
    mark() {
      if (disposed) return
      dirty = true
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, opts.delayMs)
    },
    flush,
    isDirty: () => dirty,
    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
