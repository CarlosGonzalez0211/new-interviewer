import { supabase } from '../lib/supabase'

export interface WorkspaceRow {
  notes: string
  yjs_state: string | null
  whiteboard: { elements?: unknown[]; appState?: Record<string, unknown> } | null
  updated_at: string
}

export interface WorkspacePatch {
  notes?: string
  yjs_state?: string
  whiteboard?: { elements: unknown[]; appState?: Record<string, unknown> }
}

function fail(action: string, error: { message?: string } | null | undefined): never {
  throw new Error(`${action}: ${error?.message ?? 'unknown error'}`)
}

export async function loadWorkspace(sessionId: string): Promise<WorkspaceRow | null> {
  const { data, error } = await supabase
    .from('session_workspace')
    .select('notes, yjs_state, whiteboard, updated_at')
    .eq('session_id', sessionId)
    .maybeSingle()
  if (error) fail('Could not load the workspace', error)
  return (data as WorkspaceRow | null) ?? null
}

export async function loadSessionFilesForSeed(sessionId: string): Promise<{ path: string; content: string }[]> {
  const { data, error } = await supabase
    .from('session_files')
    .select('path, content')
    .eq('session_id', sessionId)
    .order('path')
  if (error) fail('Could not load the session files', error)
  return (data ?? []) as { path: string; content: string }[]
}

/** Upsert only the provided columns (PostgREST leaves omitted columns untouched on conflict). */
export async function upsertWorkspace(sessionId: string, patch: WorkspacePatch): Promise<void> {
  const { error } = await supabase
    .from('session_workspace')
    .upsert({ session_id: sessionId, ...patch }, { onConflict: 'session_id' })
  if (error) fail('Could not save the workspace', error)
}

export async function updateFileContent(sessionId: string, path: string, content: string): Promise<void> {
  const { error } = await supabase
    .from('session_files')
    .update({ content })
    .eq('session_id', sessionId)
    .eq('path', path)
  if (error) fail(`Could not save ${path}`, error)
}

// ---- keepalive (page is closing) ----

let accessToken: string | null = null
let tokenWatching = false

/** Keep a synchronous copy of the access token so unload handlers can fire a keepalive fetch. */
export function watchAccessToken(): void {
  if (tokenWatching) return
  tokenWatching = true
  void supabase.auth.getSession().then(({ data }) => {
    accessToken = data.session?.access_token ?? accessToken
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? null
  })
}

function restBase(): { base: string; key: string } {
  return {
    base: import.meta.env.VITE_SUPABASE_URL as string,
    key: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  }
}

export function upsertWorkspaceKeepalive(sessionId: string, patch: WorkspacePatch): void {
  if (!accessToken) return
  const { base, key } = restBase()
  try {
    void fetch(`${base}/rest/v1/session_workspace?on_conflict=session_id`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ session_id: sessionId, ...patch }),
    }).catch(() => undefined)
  } catch {
    // body over the keepalive limit: nothing more we can do
  }
}

export function updateFileKeepalive(sessionId: string, path: string, content: string): void {
  if (!accessToken) return
  const { base, key } = restBase()
  const url = `${base}/rest/v1/session_files?session_id=eq.${encodeURIComponent(sessionId)}&path=eq.${encodeURIComponent(path)}`
  try {
    void fetch(url, {
      method: 'PATCH',
      keepalive: true,
      headers: { apikey: key, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).catch(() => undefined)
  } catch {
    // ignore
  }
}
