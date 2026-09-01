-- Migration 002: admin panel, multi-city, fact-check voting, page_views.
-- Run this in the SQL editor of the EXISTING project that already has
-- ward_reports / ward_reports_summary / can_submit_report from the
-- original schema.sql + migration 001 (the insert-grant + security
-- definer rate-limit fix from earlier). Safe to re-run (idempotent).

-- ============================================================ admins ====
create table if not exists admins (
  id uuid primary key references auth.users(id) on delete cascade
);
alter table admins enable row level security;
grant select on admins to authenticated;

create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from admins where id = auth.uid());
$$;

drop policy if exists "admins_self_read" on admins;
create policy "admins_self_read" on admins for select to authenticated using (is_admin());

-- ======================================================== site_config ===
create table if not exists site_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table site_config enable row level security;
grant select on site_config to anon;
grant select, insert, update, delete on site_config to authenticated;

drop policy if exists "site_config_public_read" on site_config;
create policy "site_config_public_read" on site_config for select to anon using (true);
-- Anyone can sign in via the admin page's GitHub button without being an
-- admin (they just get refused the admin app) — if they then browse the
-- public site while signed in, they're `authenticated`, not `anon`. This
-- is public info either way, so let any authenticated session read it too.
drop policy if exists "site_config_authenticated_read" on site_config;
create policy "site_config_authenticated_read" on site_config for select to authenticated using (true);
drop policy if exists "site_config_admin_write" on site_config;
create policy "site_config_admin_write" on site_config
  for all to authenticated using (is_admin()) with check (is_admin());

-- ===================================================== scoring_config ===
create table if not exists scoring_config (
  city_id text primary key,
  config jsonb not null,
  updated_at timestamptz not null default now()
);
alter table scoring_config enable row level security;
grant select, insert, update, delete on scoring_config to authenticated;
-- Deliberately no grant to anon.

drop policy if exists "scoring_config_admin_only" on scoring_config;
create policy "scoring_config_admin_only" on scoring_config
  for all to authenticated using (is_admin()) with check (is_admin());

-- ==================================================== blocked_clients ===
create table if not exists blocked_clients (
  client_id text primary key,
  reason text,
  blocked_at timestamptz not null default now()
);
alter table blocked_clients enable row level security;
grant select, insert, update, delete on blocked_clients to authenticated;

drop policy if exists "blocked_clients_admin_only" on blocked_clients;
create policy "blocked_clients_admin_only" on blocked_clients
  for all to authenticated using (is_admin()) with check (is_admin());

create or replace function is_blocked(p_client_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from blocked_clients where client_id = p_client_id);
$$;

-- ================================================= ward_reports: city ===
alter table ward_reports add column if not exists city_id text not null default 'chennai';

drop index if exists ward_reports_ward_time_idx;
create index if not exists ward_reports_city_ward_time_idx
  on ward_reports (city_id, ward_id, created_at desc);

grant select, delete on ward_reports to authenticated;
-- Signed-in sessions persist in localStorage across pages on this origin,
-- so an admin browsing the public dashboard while logged in makes these
-- same requests as `authenticated`, not `anon` — grant both roles so
-- their own browser doesn't silently break on the public site.
grant insert on ward_reports to authenticated;

-- Replace the rate-limit function: old signature was
-- can_submit_report(p_client_id text, p_ward_id text). Drop the policy
-- that depends on it first, then the function, then recreate both with
-- the new city-aware + blocklist-aware signature.
drop policy if exists "rate_limited_public_insert" on ward_reports;
drop function if exists can_submit_report(text, text);

