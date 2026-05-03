-- ─────────────────────────────────────────────────────────────────────────
-- Migration 002: notify_phone + notify_voice columns on tenants
-- Phase 4 — Threshold alerts
--
-- Idempotent: safe to re-run.
-- Run via:  railway connect Postgres < 002_notify_columns.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Pre-flight check
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name='tenants') THEN
        RAISE EXCEPTION 'Migration 002 prerequisites missing: tenants table not found';
    END IF;
END $$;

-- 2. Add notify_phone column (where to send brand-owner alerts)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notify_phone VARCHAR(20);
COMMENT ON COLUMN tenants.notify_phone IS 'WhatsApp number for brand-owner threshold alerts. NULL = no brand-owner alerts.';

-- 3. Add notify_voice column (which voice to use for brand-owner alerts)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notify_voice VARCHAR(20) DEFAULT 'neutral';
COMMENT ON COLUMN tenants.notify_voice IS 'Voice for alerts: ikaa, rajathee, woofparade, neutral';

-- 4. Seed: Ikaa brand owner (Shweta's other WhatsApp)
UPDATE tenants
SET notify_phone = '8805100535',
    notify_voice = 'ikaa'
WHERE shop_domain = 'ikaajewellery.myshopify.com'
  AND (notify_phone IS NULL OR notify_phone = '');

-- 5. Seed: Rajathee voice set, but no notify_phone yet (founder doesn't use WA)
UPDATE tenants
SET notify_voice = 'rajathee'
WHERE shop_domain = 'rajathee.myshopify.com'
  AND notify_voice = 'neutral';

-- 6. Verification
DO $$
DECLARE
    ikaa_phone VARCHAR(20);
    ikaa_voice VARCHAR(20);
    raj_voice VARCHAR(20);
BEGIN
    SELECT notify_phone, notify_voice INTO ikaa_phone, ikaa_voice
    FROM tenants WHERE shop_domain = 'ikaajewellery.myshopify.com';

    SELECT notify_voice INTO raj_voice
    FROM tenants WHERE shop_domain = 'rajathee.myshopify.com';

    RAISE NOTICE 'Migration 002 complete.';
    RAISE NOTICE '  Ikaa: notify_phone=%, voice=%', ikaa_phone, ikaa_voice;
    RAISE NOTICE '  Rajathee: voice=% (notify_phone unset)', raj_voice;
END $$;

COMMIT;
