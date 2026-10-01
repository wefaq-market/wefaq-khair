-- Wefaq Acquisition Radar + Global Matching schema
-- Safe to re-run: statements are additive/idempotent where practical.
-- External ingestion must use service-role Edge Functions; client policies expose only safe lead fields.

create extension if not exists pgcrypto;

create table if not exists public.radar_sources (
  id text primary key,
  name text not null,
  source_type text not null,
  status text not null default 'pending' check (status in ('ready','pending','disabled')),
  endpoint text,
  config jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.radar_leads (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  external_id text not null,
  title text not null,
  snippet text,
  persona text check (persona in ('student','teacher','service')),
  category text,
  priority text default 'normal' check (priority in ('hot','warm','normal')),
  source text,
  source_url text,
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  score numeric(5,2) default 0,
  triage_confidence numeric(5,2) default 0,
  status text not null default 'review' check (status in ('new','review','saved','contacted','converted','stale','rejected')),
  consent_status text not null default 'unknown' check (consent_status in ('unknown','public_contact','opted_in','restricted','not_available')),
  consent_basis text,
  contact jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  content_hash text,
  dedupe_key text,
  raw_meta jsonb not null default '{}'::jsonb,
  region text,
  country_code text,
  city text,
  language text,
  languages text[] not null default '{}',
  mode text,
  intent_type text,
  amount numeric,
  currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, external_id)
);

-- Additive upgrade for installations created with the earlier v11 schema.
alter table public.radar_leads add column if not exists triage_confidence numeric(5,2) default 0;
alter table public.radar_leads add column if not exists consent_basis text;
alter table public.radar_leads add column if not exists dedupe_key text;
alter table public.radar_leads add column if not exists region text;
alter table public.radar_leads add column if not exists country_code text;
alter table public.radar_leads add column if not exists city text;
alter table public.radar_leads add column if not exists language text;
alter table public.radar_leads add column if not exists languages text[] not null default '{}';
alter table public.radar_leads add column if not exists mode text;
alter table public.radar_leads add column if not exists intent_type text;
alter table public.radar_leads add column if not exists amount numeric;
alter table public.radar_leads add column if not exists currency text;

create index if not exists radar_leads_discovered_idx on public.radar_leads(discovered_at desc);
create index if not exists radar_leads_seen_idx on public.radar_leads(last_seen_at desc);
create index if not exists radar_leads_persona_idx on public.radar_leads(persona, priority);
create index if not exists radar_leads_status_idx on public.radar_leads(status);
create index if not exists radar_leads_hash_idx on public.radar_leads(content_hash);
create index if not exists radar_leads_dedupe_idx on public.radar_leads(dedupe_key);
create index if not exists radar_leads_region_idx on public.radar_leads(region, country_code);
create index if not exists radar_leads_category_idx on public.radar_leads(category, intent_type);

-- Cross-source duplicate protection. Empty/null keys are ignored.
create unique index if not exists radar_leads_dedupe_key_uidx
  on public.radar_leads(dedupe_key)
  where dedupe_key is not null and length(trim(dedupe_key)) > 0;

create table if not exists public.radar_sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','partial','failed')),
  source_ids text[] not null default '{}',
  found_count integer not null default 0,
  new_count integer not null default 0,
  updated_count integer not null default 0,
  deduped_count integer not null default 0,
  error_count integer not null default 0,
  notes jsonb not null default '{}'::jsonb
);

