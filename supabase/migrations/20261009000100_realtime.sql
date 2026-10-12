-- Realtime: publication membership and private Broadcast authorization.
-- Kept separate from the schema migration so tests (which have no realtime schema) can skip it.

alter publication supabase_realtime add table
  public.sessions,
  public.test_runs,
  public.ai_messages,
  public.bug_status,
  public.session_notes,
  public.session_reviews,
  public.session_files;

-- Private channel `session:<sessionId>`: only participants may receive or send.
create policy "session participants can receive broadcast"
  on realtime.messages for select to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where ('session:' || s.id::text) = (select realtime.topic())
        and (select auth.uid()) in (s.interviewer_id, s.interviewee_id)
    )
  );

create policy "session participants can send broadcast"
  on realtime.messages for insert to authenticated
  with check (
    exists (
      select 1 from public.sessions s
      where ('session:' || s.id::text) = (select realtime.topic())
        and (select auth.uid()) in (s.interviewer_id, s.interviewee_id)
    )
  );
