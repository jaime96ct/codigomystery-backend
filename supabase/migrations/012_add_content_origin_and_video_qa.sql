alter table public.projects
  add column if not exists content_origin text not null default 'INVENTADO',
  add column if not exists video_qa jsonb,
  add column if not exists approved_at timestamptz;

alter table public.content_queue
  add column if not exists content_origin text not null default 'INVENTADO';

update public.projects
set content_origin = 'INVENTADO'
where content_origin is null or content_origin = '';

update public.content_queue
set content_origin = 'INVENTADO'
where content_origin is null or content_origin = '';

alter table public.projects
  drop constraint if exists projects_content_origin_check;
alter table public.projects
  add constraint projects_content_origin_check
  check (content_origin in ('REAL', 'INVENTADO', 'INSPIRADO'));

alter table public.content_queue
  drop constraint if exists content_queue_content_origin_check;
alter table public.content_queue
  add constraint content_queue_content_origin_check
  check (content_origin in ('REAL', 'INVENTADO', 'INSPIRADO'));
