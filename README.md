# Interview Lab

A practice tool for realistic, software-engineering-style interviews. An **interviewer** and an **interviewee** join the same session and see different views. The interviewee debugs a small, intentionally broken Python codebase in the browser (Monaco + Pyodide) with a Gemini-backed assistant. The interviewer watches live, sees a diff against the reference solution, tracks bugs, and writes a review.

Reference code, bug lists and rubrics are protected server-side by Postgres row level security, not hidden in the UI.

Stack: Vite, React 19, TypeScript, react-router, Supabase (magic-link Auth, Postgres + RLS, Realtime, Edge Functions), Pyodide, Gemini.

## How a session works

1. Anyone signed in clicks **New interview**, picks a question, picks their own role and enters the other person's email.
2. The other person gets a magic-link email that opens `/session/<id>`. After sign-in they land there and claim their slot.
3. Phases, controlled by the interviewer: **briefing**, **debugging**, **completed**. Both views update live.

## Setup

### 1. Supabase project
1. Create a project at <https://supabase.com/dashboard>.
2. Apply the migrations in `supabase/migrations/` and then the seed in `supabase/seed.sql` (SQL editor, or `supabase db push` with the CLI).
3. Deploy the edge function `supabase/functions/ai-chat` and set secrets:
   - `GEMINI_API_KEY` (required)
   - `GEMINI_MODEL` (optional, default `gemini-2.5-flash`)
4. Authentication, URL Configuration: set **Site URL** to your deployed URL and add redirect URLs for `http://localhost:5173/**` and `https://<your-app>.vercel.app/**`.
5. Supabase's built-in mailer is limited to a few emails per hour. Configure custom SMTP if that gets in the way. When an invite email fails, the app still shows a direct link you can share.

### 2. Environment variables
Copy `.env.example` to `.env.local`:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon or publishable key>
```

Without them the app shows a setup screen listing what is missing.

### 3. Local development
```
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run typecheck
npm run lint
npm run build
```

### 4. Deploy
See [docs/DEPLOY.md](docs/DEPLOY.md).

## Docs
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): product requirements and locked decisions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): contracts between parts of the system