create table if not exists public.radar_outreach (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.radar_leads(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp','telegram','source','internal')),
  template_key text,
  message text,
  status text not null default 'draft' check (status in ('draft','queued','sent','blocked')),
  consent_basis text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.radar_sources enable row level security;
alter table public.radar_leads enable row level security;
alter table public.radar_sync_runs enable row level security;
alter table public.radar_outreach enable row level security;

-- No blanket client access to radar tables. Ingestion stays server-side.
-- Safe read access is provided through get_public_radar_leads() below.
drop policy if exists radar_client_read on public.radar_leads;
drop policy if exists radar_client_insert on public.radar_leads;
drop policy if exists radar_client_update on public.radar_leads;

create or replace function public.radar_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_radar_leads_updated on public.radar_leads;
create trigger trg_radar_leads_updated before update on public.radar_leads
for each row execute function public.radar_touch_updated_at();

drop trigger if exists trg_radar_sources_updated on public.radar_sources;
create trigger trg_radar_sources_updated before update on public.radar_sources
for each row execute function public.radar_touch_updated_at();

-- Safe, authenticated read surface for the front-end.
create or replace function public.get_public_radar_leads(
  p_persona text default null,
  p_region text default null,
  p_category text default null,
  p_mode text default null,
  p_language text default null,
  p_limit integer default 200
)
returns table (
  id uuid,
  source_type text,
  external_id text,
  title text,
  snippet text,
  persona text,
  category text,
  priority text,
  source text,
  source_url text,
  published_at timestamptz,
  discovered_at timestamptz,
  last_seen_at timestamptz,
  score numeric,
  triage_confidence numeric,
  status text,
  consent_status text,
  tags text[],
  region text,
  country_code text,
  city text,
  language text,
  languages text[],
  mode text,
  intent_type text,
  amount numeric,
  currency text
)
language sql
security definer
set search_path = ''
as $$
  select
    l.id,
    l.source_type,
    l.external_id,
    l.title,
    l.snippet,
    l.persona,
    l.category,
    l.priority,
    l.source,
    l.source_url,
    l.published_at,
    l.discovered_at,
    l.last_seen_at,
    l.score,
    l.triage_confidence,
    l.status,
    l.consent_status,
    l.tags,
    l.region,
    l.country_code,
    l.city,
    l.language,
    l.languages,
    l.mode,
    l.intent_type,
    l.amount,
    l.currency
  from public.radar_leads l
  where l.status in ('new','review','saved','contacted','converted')
    and (p_persona is null or l.persona = p_persona)
    and (p_region is null or l.region = p_region or l.country_code = p_region)
    and (p_category is null or l.category = p_category)
    and (p_mode is null or l.mode = p_mode)
    and (p_language is null or l.language = p_language or p_language = any(l.languages))
  order by l.discovered_at desc
  limit greatest(1, least(coalesce(p_limit,200), 500));
$$;

grant execute on function public.get_public_radar_leads(text,text,text,text,text,integer) to authenticated;
revoke all on function public.get_public_radar_leads(text,text,text,text,text,integer) from anon;

-- Safe source-readiness surface.
create or replace function public.get_radar_source_status()
returns table (
  id text,
  name text,
  source_type text,
  status text,
  last_synced_at timestamptz,
  last_error text
)
language sql
security definer
set search_path = ''
as $$
  select id,name,source_type,status,last_synced_at,last_error
  from public.radar_sources
  order by name;
$$;

grant execute on function public.get_radar_source_status() to authenticated;
revoke all on function public.get_radar_source_status() from anon;

-- Seed only source configuration, never lead data or fake counters.
insert into public.radar_sources(id,name,source_type,status,config)
values
  ('web','Open Web Search','web','pending','{"providers":["brave","google_cse"],"educational_only":true}'::jsonb),
  ('youtube','YouTube','youtube','pending','{"api":"youtube_data_api","educational_only":true}'::jsonb),
  ('x','X / Twitter','social','pending','{"api":"x_v2","educational_only":true}'::jsonb),
  ('reddit','Reddit','social','pending','{"api":"reddit_oauth","educational_only":true}'::jsonb),
  ('telegram','Telegram','community','pending','{"mode":"authorized_bot_webhook","educational_only":true}'::jsonb),
  ('rss','RSS / Feeds','feed','pending','{"mode":"approved_feed_urls","educational_only":true}'::jsonb),
  ('meta','Meta official connectors','social','pending','{"mode":"official_api_only","educational_only":true}'::jsonb),
  ('linkedin','LinkedIn official connectors','social','pending','{"mode":"official_api_only","educational_only":true}'::jsonb),
  ('freelance','Arabic freelance sources','freelance','pending','{"mode":"api_rss_or_authorized_connector","educational_only":true}'::jsonb)
on conflict (id) do update set
  name=excluded.name,
  source_type=excluded.source_type,
  config=excluded.config,
  updated_at=now();

-- Per-user saved leads: keeps CRM personalization separate from the global lead lifecycle.
create table if not exists public.radar_user_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id uuid not null references public.radar_leads(id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);

alter table public.radar_user_saves enable row level security;

drop policy if exists radar_user_saves_select on public.radar_user_saves;
drop policy if exists radar_user_saves_insert on public.radar_user_saves;
drop policy if exists radar_user_saves_update on public.radar_user_saves;
drop policy if exists radar_user_saves_delete on public.radar_user_saves;

create policy radar_user_saves_select on public.radar_user_saves
  for select to authenticated using (auth.uid() = user_id);
create policy radar_user_saves_insert on public.radar_user_saves
  for insert to authenticated with check (auth.uid() = user_id);
create policy radar_user_saves_update on public.radar_user_saves
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy radar_user_saves_delete on public.radar_user_saves
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists radar_user_saves_lead_idx on public.radar_user_saves(lead_id, created_at desc);

-- Optional safe outreach draft recorder. Sending remains a separate human-approved action.
create or replace function public.create_radar_outreach_draft(
  p_lead_id uuid,
  p_channel text,
  p_message text,
  p_consent_basis text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'auth_required';
  end if;
  if not exists (select 1 from public.radar_leads where id = p_lead_id and status <> 'rejected') then
    raise exception 'lead_not_found';
  end if;
  insert into public.radar_outreach(lead_id, channel, message, status, consent_basis, created_by)
  values(p_lead_id, p_channel, left(coalesce(p_message,''), 5000), 'draft', p_consent_basis, auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.create_radar_outreach_draft(uuid,text,text,text) to authenticated;
revoke all on function public.create_radar_outreach_draft(uuid,text,text,text) from anon;
