// alerts.js — Phase 4 threshold alerts for Vaani
//
// Fires alerts when conversation_count crosses 70%, 90%, or 100% of effective_cap.
// Two audiences:
//   - Internal: founder (FOUNDER_PHONE) — neutral status
//   - Brand-owner: tenant.notify_phone — voiced (ikaa/rajathee/woofparade/neutral)
//
// Idempotent via tenant_usage_monthly.alerts_sent JSONB:
//   {"70": "2026-05-15T...", "90": "..."}
// Each threshold fires at most once per tenant per month.

const { pool } = require('./db');

const THRESHOLDS = [70, 90, 100];

// ─── VOICE DEFINITIONS ─────────────────────────────────────────────────────
// Each brand's voice for owner-facing alerts. Founder gets neutral always.

function brandAlertMessage(voice, brand, threshold, used, cap, daysLeftInMonth) {
  const remaining = Math.max(0, cap - used);

  // Brand-specific voices
  switch (voice) {
    case 'ikaa':
      return ikaaVoice(brand, threshold, used, cap, remaining, daysLeftInMonth);
    case 'rajathee':
      return rajatheeVoice(brand, threshold, used, cap, remaining, daysLeftInMonth);
    case 'woofparade':
      return woofparadeVoice(brand, threshold, used, cap, remaining, daysLeftInMonth);
    default:
      return neutralVoice(brand, threshold, used, cap, remaining, daysLeftInMonth);
  }
}

function ikaaVoice(brand, threshold, used, cap, remaining, days) {
  if (threshold === 70) {
    return [
      `✨ A gentle update from Vaani`,
      ``,
      `Your boutique has welcomed *${used}* of ${cap} conversations this month — about 70%.`,
      ``,
      `${remaining} conversations remain in this cycle, with ${days} days to go.`,
      ``,
      `Should you wish to extend, simply reply *extend* and we'll add 250 more for ₹500.`
    ].join('\n');
  }
  if (threshold === 90) {
    return [
      `✨ A note from Vaani`,
      ``,
      `Your boutique has reached *${used}* of ${cap} conversations — 90% of this month's capacity.`,
      ``,
      `Only ${remaining} remain. Reply *extend* to add 250 more conversations (₹500), or your bot will pause once the cap is reached.`
    ].join('\n');
  }
  // 100
  return [
    `✨ Vaani has reached this month's cap`,
    ``,
    `Your boutique has used all ${cap} conversations for ${monthYearLabel()}.`,
    ``,
    `To resume immediately, reply *extend* (₹500 for 250 more). Otherwise, your bot will resume on the 1st.`
  ].join('\n');
}

function rajatheeVoice(brand, threshold, used, cap, remaining, days) {
  if (threshold === 70) {
    return [
      `🪔 *Rajathee × Vaani*`,
      ``,
      `Vaani has assisted *${used}* of ${cap} customers this month (70%).`,
      ``,
      `${remaining} more conversations available. ${days} days remain in the cycle.`,
      ``,
      `Reply *extend* to add 250 more for ₹500.`
    ].join('\n');
  }
  if (threshold === 90) {
    return [
      `🪔 *Rajathee × Vaani*`,
      ``,
      `Vaani has reached 90% of this month's capacity — *${used}* of ${cap}.`,
      ``,
      `Only ${remaining} conversations remain. Reply *extend* (₹500 for 250 more) before the cap closes.`
    ].join('\n');
  }
  // 100
  return [
    `🪔 *Rajathee × Vaani — cap reached*`,
    ``,
    `All ${cap} conversations used for ${monthYearLabel()}.`,
    ``,
    `Reply *extend* (₹500 for 250 more) to resume. Otherwise, conversations resume on the 1st.`
  ].join('\n');
}

function woofparadeVoice(brand, threshold, used, cap, remaining, days) {
  if (threshold === 70) {
    return [
      `🐶 *Woof! Quick paws-and-think.*`,
      ``,
      `Rio here. We've helped *${used}* pawrents this month — 70% of our chat budget!`,
      ``,
      `${remaining} chats left, ${days} days to go. Top up 250 more for ₹500? Just reply *extend*. 🦴`
    ].join('\n');
  }
  if (threshold === 90) {
    return [
      `🐶 *Heads up from Rio!*`,
      ``,
      `We're at *${used}/${cap}* chats this month (90%). Only ${remaining} left in the bowl.`,
      ``,
      `Reply *extend* to add 250 more for ₹500, or we'll have to take a nap once we hit the cap. 💤`
    ].join('\n');
  }
  // 100
  return [
    `🐶 *Rio's having a rest...*`,
    ``,
    `We've used all ${cap} chats for ${monthYearLabel()}. Time for a nap! 💤`,
    ``,
    `Reply *extend* (₹500 for 250 more) to wake me back up, or I'll be back on the 1st!`
  ].join('\n');
}

