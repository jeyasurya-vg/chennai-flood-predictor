-- Chennai Flood Risk — community reports schema
-- Run this once in your Supabase project's SQL editor (Project -> SQL Editor -> New query).
--
-- Design intent:
--   * Anyone can INSERT a report (no login required) — but rate-limited to
--     one report per ward per device every 15 minutes, enforced server-side
--     via the RLS policy below (client-side cooldowns are UX only, not security).
--   * Nobody can SELECT the raw table directly (no anon read policy is
--     granted on it) — the public only ever sees the aggregated counts in
--     ward_reports_summary. This avoids exposing per-submission client_ids
--     and makes the data much less useful to scrape or manipulate precisely.
--   * This schema is safe to commit publicly. It contains no scoring logic —
--     just the shape of what's collected and how abuse is limited.

create extension if not exists pgcrypto;

create table if not exists ward_reports (
  id uuid primary key default gen_random_uuid(),
  ward_id text not null,
  ward_name text not null,
  calibration text check (calibration in ('matches', 'worse', 'better')),
  water_level text check (water_level in ('dry', 'ankle', 'knee', 'waist_plus')),
  trend text check (trend in ('rising', 'steady', 'receding')),
  client_id text not null,
  created_at timestamptz not null default now(),
  constraint at_least_one_field check (
    calibration is not null or water_level is not null or trend is not null
  )
);

create index if not exists ward_reports_ward_time_idx
  on ward_reports (ward_id, created_at desc);

alter table ward_reports enable row level security;

-- RLS policies only take effect on top of a table-level grant — without
-- this, PostgREST rejects every anon insert with 42501 before the policy
-- below is even evaluated.
grant insert on ward_reports to anon;

-- The rate-limit check below needs to see prior rows to enforce anything,
-- but anon has no SELECT access to this table (by design, see below) — a
-- plain subquery in WITH CHECK would see an empty table via RLS and always
-- pass, silently disabling the limit. security definer runs with the
-- function owner's privileges, bypassing RLS for this internal check only,
-- without granting anon a general read path.
create or replace function can_submit_report(p_client_id text, p_ward_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1 from ward_reports
    where client_id = p_client_id
      and ward_id = p_ward_id
      and created_at > now() - interval '15 minutes'
  );
$$;

-- Public can insert, but only one report per (client_id, ward_id) per 15 minutes.
create policy "rate_limited_public_insert"
  on ward_reports
  for insert
  to anon
  with check (can_submit_report(client_id, ward_id));

-- Deliberately no SELECT policy for anon on the base table — it stays
-- unreadable to the public. Only the aggregated view below is exposed.

create view ward_reports_summary
with (security_invoker = false)
as
select
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
group by ward_id, ward_name;

grant select on ward_reports_summary to anon;

-- --- After running this, verify the intended access shape before going live:
-- 1. In Table Editor -> ward_reports -> API docs, confirm anon SELECT returns
--    no rows / permission denied.
-- 2. Confirm anon SELECT on ward_reports_summary returns the aggregated columns.
-- 3. Insert a couple of test rows via the app and re-run the insert within
--    15 minutes for the same ward — it should be rejected.
