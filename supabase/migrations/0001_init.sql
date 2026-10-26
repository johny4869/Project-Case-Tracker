-- ============================================================================
-- Project Case Tracker - initial schema
-- Run this in the Supabase SQL Editor (project owner / postgres role).
-- Safe to re-run: tables/indexes use IF NOT EXISTS, policies are dropped first.
--
-- Security model: single-user (owner_id = auth.uid()), extensible to multi-user
-- later by adding project_members and widening the policies. No anonymous access.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active','paused','archived')),
  color text not null default '',
  position numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, key)
);

-- ---------------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------------
create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  case_number text,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','review','done','archived')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  assignee_id uuid references auth.users(id) on delete set null,
  due_date date,
  position numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cases_project_case_number_key
  on public.cases (project_id, case_number) where case_number is not null;
create index if not exists cases_project_status_idx on public.cases (project_id, status);
create index if not exists cases_project_position_idx on public.cases (project_id, position);

-- ---------------------------------------------------------------------------
-- tasks (sub-tasks of a case)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo','in_progress','review','done')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  assignee_id uuid references auth.users(id) on delete set null,
  due_date date,
  position numeric not null default 0,
  is_done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_case_status_idx on public.tasks (case_id, status);
create index if not exists tasks_case_position_idx on public.tasks (case_id, position);

-- ---------------------------------------------------------------------------
-- reports (replaces the old RAG-only view; kind is free-form)
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  title text not null,
  kind text not null default 'general',
  content_md text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reports_project_idx on public.reports (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- attachments (metadata; files live in Storage)
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  constraint attachments_one_parent check (num_nonnulls(project_id, case_id, task_id) = 1)
);
create index if not exists attachments_case_idx on public.attachments (case_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['projects','cases','tasks','reports'] loop
    execute format('drop trigger if exists set_updated_at on public.%I;', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t);
  end loop;
end;
$$;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.profiles    enable row level security;
alter table public.projects    enable row level security;
alter table public.cases       enable row level security;
alter table public.tasks       enable row level security;
alter table public.reports     enable row level security;
alter table public.attachments enable row level security;

-- profiles -----------------------------------------------------------------
drop policy if exists profiles_owner_select on public.profiles;
drop policy if exists profiles_owner_update on public.profiles;
drop policy if exists profiles_owner_insert on public.profiles;
create policy profiles_owner_select on public.profiles for select using (id = auth.uid());
create policy profiles_owner_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_owner_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- projects -----------------------------------------------------------------
drop policy if exists projects_owner_all on public.projects;
create policy projects_owner_all on public.projects
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- cases --------------------------------------------------------------------
drop policy if exists cases_owner_all on public.cases;
create policy cases_owner_all on public.cases
  for all
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- tasks --------------------------------------------------------------------
drop policy if exists tasks_owner_all on public.tasks;
create policy tasks_owner_all on public.tasks
  for all
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.cases c
      where c.id = case_id and c.owner_id = auth.uid()
    )
  );

-- reports ------------------------------------------------------------------
drop policy if exists reports_owner_all on public.reports;
create policy reports_owner_all on public.reports
  for all
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- attachments --------------------------------------------------------------
drop policy if exists attachments_owner_all on public.attachments;
create policy attachments_owner_all on public.attachments
  for all
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and (
      (project_id is not null and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()))
      or (case_id is not null and exists (select 1 from public.cases c where c.id = case_id and c.owner_id = auth.uid()))
      or (task_id is not null and exists (select 1 from public.tasks t where t.id = task_id and t.owner_id = auth.uid()))
    )
  );

-- ===========================================================================
-- Storage: private "attachments" bucket + per-user policies
-- Object path convention: {userId}/{projectId}/{caseId|taskId|general}/{uuid}_{filename}
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set public = false;

drop policy if exists attachments_storage_select on storage.objects;
drop policy if exists attachments_storage_insert on storage.objects;
drop policy if exists attachments_storage_update on storage.objects;
drop policy if exists attachments_storage_delete on storage.objects;

create policy attachments_storage_select on storage.objects
  for select using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy attachments_storage_insert on storage.objects
  for insert with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy attachments_storage_update on storage.objects
  for update using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy attachments_storage_delete on storage.objects
  for delete using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
