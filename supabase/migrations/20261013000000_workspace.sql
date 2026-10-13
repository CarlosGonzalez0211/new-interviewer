-- Collaborative workspace: shared notes, Yjs state and whiteboard per session.

create table public.session_workspace (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  notes text not null default '',
  yjs_state text,
  whiteboard jsonb,
  updated_at timestamptz not null default now()
);

create trigger session_workspace_touch before update on public.session_workspace
  for each row execute function public.touch_updated_at();

-- Default deny, then column-level grants (no delete, no direct updated_at writes).
revoke all on public.session_workspace from public, anon, authenticated;
grant select on public.session_workspace to authenticated;
grant insert (session_id, notes, yjs_state, whiteboard) on public.session_workspace to authenticated;
grant update (notes, yjs_state, whiteboard) on public.session_workspace to authenticated;

alter table public.session_workspace enable row level security;

create policy session_workspace_select on public.session_workspace for select to authenticated
  using (public.is_session_participant(session_id));
create policy session_workspace_insert on public.session_workspace for insert to authenticated
  with check (
    public.is_session_participant(session_id)
    and public.session_phase_of(session_id) in ('briefing', 'debugging')
  );
create policy session_workspace_update on public.session_workspace for update to authenticated
  using (
    public.is_session_participant(session_id)
    and public.session_phase_of(session_id) in ('briefing', 'debugging')
  )
  with check (
    public.is_session_participant(session_id)
    and public.session_phase_of(session_id) in ('briefing', 'debugging')
  );

-- session_files: during debugging both participants may update content
-- (column grant update(content) already exists from the schema migration).
drop policy session_files_update on public.session_files;
create policy session_files_update on public.session_files for update to authenticated
  using (public.is_session_participant(session_id) and public.session_phase_of(session_id) = 'debugging')
  with check (public.is_session_participant(session_id) and public.session_phase_of(session_id) = 'debugging');
