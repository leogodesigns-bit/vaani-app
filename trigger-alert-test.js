// trigger-alert-test.js — One-off smoke test for Phase 4
// Triggers checkAndFireAlerts for Ikaa simulating 699 → 700 crossing.
// Uses real prod DB via DATABASE_URL from .env.
// Sends real WhatsApp messages to FOUNDER_PHONE and Ikaa's notify_phone.
//
// Usage:  node trigger-alert-test.js

require('dotenv').config();

const { checkAndFireAlerts } = require('./alerts');
const { sendMessage } = require('./whatsapp');
const { pool } = require('./db');

async function main() {
  console.log('───────────────────────────────────────────');
  console.log('  Phase 4 — Manual alert trigger test');
  console.log('───────────────────────────────────────────');
  console.log();

  // 1. Look up Ikaa to get its WA token + phone_number_id (what the bot uses to send)
  const tenantRes = await pool.query(
    `SELECT id, shop_domain, store_name, whatsapp_number, whatsapp_token, notify_phone, notify_voice
     FROM tenants WHERE id = 1`
  );
  if (tenantRes.rows.length === 0) {
    console.error('❌ No tenant id=1 found');
    process.exit(1);
  }
  const tenant = tenantRes.rows[0];
  console.log(`Tenant:        ${tenant.shop_domain} (id=${tenant.id})`);
  console.log(`Bot phone_id:  ${tenant.whatsapp_number}`);
  console.log(`Brand-owner:   ${tenant.notify_phone || '(unset)'} (voice: ${tenant.notify_voice})`);
  console.log(`Founder:       ${process.env.FOUNDER_PHONE}`);
  console.log();

  // 2. Reset usage row to a known state: 699/1000, no alerts fired yet
  console.log('Step 1: Setting usage = 699/1000, alerts_sent = {} ...');
  await pool.query(
    `INSERT INTO tenant_usage_monthly (tenant_id, year, month, conversation_count, base_cap, top_up_balance, alerts_sent)
     VALUES (1, EXTRACT(YEAR FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM CURRENT_DATE)::int, 699, 1000, 0, '{}'::jsonb)
     ON CONFLICT (tenant_id, year, month) DO UPDATE
       SET conversation_count = 699, base_cap = 1000, top_up_balance = 0, alerts_sent = '{}'::jsonb`
  );
  console.log('  ✓ Done.');
  console.log();

  // 3. Fire alerts simulating 699 → 700 crossing (this crosses 70%)
  console.log('Step 2: Calling checkAndFireAlerts(oldUsed=699, newUsed=700) ...');
  const result = await checkAndFireAlerts({
    tenantId: 1,
    sendMessage,
    waToken: tenant.whatsapp_token,
    phoneNumberId: tenant.whatsapp_number,
    oldUsed: 699,
    newUsed: 700
  });
  console.log('  Result:', JSON.stringify(result, null, 2));
  console.log();

  // 4. Verify JSONB was marked
  const checkRes = await pool.query(
    `SELECT alerts_sent FROM tenant_usage_monthly
     WHERE tenant_id = 1
       AND year = EXTRACT(YEAR FROM CURRENT_DATE)::int
       AND month = EXTRACT(MONTH FROM CURRENT_DATE)::int`
  );
  console.log('Step 3: alerts_sent JSONB after fire:');
  console.log('  ', checkRes.rows[0]?.alerts_sent || '(empty)');
  console.log();

  // 5. Restore usage back to original 1 (so we don't pollute live counter)
  console.log('Step 4: Restoring usage = 1/1000 (so future tests start clean) ...');
  await pool.query(
    `UPDATE tenant_usage_monthly
        SET conversation_count = 1, alerts_sent = '{}'::jsonb
      WHERE tenant_id = 1
        AND year = EXTRACT(YEAR FROM CURRENT_DATE)::int
        AND month = EXTRACT(MONTH FROM CURRENT_DATE)::int`
  );
  console.log('  ✓ Done.');
  console.log();

  console.log('───────────────────────────────────────────');
  if (result.fired.length > 0 && result.errors.length === 0) {
    console.log(`✅ SUCCESS: fired ${result.fired.join(', ')}% — ` +
                `${result.fired.length * 2} WhatsApp messages should have been sent ` +
                `(${result.fired.length} to founder + ${result.fired.length} to brand-owner).`);
    console.log();
    console.log('Check your WhatsApp on:');
    console.log(`  - ${process.env.FOUNDER_PHONE} (founder line, neutral voice)`);
    console.log(`  - ${tenant.notify_phone} (Ikaa brand owner, ikaa voice)`);
  } else if (result.errors.length > 0) {
    console.log('❌ FAILED with errors:');
    result.errors.forEach(e => console.log('  -', e));
  } else {
    console.log('⚠ No alerts fired. Check the logic.');
  }
  console.log('───────────────────────────────────────────');

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Crashed:', err);
  pool.end();
  process.exit(1);
});
