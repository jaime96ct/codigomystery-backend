alter table public.projects
  alter column idea type jsonb
  using case when idea is null then null else to_jsonb(idea) end;
