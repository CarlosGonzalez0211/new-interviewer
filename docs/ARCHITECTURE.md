# Architecture & Contracts (source of truth for parallel work)

Read `docs/REQUIREMENTS.md` first (sections 8 and 10 are locked decisions). This file fixes the interfaces between workstreams. Do not change a contract without telling the coordinator.

Stack: Vite + React 19 + TS, react-router-dom, Supabase (Auth magic link, Postgres+RLS, Realtime, Edge Functions on Deno), Monaco (`@monaco-editor/react`), Pyodide in a Web Worker (CDN), Gemini API. Deps are pre-installed (react-router-dom, @monaco-editor/react, vitest, jsdom, @testing-library/react, @electric-sql/pglite). Do not run `npm install` for other packages unless essential; if you do, say so in your report. Windows machine: use `python` (not `python3`). Docker exists, but no `supabase` CLI and no `deno`.

## Invite / session model
- Any signed-in user creates a session via RPC `create_session(p_question_id, p_my_role, p_other_email)`; the creator takes `p_my_role` ('interviewer'|'interviewee') and the other slot is reserved by email.
- The client then calls `supabase.auth.signInWithOtp({ email: otherEmail, options: { emailRedirectTo: `${origin}/session/${id}` } })` to mail the magic link (no invite Edge Function needed).
- After sign-in, the room page calls RPC `claim_session(p_session_id)`, which fills the null id slot if `auth.email()` matches the reserved email (case-insensitive). Returns the session row.
- Roles are per session. There is no global role.

## Database (public schema) — owner: DB workstream
Enums: `session_phase` = `briefing | debugging | completed`; `msg_role` = `user | model`; `bug_state` = `found | fixed`.

| table | columns |
|---|---|
| `questions` | id uuid pk, slug text unique, title, prompt text, constraints text, language text default 'python' |
| `question_private` | question_id pk fk, checklist jsonb (array of strings: "what to look for"), followups jsonb (array of strings), rubric jsonb (array of `{id,label,weight}`) |
| `question_files` | id, question_id, path, content, kind (`buggy`\|`test`) — the starting files |
| `question_reference_files` | id, question_id, path, content — the correct solution |
| `question_bugs` | id uuid pk, question_id, title, description, file_path, hint text |
| `sessions` | id uuid pk, question_id, created_by uuid, interviewer_id uuid null, interviewee_id uuid null, interviewer_email, interviewee_email (lowercased), phase default 'briefing', created_at, debugging_started_at, completed_at |
| `session_files` | session_id, path, content, kind (`code`\|`test`), updated_at; pk(session_id,path) — working copy |
| `test_runs` | id, session_id, passed int, failed int, errored int, results jsonb, stdout text, created_at |
| `ai_messages` | id uuid pk, session_id, role msg_role, content, created_at |
| `bug_status` | session_id, bug_id, state bug_state null-able via delete, updated_at; pk(session_id,bug_id) |
| `session_notes` | id, session_id, author_id, body, created_at |
| `session_reviews` | session_id pk, score int 1-5 null, summary text, rubric_scores jsonb (`{[rubricId]: number}`), updated_at |

