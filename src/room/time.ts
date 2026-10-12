/** mm:ss, or h:mm:ss past an hour. Negative/NaN clamp to 0. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function formatClock(iso: string | number): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Elapsed ms between an ISO start and an end (ISO or epoch), or null when there is no start. */
export function elapsedSince(startIso: string | null, end: string | number): number | null {
  if (!startIso) return null
  const s = new Date(startIso).getTime()
  const e = typeof end === 'number' ? end : new Date(end).getTime()
  if (Number.isNaN(s) || Number.isNaN(e)) return null
  return Math.max(0, e - s)
}
