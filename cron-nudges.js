// cron-nudges.js — S14 (silence nudges) + S15 (24-hr unpaid checkout) dispatcher
//
// Polls the scheduled_nudges table every 30 seconds. For each due row:
//   - resolves tenant WhatsApp creds (token + phone_number_id)
//   - dispatches to the right handler based on `kind`
//   - marks sent (or records error)
//
// Kinds dispatched:
//   - s14_branch_a_pre_shortlist   (30 min after browse start, in-window freeform)
//   - s14_branch_b_post_shortlist  (2 hr after shortlist add, in-window freeform)
//   - s14_day14_final              (14 days after first contact, OUT-OF-WINDOW → template)
//   - s15_unpaid_checkout          (24 hr after Pay-now link sent, OUT-OF-WINDOW → template)
//
// Template sends are stubbed until Meta approval lands. Until then they log
// "[cron-nudges] template not yet approved" and skip without erroring.

const { pool, getDueNudges, markNudgeSent, markNudgeError, getConversation } = require('./db');
const { sendMessage } = require('./whatsapp');

const POLL_INTERVAL_MS = 30 * 1000;  // 30s
const PAW = '🐾';

// ─── Tenant creds resolver ────────────────────────────────────────────────
async function getTenantById(tenantId) {
  const r = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return r.rows[0] || null;
}

