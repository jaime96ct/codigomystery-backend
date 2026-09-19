alter table public.projects
  add column if not exists animation_selection_confirmed boolean not null default false;

alter table public.scenes
  add column if not exists animate_with_flow boolean not null default false,
  add column if not exists animation_priority smallint,
  add column if not exists flow_prompt text,
  add column if not exists motion_type text,
  add column if not exists animation_provider text,
  add column if not exists animation_status text not null default 'NOT_SELECTED',
  add column if not exists animation_duration numeric;

update public.scenes
set flow_prompt = coalesce(
  flow_prompt,
  trim(both from concat(
    coalesce(animation_prompt, ''),
    case when animation_prompt is not null and animation_prompt <> '' then ' ' else '' end,
    'Animate this exact CodigoMystery stickman scene in vertical 9:16. Preserve the original character design, composition and simple 2D style. Do not add text, new characters, new clothing or redesign the scene. Use controlled motion only.'
  ))
)
where flow_prompt is null;
