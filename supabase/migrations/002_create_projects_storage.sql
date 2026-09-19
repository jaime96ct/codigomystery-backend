-- Private project asset bucket for CodigoMystery.
insert into storage.buckets (id, name, public, file_size_limit)
values ('projects', 'projects', false, 524288000)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

-- No anon/authenticated storage policies are created intentionally.
-- Backend service-role access bypasses RLS.
