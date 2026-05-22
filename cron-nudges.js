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
// PATCH 23 — wire real template sends with freeform fallback for in-window cases.
const { sendTemplateOrFreeform } = require('./templates');

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
// PATCH 26 — Sizing reminder send (in-window, freeform).
// Customer tapped "In 2 hours" / "Tomorrow morning" / "Pick a time" during S07.
// Fires whenever they asked. Freeform is safe because they explicitly opted-in
// via button tap within the last 24h (well within WA service window).
async function sendSizingRemind(creds, phone, payload) {
  const sig = nudgeSignature(payload);
  const productPart = payload?.productTitle
    ? `*${payload.productTitle}*`
    : 'that fit';
  const text =
    `Hey ${PAW} Circling back on those measurements for ${productPart}.\n\n` +
    `If you grabbed them, send: *Back X, Chest Y, Neck Z* and I'll suggest a size.\n` +
    `If not, no stress — happy to help when you're ready.\n\n` +
    `— ${sig}`;
  await sendMessage(phone, text, creds.waToken, creds.phoneNumberId);
}

async function sendDay14Template(tenant, creds, phone, payload) {
  // PATCH 23 — S14 day-14 final.
  // Template: woof_day14_final, 1 param (pup name or "there").
  const pupNameOrThere = (payload?.pupName || '').trim() || 'there';
  const freeformText =
    `Hey ${pupNameOrThere === 'there' ? '' : pupNameOrThere + '\'s parent '}🐾\n` +
    `Your shortlist at The Woof Parade is still saved, but it'll clear tomorrow.\n` +
    `Want to grab it before it's gone? Just reply 'show me' and Rio will pull it up.`;
  const r = await sendTemplateOrFreeform({
    to: phone,
    templateName: 'woof_day14_final',
    params: { pupNameOrThere },
    freeformText,
    tenant,
    waToken: creds.waToken,
    phoneNumberId: creds.phoneNumberId,
  });
  if (r?.ok) return { sent: true };
  if (r?.skipped) return { skipped: true, reason: r.reason || 'template_skipped' };
  return { skipped: true, reason: r?.error || 'unknown_failure' };
}

async function sendUnpaidCheckoutTemplate(tenant, creds, phone, payload) {
  // PATCH 23 — S15 24-hr unpaid checkout.
  // Template: woof_unpaid_checkout_24h, 1 param (invoice hint).
  const product = (payload?.productTitle || '').trim();
  const invoiceHint = product
    ? `Your ${product} is one tap away.`
    : `Reply 'cart' to see your saved items.`;
  const freeformText =
    `Hey 🐾 Your shortlist at The Woof Parade is still saved if you want to continue.\n` +
    `No pressure — but the WOOF15 discount is good for the next 24 hours. ${invoiceHint}`;
  const r = await sendTemplateOrFreeform({
    to: phone,
    templateName: 'woof_unpaid_checkout_24h',
    params: { invoiceHint },
    freeformText,
    tenant,
    waToken: creds.waToken,
    phoneNumberId: creds.phoneNumberId,
  });
  if (r?.ok) return { sent: true };
  if (r?.skipped) return { skipped: true, reason: r.reason || 'template_skipped' };
  return { skipped: true, reason: r?.error || 'unknown_failure' };
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
      return await sendDay14Template(tenant, creds, phone, payload);
    case 's15_unpaid_checkout':
      return await sendUnpaidCheckoutTemplate(tenant, creds, phone, payload);
    case 's07_sizing_remind':
      // PATCH 26 — Customer asked to be reminded about sizing.
      // In-window freeform send (no template required because customer
      // explicitly opted-in by tapping a reminder button).
      await sendSizingRemind(creds, phone, payload);
      return { sent: true };
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