create or replace function can_submit_report(p_client_id text, p_city_id text, p_ward_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select (not is_blocked(p_client_id)) and not exists (
    select 1 from ward_reports
    where client_id = p_client_id
      and city_id = p_city_id
      and ward_id = p_ward_id
      and created_at > now() - interval '15 minutes'
  );
$$;

create policy "rate_limited_public_insert"
  on ward_reports
  for insert
  to anon, authenticated
  with check (can_submit_report(client_id, city_id, ward_id));

drop policy if exists "ward_reports_admin_read" on ward_reports;
create policy "ward_reports_admin_read" on ward_reports for select to authenticated using (is_admin());
drop policy if exists "ward_reports_admin_delete" on ward_reports;
create policy "ward_reports_admin_delete" on ward_reports for delete to authenticated using (is_admin());

-- ward_reports_summary needs city_id in its grouping — drop and recreate.
drop view if exists ward_reports_summary;
create view ward_reports_summary
with (security_invoker = false)
as
select
  city_id,
  ward_id,
  ward_name,
  count(*) filter (where created_at > now() - interval '2 hours') as reports_last_2h,
  count(*) filter (where calibration = 'worse' and created_at > now() - interval '2 hours') as calibration_worse,
  count(*) filter (where calibration = 'matches' and created_at > now() - interval '2 hours') as calibration_matches,
  count(*) filter (where calibration = 'better' and created_at > now() - interval '2 hours') as calibration_better,
  mode() within group (order by water_level) filter (where created_at > now() - interval '2 hours') as most_reported_water_level,
  mode() within group (order by trend) filter (where created_at > now() - interval '2 hours') as most_reported_trend,
  max(created_at) as last_report_at
from ward_reports
group by city_id, ward_id, ward_name;

grant select on ward_reports_summary to anon, authenticated;

create or replace view ward_reports_recent
with (security_invoker = false)
as
select id, city_id, ward_id, ward_name, calibration, water_level, trend, created_at
from ward_reports
where created_at > now() - interval '2 hours';

grant select on ward_reports_recent to anon, authenticated;

-- ================================================ report_confirmations ==
create table if not exists report_confirmations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references ward_reports(id) on delete cascade,
  client_id text not null,
  vote text not null check (vote in ('confirm', 'dispute')),
  created_at timestamptz not null default now(),
  unique (report_id, client_id)
);
alter table report_confirmations enable row level security;
grant insert on report_confirmations to anon, authenticated;
grant select, delete on report_confirmations to authenticated;

create or replace function can_vote_on_report(p_report_id uuid, p_client_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select (not is_blocked(p_client_id))
    and not exists (
      select 1 from ward_reports
      where id = p_report_id and client_id = p_client_id
    );
$$;

drop policy if exists "rate_limited_public_vote" on report_confirmations;
create policy "rate_limited_public_vote"
  on report_confirmations
  for insert
  to anon, authenticated
  with check (can_vote_on_report(report_id, client_id));

drop policy if exists "report_confirmations_admin_read" on report_confirmations;
create policy "report_confirmations_admin_read" on report_confirmations for select to authenticated using (is_admin());
drop policy if exists "report_confirmations_admin_delete" on report_confirmations;
create policy "report_confirmations_admin_delete" on report_confirmations for delete to authenticated using (is_admin());

create or replace view report_confirmation_summary
with (security_invoker = false)
as
select
  report_id,
  count(*) filter (where vote = 'confirm') as confirms,
  count(*) filter (where vote = 'dispute') as disputes
from report_confirmations
group by report_id;

grant select on report_confirmation_summary to anon;
grant select on report_confirmation_summary to authenticated;

-- =================================================== page_views (v1) =====
create table if not exists page_views (
  day date primary key default (now()::date),
  views bigint not null default 0
);
alter table page_views enable row level security;
grant select on page_views to anon, authenticated;

drop policy if exists "page_views_public_read" on page_views;
create policy "page_views_public_read" on page_views for select to anon, authenticated using (true);

create or replace function record_page_view()
returns void
language sql
security definer
set search_path = public
as $$
  insert into page_views (day, views) values (now()::date, 1)
  on conflict (day) do update set views = page_views.views + 1;
$$;

grant execute on function record_page_view() to anon, authenticated;

-- --- After running this:
-- 1. Sign into docs/admin.html once via GitHub to create your auth.users
--    row, then run:
--      insert into admins (id) select id from auth.users where email = 'YOUR_GITHUB_EMAIL';
-- 2. Re-run the verification checklist at the bottom of schema.sql.
