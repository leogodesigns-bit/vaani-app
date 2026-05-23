// cron-s16-digest.js
// S16 weekly digest — Sunday 9am IST → Kashmira gets a count of all
// HUMAN HELP handoffs that fired in the previous week.
//
// Triggered by setInterval polling every 5 min; sends only once per week
// (idempotency keyed on tenant_id + ISO week). Idempotency record: row in
// `scheduled_nudges` with kind='s16_weekly_digest', sent_at=NOW(),
// payload={week:"2026-W21"}. We read the most recent one to decide whether
// to fire this week.
//
// Hooked into index.js with `require('./cron-s16-digest').start();` —
// no changes required to handlers/woofparade.js or cron-nudges.js.
//
// Failure mode: any error inside tick() is caught and logged; the next
// tick will retry. Won't crash the bot.

const { pool } = require('./db');
const { sendTemplateOrFreeform } = require('./templates');

// ─── CONFIG ──────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const TARGET_TENANT_ID = 10;              // Woof Parade only — Rajathee/Ikaa not enrolled

// "9am IST" = 03:30 UTC. The check is "is it currently >= Sunday 09:00 IST
// AND last digest sent week != this week". Window stays open for 24h
// in case the bot was down at the exact moment.
const KASHMIRA_PHONE = '918888816399';

// ─── HELPERS ─────────────────────────────────────────────────────────────

function isoWeek(date) {
  // ISO 8601 week (Mon-start) — same convention as `date +%G-W%V`.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function toISTString(date) {
  // Formats date as "Mon May 19, 14:32 IST" for human readability in the digest.
  // Uses UTC+5:30 offset manually since the container TZ is UTC.
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[ist.getUTCDay()]} ${months[ist.getUTCMonth()]} ${ist.getUTCDate()}, ` +
         `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')} IST`;
}

function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function isSundayMorningISTWindow() {
  // Returns true if the current IST time is Sun 09:00 → Mon 09:00.
  // The 24h window prevents misses if the bot was down at 9am sharp.
  const ist = nowIST();
  const day = ist.getUTCDay();         // 0=Sun, 1=Mon, ...
  const hour = ist.getUTCHours();
  if (day === 0 && hour >= 9) return true;     // Sun 09:00 → Sun 23:59
  if (day === 1 && hour < 9) return true;      // Mon 00:00 → Mon 08:59
  return false;
}

// ─── DIGEST SEND ─────────────────────────────────────────────────────────