function getTenantWhatsAppCreds(tenant) {
  if (!tenant) return null;
  // Tenants table stores phone_number_id in `whatsapp_number` column (legacy naming).
  // Token is in `whatsapp_token`. Mirror routes/shopify-webhook.js getTenantWhatsAppCreds.
  return {
    waToken: tenant.whatsapp_token || tenant.wa_token || process.env.WHATSAPP_TOKEN,
    phoneNumberId: tenant.whatsapp_number || tenant.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

// ─── Persona helper ───────────────────────────────────────────────────────
// S14 Biscuit rule: if customer's pup is named Rio, our Rio can't sign nudges
// (collision). Switch to "Biscuit" sub-persona for that customer's nudges.
function nudgeSignature(payload) {
  const pupName = (payload?.pupName || '').trim().toLowerCase();
  return pupName === 'rio' ? 'Biscuit' : 'Rio';
}

// ─── In-window nudge senders (freeform text, no template needed) ──────────
async function sendBranchA(creds, phone, payload) {
  const sig = nudgeSignature(payload);
  // PDF v1.4 S14 Branch A: "Hey! Just checking in — anything caught your eye?"
  const text =
    `Hey! ${PAW} Just checking in — anything caught your eye yet?\n` +
    `If you'd like, I can show you a few based on your pup, or help with sizing.\n\n` +
    `— ${sig}`;
  await sendMessage(phone, text, creds.waToken, creds.phoneNumberId);
}

async function sendBranchB(creds, phone, payload) {
  const sig = nudgeSignature(payload);
  const productTitle = payload?.productTitle || 'that one';
  const size = payload?.size ? ` (Size ${payload.size})` : '';
  // PDF v1.4 S14 Branch B: nudge with shortlisted item, friendly low-pressure.
  const text =
    `Still thinking about *${productTitle}*${size}? ${PAW}\n` +
    `Happy to answer any questions, or wrap it up whenever you're ready.\n\n` +
    `— ${sig}`;
  await sendMessage(phone, text, creds.waToken, creds.phoneNumberId);
}

// ─── Out-of-window nudge senders (templates — dormant until Meta approves) ─
async function sendDay14Template(creds, phone, payload) {
  // S14 Day-14 final: outside 24h window, must be Meta utility template.
  // Template name placeholder: "woof_day14_final" with 1 parameter (pup name or "your pup").
  if (!process.env.WOOF_TEMPLATE_DAY14_NAMESPACE) {
    console.log(`[cron-nudges] s14_day14_final → template not yet approved, skipping (phone=${phone})`);
    return { skipped: true, reason: 'template_pending' };
  }
  // TODO: real template call once Meta approves.
  console.log(`[cron-nudges] s14_day14_final → would send template (phone=${phone}, payload=${JSON.stringify(payload)})`);
  return { skipped: true, reason: 'not_implemented' };
}

async function sendUnpaidCheckoutTemplate(creds, phone, payload) {
  // S15 24-hr unpaid: outside 24h window, must be Meta utility template.
  // Template name placeholder: "woof_unpaid_checkout_24h" with 2 params (productTitle, invoiceUrl).
  if (!process.env.WOOF_TEMPLATE_UNPAID_NAMESPACE) {
    console.log(`[cron-nudges] s15_unpaid_checkout → template not yet approved, skipping (phone=${phone})`);
    return { skipped: true, reason: 'template_pending' };
  }
  // TODO: real template call once Meta approves.
  console.log(`[cron-nudges] s15_unpaid_checkout → would send template (phone=${phone}, payload=${JSON.stringify(payload)})`);
  return { skipped: true, reason: 'not_implemented' };
}

// ─── Dispatch one nudge ───────────────────────────────────────────────────
async function dispatchOne(nudge) {
  const tenant = await getTenantById(nudge.tenant_id);
  const creds = getTenantWhatsAppCreds(tenant);
  if (!creds || !creds.waToken || !creds.phoneNumberId) {
    throw new Error(`tenant ${nudge.tenant_id} missing WhatsApp creds`);
  }

  const phone = nudge.customer_phone;
  const payload = nudge.payload || {};

  // S19 — respect unsubscribe: if customer opted out between schedule and tick,
  // skip this nudge silently. Conversation cart holds the flag.
  try {
    const conv = await getConversation(nudge.tenant_id, phone);
    if (conv?.cart?.woofparade?.unsubscribed === true) {
      console.log(`[cron-nudges] ⏭️  skipping id=${nudge.id} kind=${nudge.kind} phone=${phone} — customer unsubscribed`);
      return { skipped: true, reason: 'unsubscribed' };
    }
  } catch (e) {
    // Conversation lookup failure shouldn't block the dispatch — log and proceed
    console.error('[cron-nudges] unsubscribe check failed (proceeding):', e.message);
  }

  switch (nudge.kind) {
    case 's14_branch_a_pre_shortlist':
      await sendBranchA(creds, phone, payload);
      return { sent: true };
    case 's14_branch_b_post_shortlist':
      await sendBranchB(creds, phone, payload);
      return { sent: true };
    case 's14_day14_final':
      return await sendDay14Template(creds, phone, payload);
    case 's15_unpaid_checkout':
      return await sendUnpaidCheckoutTemplate(creds, phone, payload);
    default:
      throw new Error(`unknown nudge kind: ${nudge.kind}`);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────
let inFlight = false;

async function tick() {
  if (inFlight) return;  // prevent overlapping polls
  inFlight = true;
  try {
    const due = await getDueNudges(20);
    if (due.length === 0) return;
    console.log(`[cron-nudges] ${due.length} nudge(s) due`);

    for (const nudge of due) {
      try {
        const result = await dispatchOne(nudge);
        if (result?.sent) {
          await markNudgeSent(nudge.id);
          console.log(`[cron-nudges] ✅ sent id=${nudge.id} kind=${nudge.kind} phone=${nudge.customer_phone}`);
        } else if (result?.skipped) {
          // Mark sent so we don't retry forever — template path will be re-implemented when ready.
          await markNudgeSent(nudge.id);
          console.log(`[cron-nudges] ⏭️  skipped id=${nudge.id} reason=${result.reason}`);
        }
      } catch (e) {
        console.error(`[cron-nudges] ❌ id=${nudge.id} failed:`, e.message);
        await markNudgeError(nudge.id, e.message).catch(() => {});
        // After 3 attempts, getDueNudges stops picking it up.
      }
    }
  } catch (e) {
    console.error('[cron-nudges] tick error (non-fatal):', e.message);
  } finally {
    inFlight = false;
  }
}

function start() {
  console.log(`[cron-nudges] polling every ${POLL_INTERVAL_MS/1000}s for due nudges`);
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { start, tick, dispatchOne };
