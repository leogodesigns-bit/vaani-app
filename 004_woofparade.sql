-- 004_woofparade.sql
-- Migration for Woof Parade Vaani onboarding (tenant id=10).
--
-- Run via: psql "$DATABASE_URL" -f 004_woofparade.sql

BEGIN;

-- 1. Route the Woof Parade tenant to the new handler.
UPDATE tenants SET flow_template = 'woofparade' WHERE shop_domain = 'thewoofparade.com';

-- 2. Bot pause state (per-tenant). Used by Kashmira's "pause bot" / "resume bot" commands.
CREATE TABLE IF NOT EXISTS woofparade_bot_state (
  tenant_id INTEGER PRIMARY KEY,
  paused_until TIMESTAMP,
  test_mode BOOLEAN DEFAULT false
);

-- 3. Pup profiles (S30). One row per pup, indexed by (tenant, customer_phone).
CREATE TABLE IF NOT EXISTS pup_profiles (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER,
  customer_phone VARCHAR(50),
  pup_name VARCHAR(100) NOT NULL,
  breed VARCHAR(100),
  dob DATE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pup_profiles_tenant_phone
  ON pup_profiles (tenant_id, customer_phone);

-- 4. Opt-ins (international interest, OOS notify-when-back, non-serviceable PIN).
CREATE TABLE IF NOT EXISTS woofparade_optins (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER,
  customer_phone VARCHAR(50),
  kind VARCHAR(30),
  meta JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Orders table — make sure created_at exists (used for S32 "unfulfilled > 2 days" check).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

COMMIT;

-- Verify:
-- SELECT id, shop_domain, flow_template FROM tenants WHERE id = 10;
