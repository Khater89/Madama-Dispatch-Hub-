-- ============================================================================
-- 10_n8n_webhook.sql
-- Adds a column to app_settings so the n8n Find-Closest-Tech webhook URL
-- persists in the database instead of local storage.
-- Safe to re-run.
-- ============================================================================
begin;

alter table public.app_settings
  add column if not exists n8n_find_tech_url text;

commit;

-- After running this, save the URL once from Settings and it will follow you
-- across browsers and devices instead of being stored per-browser.
