-- ============================================================
-- SCI RUVELON GESTION 3 - Schema Supabase
-- Objectif: outil simple de pilotage MEG, loyers, baux, travaux
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Utilisateurs et securite ----------

create table if not exists public.app_users (
  email text primary key,
  nom text not null,
  role text not null check (role in ('admin', 'lecture')),
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.app_users (email, nom, role, actif)
values
  ('bidal.michel2@gmail.com', 'Michel Bidal', 'admin', true),
  ('matthieu.lonchamp@gmail.com', 'Matthieu Lonchamp', 'lecture', true)
on conflict (email) do update
set nom = excluded.nom, role = excluded.role, actif = excluded.actif;

create or replace function public.ruvelon_current_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.ruvelon_is_authorized()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where lower(email) = public.ruvelon_current_email()
      and actif = true
  );
$$;

create or replace function public.ruvelon_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where lower(email) = public.ruvelon_current_email()
      and role = 'admin'
      and actif = true
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- Tables metier ----------

create table if not exists public.locaux (
  id uuid primary key default gen_random_uuid(),
  code_local text not null unique,
  designation text not null,
  niveau text,
  surface_m2 numeric(10,2),
  statut text not null default 'Disponible',
  loyer_ht numeric(12,2) not null default 0,
  tva_loyer numeric(5,2) not null default 0,
  loyer_ttc numeric(12,2) not null default 0,
  charges_mensuelles numeric(12,2) not null default 0,
  depot_garantie numeric(12,2) not null default 0,
  observations text,
  actif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.locataires (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'Particulier',
  nom text,
  prenom text,
  raison_sociale text,
  activite text,
  telephone text,
  email text,
  adresse text,
  code_postal text,
  ville text,
  statut text not null default 'Actif',
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.baux (
  id uuid primary key default gen_random_uuid(),
  local_id uuid not null references public.locaux(id) on delete restrict,
  locataire_id uuid not null references public.locataires(id) on delete restrict,
  type_bail text not null default 'Commercial',
  date_debut date not null,
  date_fin date,
  duree_mois integer,
  loyer_ht numeric(12,2) not null default 0,
  tva numeric(5,2) not null default 0,
  charges_mensuelles numeric(12,2) not null default 0,
  depot_garantie numeric(12,2) not null default 0,
  renouvellement_auto boolean not null default false,
  statut text not null default 'Actif',
  document_url text,
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.loyers_mensuels (
  id uuid primary key default gen_random_uuid(),
  mois date not null,
  bail_id uuid references public.baux(id) on delete set null,
  local_id uuid references public.locaux(id) on delete set null,
  locataire_id uuid references public.locataires(id) on delete set null,
  loyer_ht numeric(12,2) not null default 0 check (loyer_ht >= 0),
  tva numeric(12,2) not null default 0 check (tva >= 0),
  loyer_ttc numeric(12,2) not null default 0 check (loyer_ttc >= 0),
  charges_mensuelles numeric(12,2) not null default 0 check (charges_mensuelles >= 0),
  total_attendu numeric(12,2) not null default 0 check (total_attendu >= 0),
  total_paye numeric(12,2) not null default 0 check (total_paye >= 0),
  solde numeric(12,2) generated always as (round(total_attendu - total_paye, 2)) stored,
  facture_meg_faite boolean not null default false,
  date_facture_meg date,
  paiement_controle boolean not null default false,
  date_paiement_controle date,
  statut text not null default 'A suivre',
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mois, bail_id),
  constraint loyers_mensuels_total_paye_max check (total_paye <= total_attendu)
);

create table if not exists public.paiements (
  id uuid primary key default gen_random_uuid(),
  loyer_id uuid not null references public.loyers_mensuels(id) on delete cascade,
  date_paiement date not null default current_date,
  montant numeric(12,2) not null check (montant >= 0),
  mode_reglement text default 'Virement',
  reference_bancaire text,
  observations text,
  created_at timestamptz not null default now()
);

create table if not exists public.travaux (
  id uuid primary key default gen_random_uuid(),
  local_id uuid references public.locaux(id) on delete set null,
  titre text not null,
  description text,
  priorite text not null default 'Normale',
  statut text not null default 'A faire',
  entreprise text,
  montant_estime numeric(12,2) not null default 0,
  montant_reel numeric(12,2) not null default 0,
  date_prevue date,
  date_realisation date,
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.remuneration_gerant (
  id uuid primary key default gen_random_uuid(),
  annee integer not null,
  mois date not null unique,
  encaissements_ht numeric(12,2) not null default 0,
  remuneration_brute_7pc numeric(12,2) generated always as (round(encaissements_ht * 0.07, 2)) stored,
  remuneration_apres_abattement numeric(12,2) generated always as (round(encaissements_ht * 0.07 * 0.70, 2)) stored,
  heures numeric(8,2) not null default 0,
  km numeric(10,2) not null default 0,
  bareme_km numeric(8,3) not null default 0.636,
  frais_km numeric(12,2) generated always as (round(km * bareme_km, 2)) stored,
  loyer_reference_prime numeric(12,2) not null default 0,
  situation_prime text not null default 'Aucune prime',
  taux_prime numeric(5,2) not null default 0,
  prime_edl numeric(12,2) not null default 0,
  prime_responsabilite numeric(12,2) not null default 0,
  autres_frais numeric(12,2) not null default 0,
  autres_frais_inclus_total boolean not null default false,
  total_compte_courant numeric(12,2) generated always as (
    round(
      encaissements_ht * 0.07 * 0.70
      + km * bareme_km
      + prime_edl
      + prime_responsabilite
      + case when autres_frais_inclus_total then autres_frais else 0 end,
      2
    )
  ) stored,
  note_prime text,
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  nom_fichier text not null,
  categorie text,
  url text not null,
  local_id uuid references public.locaux(id) on delete set null,
  locataire_id uuid references public.locataires(id) on delete set null,
  bail_id uuid references public.baux(id) on delete set null,
  travaux_id uuid references public.travaux(id) on delete set null,
  observations text,
  created_at timestamptz not null default now()
);

-- ---------- Index ----------

create index if not exists idx_baux_date_fin on public.baux(date_fin);
create index if not exists idx_baux_statut on public.baux(statut);
create index if not exists idx_loyers_mois on public.loyers_mensuels(mois);
create index if not exists idx_loyers_facture_meg on public.loyers_mensuels(facture_meg_faite);
create index if not exists idx_travaux_statut on public.travaux(statut);
create index if not exists idx_remuneration_annee on public.remuneration_gerant(annee);

-- ---------- Triggers updated_at ----------

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'tr_locaux_updated_at') then
    create trigger tr_locaux_updated_at before update on public.locaux for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'tr_locataires_updated_at') then
    create trigger tr_locataires_updated_at before update on public.locataires for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'tr_baux_updated_at') then
    create trigger tr_baux_updated_at before update on public.baux for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'tr_loyers_updated_at') then
    create trigger tr_loyers_updated_at before update on public.loyers_mensuels for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'tr_travaux_updated_at') then
    create trigger tr_travaux_updated_at before update on public.travaux for each row execute function public.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'tr_remuneration_updated_at') then
    create trigger tr_remuneration_updated_at before update on public.remuneration_gerant for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------- Generation mensuelle des lignes de loyers ----------

