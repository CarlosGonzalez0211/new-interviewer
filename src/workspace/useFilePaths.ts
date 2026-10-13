import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Collab } from '../collab'
import { sameList } from './logic'

const EMPTY: string[] = []

/** Sorted file paths of the shared doc, re-rendering when files are added/removed. */
export function useFilePaths(collab: Collab | null): string[] {
  const cache = useRef<string[]>(EMPTY)
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!collab) return () => undefined
      const map = collab.doc.getMap('files')
      map.observe(onChange)
      return () => map.unobserve(onChange)
    },
    [collab],
  )
  const getSnapshot = useCallback(() => {
    const next = collab ? collab.filePaths() : EMPTY
    if (!sameList(cache.current, next)) cache.current = next
    return cache.current
  }, [collab])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
