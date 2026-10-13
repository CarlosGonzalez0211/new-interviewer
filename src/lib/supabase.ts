import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const missingEnvVars: string[] = [
  ...(url ? [] : ['VITE_SUPABASE_URL']),
  ...(anonKey ? [] : ['VITE_SUPABASE_ANON_KEY']),
]

export const isSupabaseConfigured = missingEnvVars.length === 0

// Placeholder values are used only when unconfigured so that imports never crash;
// the App shows a setup screen instead of rendering anything that uses the client.
const realClient: SupabaseClient = createClient(
  url || 'http://localhost:54321',
  anonKey || 'placeholder-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
)

/**
 * The active client. This is a live ES binding: every importer reads the current value at call time, so
 * `setSupabaseBackend` (used only by the /sandbox demo mode) takes effect everywhere. Never copy it into a
 * module-level constant.
 */
export let supabase: SupabaseClient = realClient

/** Swap in another client (the in-memory sandbox backend). */
export function setSupabaseBackend(client: SupabaseClient): void {
  supabase = client
}

/** Restore the real client. */
export function resetSupabaseBackend(): void {
  supabase = realClient
}

/** True while a non-default backend is installed. */
export function isSupabaseBackendSwapped(): boolean {
  return supabase !== realClient
}
