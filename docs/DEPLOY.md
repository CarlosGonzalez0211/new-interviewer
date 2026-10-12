# Deploying to Vercel + Supabase

## 1. Supabase
1. Create a new project (Dashboard, New project). Note the **Project URL** and the **anon / publishable key** (Project Settings, API).
2. Database: run every file in `supabase/migrations/` in order, then `supabase/seed.sql`, in the SQL editor. With the CLI: `supabase link --project-ref <ref>` and `supabase db push`, then run the seed.
3. Edge functions: `supabase functions deploy ai-chat --project-ref <ref>` and `supabase functions deploy create-interview --no-verify-jwt --project-ref <ref>`. `create-interview` is called by visitors who are not signed in, so `--no-verify-jwt` is required (it applies its own validation and rate limiting).
4. Secrets: `supabase secrets set GEMINI_API_KEY=<key> --project-ref <ref>` (optionally `GEMINI_MODEL=gemini-2.5-flash`). Optionally `supabase secrets set SITE_URL=https://<your-app>.vercel.app --project-ref <ref>` so magic links redirect to the public app URL. The key is never put in Vercel or in the repository.
5. Realtime: confirm the tables listed in `docs/ARCHITECTURE.md` are in the `supabase_realtime` publication (the migration does this). Broadcast uses private channels, which require the `realtime.messages` policy from the migration.

## 2. Vercel
1. Push the repository to GitHub and import it in Vercel. Framework preset: Vite. Build command `npm run build`, output directory `dist` (defaults).
2. Environment variables (Project Settings, Environment Variables), for Production and Preview:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy. `vercel.json` rewrites all paths to `index.html` so deep links such as `/session/<id>` work.

## 3. Auth redirect URLs
In Supabase, Authentication, URL Configuration:
- **Site URL**: `https://<your-app>.vercel.app`
- **Redirect URLs**: add `https://<your-app>.vercel.app/**` and `http://localhost:5173/**` (plus preview URLs if you use them).

Without these the magic link falls back to the Site URL and the user will not land on the session.

## 4. Smoke test
1. Open the deployed URL (no sign-in needed) and confirm the question list loads.
2. Open a question, enter two different emails you control as interviewer and interviewee, and submit. The page should say magic links were sent to both people (and show a direct link).
3. Open each email's link, sign in with that email, and confirm you land in the session with the right role. `/dashboard` (My interviews) lists it.
4. As interviewer, press the reveal button; the interviewee view should switch to the debugging room without a refresh.

## Troubleshooting
- **Setup screen after deploy**: the env vars are missing or were added after the build. Redeploy.
- **Email rate limit exceeded / 429 on the question page**: wait, or configure custom SMTP. If the session was created, share the direct link shown.
- **Starting an interview fails with 401**: `create-interview` was deployed without `--no-verify-jwt`. Redeploy with the flag.
- **Question list is empty or errors for anonymous visitors**: the migration making `questions` anon-readable has not been applied.
- **"Could not join the session"**: the signed-in email differs from the invited one (case-insensitive match is required).
- **Magic link opens the home page**: the redirect URL is not allow-listed in Supabase.
