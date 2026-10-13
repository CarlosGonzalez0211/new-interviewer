-- Interview duration: sessions.started_at = the moment BOTH participant slots are filled
-- (the interview effectively begins). Null until then.
--
-- Clients read it through the existing table-level `grant select on public.sessions`
-- (table-level privileges cover columns added later) and the sessions_select policy.
-- There is no update/insert grant on sessions, so clients cannot write it; only the
-- security definer RPCs below set it.

alter table public.sessions add column started_at timestamptz;

-- Backfill: for sessions that already have both slots filled we cannot know when the
-- second person joined, so use created_at (a lower bound that keeps
-- started_at <= debugging_started_at <= completed_at). Sessions with an open slot stay null.
update public.sessions
   set started_at = created_at
 where started_at is null
   and interviewer_id is not null
   and interviewee_id is not null;

create or replace function public.claim_session(p_session_id uuid) returns public.sessions
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
  -- Both slots filled for the first time: the interview begins.
  if v_row.started_at is null and v_row.interviewer_id is not null and v_row.interviewee_id is not null then
    update public.sessions set started_at = now() where id = p_session_id returning * into v_row;
  end if;
  return v_row;
end;
$$;

create or replace function public.set_phase(p_session_id uuid, p_phase public.session_phase)
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
    -- started_at is normally set by claim_session; fill it here if a session skipped that path.
    update public.sessions
       set phase = p_phase, debugging_started_at = now(), started_at = coalesce(started_at, now())
     where id = p_session_id returning * into v_row;
  else
    update public.sessions set phase = p_phase, completed_at = now()
      where id = p_session_id returning * into v_row;
  end if;
  return v_row;
end;
$$;
