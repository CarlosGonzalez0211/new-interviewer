/** Minimal structural view of an Excalidraw element used for sync decisions. */
export interface WbElement {
  id: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  [k: string]: unknown
}

export const isWbElement = (v: unknown): v is WbElement =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as WbElement).id === 'string' &&
  typeof (v as WbElement).version === 'number' &&
  typeof (v as WbElement).versionNonce === 'number'

/** Excalidraw rule: higher version wins; on a tie the LOWER versionNonce wins (deterministic on all peers). */
export function shouldTakeRemote(local: WbElement | undefined, remote: WbElement): boolean {
  if (!local) return true
  if (remote.version !== local.version) return remote.version > local.version
  return remote.versionNonce < local.versionNonce
}

/** Merge remote into local element-wise. Local order is kept; unknown remote elements are appended. */
export function mergeElements(local: readonly WbElement[], remote: readonly WbElement[]): WbElement[] {
  const result = [...local]
  const indexOf = new Map<string, number>()
  result.forEach((e, i) => indexOf.set(e.id, i))
  for (const r of remote) {
    const at = indexOf.get(r.id)
    if (at === undefined) {
      indexOf.set(r.id, result.length)
      result.push(r)
    } else if (shouldTakeRemote(result[at], r)) {
      result[at] = r
    }
  }
  return result
}

export type VersionMap = Map<string, { version: number; versionNonce: number }>

/** Elements whose (version, versionNonce) differ from what we last sent/received. Updates `known` in place. */
export function takeChanged(known: VersionMap, elements: readonly WbElement[]): WbElement[] {
  const changed: WbElement[] = []
  for (const e of elements) {
    const k = known.get(e.id)
    if (!k || k.version !== e.version || k.versionNonce !== e.versionNonce) {
      known.set(e.id, { version: e.version, versionNonce: e.versionNonce })
      changed.push(e)
    }
  }
  return changed
}

/** Record elements as already known (e.g. just applied from a remote) so they are never re-broadcast. */
export function markKnown(known: VersionMap, elements: readonly WbElement[]): void {
  for (const e of elements) known.set(e.id, { version: e.version, versionNonce: e.versionNonce })
}

export function filterElements(v: unknown): WbElement[] {
  return Array.isArray(v) ? v.filter(isWbElement) : []
}
