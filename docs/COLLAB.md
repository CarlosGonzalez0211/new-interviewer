# Collaborative workspace (v2): contract

Feature (user-requested): in the **briefing** phase the interviewee gets a **Notes** area and a **Whiteboard** (Canva-like: shapes, arrows, text, freehand, sticky notes). Both persist and stay available in the **debugging** phase next to the code. The **interviewer can always edit** the notes, the whiteboard AND the code (to explain a point), live, at the same time as the interviewee, without overwriting each other. After `completed`, everything is read-only and shown in the review.

Packages already installed: `yjs`, `y-protocols`, `lib0`, `@excalidraw/excalidraw` (0.18, React 19). Do NOT use y-monaco (it needs the bundled monaco-editor; we use `@monaco-editor/react` from CDN). Write a small own Monaco binding.

## Data model
Migration `supabase/migrations/20261013000000_workspace.sql` (DB workstream):
- `public.session_workspace(session_id uuid pk references sessions on delete cascade, notes text not null default '', yjs_state text, whiteboard jsonb, updated_at timestamptz default now())`. `yjs_state` = base64 of `Y.encodeStateAsUpdate(doc)` for the shared doc (files + notes); `notes` = plain-text copy of the notes (for review/search); `whiteboard` = `{ elements: ExcalidrawElement[], appState?: {...small subset...} }` JSON.
- RLS: select for participants. Insert/update (upsert) for either participant (interviewer or interviewee) while phase IN ('briefing','debugging') (`session_phase_of`). No delete. Column grants: `select`, `insert(session_id, notes, yjs_state, whiteboard)`, `update(notes, yjs_state, whiteboard)` to authenticated; trigger sets updated_at. Add to `supabase_realtime` publication in `20261013000100_workspace_realtime.sql`.
- Change `session_files` update policy and column grant: during phase 'debugging' BOTH the interviewee AND the interviewer may update `content` (still only content, only in debugging, only own session). Interviewee behaviour unchanged.
- Tests in `supabase/tests/` (pglite): participants can read/write workspace in briefing & debugging; third user can't read/write; no writes after completed; anon nothing; interviewer can update session_files.content in debugging but not in briefing/completed; third user can't. Existing tests (all) keep passing.

## Realtime
Same private channel `session:<sessionId>` (see src/types/realtime.ts, add new events there):
- `y_update` `{ update: string /*base64*/, from: string }` — Yjs doc updates (local origin only).
- `y_sync_request` `{ stateVector: string /*base64*/, from }` / `y_sync_reply` `{ update: string, to: string, from }` — late joiners and reconnects exchange state vectors (standard Yjs sync step 1/2).
- `y_awareness` `{ update: string /*base64 of y-protocols awareness update*/, from }` — cursors/selections/user names/colors.
- `wb_update` `{ elements: unknown[]  /* only changed elements (by version) */, from }`, `wb_pointer` `{ x:number,y:number,tool:string,from }`, `wb_sync_request` `{from}` / `wb_sync_reply` `{elements, to, from}`.

## Shared Yjs document layout (single Y.Doc per session)
- `doc.getMap('files')` : `Y.Map<string, Y.Text>` — path → file text (code + test files).
- `doc.getText('notes')` : the notes.
- **Deterministic seeding (avoids duplicated text from concurrent init):** `seedDocFromFiles(files: {path,content}[], notes: string)` builds an update using a throwaway `Y.Doc` with fixed `clientID = 1` inserting every file in path order inside ONE transaction; applying that identical update on every client is idempotent. Load order on join: (1) fetch `session_workspace` row; if `yjs_state` exists apply it; (2) else apply the deterministic seed built from `session_files` (+ `notes` column); (3) subscribe to the channel and run sync step 1/2 with peers.
- Persistence: debounce 2s trailing + flush on unmount/beforeunload (existing keepalive helper pattern in `src/room/roomApi.ts`): upsert `session_workspace` {notes: plain text, yjs_state: base64, whiteboard} AND update `session_files.content` for changed paths (the AI function, test runner history and review read plain `session_files`). Both participants may run persistence; concurrent writes are fine because Yjs state is a CRDT union (apply the latest DB state to the doc before overwriting when `updated_at` is newer: re-read & merge before write, or write only when local changes exist).

