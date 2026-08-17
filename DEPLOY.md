# MDAMA Dispatch — Current Deployment

## Frontend
Publish/replace `index.html` using the same host currently used by MDAMA.

## Supabase
- Database scripts are only under `sql/`.
- Edge Functions are only under `supabase/functions/`.
- Yelp requires the Supabase secret `YELP_API_KEY`.
- AI Subtrade uses the existing `ai-assist` function / OpenAI secret configuration.

### Yelp current functions
Deploy the current `ai-assist` and `yelp-search` functions when those backend files change.

### Yelp Search Memory
The Yelp memory table is defined by `sql/28_yelp_search_memory.sql` in this package. If it was already run on the project, do not run it again just because of this optimization.

## Existing Live Search
The existing n8n workflow remains under `n8n/MDAMA_find_closest_tech.json`; this optimization does not alter it.

## No migration for optimization
No SQL migration is required merely to move from the previous Step 5 package to this optimized package.

## Independent Quo queues — Live Search + Yelp

For an existing database, run this SQL once in Supabase SQL Editor before testing the two queues across devices:

`sql/29_quo_source_separation.sql`

This changes Quo persistence from `WO + phone` to `WO + source + phone`, so Live Search and Yelp keep completely separate queue progress and statuses.

## Step 12 — 60-mile search display + Queue Focus
- Publish the updated `index.html`.
- Redeploy `supabase/functions/yelp-search` because this step lets Yelp return its natural result area; the backend saves every Yelp result returned, while MDAMA only displays/routes results at or under 60 miles.
- No SQL migration is required for Step 12. Keep `sql/29_quo_source_separation.sql` from Step 11 applied.