RPCs (security definer, `set search_path = public`): `create_session`, `claim_session`, `set_phase(p_session_id, p_phase)` (interviewer only, forward only briefing→debugging→completed; moving to `debugging` copies the question's buggy+test files into `session_files` with kind code/test and stamps debugging_started_at; to `completed` stamps completed_at), `get_reference_files(p_session_id)` and `get_session_private(p_session_id)` are NOT needed — use RLS selects instead.

### RLS rules (the security core — must be tested)
- A "participant" = `auth.uid()` in (`interviewer_id`, `interviewee_id`) of the session. The "interviewer of a session" = `interviewer_id = auth.uid()`.
- `questions`: select for any authenticated user (title/prompt/constraints are not secret).
- `question_private`, `question_files`, `question_reference_files`, `question_bugs`: select ONLY for a user who is the interviewer of some session using that question. No client writes. The interviewee must never be able to read these, even by direct table access, and even in the briefing phase (they get code only through `session_files`).
- `sessions`: select for participants and for the creator; no direct insert/update/delete from clients (RPCs only).
- `session_files`: select for participants; update of `content` only by the interviewee while phase = 'debugging'; no insert/delete from clients.
- `test_runs`: select for participants; insert only by the interviewee while debugging.
- `ai_messages`: select for participants; inserts only by service role (Edge Function).
- `bug_status`, `session_notes`, `session_reviews`: select/write only by the session's interviewer (review is also selectable by the interviewee once phase = 'completed'; the interviewee never sees bug_status or notes).
- All tables RLS-enabled with no permissive default. Revoke anon.
- Add to publication `supabase_realtime`: `sessions`, `test_runs`, `ai_messages`, `bug_status`, `session_notes`, `session_reviews`, `session_files`.
- Realtime Broadcast channel `session:<sessionId>` is private (`config: { private: true }`). Add an RLS policy on `realtime.messages` allowing select+insert for `topic` = 'session:' || session_id where the user is a participant. (`realtime.topic()`).

## Broadcast protocol (keystroke-level live view)
Channel name `session:<sessionId>`, private. Events (payload types in `src/types/realtime.ts`):
- `file_edit` `{ path, content, seq, from }` — interviewee sends on every editor change (no debounce; files are small, send full content). Interviewer applies it to a mirror.
- `cursor` `{ path, line, column, selection?: {startLine,startColumn,endLine,endColumn} , from }`
- `active_file` `{ path, from }`
- `sync_request` `{ from }` — interviewer joining late asks; interviewee replies by re-broadcasting all current files.
Durable copy: the interviewee debounces (2s trailing) writes of changed files into `session_files`. On load, the interviewer reads `session_files` first, then overlays broadcast.

## Edge Function `ai-chat` (supabase/functions/ai-chat/index.ts, Deno) — owner: Edge workstream
`POST` JSON `{ session_id: string, message: string }` with `Authorization: Bearer <user jwt>`. Steps: validate JWT with an anon-key client; ensure caller is the **interviewee** of the session and phase = 'debugging'; load question title/prompt/constraints and the current `session_files` (code + tests) with the **service-role** client; load prior `ai_messages` (last 30); call Gemini `generateContent` with a system instruction (helpful pair-programming assistant on this codebase; never has the reference solution or bug list — it must not be given them) using secrets `GEMINI_API_KEY` and optional `GEMINI_MODEL` (default `gemini-2.5-flash`); insert the user message and the model reply into `ai_messages` (service role); respond `{ reply: string, message_id: string }`. Errors: JSON `{ error: string }` with 400/401/403/429/502. CORS for browser calls (OPTIONS handled). Pure logic (prompt building, request validation, Gemini request/response mapping) lives in separate importable modules with unit tests runnable by vitest under Node (no Deno-only imports in those modules).

## Test harness contract (Python) — owner: Questions workstream
File: `src/runner/harness.py`. Plain-stdlib Python, runs under CPython and Pyodide. Function `run(root: str) -> str` returns a JSON string:
`{"results":[{"file":"test_x.py","name":"test_foo","status":"passed"|"failed"|"error","message":"...","traceback":"..."}],"stdout":"captured stdout/stderr"}`.
It adds `root` to `sys.path`, imports every `test_*.py` in `root` fresh (clear cached modules from root first), runs every top-level `test_*` function (no pytest; `assert` and exceptions; a failed `AssertionError` => "failed", any other exception => "error"; an import error in a test file => one "error" result for the file). It captures stdout/stderr during runs. The frontend imports it with `import harnessSource from './harness.py?raw'`.

## Frontend contracts
Types live in `src/types/db.ts` and `src/types/realtime.ts` (already written by the coordinator; extend only by agreement). `src/lib/supabase.ts` exports `supabase`.

File ownership (do not edit other workstreams' files):
- **Shell workstream** owns: `src/main.tsx`, `src/App.tsx`, `src/App.css`/`index.css`, `src/auth/*`, `src/lib/api.ts` (typed data-access wrappers for all RPCs/queries used by both workstreams, see below), `src/pages/*` (Login, AuthCallback if needed, Dashboard, NewSession, RoomPage), `src/components/ui/*` (shared small UI), `vercel.json`, `.env.example`, `README.md`, `docs/DEPLOY.md`.
- **Room workstream** owns: `src/room/*`, `src/runner/*` (worker, pyodide loader, run hook — NOT harness.py, which belongs to Questions), `src/hooks/*`.

`src/lib/api.ts` must export (Shell writes it first and immediately; Room may call these but must not edit the file; if Room needs another wrapper it puts it in `src/room/roomApi.ts`):
```ts
getSession(id): Promise<SessionWithQuestion>
claimSession(id): Promise<Session>
createSession(args:{questionId,myRole,otherEmail}): Promise<Session>
sendMagicLink(email, sessionId): Promise<void>
listMyLabs?: n/a
listQuestions(): Promise<Question[]>
listMySessions(): Promise<SessionWithQuestion[]>
setPhase(sessionId, phase): Promise<Session>
```
Room components (Room workstream implements; Shell's `RoomPage` renders them — exact props):
- `src/room/BriefingView.tsx` default export `({ session, question, role }: { session: Session; question: Question; role: Role })` — shows prompt+constraints; for interviewer shows the guided checklist/followups (from `question_private`) and a "Reveal code & start debugging" button that calls `setPhase`.
- `src/room/IntervieweeRoom.tsx` default export `({ session, userId }: { session: Session; userId: string })` — debugging UI (files, Monaco, Run tests via Pyodide worker, AI chat, broadcast out, debounced persistence).
- `src/room/InterviewerRoom.tsx` default export `({ session, userId }: ...)` — live mirror, diff vs reference, AI transcript, test runs, bug toggles, notes, "Complete interview" button.
- `src/room/ReviewView.tsx` default export `({ session, question, role }: ...)` — completed summary (timeline of test runs, AI messages, bugs found for interviewer; score+summary for both) and the interviewer's review form.
`RoomPage` re-fetches the session on `sessions` realtime UPDATE so the phase flips live for both users.

## Seed questions — owner: Questions workstream
Source of truth in `supabase/questions/<slug>/`: `question.json` (title, prompt, constraints, language, checklist[], followups[], rubric[], bugs[{title,description,file_path,hint}]), `buggy/*.py`, `reference/*.py`, `tests/test_*.py`. Generator `supabase/scripts/build_seed.py` writes `supabase/seed.sql` (idempotent, `on conflict do update`, dollar-quoted strings). Verifier `supabase/scripts/verify_questions.py` uses `src/runner/harness.py` to prove: tests FAIL on buggy (each documented bug is caught by at least one failing test), and ALL PASS on reference. Questions: (1) `potluck-raffle` — ~100 line Python raffle: tickets generated per participant, fixed ticket price, constraints, winner draw with seedable RNG, prize pool; (2) `rate-limiter` or `shopping-cart` (author's choice) with a different bug profile (state/off-by-one). Each has 3–5 seeded bugs.