function neutralVoice(brand, threshold, used, cap, remaining, days) {
  if (threshold === 70) {
    return [
      `📊 *Vaani usage update — ${brand}*`,
      ``,
      `${used}/${cap} conversations used this month (70%).`,
      `${remaining} remaining. ${days} days left in cycle.`,
      ``,
      `Reply *extend* to add 250 conversations for ₹500.`
    ].join('\n');
  }
  if (threshold === 90) {
    return [
      `⚠️ *Vaani — ${brand}*`,
      ``,
      `${used}/${cap} conversations used (90%). Only ${remaining} remain.`,
      ``,
      `Reply *extend* (₹500 for 250 more) before the cap is reached.`
    ].join('\n');
  }
  // 100
  return [
    `🛑 *Vaani — ${brand}: cap reached*`,
    ``,
    `${cap}/${cap} conversations used for ${monthYearLabel()}.`,
    ``,
    `Reply *extend* (₹500 for 250 more) to resume immediately, or wait for the 1st.`
  ].join('\n');
}

// ─── INTERNAL ALERT (always neutral, sent to founder) ──────────────────────

function internalAlertMessage(brand, threshold, used, cap, daysLeftInMonth) {
  const remaining = Math.max(0, cap - used);
  const emoji = threshold === 100 ? '🛑' : (threshold === 90 ? '⚠️' : '📊');
  return [
    `${emoji} *Vaani usage alert — ${brand}*`,
    ``,
    `Threshold: *${threshold}%* crossed`,
    `Usage: ${used}/${cap}`,
    `Remaining: ${remaining}`,
    `Days left in month: ${daysLeftInMonth}`,
    ``,
    `_Brand-owner notified: ${threshold >= 70 ? 'yes' : 'no'}_`
  ].join('\n');
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function monthYearLabel() {
  const d = new Date();
  return d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

function daysLeftInMonth() {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(0, lastDay - now.getDate());
}

function brandLabel(tenant) {
  return tenant.store_name || tenant.shop_domain.replace('.myshopify.com', '');
}

// Determine which thresholds (if any) were crossed by going from oldUsed → newUsed
// at this effectiveCap. Returns array of integer thresholds, e.g. [70, 90].
function crossedThresholds(oldUsed, newUsed, effectiveCap) {
  if (!effectiveCap || effectiveCap <= 0) return [];
  if (newUsed <= oldUsed) return [];
  const crossed = [];
  for (const t of THRESHOLDS) {
    const limit = (t / 100) * effectiveCap;
    if (oldUsed < limit && newUsed >= limit) {
      crossed.push(t);
    }
  }
  return crossed;
}

// ─── CORE: check + fire alerts for one tenant ──────────────────────────────
// Called by:
//   - usage.js trackConversation() right after counter increment (inline path)
//   - cron-alerts.js daily 9 AM IST (safety net path)
//
// Idempotent: alerts_sent JSONB tracks fired thresholds per tenant per month.
// Returns { fired: [70,90,...], errors: [] }
async function checkAndFireAlerts({ tenantId, sendMessage, waToken, phoneNumberId, oldUsed, newUsed }) {
  const result = { fired: [], errors: [] };

  try {
    // Fetch tenant + current month usage in one query
    const r = await pool.query(
      `SELECT t.id, t.shop_domain, t.store_name, t.notify_phone, t.notify_voice,
              u.year, u.month, u.conversation_count, u.effective_cap, u.alerts_sent
       FROM tenants t
       LEFT JOIN tenant_usage_monthly u
              ON u.tenant_id = t.id
             AND u.year = EXTRACT(YEAR FROM CURRENT_DATE)::int
             AND u.month = EXTRACT(MONTH FROM CURRENT_DATE)::int
       WHERE t.id = $1`,
      [tenantId]
    );
    if (r.rows.length === 0) {
      result.errors.push(`tenant ${tenantId} not found`);
      return result;
    }

    const row = r.rows[0];
    const cap = row.effective_cap || 1000;
    const used = (typeof newUsed === 'number') ? newUsed : (row.conversation_count || 0);
    const prev = (typeof oldUsed === 'number') ? oldUsed : (used - 1); // assume prev = used - 1 for cron path
    const alertsSent = row.alerts_sent || {};

    // Determine which thresholds need firing now.
    // Inline path: we know oldUsed/newUsed → use crossing logic.
    // Cron path (oldUsed/newUsed undefined): check current used against thresholds, only fire if not yet sent.
    let candidates;
    if (typeof oldUsed === 'number' && typeof newUsed === 'number') {
      candidates = crossedThresholds(oldUsed, newUsed, cap);
    } else {
      candidates = THRESHOLDS.filter(t => used >= (t / 100) * cap);
    }

    // Filter out thresholds already fired this month
    const toFire = candidates.filter(t => !alertsSent[String(t)]);
    if (toFire.length === 0) return result;

    const brand = brandLabel(row);
    const days = daysLeftInMonth();

    // Fire each threshold
    for (const threshold of toFire) {
      // 1. Internal alert to founder (always)
      const founderPhone = process.env.FOUNDER_PHONE;
      if (founderPhone && sendMessage && waToken && phoneNumberId) {
        try {
          const msg = internalAlertMessage(brand, threshold, used, cap, days);
          await sendMessage(founderPhone, msg, waToken, phoneNumberId);
          console.log(`[alerts] internal ${threshold}% fired for ${brand} → founder`);
        } catch (err) {
          result.errors.push(`internal ${threshold}%: ${err.message}`);
          console.error(`[alerts] internal send failed for ${brand} @ ${threshold}%:`, err.message);
        }
      }

      // 2. Brand-owner alert (only if notify_phone set)
      if (row.notify_phone && sendMessage && waToken && phoneNumberId) {
        try {
          const voice = row.notify_voice || 'neutral';
          const msg = brandAlertMessage(voice, brand, threshold, used, cap, days);
          await sendMessage(row.notify_phone, msg, waToken, phoneNumberId);
          console.log(`[alerts] brand-owner ${threshold}% fired for ${brand} → ${row.notify_phone} (voice=${voice})`);
        } catch (err) {
          result.errors.push(`brand-owner ${threshold}%: ${err.message}`);
          console.error(`[alerts] brand-owner send failed for ${brand} @ ${threshold}%:`, err.message);
        }
      }

      // 3. Mark fired in JSONB (do this even if a send failed, to avoid retry storm.
      //    Errors are logged + returned for visibility.)
      try {
        await pool.query(
          `UPDATE tenant_usage_monthly
           SET alerts_sent = COALESCE(alerts_sent, '{}'::jsonb) || jsonb_build_object($1::text, NOW())
           WHERE tenant_id = $2
             AND year = EXTRACT(YEAR FROM CURRENT_DATE)::int
             AND month = EXTRACT(MONTH FROM CURRENT_DATE)::int`,
          [String(threshold), tenantId]
        );
        result.fired.push(threshold);
      } catch (err) {
        result.errors.push(`mark ${threshold}%: ${err.message}`);
        console.error(`[alerts] failed to mark ${threshold}% fired:`, err.message);
      }
    }
  } catch (err) {
    result.errors.push(`fatal: ${err.message}`);
    console.error('[alerts] checkAndFireAlerts fatal error:', err);
  }

  return result;
}

// ─── CRON SAFETY NET ───────────────────────────────────────────────────────
// Scans all tenants, fires any unsent alerts based on current usage.
// Called by cron-alerts.js once per day. Uses each tenant's own WhatsApp bot
// to send (the bot must be active — i.e. have whatsapp_token + whatsapp_number).
async function runDailyCheck({ sendMessage }) {
  console.log('[alerts:cron] Daily threshold check started');
  const tenantsRes = await pool.query(
    `SELECT id, shop_domain, store_name, whatsapp_number, whatsapp_token
     FROM tenants
     WHERE whatsapp_token IS NOT NULL
       AND whatsapp_number IS NOT NULL
     ORDER BY id ASC`
  );

  let totalFired = 0;
  let totalErrors = 0;
  for (const tenant of tenantsRes.rows) {
    const r = await checkAndFireAlerts({
      tenantId: tenant.id,
      sendMessage,
      waToken: tenant.whatsapp_token,
      phoneNumberId: tenant.whatsapp_number
      // oldUsed/newUsed deliberately omitted → cron path
    });
    totalFired += r.fired.length;
    totalErrors += r.errors.length;
  }

  console.log(`[alerts:cron] Daily check done: ${totalFired} fired, ${totalErrors} errors across ${tenantsRes.rows.length} tenants`);
  return { totalFired, totalErrors };
}

module.exports = {
  checkAndFireAlerts,
  runDailyCheck,
  // Exposed for testing
  _internal: {
    crossedThresholds,
    brandAlertMessage,
    internalAlertMessage,
    daysLeftInMonth,
    THRESHOLDS
  }
};