## src/collab API (Collab workstream implements; Room/UI workstream consumes — exact signatures)
```ts
// src/collab/index.ts
export type CollabStatus = 'loading' | 'connecting' | 'live' | 'offline' | 'readonly'
export interface CollabUser { id: string; name: string; color: string; role: 'interviewer' | 'interviewee' }
export interface Collab {
  doc: Y.Doc
  awareness: Awareness            // y-protocols
  status: CollabStatus
  editable: boolean               // false once session completed
  fileText(path: string): Y.Text | undefined
  filePaths(): string[]           // sorted, observable via doc 'files' map
  notes: Y.Text
  flush(): Promise<void>          // force persistence now
  destroy(): void
}
export function useCollab(session: { id: string; phase: SessionPhase }, user: CollabUser): { collab: Collab | null; error: string | null }
export function bindMonaco(args: { ytext: Y.Text; editor: monaco.editor.IStandaloneCodeEditor; monaco: typeof import('monaco-editor'); awareness: Awareness; readOnly?: boolean }): () => void // returns unbind; remote cursors/selections with name labels via decorations (inject css), no feedback loops
export function useYText(ytext: Y.Text | undefined): string  // re-renders on change (for test runner / diff / review)
export function useWhiteboard(session: {id:string; phase: SessionPhase}, user: CollabUser): {
  initialData: { elements: readonly unknown[]; appState?: Record<string, unknown> } | null
  onChange(elements: readonly unknown[], appState: Record<string, unknown>): void   // from <Excalidraw onChange>
  onPointerUpdate(p: { pointer: {x:number;y:number}; button: 'down'|'up' }): void
  bindApi(api: unknown): void       // ExcalidrawImperativeAPI; remote elements applied via api.updateScene with reconcile
  collaborators: Map<string, { pointer?: {x:number;y:number}; username: string; color: {background:string;stroke:string} }>
  editable: boolean
  status: CollabStatus
}
```
Pure logic must be unit-tested without Supabase/Monaco/Excalidraw: Yjs convergence of two docs through a fake in-memory channel (concurrent edits, late join sync, deterministic seed idempotence), base64 helpers, debounce/flush, whiteboard element reconciliation by version/versionNonce.

## UI (Room workstream) — owner of `src/room/**` and new `src/workspace/**`
- `src/workspace/NotesEditor.tsx` — props `{ collab: Collab; readOnly?: boolean }`: Monaco in markdown mode (word wrap, no minimap) bound to `collab.notes`, with a small toolbar hint ('shared notes — both of you can edit').
- `src/workspace/WhiteboardPanel.tsx` — props `{ session; user: CollabUser; readOnly?: boolean }`: lazy-loaded (React.lazy) `@excalidraw/excalidraw` (+ its css), `UIOptions` with image tool disabled, `viewModeEnabled` when read-only, `isCollaborating`, theme following app theme, uses `useWhiteboard`. Chunk must not load until the whiteboard tab is opened.
- `src/workspace/WorkspaceTabs.tsx` — Notes | Whiteboard (tabs) used in BriefingView (side by side with the question prompt on wide screens) for BOTH roles; the whiteboard keeps its state when switching tabs (keep mounted, hide).
- `IntervieweeRoom`: tabs Code | Notes | Whiteboard beside the AI chat; code editor now bound to the Y.Text of the active file (shared with the interviewer, remote cursor shown); Run tests uses current Y.Text contents (`useYText`/`fileText`); test files stay read-only for the interviewee (and for the interviewer: read-only too — only code files editable). Remove the old file_edit/mirror protocol and persistence code that is now superseded (delete dead modules and their tests; keep what is still used).
- `InterviewerRoom`: Live code becomes an EDITABLE shared editor (same binding), + Notes + Whiteboard tabs, existing Diff/Transcript/Test runs tabs remain (diff compares live Y.Text to reference); keep the sidebar (checklist, bugs, private interviewer notes `session_notes`, timer, Complete button). A clear label differentiates 'shared notes' (both edit) from 'private interviewer notes'.
- `BriefingView`: both roles see prompt/constraints + the WorkspaceTabs; interviewer additionally keeps checklist/follow-ups and the Reveal button; the page must keep the same workspace content when the phase flips to debugging (collab keyed by session id, not phase).
- `ReviewView`: read-only Notes (rendered text) and a read-only whiteboard (Excalidraw viewMode) next to the existing review content; falls back gracefully if empty.
- `RoomPage` (Shell file) needs no changes beyond props already used; if a prop change is unavoidable, tell the coordinator.
