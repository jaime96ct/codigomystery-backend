create or replace function public.claim_daily_content_slot(
  p_project_id text,
  p_content_date date,
  p_slot smallint,
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
    and slot = p_slot
    and status = 'READY'
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  insert into public.projects (
    project_id, status, format, language, title, description, tags, script,
    style, topic, idea, script_qa, generation_attempts, generation_model, content_origin
  )
  values (
    p_project_id, 'READY_FOR_IMAGES', p_format, p_language, queued.title,
    queued.description, queued.tags, queued.script, p_style, queued.topic,
    queued.idea, queued.script_qa, 1, 'chatgpt_scheduled',
    coalesce(queued.content_origin, 'INVENTADO')
  )
  returning * into created;

  insert into public.scenes (
    project_id, scene_number, narration, duration, image_prompt,
    animation_prompt, visual_spec, character_model, camera_view,
    accessory_variant, status
  )
  select
    p_project_id,
    scene_number,
    narration,
    duration,
    image_prompt,
    animation_prompt,
    visual_spec,
    coalesce(character_model, 'codigomystery_stickman_v1'),
    visual_spec->>'camera_view',
    coalesce(visual_spec->>'accessory_variant', 'base'),
    'IMAGE_PENDING'
  from jsonb_to_recordset(queued.scenes) as scene(
    scene_number integer,
    narration text,
    duration numeric,
    image_prompt text,
    animation_prompt text,
    visual_spec jsonb,
    character_model text
  );

  update public.content_queue
  set status = 'CLAIMED',
      project_id = p_project_id,
      claimed_at = now()
  where id = queued.id;

  return created;
end;
$$;

revoke execute on function public.claim_daily_content_slot(text,date,smallint,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_daily_content_slot(text,date,smallint,text,text,text) to service_role;
