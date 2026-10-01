-- Wefaq Acquisition Radar v11
-- Public/authorized source ingestion only. Keep provider secrets server-side.

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
  status text not null default 'review' check (status in ('new','review','saved','contacted','converted','stale','rejected')),
  consent_status text not null default 'unknown' check (consent_status in ('unknown','public_contact','opted_in','restricted','not_available')),
  contact jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  content_hash text,
  raw_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, external_id)
);

create index if not exists radar_leads_discovered_idx on public.radar_leads(discovered_at desc);
create index if not exists radar_leads_persona_idx on public.radar_leads(persona, priority);
create index if not exists radar_leads_status_idx on public.radar_leads(status);
create index if not exists radar_leads_hash_idx on public.radar_leads(content_hash);

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

-- Admin/service-role functions should be used for ingestion. The client may read only if you later add a safe admin policy.
-- Example policy after you have a trusted admin role claim:
-- create policy "radar_admin_read" on public.radar_leads for select using ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create or replace function public.radar_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end; $$;

drop trigger if exists trg_radar_leads_updated on public.radar_leads;
create trigger trg_radar_leads_updated before update on public.radar_leads for each row execute function public.radar_touch_updated_at();

drop trigger if exists trg_radar_sources_updated on public.radar_sources;
create trigger trg_radar_sources_updated before update on public.radar_sources for each row execute function public.radar_touch_updated_at();
