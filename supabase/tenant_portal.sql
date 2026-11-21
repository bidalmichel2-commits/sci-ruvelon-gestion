-- Portail locataire SCI RUVELON.
-- Migration additive et relancable : aucune ligne metier n'est supprimee.

begin;

alter table public.app_users
  add column if not exists locataire_id uuid references public.locataires(id) on delete restrict;

alter table public.app_users
  drop constraint if exists app_users_role_check;

alter table public.app_users
  add constraint app_users_role_check check (role in ('admin','lecture','tenant'));

create unique index if not exists app_users_one_tenant_login
  on public.app_users (locataire_id)
  where role = 'tenant' and locataire_id is not null;

create or replace function public.ruvelon_is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.app_users u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email',''))
      and u.actif = true
      and u.role in ('admin','lecture')
  );
$$;

create or replace function public.ruvelon_current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.locataire_id
  from public.app_users u
  where auth.uid() is not null
    and lower(u.email) = lower(coalesce(auth.jwt() ->> 'email',''))
    and u.actif = true
    and u.role = 'tenant'
  limit 1;
$$;

revoke all on function public.ruvelon_is_staff() from public;
revoke all on function public.ruvelon_current_tenant_id() from public;
grant execute on function public.ruvelon_is_staff() to authenticated;
grant execute on function public.ruvelon_current_tenant_id() to authenticated;

drop policy if exists locaux_select on public.locaux;
create policy locaux_select on public.locaux
  for select to authenticated
  using (
    public.ruvelon_is_staff()
    or exists (
      select 1 from public.baux b
      where b.local_id = locaux.id
        and b.locataire_id = public.ruvelon_current_tenant_id()
    )
  );

drop policy if exists locataires_select on public.locataires;
create policy locataires_select on public.locataires
  for select to authenticated
  using (public.ruvelon_is_staff() or id = public.ruvelon_current_tenant_id());

drop policy if exists baux_select on public.baux;
create policy baux_select on public.baux
  for select to authenticated
  using (public.ruvelon_is_staff() or locataire_id = public.ruvelon_current_tenant_id());

drop policy if exists loyers_mensuels_select on public.loyers_mensuels;
create policy loyers_mensuels_select on public.loyers_mensuels
  for select to authenticated
  using (public.ruvelon_is_staff() or locataire_id = public.ruvelon_current_tenant_id());

drop policy if exists paiements_select on public.paiements;
create policy paiements_select on public.paiements
  for select to authenticated
  using (
    public.ruvelon_is_staff()
    or exists (
      select 1 from public.loyers_mensuels l
      where l.id = paiements.loyer_id
        and l.locataire_id = public.ruvelon_current_tenant_id()
    )
  );

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select to authenticated
  using (
    public.ruvelon_is_staff()
    or locataire_id = public.ruvelon_current_tenant_id()
    or exists (
      select 1 from public.baux b
      where b.id = documents.bail_id
        and b.locataire_id = public.ruvelon_current_tenant_id()
    )
  );

drop policy if exists travaux_select on public.travaux;
create policy travaux_select on public.travaux
  for select to authenticated
  using (public.ruvelon_is_staff());

drop policy if exists remuneration_gerant_select on public.remuneration_gerant;
create policy remuneration_gerant_select on public.remuneration_gerant
  for select to authenticated
  using (public.ruvelon_is_staff());

drop policy if exists contributions_read on public.contributions;
create policy contributions_read on public.contributions
  for select to authenticated
  using (public.ruvelon_is_staff());

drop policy if exists contributions_add on public.contributions;
create policy contributions_add on public.contributions
  for insert to authenticated
  with check (
    public.ruvelon_is_staff()
    and author_email = public.ruvelon_current_email()
    and ((select public.ruvelon_is_admin()) or author_email = 'matthieu.lonchamp@gmail.com')
    and (report_id is null or exists (
      select 1 from public.documents d
      where d.id = report_id and d.categorie = 'compte_rendu'
    ))
  );

drop policy if exists contributions_edit_note on public.contributions;
create policy contributions_edit_note on public.contributions
  for update to authenticated
  using (
    public.ruvelon_is_staff() and report_id is null
    and ((select public.ruvelon_is_admin()) or author_email = public.ruvelon_current_email())
  )
  with check (
    public.ruvelon_is_staff() and report_id is null
    and ((select public.ruvelon_is_admin()) or author_email = public.ruvelon_current_email())
  );

drop policy if exists contributions_delete_note on public.contributions;
create policy contributions_delete_note on public.contributions
  for delete to authenticated
  using (
    public.ruvelon_is_staff() and report_id is null
    and ((select public.ruvelon_is_admin()) or author_email = public.ruvelon_current_email())
  );

commit;
