alter table public.scenes
  add column if not exists start_time numeric,
  add column if not exists end_time numeric;

alter table public.projects
  add column if not exists estimated_duration numeric,
  add column if not exists subtitles_url text,
  add column if not exists timeline jsonb;
