-- ───────────────────────────────────────────────────────────────────────
-- 006_onboarding_submissions.sql — Leogo Designs client onboarding form
--
-- Backs the /get-started lead-capture page on vaani.website and the
-- /admin/leads view in the Vaani admin dashboard.
--
-- Safe to re-run (all IF NOT EXISTS).
--
-- Usage:
--   railway connect Postgres < 006_onboarding_submissions.sql
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id                   SERIAL PRIMARY KEY,

  -- Required identity fields
  name                 VARCHAR(120)  NOT NULL,
  business_name        VARCHAR(160)  NOT NULL,
  phone                VARCHAR(20)   NOT NULL,
  email                VARCHAR(160)  NOT NULL,

  -- Multi-select services (whitelist enforced in the route handler).
  -- Stored as TEXT[] so we can filter with `?` operators in admin views.
  services_interested  TEXT[]        NOT NULL DEFAULT '{}',

  -- Free-form fields
  business_description TEXT,
  instagram_handle     VARCHAR(80),
  current_website      VARCHAR(200),
  timeline             VARCHAR(40),
  additional_notes     TEXT,

  -- Internal metadata
  source               VARCHAR(60),
  client_ip            VARCHAR(64),
  user_agent           TEXT,
  status               VARCHAR(20)   NOT NULL DEFAULT 'new',
  contacted_at         TIMESTAMPTZ,

  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Most admin queries sort newest-first.
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_created
  ON onboarding_submissions (created_at DESC);

-- Dedupe + lookup by email.
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_email
  ON onboarding_submissions (LOWER(email));

-- Filter pending vs handled leads in the admin UI.
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_status
  ON onboarding_submissions (status);

COMMIT;

-- Verify:
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'onboarding_submissions'
  ORDER BY ordinal_position;
