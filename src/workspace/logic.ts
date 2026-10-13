import type { CollabStatus, CollabUser } from '../collab'
import type { Role } from '../types/db'

/** Test files are shown but never editable (for either role). */
export function isTestPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return base.startsWith('test_') || /_test\.[a-z]+$/.test(base) || path.split('/').includes('tests')
}

/** The shared document is read-only when the caller asks for it or the collab layer says so. */
export function isReadOnly(requested: boolean | undefined, editable: boolean): boolean {
  return requested === true || !editable
}

/** A file is editable only if it is a code file and the workspace itself is editable. */
export function canEditFile(path: string, requestedReadOnly: boolean | undefined, editable: boolean): boolean {
  return !isTestPath(path) && !isReadOnly(requestedReadOnly, editable)
}

/**
 * Which file tab is active: keep the current one while it exists, otherwise prefer the first
 * non-test file, otherwise the first file. `null` when there are no files.
 */
export function pickActivePath(paths: readonly string[], current: string | null): string | null {
  if (current !== null && paths.includes(current)) return current
  return paths.find((p) => !isTestPath(p)) ?? paths[0] ?? null
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Roving-tabindex keyboard navigation for a tab list. Returns the id to activate (or `current`). */
export function nextTabId(ids: readonly string[], current: string, key: string): string {
  if (ids.length === 0) return current
  const i = ids.indexOf(current)
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ids[(i + 1 + ids.length) % ids.length]
    case 'ArrowLeft':
    case 'ArrowUp':
      return ids[(i - 1 + ids.length) % ids.length]
    case 'Home':
      return ids[0]
    case 'End':
      return ids[ids.length - 1]
    default:
      return current
  }
}

/** Panels are mounted lazily on first visit and then kept mounted (hidden) so state survives tab switches. */
export function markVisited(visited: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (visited.has(id)) return visited
  const next = new Set(visited)
  next.add(id)
  return next
}

const COLORS: Record<Role, string> = { interviewer: '#f97316', interviewee: '#3b82f6' }

export function collabUserFor(args: { userId: string; role: Role; email: string | null | undefined }): CollabUser {
  const local = (args.email ?? '').split('@')[0].trim()
  const fallback = args.role === 'interviewer' ? 'Interviewer' : 'Interviewee'
  return { id: args.userId, name: local !== '' ? local : fallback, color: COLORS[args.role], role: args.role }
}

export const STATUS_LABEL: Record<CollabStatus, string> = {
  loading: 'Loading workspace…',
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Offline: changes are kept locally',
  readonly: 'Read-only',
}
export const STATUS_DOT: Record<CollabStatus, string> = {
  loading: 'warn pulse',
  connecting: 'warn pulse',
  live: 'ok',
  offline: 'bad',
  readonly: '',
}

const EXT_LANG: Record<string, string> = { py: 'python', md: 'markdown', json: 'json', js: 'javascript', ts: 'typescript', txt: 'plaintext' }
export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? 'plaintext'
}
