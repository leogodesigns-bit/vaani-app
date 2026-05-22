// cron-alerts.js — Phase 4 daily safety-net cron for threshold alerts
//                + Patch 31 6-hour escalation for pending S02 custom-order drafts
//
// Calls alerts.runDailyCheck() once per day at 9 AM IST (03:30 UTC).
// Also runs escalatePendingDrafts() every minute: finds pending_drafts older
// than 6h with no escalation yet, and pings Kashmira via vaani_team_sos template.

const { runDailyCheck } = require('./alerts');
const { sendMessage } = require('./whatsapp');
const { pool } = require('./db');
const { sendTemplate } = require('./templates');

const CRON_HOUR_IST = 9;
const CRON_MIN_IST = 0;
const CRON_HOUR_UTC = 3;
const CRON_MIN_UTC = 30;

const CHECK_INTERVAL_MS = 60 * 1000;

const ESCALATE_AFTER_HOURS = 6;  // S02: 6h Apurv-no-reply → Kashmira

let lastFiredDay = null;

function isItTime() {
  const now = new Date();
  return now.getUTCHours() === CRON_HOUR_UTC && now.getUTCMinutes() === CRON_MIN_UTC;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Daily 9 AM IST threshold alert check (Phase 4) ───────────────────────
async function maybeRunDailyCheck() {
  try {
    if (!isItTime()) return;
    const today = todayKey();
    if (lastFiredDay === today) return;
    lastFiredDay = today;

    console.log('[cron-alerts] Triggering daily threshold check...');
    const result = await runDailyCheck({ sendMessage });
    console.log('[cron-alerts] Daily check result:', result);
  } catch (err) {
    console.error('[cron-alerts] daily check error (non-fatal):', err.message);
  }
}

// ─── Patch 31: 6h S02 draft escalation to Kashmira ────────────────────────
async function escalatePendingDrafts() {
  try {
    const res = await pool.query(
      `SELECT pd.id, pd.tenant_id, pd.draft_id, pd.draft_name, pd.customer_phone,
              pd.pup_name, pd.design_name, pd.created_at,
              t.whatsapp_number AS phone_number_id,
              t.whatsapp_token  AS wa_token,
              t.templates_approved,
              t.template_namespace
         FROM pending_drafts pd
         JOIN tenants t ON t.id = pd.tenant_id
        WHERE pd.status = 'pending'
          AND pd.escalated_at IS NULL
          AND pd.created_at < NOW() - INTERVAL '${ESCALATE_AFTER_HOURS} hours'
        ORDER BY pd.created_at ASC
        LIMIT 20`
    );
    if (res.rows.length === 0) return;
    console.log(`[cron-alerts:escalate] Found ${res.rows.length} draft(s) > ${ESCALATE_AFTER_HOURS}h pending — escalating to Kashmira`);

    const KASHMIRA_PHONE = process.env.KASHMIRA_PHONE;
    if (!KASHMIRA_PHONE) {
      console.warn('[cron-alerts:escalate] KASHMIRA_PHONE env not set — cannot escalate');
      return;
    }

    for (const row of res.rows) {
      try {
        const ageHours = Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000);
        const summary = `Custom order draft ${row.draft_name} pending ${ageHours}h, no Apurv approval yet. Customer +${row.customer_phone}${row.pup_name ? ` (${row.pup_name}'s parent)` : ''}${row.design_name ? `, ${row.design_name}` : ''}.`;

        const tenantShape = {
          id: row.tenant_id,
          templates_approved: row.templates_approved,
          template_namespace: row.template_namespace,
        };

        const result = await sendTemplate({
          to: KASHMIRA_PHONE,
          templateName: 'vaani_team_sos',
          params: {
            sosType: 'S02 ESCALATION (6h)',
            customerPhone: `+${row.customer_phone}`,
            summary: summary.slice(0, 250),
          },
          tenant: tenantShape,
          waToken: row.wa_token,
          phoneNumberId: row.phone_number_id,
        }).catch(e => { console.error('[cron-alerts:escalate] sendTemplate threw:', e.message); return { ok: false }; });

        if (result && result.ok) {
          await pool.query(
            `UPDATE pending_drafts SET escalated_at = NOW() WHERE id = $1`,
            [row.id]
          );
          console.log(`[cron-alerts:escalate] Escalated draft ${row.draft_name} (id=${row.id}) → Kashmira (+${KASHMIRA_PHONE}) — msgId=${result.messageId || '-'}`);
        } else {
          console.warn(`[cron-alerts:escalate] sendTemplate failed for draft ${row.draft_name}: ${result?.error || 'unknown'} — will retry next tick`);
        }
      } catch (rowErr) {
        console.error(`[cron-alerts:escalate] error on draft id=${row.id}:`, rowErr.message);
      }
    }
  } catch (err) {
    console.error('[cron-alerts:escalate] query error (non-fatal):', err.message);
  }
}

async function tick() {
  await maybeRunDailyCheck();
  await escalatePendingDrafts();
}

function start() {
  console.log(`[cron-alerts] Scheduled: daily ${CRON_HOUR_IST}:${String(CRON_MIN_IST).padStart(2,'0')} IST (${CRON_HOUR_UTC}:${String(CRON_MIN_UTC).padStart(2,'0')} UTC)`);
  console.log(`[cron-alerts] Patch 31 escalation: pending_drafts > ${ESCALATE_AFTER_HOURS}h \u2192 Kashmira (every minute)`);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { start };
