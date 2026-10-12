-- Schema, RLS and RPCs for the double-sided interview platform.

-- ---------------------------------------------------------------- enums
create type public.session_phase as enum ('briefing', 'debugging', 'completed');
create type public.msg_role as enum ('user', 'model');
create type public.bug_state as enum ('found', 'fixed');

-- --------------------------------------------------------------- tables
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  prompt text not null,
  constraints text not null default '',
  language text not null default 'python'
);

create table public.question_private (
  question_id uuid primary key references public.questions(id) on delete cascade,
  checklist jsonb not null default '[]'::jsonb,
  followups jsonb not null default '[]'::jsonb,
  rubric jsonb not null default '[]'::jsonb
);

create table public.question_files (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  path text not null,
  content text not null,
  kind text not null check (kind in ('buggy', 'test')),
  unique (question_id, path)
);

create table public.question_reference_files (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  path text not null,
  content text not null,
  unique (question_id, path)
);

create table public.question_bugs (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  title text not null,
  description text not null default '',
  file_path text,
  hint text
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id),
  created_by uuid not null,
  interviewer_id uuid,
  interviewee_id uuid,
  interviewer_email text not null check (interviewer_email = lower(interviewer_email)),
  interviewee_email text not null check (interviewee_email = lower(interviewee_email)),
  phase public.session_phase not null default 'briefing',
  created_at timestamptz not null default now(),
  debugging_started_at timestamptz,
  completed_at timestamptz
);
create index sessions_question_idx on public.sessions(question_id);
create index sessions_interviewer_idx on public.sessions(interviewer_id);
create index sessions_interviewee_idx on public.sessions(interviewee_id);
create index sessions_created_by_idx on public.sessions(created_by);

create table public.session_files (
  session_id uuid not null references public.sessions(id) on delete cascade,
  path text not null,
  content text not null,
  kind text not null check (kind in ('code', 'test')),
  updated_at timestamptz not null default now(),
  primary key (session_id, path)
);

create table public.test_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  passed int not null default 0,
  failed int not null default 0,
  errored int not null default 0,
  results jsonb not null default '[]'::jsonb,
  stdout text not null default '',
  created_at timestamptz not null default now()
);
create index test_runs_session_idx on public.test_runs(session_id, created_at);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  role public.msg_role not null,
  content text not null,
  created_at timestamptz not null default now()
);
create index ai_messages_session_idx on public.ai_messages(session_id, created_at);

create table public.bug_status (
  session_id uuid not null references public.sessions(id) on delete cascade,
  bug_id uuid not null references public.question_bugs(id) on delete cascade,
  state public.bug_state not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, bug_id)
);

create table public.session_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  author_id uuid not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index session_notes_session_idx on public.session_notes(session_id, created_at);

