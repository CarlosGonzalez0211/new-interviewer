# Double-Sided Coding Interview Platform: Requirements

## 1. Goal
A practice tool for realistic, software-engineering-style interviews (not LeetCode). An **interviewer** and an **interviewee** join the same session and see different views. The interviewee debugs a small, intentionally broken codebase with limited AI help. The interviewer watches how they work.

Primary use: solo/peer practice. Scale and multi-tenancy are non-goals.

## 2. Roles and views

| | Interviewee | Interviewer |
|---|---|---|
| Problem brief | Yes (spec, constraints) | Yes |
| Buggy code | Yes, editable | Yes, read-only live mirror |
| Reference (correct) solution | **Never** | Yes |
| Bug list / rubric / hints / talking points | **Never** | Yes |
| AI assistant chat | Yes (can use) | Yes (read-only transcript) |
| Test run output | Yes | Yes |

The interviewee must never receive reference or rubric data, so it has to be enforced server-side by RLS, not hidden in the UI.

## 3. Functional requirements

### 3.1 Auth and session access
- FR-1: Supabase native magic-link (email OTP) sign-in. No passwords.
- FR-2: Two accounts, one per role. A user's role decides which site view they land in (interviewee site vs interviewer site).
- FR-3: Each magic link resolves to the correct role and session. Interviewer link opens the interviewer view, interviewee link opens the interviewee view.
- FR-4: Unauthenticated users are redirected to sign-in. A user cannot open the other role's view by changing the URL.

### 3.2 Interview session lifecycle
- FR-5: Interviewer creates a session by picking a question and entering the interviewee's email. The system sends the magic links.
- FR-6: Session phases, controlled by the interviewer:
  1. **Briefing**: problem description and constraints are shown, and the interviewee explains their intended implementation (verbal or text notes).
  2. **Debugging**: the buggy code is revealed to the interviewee (the "another window opens" moment).
  3. **Completed**: the session is locked and a review is available.
- FR-7: The interviewee view updates in real time when the phase changes, with no refresh.

### 3.3 Code environment (interviewee)
- FR-8: In-browser code editor (Monaco or CodeMirror) with syntax highlighting. Starts with a single file and supports multi-file codebases.
- FR-9: Run code and tests in the browser or a sandbox, and show stdout/stderr and pass/fail per test.
- FR-10: v1 language is Python (matches the reference interview). The design must not hard-code Python.
- FR-11: Edits are autosaved and streamed to the interviewer.

### 3.4 Interviewer experience
- FR-12: Live, read-only mirror of the interviewee's editor, file tree, and test results.
- FR-13: Side-by-side view of the interviewee's current code vs the reference solution, with a diff.
- FR-14: Private panel with the bug list (which bugs exist, where, found or not), the rubric, and notes.
- FR-15: Interviewer can toggle bugs as "found / fixed" and add timestamped notes.
- FR-16: Interviewer can see the full AI chat transcript as it happens.

### 3.5 AI assistant (interviewee)
- FR-17: Chat panel backed by an LLM with the question's codebase and problem brief as context.
- FR-18: Calls go through a server-side function (Supabase Edge Function), never from the browser. The API key stays secret.
- FR-19: Every prompt and response is stored with a timestamp and linked to the session.
- FR-20: The assistant must not be given the reference solution or bug list.
- FR-21: Configurable per question. The interviewer can set an AI policy (on / limited / off) so the "not a vibe coder" signal can be tuned.

### 3.6 Question bank
- FR-22: A question is a record with: title, prompt/spec, constraints, buggy files, reference files, test suite, bug list, rubric, language.
- FR-23: Seed at least 2 practice questions:
  - **Potluck raffle**: Python, about 100 lines. Covers ticket generation, ticket price, and winner selection, with seeded bugs.
  - **One more**: a different bug profile, for example an off-by-one or state bug in a small service such as a rate limiter or shopping cart.
- FR-24: Each seeded question ships with working tests that fail on the buggy code and pass on the reference.

### 3.7 Post-interview review
- FR-25: Session replay/summary: timeline of edits, test runs, AI prompts, bugs found with timestamps, total time.
- FR-26: Interviewer can add a final score and notes per rubric item.

## 4. Non-functional requirements
- NFR-1: **Security**: RLS on all tables. Interviewee-facing queries can never return reference code, rubric, or bug list. Reference data lives in interviewer-only tables or columns.
- NFR-2: **Real-time**: edit sync under about 1s via Supabase Realtime.
- NFR-3: **Sandboxing**: user code runs isolated (for example Pyodide in a Web Worker for v1) with a timeout, and never on the app server.
- NFR-4: Secrets (LLM key, service role) live only in Edge Function env vars. The frontend holds only the Supabase URL and anon key.
- NFR-5: Desktop-first. Mobile is not required.
- NFR-6: Stack is fixed: Vite + React + TypeScript (already scaffolded), Supabase (Auth, Postgres, Realtime, Edge Functions).

