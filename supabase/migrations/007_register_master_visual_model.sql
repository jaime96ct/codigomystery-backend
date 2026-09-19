create table if not exists public.visual_models (
  id text primary key,
  name text not null,
  version text not null,
  is_active boolean not null default false,
  spec jsonb not null,
  reference_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.visual_models (id, name, version, is_active, spec, reference_notes)
values (
  'codigomystery_stickman_v1',
  'CodigoMystery Stickman',
  '1.0',
  true,
  '{
    "canvas":{"aspect_ratio":"9:16","target_width":1080,"target_height":1920},
    "character":{"head":"round white head with thick black outline","eyes":"large black oval eyes","eyebrows":"thick expressive black eyebrows","mouth":"small simple expressive mouth","body":"thick black stick limbs","hands":"rounded black hands","feet":"oval black feet","line_weight":"bold consistent","ground_shadow":"simple dark oval"},
    "expressions":["neutral","fear","surprise","suspicion","doubt","relief","thinking","angry","nervous"],
    "poses":["stand","pointing","running","kneeling","accusing","sneaking","looking_back"],
    "variants":["base","flashlight","notebook","detective_magnifying_glass","police","formal"],
    "palette":{"background":"simple muted dark/neutral","character":["white","black"],"accent":["blue","yellow","red"]},
    "rules":["same recognizable character silhouette in every scene","one scene per image","never collage","never split screen","one clear visual focus","simple readable background","no text inside scene image unless explicitly requested"]
  }'::jsonb,
  'Official master model based on the approved CodigoMystery character sheet from the project conversation.'
)
on conflict (id) do update
set name = excluded.name,
    version = excluded.version,
    is_active = excluded.is_active,
    spec = excluded.spec,
    reference_notes = excluded.reference_notes,
    updated_at = now();

alter table public.scenes
  add column if not exists character_model text not null default 'codigomystery_stickman_v1',
  add column if not exists camera_view text,
  add column if not exists accessory_variant text,
  add column if not exists image_provider text,
  add column if not exists image_generation_notes text;

alter table public.visual_models enable row level security;
