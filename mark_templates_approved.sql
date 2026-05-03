-- ───────────────────────────────────────────────────────────────────────
-- mark_templates_approved.sql
--
-- After Meta approves your templates, run this to flip statuses from
-- 'pending' to 'approved'. Edit the lines below as needed.
--
-- Usage:
--   railway connect Postgres < mark_templates_approved.sql
--
-- Or interactively in psql:
--   railway connect Postgres
--   \i mark_templates_approved.sql
-- ───────────────────────────────────────────────────────────────────────

-- IKAA — mark all 6 templates approved (run after Meta sends approval emails)
UPDATE tenants
SET templates_approved = jsonb_build_object(
  'vaani_threshold_70',         'approved',
  'vaani_threshold_90',         'approved',
  'vaani_threshold_100',        'approved',
  'vaani_topup_confirmed',      'approved',
  'vaani_subscription_paused',  'approved',
  'vaani_subscription_unpaused','approved'
)
WHERE shop_domain = 'ikaajewellery.myshopify.com';

-- Verify
SELECT shop_domain, template_namespace, templates_approved
FROM tenants
WHERE shop_domain = 'ikaajewellery.myshopify.com';

-- ─── To mark a SINGLE template approved (instead of all at once) ───────
-- Useful if Meta approves them one at a time.
--
-- UPDATE tenants
-- SET templates_approved = templates_approved || jsonb_build_object('vaani_threshold_70', 'approved')
-- WHERE shop_domain = 'ikaajewellery.myshopify.com';

-- ─── To mark a template REJECTED (Meta rejected it) ─────────────────────
-- UPDATE tenants
-- SET templates_approved = templates_approved || jsonb_build_object('vaani_threshold_70', 'rejected')
-- WHERE shop_domain = 'ikaajewellery.myshopify.com';
