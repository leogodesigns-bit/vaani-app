-- ───────────────────────────────────────────────────────────────────────
-- 007_onboarding_details.sql — per-client onboarding form responses
--
-- Backs the /onboarding?lead=ID multi-step form that's sent to a lead
-- once they confirm they want to start. Linked 1:1 to a lead row in
-- onboarding_submissions; per-service answers stored as JSONB so we
-- don't need to alter the schema when new services or fields show up.
--
-- Safe to re-run (all IF NOT EXISTS).
--
-- Usage:
--   railway connect Postgres < 007_onboarding_details.sql
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_details (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER NOT NULL UNIQUE
                  REFERENCES onboarding_submissions(id) ON DELETE CASCADE,

  -- Per-service response blobs. NULL when the lead didn't pick that service.
  vaani_details   JSONB,   -- { whatsapp_number, meta_access, shopify_url, language, persona_name }
  social_details  JSONB,   -- { instagram_handle, tone, competitors[], raw_videos_confirmed }
  shopify_details JSONB,   -- { has_domain, domain, categories, references[], has_logo, brand_colors }

  -- Always-on final step.
  uploaded_files  JSONB,   -- array of URLs (Drive/Dropbox/WeTransfer/etc.)
  final_notes     TEXT,

  -- Metadata
  client_ip       VARCHAR(64),
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_details_lead
  ON onboarding_details (lead_id);

COMMIT;

-- Verify:
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'onboarding_details'
  ORDER BY ordinal_position;