create table public.session_reviews (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  score int check (score between 1 and 5),
  summary text not null default '',
  rubric_scores jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------- touch triggers
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger session_files_touch before update on public.session_files
  for each row execute function public.touch_updated_at();
create trigger bug_status_touch before update on public.bug_status
  for each row execute function public.touch_updated_at();
create trigger session_reviews_touch before update on public.session_reviews
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------- helper checks
-- Security definer so policies on one table can consult sessions without RLS recursion.
create function public.is_session_participant(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session_id
      and (select auth.uid()) in (s.interviewer_id, s.interviewee_id)
  );
$$;

create function public.is_session_interviewer(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.interviewer_id = (select auth.uid())
  );
$$;

create function public.is_session_interviewee(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.interviewee_id = (select auth.uid())
  );
$$;

create function public.is_question_interviewer(p_question_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.sessions s
    where s.question_id = p_question_id and s.interviewer_id = (select auth.uid())
  );
$$;

create function public.session_phase_of(p_session_id uuid) returns public.session_phase
language sql stable security definer set search_path = public as $$
  select s.phase from public.sessions s where s.id = p_session_id;
$$;

-- ----------------------------------------------------------------- RPCs
create function public.create_session(
  p_question_id uuid,
  p_my_role text,
  p_other_email text
) returns public.sessions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_my_email text := lower(nullif(btrim((select auth.jwt() ->> 'email')), ''));
  v_other text := lower(nullif(btrim(coalesce(p_other_email, '')), ''));
  v_row public.sessions;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_my_email is null then
    raise exception 'caller has no email' using errcode = '22023';
  end if;
  if p_my_role is null or p_my_role not in ('interviewer', 'interviewee') then
    raise exception 'invalid role: must be interviewer or interviewee' using errcode = '22023';
  end if;
  if v_other is null then
    raise exception 'other email is required' using errcode = '22023';
  end if;
  if v_other = v_my_email then
    raise exception 'other email must differ from your own' using errcode = '22023';
  end if;
  if not exists (select 1 from public.questions q where q.id = p_question_id) then
    raise exception 'question not found' using errcode = '22023';
  end if;

  if p_my_role = 'interviewer' then
    insert into public.sessions (question_id, created_by, interviewer_id, interviewer_email, interviewee_email)
    values (p_question_id, v_uid, v_uid, v_my_email, v_other)
    returning * into v_row;
  else
    insert into public.sessions (question_id, created_by, interviewee_id, interviewee_email, interviewer_email)
    values (p_question_id, v_uid, v_uid, v_my_email, v_other)
    returning * into v_row;
  end if;
  return v_row;
end;
$$;

create function public.claim_session(p_session_id uuid) returns public.sessions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(nullif(btrim((select auth.jwt() ->> 'email')), ''));
  v_row public.sessions;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_row from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  -- Already a participant: idempotent.
  if v_uid in (v_row.interviewer_id, v_row.interviewee_id) then
    return v_row;
  end if;
  if v_email is null then
    raise exception 'caller has no email' using errcode = '22023';
  end if;
  if v_row.interviewer_id is null and v_row.interviewer_email = v_email then
    update public.sessions set interviewer_id = v_uid where id = p_session_id returning * into v_row;
  elsif v_row.interviewee_id is null and v_row.interviewee_email = v_email then
    update public.sessions set interviewee_id = v_uid where id = p_session_id returning * into v_row;
  else
    raise exception 'no open slot for this account in the session' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

create function public.set_phase(p_session_id uuid, p_phase public.session_phase)
returns public.sessions
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.sessions;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_row from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_row.interviewer_id is distinct from v_uid then
    raise exception 'only the interviewer can change the phase' using errcode = '42501';
  end if;
  if not ((v_row.phase = 'briefing' and p_phase = 'debugging')
       or (v_row.phase = 'debugging' and p_phase = 'completed')) then
    raise exception 'invalid phase transition % -> %', v_row.phase, p_phase using errcode = '22023';
  end if;

  if p_phase = 'debugging' then
    insert into public.session_files (session_id, path, content, kind)
    select p_session_id, qf.path, qf.content,
           case qf.kind when 'buggy' then 'code' else 'test' end
    from public.question_files qf
    where qf.question_id = v_row.question_id
    on conflict (session_id, path) do nothing;
    update public.sessions set phase = p_phase, debugging_started_at = now()
      where id = p_session_id returning * into v_row;
  else
    update public.sessions set phase = p_phase, completed_at = now()
      where id = p_session_id returning * into v_row;
  end if;
  return v_row;
end;
$$;

-- ------------------------------------------------------ grants (default deny)
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon;

grant usage on schema public to authenticated;

grant select on public.questions, public.question_private, public.question_files,
  public.question_reference_files, public.question_bugs, public.sessions,
  public.session_files, public.test_runs, public.ai_messages to authenticated;
grant update (content) on public.session_files to authenticated;
grant insert (session_id, passed, failed, errored, results, stdout) on public.test_runs to authenticated;
grant select, insert, update, delete on public.bug_status, public.session_notes,
  public.session_reviews to authenticated;

grant execute on function public.create_session(uuid, text, text) to authenticated;
grant execute on function public.claim_session(uuid) to authenticated;
grant execute on function public.set_phase(uuid, public.session_phase) to authenticated;
grant execute on function public.is_session_participant(uuid) to authenticated;
grant execute on function public.is_session_interviewer(uuid) to authenticated;
grant execute on function public.is_session_interviewee(uuid) to authenticated;
grant execute on function public.is_question_interviewer(uuid) to authenticated;
grant execute on function public.session_phase_of(uuid) to authenticated;

-- ------------------------------------------------------------------- RLS
alter table public.questions enable row level security;
alter table public.question_private enable row level security;
alter table public.question_files enable row level security;
alter table public.question_reference_files enable row level security;
alter table public.question_bugs enable row level security;
alter table public.sessions enable row level security;
alter table public.session_files enable row level security;
alter table public.test_runs enable row level security;
alter table public.ai_messages enable row level security;
alter table public.bug_status enable row level security;
alter table public.session_notes enable row level security;
alter table public.session_reviews enable row level security;

create policy questions_select on public.questions for select to authenticated
  using (true);

create policy question_private_select on public.question_private for select to authenticated
  using (public.is_question_interviewer(question_id));
create policy question_files_select on public.question_files for select to authenticated
  using (public.is_question_interviewer(question_id));
create policy question_reference_files_select on public.question_reference_files for select to authenticated
  using (public.is_question_interviewer(question_id));
create policy question_bugs_select on public.question_bugs for select to authenticated
  using (public.is_question_interviewer(question_id));

create policy sessions_select on public.sessions for select to authenticated
  using (
    created_by = (select auth.uid())
    or interviewer_id = (select auth.uid())
    or interviewee_id = (select auth.uid())
  );

create policy session_files_select on public.session_files for select to authenticated
  using (public.is_session_participant(session_id));
create policy session_files_update on public.session_files for update to authenticated
  using (public.is_session_interviewee(session_id) and public.session_phase_of(session_id) = 'debugging')
  with check (public.is_session_interviewee(session_id) and public.session_phase_of(session_id) = 'debugging');

create policy test_runs_select on public.test_runs for select to authenticated
  using (public.is_session_participant(session_id));
create policy test_runs_insert on public.test_runs for insert to authenticated
  with check (public.is_session_interviewee(session_id) and public.session_phase_of(session_id) = 'debugging');

-- ai_messages: no insert policy for clients; service role bypasses RLS.
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (public.is_session_participant(session_id));

create policy bug_status_all on public.bug_status for all to authenticated
  using (public.is_session_interviewer(session_id))
  with check (public.is_session_interviewer(session_id));

create policy session_notes_all on public.session_notes for all to authenticated
  using (public.is_session_interviewer(session_id))
  with check (public.is_session_interviewer(session_id) and author_id = (select auth.uid()));

create policy session_reviews_interviewer on public.session_reviews for all to authenticated
  using (public.is_session_interviewer(session_id))
  with check (public.is_session_interviewer(session_id));
create policy session_reviews_interviewee_select on public.session_reviews for select to authenticated
  using (public.is_session_interviewee(session_id) and public.session_phase_of(session_id) = 'completed');
