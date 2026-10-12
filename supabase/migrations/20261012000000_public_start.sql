-- Public start flow: no login to browse questions, sessions created server-side
-- (service role) with both slots reserved by email.

-- Anyone may browse the question list (title/prompt/constraints are public).
grant usage on schema public to anon;
grant select on public.questions to anon;
create policy questions_select_anon on public.questions for select to anon
  using (true);

-- Sessions created by the create-interview Edge Function have no creator.
-- sessions_select compares created_by = auth.uid(); NULL never matches, so such a
-- session is invisible to everyone until claim_session fills a slot, after which
-- participants see it via interviewer_id/interviewee_id.
alter table public.sessions alter column created_by drop not null;

-- Rate-limit ledger: service role only.
create table public.interview_requests (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  emails text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index interview_requests_ip_idx on public.interview_requests(ip, created_at);
create index interview_requests_emails_idx on public.interview_requests using gin (emails);
alter table public.interview_requests enable row level security;
revoke all on public.interview_requests from public, anon, authenticated;
