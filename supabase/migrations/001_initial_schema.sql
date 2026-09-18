-- CodigoMystery initial Supabase schema
create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_id text not null unique,
  status text not null default 'QUEUED',
  format text,
  language text,
  title text,
  description text,
  tags text[],
  script text,
  style text,
  preview_url text,
  final_video_url text,
  thumbnail_url text,
  youtube_video_id text,
  youtube_url text,
  youtube_privacy_status text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(project_id) on delete cascade,
  scene_number integer not null,
  narration text,
  duration numeric,
  image_prompt text,
  animation_prompt text,
  image_url text,
  animation_url text,
  voice_url text,
  status text not null default 'QUEUED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, scene_number)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(project_id) on delete cascade,
  type text not null,
  status text not null default 'QUEUED',
  progress integer not null default 0 check (progress between 0 and 100),
  attempt integer not null default 1 check (attempt >= 1),
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(project_id) on delete cascade,
  scene_id uuid references public.scenes(id) on delete cascade,
  type text not null,
  provider text,
  url text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists projects_status_idx on public.projects(status);
create index if not exists projects_created_at_idx on public.projects(created_at desc);
create index if not exists scenes_project_id_idx on public.scenes(project_id);
create index if not exists jobs_project_id_idx on public.jobs(project_id);
create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists assets_project_id_idx on public.assets(project_id);
create index if not exists assets_scene_id_idx on public.assets(scene_id);

alter table public.projects enable row level security;
alter table public.scenes enable row level security;
alter table public.jobs enable row level security;
alter table public.assets enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists scenes_set_updated_at on public.scenes;
create trigger scenes_set_updated_at
before update on public.scenes
for each row execute function public.set_updated_at();
