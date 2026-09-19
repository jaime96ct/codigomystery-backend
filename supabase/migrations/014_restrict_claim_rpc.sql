
revoke all on function public.claim_daily_content(text,date,text,text,text) from public;
revoke all on function public.claim_daily_content(text,date,text,text,text) from anon;
revoke all on function public.claim_daily_content(text,date,text,text,text) from authenticated;
grant execute on function public.claim_daily_content(text,date,text,text,text) to service_role;

create index if not exists content_queue_project_id_idx
  on public.content_queue(project_id);
