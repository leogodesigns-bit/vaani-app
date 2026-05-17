-- =============================================================================
-- Vaani — Usage Tracking & Tier Alerts (Phase 1)
-- Migration: 001_usage_tracking.sql
-- Spec: Vaani_Usage_Tracking_Spec_v1_2.md (signed off May 2026)
-- =============================================================================
-- This script is IDEMPOTENT. Safe to run multiple times.
-- Creates 4 new tables:
--   1. tenant_usage_monthly      — per-tenant per-month conversation counter
--   2. tenant_daily_conversations — per-customer-per-day dedup
--   3. tenant_topups             — top-up purchases with 3-month rollover
--   4. tenant_subscriptions      — plan type, annual/monthly, cancellation state
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Sanity check: confirm `tenants` table exists with `id` column.
-- If this RAISE fires, the rest of the migration aborts (BEGIN/COMMIT wraps it).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tenants'
  ) THEN
    RAISE EXCEPTION 'Table public.tenants does not exist. Migration aborted.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'Column public.tenants.id does not exist. Migration aborted.';
  END IF;
END $$;


-- =============================================================================
-- Table 1: tenant_usage_monthly
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_usage_monthly (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
  year                INT NOT NULL,
  month               INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  conversation_count  INT NOT NULL DEFAULT 0,
  base_cap            INT NOT NULL DEFAULT 1000,
  top_up_balance      INT NOT NULL DEFAULT 0,
  effective_cap       INT GENERATED ALWAYS AS (base_cap + top_up_balance) STORED,
  paused              BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at           TIMESTAMP,
  alerts_sent         JSONB NOT NULL DEFAULT '{}'::jsonb,
  overage_count       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_usage_tenant_year_month UNIQUE (tenant_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant_month
  ON tenant_usage_monthly (tenant_id, year, month);

COMMENT ON TABLE tenant_usage_monthly IS
  'One row per tenant per calendar month. Tracks conversation count vs cap.';
COMMENT ON COLUMN tenant_usage_monthly.effective_cap IS
  'Generated column: base_cap + top_up_balance. Used by alert thresholds.';
COMMENT ON COLUMN tenant_usage_monthly.alerts_sent IS
  'JSONB tracking which thresholds have fired this month, e.g. {"70": true, "90": true}.';


-- =============================================================================
-- Table 2: tenant_daily_conversations
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_daily_conversations (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INTEGER NOT NULL REFERENCES tenants(id),
  customer_phone     VARCHAR(20) NOT NULL,
  conversation_date  DATE NOT NULL,
  first_message_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  message_count      INT NOT NULL DEFAULT 1,
  CONSTRAINT uq_daily_tenant_customer_date UNIQUE (tenant_id, customer_phone, conversation_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_tenant_date
  ON tenant_daily_conversations (tenant_id, conversation_date);

COMMENT ON TABLE tenant_daily_conversations IS
  'One row per tenant+customer+day. UNIQUE constraint enforces 1-conversation-per-customer-per-day.';


-- =============================================================================
-- Table 3: tenant_topups
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_topups (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id),
  chats_purchased  INT NOT NULL DEFAULT 250,
  chats_remaining  INT NOT NULL,
  amount_paid      INT NOT NULL DEFAULT 500,
  purchased_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMP NOT NULL,
  expired          BOOLEAN NOT NULL DEFAULT FALSE,
  notes            TEXT,
  CONSTRAINT chk_topup_remaining_nonneg CHECK (chats_remaining >= 0),
  CONSTRAINT chk_topup_purchased_pos    CHECK (chats_purchased > 0)
);

CREATE INDEX IF NOT EXISTS idx_topups_tenant_active
  ON tenant_topups (tenant_id, expires_at)
  WHERE NOT expired;

COMMENT ON TABLE tenant_topups IS
  'Top-up purchases. ₹500 = 250 chats, valid 3 months. Consumed FIFO (earliest expires_at first).';


-- =============================================================================
-- Table 4: tenant_subscriptions
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id),
  plan_type           VARCHAR(20) NOT NULL CHECK (plan_type IN ('monthly', 'annual')),
  started_at          DATE NOT NULL,
  next_billing_date   DATE,
  annual_end_date     DATE,
  cancelled_at        TIMESTAMP,
  credit_balance      INT NOT NULL DEFAULT 0,
  credit_expires_at   TIMESTAMP,
  status              VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'cancelled', 'paused')),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_subscriptions_tenant UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON tenant_subscriptions (status);

COMMENT ON TABLE tenant_subscriptions IS
  'One row per tenant. Plan type, billing dates, cancellation state, Leogo credit balance.';


-- =============================================================================
-- updated_at auto-touch trigger for tenant_usage_monthly
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usage_monthly_touch ON tenant_usage_monthly;
CREATE TRIGGER trg_usage_monthly_touch
  BEFORE UPDATE ON tenant_usage_monthly
  FOR EACH ROW
  EXECUTE FUNCTION fn_touch_updated_at();


-- =============================================================================
-- Verification — should print 4 rows when migration succeeds
-- =============================================================================
DO $$
DECLARE
  table_count INT;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'tenant_usage_monthly',
      'tenant_daily_conversations',
      'tenant_topups',
      'tenant_subscriptions'
    );

  IF table_count <> 4 THEN
    RAISE EXCEPTION 'Expected 4 new tables, found %. Migration incomplete.', table_count;
  END IF;

  RAISE NOTICE 'Migration 001_usage_tracking complete. All 4 tables created.';
END $$;

COMMIT;
