-- ───────────────────────────────────────────────────────────────────────
-- 008_meta_leadgen_id.sql — Meta Lead Ads dedupe column
--
-- Adds meta_leadgen_id to onboarding_submissions so we can recognise
-- Meta webhook retries (Meta resends a leadgen event if it doesn't
-- get a 200 within 5 s, so the same lead can arrive multiple times).
-- A partial unique index gives us idempotent INSERT … ON CONFLICT
-- without preventing duplicate NULLs from non-Meta leads.
--
-- Safe to re-run (all IF NOT EXISTS).
--
-- Usage:
--   railway connect Postgres < 008_meta_leadgen_id.sql
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE onboarding_submissions
  ADD COLUMN IF NOT EXISTS meta_leadgen_id VARCHAR(40);

CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_submissions_leadgen
  ON onboarding_submissions (meta_leadgen_id)
  WHERE meta_leadgen_id IS NOT NULL;

COMMIT;

-- Verify:
SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'onboarding_submissions'
    AND column_name = 'meta_leadgen_id';
