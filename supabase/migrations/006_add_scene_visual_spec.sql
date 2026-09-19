alter table public.scenes
  add column if not exists visual_spec jsonb;

create or replace function public.claim_daily_content(
  p_project_id text,
  p_content_date date,
  p_format text default 'Micro-misterio',
  p_language text default 'Español',
  p_style text default 'Stickman CodigoMystery'
)
returns public.projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued public.content_queue%rowtype;
  created public.projects%rowtype;
begin
  select *
  into queued
  from public.content_queue
  where content_date = p_content_date
    and status = 'READY'
  order by slot
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  insert into public.projects (
    project_id, status, format, language, title, description, tags, script,
    style, topic, idea, script_qa, generation_attempts, generation_model
  )
  values (
    p_project_id, 'READY_FOR_ASSETS', p_format, p_language, queued.title,
    queued.description, queued.tags, queued.script, p_style, queued.topic,
    queued.idea, queued.script_qa, 1, 'chatgpt_scheduled'
  )
  returning * into created;

  insert into public.scenes (
    project_id, scene_number, narration, duration, image_prompt,
    animation_prompt, visual_spec, status
  )
  select
    p_project_id,
    scene_number,
    narration,
    duration,
    image_prompt,
    animation_prompt,
    visual_spec,
    'PLANNED'
  from jsonb_to_recordset(queued.scenes) as scene(
    scene_number integer,
    narration text,
    duration numeric,
    image_prompt text,
    animation_prompt text,
    visual_spec jsonb
  );

  update public.content_queue
  set status = 'CLAIMED',
      project_id = p_project_id,
      claimed_at = now()
  where id = queued.id;

  return created;
end;
$$;