## 5. Data model (draft)
- `profiles`: user id, email, role (`interviewer` | `interviewee`)
- `questions`: id, title, prompt, language, ai_policy_default, constraints
- `question_files`: question_id, path, content, kind (`buggy` | `reference` | `test`)
- `question_bugs`: question_id, description, file, location hint, rubric weight (interviewer-only)
- `sessions`: id, question_id, interviewer_id, interviewee_id, phase, started_at, ended_at
- `session_files`: session_id, path, content (the interviewee's working copy, realtime)
- `test_runs`: session_id, results json, created_at
- `ai_messages`: session_id, role, content, created_at
- `session_notes` / `bug_status`: interviewer notes and found/fixed flags

## 6. Suggested build order (milestones)
1. Schema, RLS, and seed data (including the potluck raffle).
2. Magic-link auth and role routing, with two separate site views.
3. Session creation and phase control, with realtime phase sync.
4. Interviewee editor and in-browser Python execution with tests.
5. Realtime mirror and diff view for the interviewer.
6. AI assistant (Edge Function) with transcript logging.
7. Interviewer rubric/bug panel and post-interview review.
8. Second practice question, polish, and RLS leak testing.

## 7. Acceptance criteria (definition of done)
- Two different emails each get a magic link and land in the correct role view.
- The interviewee cannot, via UI or direct API calls, read the reference solution, bug list, or rubric. Verified with a test.
- The interviewer sees the interviewee's keystrokes live and sees AI chat messages as they are sent.
- The potluck question runs end to end: briefing, reveal buggy code, run tests (red), fix bugs, run tests (green), review.
- At least 2 questions are playable.

## 8. Decisions (locked)
1. **Users**: the owner (Carlos) practices as the **interviewee**; a friend is the **interviewer**. Roles are per session, so either person could play either role later.
2. **Briefing**: voice happens outside the app (Meet/Zoom/etc.). No in-app audio, video, or whiteboard. The app only controls the phase switch.
3. **Code execution**: Pyodide in a Web Worker (browser-side Python, with a timeout). Python only for v1.
4. **LLM**: Google **Gemini API**, called only from a Supabase Edge Function. The key is stored as an Edge Function secret.
5. **Backend**: a new Supabase project, created for this app. The Supabase MCP in this environment has no create-project tool, so either the user creates it in the dashboard (about 2 minutes) and shares the URL and anon key, or we use the Supabase CLI.
6. **Video/audio**: out of scope.

## 9. Changes these decisions force
- FR-2 / FR-5 become **invite-based**: the interviewee creates (or the interviewer creates) a session, enters the other person's email, and the system sends a magic link that carries the role and session. Roles live on the session (`sessions.interviewer_id`, `sessions.interviewee_id`), not on a global profile. Drop `profiles.role`.
- FR-18 / FR-17: Gemini instead of Claude. Use a server-side proxy with streaming. Pick the model at build time.
- FR-9: Pyodide only. Tests are pytest-style Python files run in the worker. The Pyodide bundle is large (about 10 MB) so it loads lazily in the interviewee view only.
- FR-5 adds: since the interviewee is also the person practicing, the **interviewer must be able to create/own the session**, so the friend picks the question and the reference data stays hidden from Carlos. A question the interviewee has seen can still be practiced, but ideally the question list is visible only to the interviewer.

## 10. Decisions, round 2 (locked)
1. **Session creation**: any signed-in user can create a session. The creator picks the question and enters the other person's email, and chooses their own role (interviewer or interviewee). The system emails the other person a magic link carrying the session and their role. Reference code, bug list, and rubric stay hidden from the interviewee by RLS regardless of who created the session. Trade-off: a creator-interviewee can see question titles and prompts, but never the answers.
2. **Interviewer panel is guided**: per-question "what to look for" checklist, bug list with found/fixed toggles, and suggested follow-up questions.
3. **AI is always on** for the interviewee, with no per-session toggle. Drop the AI policy setting from FR-21. The assistant can help freely, with the codebase and problem brief as context, and still never receives the reference solution or bug list.
4. **Fully real-time view**: the interviewer sees the interviewee's editor with keystroke-level latency. (Earlier "snapshots" meant saving to the database every few seconds. That's still needed for persistence and replay, but the live view is separate.) Design: edits go over Supabase Realtime Broadcast, sent per change as small diffs and not through the database, with a debounced write to `session_files` (about every 2-3 s) as the durable copy and for late joiners. Cursor and selection are included.
5. **Questions**: 2 seeded questions for v1, with no authoring UI.
6. **Past sessions**: skipped. Only the one-time review at the end of each session.
7. **Magic link keeps the user signed in** (Supabase's default persisted session).
8. **Hosting**: the owner deploys to Vercel. Needs a Vercel env config (Supabase URL and anon key) and the Vercel URL added to Supabase Auth redirect URLs, plus an SPA rewrite so deep links work.

## 11. Remaining open items (not blockers for design)
- Supabase project: still needs to be created (see decision 5 in section 8).
- Gemini API key: needed as an Edge Function secret. It is never committed.
- Gemini model choice (for example a Flash model for latency) is decided at build time.
- Email delivery: Supabase's built-in mailer is heavily rate-limited (a few emails per hour). Fine for practice, but custom SMTP is needed if it becomes annoying.
