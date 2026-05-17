-- =============================================================================
-- Vaani — Usage Tracking & Tier Alerts (Phase 1) — ROLLBACK
-- Migration: 001_usage_tracking_rollback.sql
-- =============================================================================
-- DANGER: This DROPS all 4 new tables and their data.
-- Run this ONLY if you need to undo migration 001_usage_tracking.sql.
--
-- This will permanently delete:
--   - All conversation usage records
--   - All daily conversation tracking
--   - All top-up purchase records
--   - All subscription records
--
-- Existing `tenants` table is NOT touched.
-- =============================================================================

BEGIN;

-- Drop in reverse dependency order (no FKs between these 4, but order matches creation)
DROP TABLE IF EXISTS tenant_subscriptions CASCADE;
DROP TABLE IF EXISTS tenant_topups CASCADE;
DROP TABLE IF EXISTS tenant_daily_conversations CASCADE;
DROP TABLE IF EXISTS tenant_usage_monthly CASCADE;

-- Drop the trigger function (only if no other table is using it)
-- We check first so we don't break anything else that may have been added later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE action_statement LIKE '%fn_touch_updated_at%'
  ) THEN
    DROP FUNCTION IF EXISTS fn_touch_updated_at();
    RAISE NOTICE 'Dropped fn_touch_updated_at function (no other triggers using it).';
  ELSE
    RAISE NOTICE 'Kept fn_touch_updated_at function (still in use by other triggers).';
  END IF;
END $$;

-- Verification
DO $$
DECLARE
  remaining_count INT;
BEGIN
  SELECT COUNT(*) INTO remaining_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'tenant_usage_monthly',
      'tenant_daily_conversations',
      'tenant_topups',
      'tenant_subscriptions'
    );

  IF remaining_count <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete. % tables still exist.', remaining_count;
  END IF;

  RAISE NOTICE 'Rollback complete. All 4 tables removed.';
END $$;

COMMIT;
