-- Record which Gemini model produced each assistant reply (written by the ai-chat Edge Function via the service role).
-- Participants already read ai_messages through the existing select policy/grant; clients still have no insert grant.
alter table public.ai_messages add column if not exists model text;
