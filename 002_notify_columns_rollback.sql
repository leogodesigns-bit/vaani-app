-- Rollback for 002_notify_columns.sql
BEGIN;
ALTER TABLE tenants DROP COLUMN IF EXISTS notify_phone;
ALTER TABLE tenants DROP COLUMN IF EXISTS notify_voice;
COMMIT;