async function getLastDigestWeek(tenantId) {
  // We track "last week sent" by writing a row to scheduled_nudges with
  // kind='s16_weekly_digest', sent_at=NOW(), fire_at=NOW(). The payload
  // jsonb stores { week: "2026-W21" }. We read the most recent one to
  // decide whether to fire this week.
  try {
    const r = await pool.query(
      `SELECT payload FROM scheduled_nudges
        WHERE tenant_id = $1 AND kind = 's16_weekly_digest'
        ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );
    const payload = r.rows[0]?.payload;
    if (!payload) return null;
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return obj?.week || null;
  } catch (e) {
    console.error('[s16-digest] failed to read last digest week:', e.message);
    return null;
  }
}

async function markDigestSent(tenantId, weekStr) {
  try {
    await pool.query(
      `INSERT INTO scheduled_nudges
         (tenant_id, customer_phone, kind, fire_at, sent_at, payload)
       VALUES ($1, $2, 's16_weekly_digest', NOW(), NOW(), $3::jsonb)`,
      [tenantId, KASHMIRA_PHONE, JSON.stringify({ week: weekStr })]
    );
  } catch (e) {
    console.error('[s16-digest] failed to persist digest-sent row:', e.message);
  }
}

async function buildDigestBody(tenantId) {
  // Pull all HUMAN HELP rows in the last 7 days, route='apurv' (S16 routes to
  // Apurv per PDF). Dedup by customer_phone — same customer pinging twice
  // counts once in the unique-count line but each ping is listed.
  // Order: newest first, max 25 rows shown to fit WhatsApp message limit.
  const r = await pool.query(
    `SELECT recipient_phone, created_at, params
       FROM team_messages
      WHERE tenant_id = $1
        AND sos_type = 'HUMAN HELP'
        AND recipient_role = 'apurv'
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 25`,
    [tenantId]
  );

  const rows = r.rows;
  if (rows.length === 0) {
    return null;  // skip send — no handoffs this week
  }

  // Each row's params jsonb has { summary: "Customer asked to speak with human (sizing)" }
  // We extract the reasonCode from the parens, fallback to "general".
  const parseReason = (params) => {
    try {
      const obj = typeof params === 'string' ? JSON.parse(params) : params;
      const summary = obj?.summary || '';
      const m = summary.match(/\(([^)]+)\)\s*$/);
      return m ? m[1] : 'general';
    } catch (_) { return 'general'; }
  };

  // Customer phone from the ORIGINAL handoff event isn't directly stored on
  // team_messages — that table stores recipient (Apurv), not customer.
  // But params.summary doesn't include customer phone either.
  // FIX: pull customer phones from conversations.last_active during the
  // same window. Cleaner: parse from the body if available, else skip.
  // For v1, we group by reason only and show count + reasons breakdown.

  const reasonCounts = {};
  for (const row of rows) {
    const reason = parseReason(row.params);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  // Window dates (last 7 days, IST)
  const now = nowIST();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${d.getUTCDate()}`;
  const windowLabel = `${fmt(weekAgo)} – ${fmt(now)}`;

  // Newest 10 with timestamps for the body
  const recentLines = rows.slice(0, 10).map(row => {
    const reason = parseReason(row.params);
    return `• ${toISTString(new Date(row.created_at))} — ${reason}`;
  });

  const reasonsSummary = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `  ${reason}: ${n}`)
    .join('\n');

  const more = rows.length > 10 ? `\n…and ${rows.length - 10} more` : '';

  const body =
    `📊 *Weekly S16 digest* (${windowLabel})\n\n` +
    `*${rows.length}* talk-to-human handoffs this week.\n\n` +
    `*Recent:*\n${recentLines.join('\n')}${more}\n\n` +
    `*By reason:*\n${reasonsSummary}\n\n` +
    `Tap any customer in the dashboard to follow up.`;

  return body;
}

async function sendDigest(tenantId) {
  const body = await buildDigestBody(tenantId);
  if (!body) {
    console.log(`[s16-digest] tenant ${tenantId}: 0 handoffs this week — skipping`);
    return { sent: false, reason: 'no_handoffs' };
  }

  // Need tenant creds for the send
  const t = await pool.query(
    `SELECT id, whatsapp_number AS phone_number_id, store_name FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!t.rows.length) {
    console.error(`[s16-digest] tenant ${tenantId} not found`);
    return { sent: false, reason: 'no_tenant' };
  }
  const tenant = t.rows[0];

  const creds = {
    waToken: process.env.WHATSAPP_TOKEN,
    phoneNumberId: tenant.phone_number_id,
  };

  // Use vaani_team_sos template (already approved for tenant 10). Its 3 params
  // are {sosType, customerPhone, summary}. We map digest to:
  //   sosType = "WEEKLY DIGEST"
  //   customerPhone = "—" (no single customer)
  //   summary = digest body truncated to 800 chars (Meta template body cap is
  //            ~1024; 800 is safe with Unicode emoji).
  // If outside 24h window (Sunday digest = always outside), sends as template.
  // If inside 24h (unlikely — Kashmira would have needed to message Vaani),
  // sends as freeform via the sendMessage callback we pass in.
  const safeSummary = body.length > 800 ? body.slice(0, 797) + '…' : body;
  const { sendMessage } = require('./whatsapp');

  try {
    const result = await sendTemplateOrFreeform({
      to: KASHMIRA_PHONE,
      templateName: 'vaani_team_sos',
      params: ['WEEKLY DIGEST', '—', safeSummary],
      tenant,
      waToken: creds.waToken,
      phoneNumberId: creds.phoneNumberId,
      freeformText: body,
      sendMessage,
      record: {
        tenantId: tenant.id,
        role: 'kashmira',
        sosType: 'WEEKLY DIGEST',
      },
    });
    console.log(`[s16-digest] ✅ sent via=${result?.via} ok=${result?.ok}`);
    return { sent: !!result?.ok };
  } catch (e) {
    console.error('[s16-digest] send failed:', e.message);
    return { sent: false, reason: 'send_failed', error: e.message };
  }
}

// ─── TICK ─────────────────────────────────────────────────────────────────

let inFlight = false;

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    if (!isSundayMorningISTWindow()) {
      return;
    }
    const thisWeek = isoWeek(nowIST());
    const lastWeek = await getLastDigestWeek(TARGET_TENANT_ID);
    if (lastWeek === thisWeek) {
      // Already sent this week — silent skip
      return;
    }
    console.log(`[s16-digest] window open, last=${lastWeek}, now=${thisWeek} — building digest`);
    const result = await sendDigest(TARGET_TENANT_ID);
    if (result.sent || result.reason === 'no_handoffs') {
      // Mark week as done either way — don't retry "0 handoffs" weeks all day
      await markDigestSent(TARGET_TENANT_ID, thisWeek);
    }
  } catch (e) {
    console.error('[s16-digest] tick error (non-fatal):', e.message);
  } finally {
    inFlight = false;
  }
}

function start() {
  console.log(`[s16-digest] polling every ${POLL_INTERVAL_MS / 1000}s; fires Sunday 9am IST → ${KASHMIRA_PHONE}`);
  // Fire one immediate tick so a Sunday-9am-exactly cold-start is caught
  setTimeout(tick, 30 * 1000);
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { start, tick, buildDigestBody, isoWeek, isSundayMorningISTWindow };
