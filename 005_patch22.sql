-- ───────────────────────────────────────────────────────────────────────
-- 005_patch22.sql — v1.4 completion migration
--
-- Adds columns needed for S30 pup notes, order pup-tagging, and ensures
-- the `woofparade_optins` table created in 004 has a uniqueness guard so
-- repeat opt-ins don't duplicate.
--
-- Safe to re-run (all IF NOT EXISTS).
--
-- Usage:
--   railway connect Postgres < 005_patch22.sql
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Pup notes (founder `note Mochi prefers loose fit` command — S5.5).
ALTER TABLE pup_profiles
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2. Tag an order to a specific pup (S30 Branch B/C tap selection).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tagged_pup VARCHAR(100);

-- 3. Make opt-in writes idempotent — one row per (tenant, customer, kind).
-- Drop dupes first (kind is a varchar; safe).
DELETE FROM woofparade_optins a USING woofparade_optins b
  WHERE a.id > b.id
    AND a.tenant_id = b.tenant_id
    AND a.customer_phone = b.customer_phone
    AND a.kind = b.kind;

CREATE UNIQUE INDEX IF NOT EXISTS idx_woofparade_optins_unique
  ON woofparade_optins (tenant_id, customer_phone, kind);

COMMIT;

-- Verify:
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'pup_profiles' AND column_name = 'notes';
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'orders' AND column_name = 'tagged_pup';
SELECT indexname FROM pg_indexes
  WHERE tablename = 'woofparade_optins' AND indexname = 'idx_woofparade_optins_unique';
