alter table public.projects
  add column if not exists topic text,
  add column if not exists idea text,
  add column if not exists script_qa jsonb,
  add column if not exists generation_attempts integer not null default 0,
  add column if not exists generation_model text;

create index if not exists projects_queue_idx
  on public.projects(status, created_at);
