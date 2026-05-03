-- ───────────────────────────────────────────────────────────────────────
-- Rollback for Migration 003: drop template support columns
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE tenants DROP COLUMN IF EXISTS template_namespace;
ALTER TABLE tenants DROP COLUMN IF EXISTS templates_approved;

DO $$
BEGIN
  RAISE NOTICE 'Rollback 003 complete. Dropped template_namespace and templates_approved.';
END $$;

COMMIT;
