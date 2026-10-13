/** Transaction origins that must never be re-broadcast (they are not local edits). */
export const ORIGIN_REMOTE = 'collab:remote'
export const ORIGIN_SEED = 'collab:seed'
export const ORIGIN_DB = 'collab:db'

const NON_LOCAL = new Set<unknown>([ORIGIN_REMOTE, ORIGIN_SEED, ORIGIN_DB])
export const isLocalOrigin = (origin: unknown): boolean => !NON_LOCAL.has(origin)
