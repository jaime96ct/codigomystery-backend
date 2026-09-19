alter table public.visual_models
  add column if not exists reference_library_file_id text,
  add column if not exists reference_library_path text;

update public.visual_models
set reference_library_file_id = 'file_0000000024c881f498ad2010c9f108f6',
    reference_library_path = '/CodigoMystery/codigomystery_stickman_v1.png',
    updated_at = now()
where id = 'codigomystery_stickman_v1';
