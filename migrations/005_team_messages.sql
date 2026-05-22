CREATE TABLE IF NOT EXISTS team_messages (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wamid           TEXT NOT NULL UNIQUE,
  recipient_phone TEXT NOT NULL,
  recipient_role  TEXT,
  sos_type        TEXT,
  template_name   TEXT,
  params          JSONB,
  draft_id        BIGINT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  replied_at      TIMESTAMPTZ,
  reply_text      TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_messages_tenant_draft
  ON team_messages (tenant_id, draft_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_team_messages_recipient_pending
  ON team_messages (tenant_id, recipient_phone, replied_at)
  WHERE replied_at IS NULL;
