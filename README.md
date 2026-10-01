# Wefaq Educational Platform

## V15 â€” Live Acquisition Radar + Global/Regional Matching

This repository is the current Wefaq educational build. It keeps the platform focused on Quran, Hadith, Arabic, languages, children, learners, teachers and educational services.

### Production architecture

```text
Public / authorized sources
        â†“
 social-radar-sync
        â†“
 source_items
        â†“
  smart-processor
        â†“
 radar_leads
        â†“
 Regional / Global Matching
        â†“
 CRM / Outreach
```

### No fake data

The UI does not ship with demo leads, fake counters, or synthetic external records. External items are shown only after they are returned by a real connector and pass the educational classifier. Brave web results are kept transient by design in the collector; they are not written to the database.

### Edge Functions

- `social-radar-sync`: collection only. Uses configured official/public APIs and stores supported source items.
- `smart-processor`: classification, deduplication, freshness scoring, contact-hint extraction and `radar_leads` upsert.
- `radar-sync`: authenticated orchestrator for collector â†’ processor â†’ dashboard response.
- `smart-endpoint`: authenticated read/query API over safe radar lead fields.

### Supabase SQL

Run `supabase/radar_schema.sql` in the Supabase SQL Editor. It is additive/idempotent and includes the V15 fields needed by the front-end, safe read RPCs, user lead saves and outreach draft storage.

### Secrets

Keep external API credentials server-side as Supabase Edge Function Secrets. Do not place provider keys in `index.html` or GitHub.

Expected optional secrets include:

- `BRAVE_SEARCH_API_KEY`
- `GOOGLE_CSE_API_KEY`
- `GOOGLE_CSE_ID` (or `GOOGLE_CSE_CX` for compatibility)
- `YOUTUBE_API_KEY`
- `X_BEARER_TOKEN`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `REDDIT_USER_AGENT`
- `TELEGRAM_BOT_TOKEN` (for readiness reporting; Telegram ingestion remains webhook-driven)

### Front-end

The main entry point is `index.html`.

The front-end expects the following deployed functions:

- `/functions/v1/radar-sync`
- `/functions/v1/smart-endpoint`

and reads live leads through the RPC `get_public_radar_leads`.

