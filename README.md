# MDAMA Dispatch — Optimized Current Build

This package keeps the current MDAMA runtime behavior, including Yelp Search Memory, AI Subtrade, Yelp/Live Search Solo Probability, Solo confirmation, and Worked With actions.

## Canonical structure

- `index.html` — frontend (single-file deployment remains supported).
- `sql/` — **only** location for database SQL/migrations.
- `supabase/functions/` — **only** location for Edge Function source.
- `supabase/config.toml` — Supabase function configuration.
- `n8n/` — existing Live Search workflow and integration notes.
- `data/` — source map data.
- `tools/` — utility scripts.
- `All_States_Techs_NORMALIZED.csv` — normalized technician import dataset.

## What was optimized

- Removed historical `DEPLOY_v*.md` and step-by-step deployment files from the active project.
- Removed duplicate/stale root SQL copies; `sql/` is canonical.
- Removed duplicate/stale root Edge Function `.ts` copies; `supabase/functions/` is canonical.
- Removed older overridden Worked With function declarations from `index.html`; only the effective/latest declarations remain.
- Kept the app as a single `index.html` instead of minifying or splitting it, so deployment remains simple and debugging remains readable.

## Important

This is a repository cleanup/refactor only. It does not intentionally change WO Workflow, Hiring, Yelp Search, Live Search, Solo Tech, Worked With, Quote, or Payment behavior.


## v11.76 Coverage
- Adds a read-only Coverage tab.
- Coverage uses existing Yelp Search Memory, Confirmed Solo technicians, Worked With technicians, and Work Orders.
- No new SQL table and no Build Coverage automation in this step.
- Deploy the updated `yelp-search` Edge Function, then publish `index.html`.
