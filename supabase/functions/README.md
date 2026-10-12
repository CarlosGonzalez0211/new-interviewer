# Edge Functions

## ai-chat

Gemini-backed assistant for the interviewee. Only the interviewee of a session may call it, and only while the session phase is `debugging`. The function never receives the reference solution or bug list.

Request: `POST /functions/v1/ai-chat` with `Authorization: Bearer <user jwt>` and JSON `{ "session_id": "<uuid>", "message": "..." }`.
Response: `{ "reply": string, "message_id": string }` or `{ "error": string }` (400/401/403/404/429/502).

### Deploy

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set GEMINI_API_KEY=<your key> GEMINI_MODEL=gemini-2.5-flash
supabase functions deploy ai-chat
```

`GEMINI_MODEL` is optional (default `gemini-2.5-flash`). `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by Supabase. The function verifies the JWT itself.

For local runs copy `.env.example` to `.env`, fill it in, and use `supabase functions serve ai-chat --env-file supabase/functions/.env`.

### Tests

The pure modules are tested under Node: `npx vitest run supabase/functions`
