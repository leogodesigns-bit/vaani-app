-- ───────────────────────────────────────────────────────────────────────
-- Migration 003: per-tenant WhatsApp template support
--
-- Adds two columns to tenants:
--   1. template_namespace — Meta WABA namespace UUID, required for sending
--      template messages outside the 24-hour window
--   2. templates_approved — JSONB tracking which templates Meta has approved
--      for this tenant's WABA. Schema:
--        { "vaani_threshold_70": "approved",
--          "vaani_threshold_90": "pending",
--          "vaani_threshold_100": "approved",
--          "vaani_topup_confirmed": "approved",
--          "vaani_subscription_paused": "approved",
--          "vaani_subscription_unpaused": "approved" }
--      Statuses: 'approved', 'pending', 'rejected', 'paused'
--
-- Idempotent: safe to run multiple times.
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  -- Add template_namespace if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'template_namespace'
  ) THEN
    ALTER TABLE tenants ADD COLUMN template_namespace VARCHAR(64);
    COMMENT ON COLUMN tenants.template_namespace IS
      'Meta WABA namespace UUID (find in Meta WhatsApp Manager → API Settings). Required for sending template messages.';
  END IF;

  -- Add templates_approved if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'templates_approved'
  ) THEN
    ALTER TABLE tenants ADD COLUMN templates_approved JSONB NOT NULL DEFAULT '{}'::jsonb;
    COMMENT ON COLUMN tenants.templates_approved IS
      'JSONB map of template_name → status. Statuses: approved, pending, rejected, paused.';
  END IF;
END $$;

-- Initialize templates_approved with all 6 templates as 'pending' for existing tenants
-- that don't have any template status yet. New tenants will get '{}' default.
UPDATE tenants
SET templates_approved = jsonb_build_object(
  'vaani_threshold_70',         'pending',
  'vaani_threshold_90',         'pending',
  'vaani_threshold_100',        'pending',
  'vaani_topup_confirmed',      'pending',
  'vaani_subscription_paused',  'pending',
  'vaani_subscription_unpaused','pending'
)
WHERE templates_approved = '{}'::jsonb OR templates_approved IS NULL;

-- Status notice
DO $$
DECLARE
  ikaa_namespace TEXT;
  rajathee_namespace TEXT;
BEGIN
  SELECT template_namespace INTO ikaa_namespace
  FROM tenants WHERE shop_domain = 'ikaajewellery.myshopify.com';

  SELECT template_namespace INTO rajathee_namespace
  FROM tenants WHERE shop_domain = 'rajathee.myshopify.com';

  RAISE NOTICE 'Migration 003 complete.';
  RAISE NOTICE '  Ikaa template_namespace: %', COALESCE(ikaa_namespace, '(unset — fill in via founder cmd or Meta WA Manager)');
  RAISE NOTICE '  Rajathee template_namespace: %', COALESCE(rajathee_namespace, '(unset — fill in when WABA migrated)');
  RAISE NOTICE 'Use founder cmd: namespace <brand> <uuid> to set.';
END $$;

COMMIT;
