-- Verification apres execution de schema.sql
-- A lancer dans Supabase SQL Editor.

select 'app_users' as controle, count(*) as lignes from public.app_users
union all select 'locaux', count(*) from public.locaux
union all select 'locataires', count(*) from public.locataires
union all select 'baux', count(*) from public.baux
union all select 'loyers_mensuels', count(*) from public.loyers_mensuels
union all select 'travaux', count(*) from public.travaux
union all select 'remuneration_gerant', count(*) from public.remuneration_gerant;

select email, nom, role, actif
from public.app_users
order by role, email;

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'app_users',
    'locaux',
    'locataires',
    'baux',
    'loyers_mensuels',
    'paiements',
    'travaux',
    'remuneration_gerant',
    'documents'
  )
order by tablename;
