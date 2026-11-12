begin;

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.documents(id) on delete restrict,
  title text not null,
  body text not null,
  author_email text not null default public.ruvelon_current_email(),
  created_at timestamptz not null default now(),
  constraint contributions_title check (
    (report_id is null and char_length(btrim(title)) between 1 and 160)
    or (report_id is not null and title = '')
  ),
  constraint contributions_body check (char_length(btrim(body)) between 1 and 5000)
);

create index if not exists contributions_report_date_idx
  on public.contributions (report_id, created_at desc);

alter table public.contributions enable row level security;
revoke all on public.contributions from public, anon, authenticated;
grant select on public.contributions to authenticated;
grant insert (report_id, title, body) on public.contributions to authenticated;

drop policy if exists contributions_read on public.contributions;
create policy contributions_read on public.contributions for select to authenticated
  using ((select public.ruvelon_is_authorized()));

drop policy if exists contributions_add on public.contributions;
create policy contributions_add on public.contributions for insert to authenticated
  with check (
    (select public.ruvelon_is_authorized())
    and author_email = (select public.ruvelon_current_email())
    and ((select public.ruvelon_is_admin()) or author_email = 'matthieu.lonchamp@gmail.com')
    and (report_id is null or exists (
      select 1 from public.documents d
      where d.id = report_id and d.categorie = 'compte_rendu'
    ))
  );

commit;
