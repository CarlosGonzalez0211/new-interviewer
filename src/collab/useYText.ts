import { useCallback, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

/** Current text of a Y.Text; re-renders on every change (local or remote). */
export function useYText(ytext: Y.Text | undefined): string {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!ytext) return () => undefined
      ytext.observe(cb)
      return () => ytext.unobserve(cb)
    },
    [ytext],
  )
  const getSnapshot = useCallback(() => (ytext ? ytext.toString() : ''), [ytext])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
