-- Patch 31 — S02 custom-order Shopify draft + approval flow
CREATE TABLE IF NOT EXISTS pending_drafts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  draft_id BIGINT NOT NULL,
  draft_name TEXT,
  invoice_url TEXT,
  customer_phone TEXT NOT NULL,
  pup_name TEXT,
  design_name TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  price_set NUMERIC(10,2),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  invoice_sent_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_drafts_status ON pending_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_drafts_phone  ON pending_drafts(tenant_id, customer_phone);
