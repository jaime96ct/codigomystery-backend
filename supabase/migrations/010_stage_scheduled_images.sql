create table if not exists public.content_queue_images (
  id uuid primary key default gen_random_uuid(),
  content_queue_id uuid not null references public.content_queue(id) on delete cascade,
  scene_number integer not null check (scene_number > 0),
  status text not null default 'PENDING',
  source text,
  mime_type text,
  width integer,
  height integer,
  image_base64 text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (content_queue_id, scene_number)
);

create index if not exists content_queue_images_status_idx
  on public.content_queue_images(status, content_queue_id);

alter table public.content_queue_images enable row level security;

drop trigger if exists content_queue_images_set_updated_at on public.content_queue_images;
create trigger content_queue_images_set_updated_at
before update on public.content_queue_images
for each row execute function public.set_updated_at();