create or replace function public.generer_loyers_mois(p_mois date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_mois date := date_trunc('month', p_mois)::date;
begin
  if not public.ruvelon_is_admin() then
    raise exception 'Acces refuse';
  end if;

  insert into public.loyers_mensuels (
    mois, bail_id, local_id, locataire_id,
    loyer_ht, tva, loyer_ttc, charges_mensuelles, total_attendu, statut
  )
  select
    v_mois,
    b.id,
    b.local_id,
    b.locataire_id,
    b.loyer_ht,
    round(b.loyer_ht * b.tva / 100, 2),
    round(b.loyer_ht * (1 + b.tva / 100), 2),
    b.charges_mensuelles,
    round(b.loyer_ht * (1 + b.tva / 100) + b.charges_mensuelles, 2),
    'A suivre'
  from public.baux b
  where b.statut = 'Actif'
    and b.date_debut <= v_mois
    and (b.date_fin is null or b.date_fin >= v_mois)
  on conflict (mois, bail_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- Vues utiles ----------

create or replace view public.v_baux_echeance_6_mois as
select
  b.*,
  l.code_local,
  l.designation as local_designation,
  coalesce(nullif(trim(coalesce(t.raison_sociale, '')), ''), trim(coalesce(t.nom, '') || ' ' || coalesce(t.prenom, ''))) as locataire_nom,
  (b.date_fin - current_date) as jours_restants
from public.baux b
join public.locaux l on l.id = b.local_id
join public.locataires t on t.id = b.locataire_id
where b.statut = 'Actif'
  and b.date_fin is not null
  and b.date_fin between current_date and current_date + interval '6 months';

-- ---------- RLS ----------

alter table public.app_users enable row level security;
alter table public.locaux enable row level security;
alter table public.locataires enable row level security;
alter table public.baux enable row level security;
alter table public.loyers_mensuels enable row level security;
alter table public.paiements enable row level security;
alter table public.travaux enable row level security;
alter table public.remuneration_gerant enable row level security;
alter table public.documents enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_users'
      and policyname = 'app_users_select'
  ) then
    create policy app_users_select on public.app_users
    for select
    using (
      lower(email) = public.ruvelon_current_email()
      or public.ruvelon_current_email() = 'bidal.michel2@gmail.com'
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_users'
      and policyname = 'app_users_admin_write'
  ) then
    create policy app_users_admin_write on public.app_users
    for all
    using (public.ruvelon_is_admin())
    with check (public.ruvelon_is_admin());
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'locaux', 'locataires', 'baux', 'loyers_mensuels',
    'paiements', 'travaux', 'remuneration_gerant', 'documents'
  ]
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_select') then
      execute format('create policy %I_select on public.%I for select using (public.ruvelon_is_authorized())', t, t);
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_insert') then
      execute format('create policy %I_insert on public.%I for insert with check (public.ruvelon_is_admin())', t, t);
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_update') then
      execute format('create policy %I_update on public.%I for update using (public.ruvelon_is_admin()) with check (public.ruvelon_is_admin())', t, t);
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_delete') then
      execute format('create policy %I_delete on public.%I for delete using (public.ruvelon_is_admin())', t, t);
    end if;
  end loop;
end $$;
