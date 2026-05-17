// founder.js — Phase 3 founder commands for Vaani
//
// Recognizes admin commands sent from Shweta's WhatsApp (FOUNDER_PHONE env var)
// to ANY Vaani-managed bot. When matched, replies through the same bot's WA token.

const { pool } = require('./db');

// In-memory pending confirmations for dangerous commands.
// 5-minute timeout — after that the user has to re-type the command.
const pendingConfirmations = new Map();
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// ─── PHONE NORMALIZATION ───────────────────────────────────────────────────
function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) {
    return digits.slice(2);
  }
  return digits;
}

function isFounderPhone(from) {
  const founder = process.env.FOUNDER_PHONE;
  if (!founder) return false;
  return normalizePhone(from) === normalizePhone(founder);
}

// ─── COMMAND DETECTION ─────────────────────────────────────────────────────
function isFounderCommand(from, text) {
  if (!isFounderPhone(from)) return false;
  if (!text || typeof text !== 'string') return false;

  const t = text.trim().toLowerCase();
  if (!t) return false;

  const prefixes = [
    'help',
    'usage',
    'extend ',
    'pause ',
    'unpause ',
    'topup status ',
    'subscriptions',
    'subscribe ',
    'reset usage ',
    'cancel ',
    'kill ',
    'confirm',
    'no'
  ];

  return prefixes.some(p => t === p.trim() || t.startsWith(p));
}

// ─── BRAND RESOLUTION ──────────────────────────────────────────────────────
async function resolveBrand(slug) {
  if (!slug) return null;
  const s = slug.trim().toLowerCase();
  if (!s) return null;

  const r = await pool.query(
    `SELECT * FROM tenants
     WHERE LOWER(shop_domain) LIKE $1
        OR LOWER(COALESCE(store_name, '')) LIKE $1
     ORDER BY id ASC
     LIMIT 5`,
    [`%${s}%`]
  );

  if (r.rows.length === 0) return null;
  if (r.rows.length === 1) return r.rows[0];

  // Multiple matches — prefer one whose shop_domain starts with the slug
  const exact = r.rows.find(t => t.shop_domain.toLowerCase().startsWith(s));
  return exact || r.rows[0];
}

// ─── SHARED HELPERS ────────────────────────────────────────────────────────
function getCurrentMonthYear() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function fmtPct(used, cap) {
  if (!cap || cap === 0) return '0%';
  return Math.round((used / cap) * 100) + '%';
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10);
}

function brandName(tenant) {
  return tenant.store_name || tenant.shop_domain.replace('.myshopify.com', '');
}

// ─── COMMAND: help ─────────────────────────────────────────────────────────
function cmdHelp() {
  return [
    '🛠 *Vaani Founder Commands*',
    '',
    '*Read-only:*',
    '• `usage all` — usage across all brands',
    '• `usage <brand>` — detailed usage for one brand',
    '• `topup status <brand>` — active topups',
    '• `subscriptions` — all subscription plans',
    '',
    '*Manage:*',
    '• `extend <brand>` — +250 chats (₹500)',
    '• `pause <brand>` — pause bot',
    '• `unpause <brand>` — resume bot',
    '• `subscribe <brand> monthly|annual|internal`',
    '',
    '*Dangerous (need confirm):*',
    '• `reset usage <brand>` — zero counter',
    '• `cancel <brand>` — cancel subscription',
    '• `kill <brand>` — pause + cancel',
    '',
    'Reply `confirm` within 5 min to execute, or `no` to abort.'
  ].join('\n');
}

// ─── COMMAND: usage all ────────────────────────────────────────────────────
async function cmdUsageAll() {
  const { year, month } = getCurrentMonthYear();
  const r = await pool.query(
    `SELECT t.id, t.shop_domain, t.store_name,
            COALESCE(u.conversation_count, 0) AS used,
            COALESCE(u.base_cap, 1000) AS base_cap,
            COALESCE(u.top_up_balance, 0) AS topup,
            COALESCE(u.effective_cap, 1000) AS cap,
            COALESCE(u.paused, false) AS paused,
            s.plan_type, s.status AS sub_status
     FROM tenants t
     LEFT JOIN tenant_usage_monthly u
            ON u.tenant_id = t.id AND u.year = $1 AND u.month = $2
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
     ORDER BY t.id ASC`,
    [year, month]
  );

  if (r.rows.length === 0) {
    return '📊 *Usage — ' + year + '-' + String(month).padStart(2, '0') + '*\n\nNo tenants found.';
  }

  const lines = ['📊 *Usage — ' + year + '-' + String(month).padStart(2, '0') + '*', ''];
  for (const row of r.rows) {
    const name = row.store_name || row.shop_domain.replace('.myshopify.com', '');
    const pausedMark = row.paused ? ' ⏸' : '';
    const planMark = row.plan_type ? ` [${row.plan_type}]` : ' [no plan]';
    lines.push(`*${name}*${pausedMark}${planMark}`);
    lines.push(`  ${row.used} / ${row.cap} (${fmtPct(row.used, row.cap)})${row.topup > 0 ? ` +${row.topup} topup` : ''}`);
    lines.push('');
  }
  lines.push('_Reply `usage <brand>` for details._');
  return lines.join('\n');
}

// ─── COMMAND: usage <brand> ────────────────────────────────────────────────
async function cmdUsageBrand(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const { year, month } = getCurrentMonthYear();
  const usageRes = await pool.query(
    `SELECT * FROM tenant_usage_monthly
     WHERE tenant_id = $1 AND year = $2 AND month = $3`,
    [tenant.id, year, month]
  );
  const usage = usageRes.rows[0];

  const subRes = await pool.query(
    `SELECT * FROM tenant_subscriptions WHERE tenant_id = $1`,
    [tenant.id]
  );
  const sub = subRes.rows[0];

  const topupRes = await pool.query(
    `SELECT COUNT(*) AS active_count, COALESCE(SUM(chats_remaining), 0) AS total_remaining
     FROM tenant_topups
     WHERE tenant_id = $1 AND NOT expired AND expires_at > NOW()`,
    [tenant.id]
  );
  const topupSummary = topupRes.rows[0];

  const used = usage?.conversation_count || 0;
  const cap = usage?.effective_cap || 1000;
  const paused = usage?.paused || false;
  const name = brandName(tenant);

  const lines = [
    `📊 *${name}* — ${year}-${String(month).padStart(2, '0')}`,
    '',
    `Used: *${used}* / ${cap} (${fmtPct(used, cap)})`,
    `Base cap: ${usage?.base_cap || 1000}`,
    `Topup balance: ${usage?.top_up_balance || 0}`,
    `Active topups: ${topupSummary.active_count} (${topupSummary.total_remaining} chats remaining)`,
    `Status: ${paused ? '⏸ paused' : '✅ active'}`,
  ];

  if (sub) {
    lines.push('');
    lines.push(`Plan: *${sub.plan_type}* (${sub.status})`);
    lines.push(`Started: ${fmtDate(sub.started_at)}`);
    if (sub.next_billing_date) lines.push(`Next billing: ${fmtDate(sub.next_billing_date)}`);
    if (sub.annual_end_date) lines.push(`Annual ends: ${fmtDate(sub.annual_end_date)}`);
    if (sub.credit_balance > 0) lines.push(`Credit balance: ₹${sub.credit_balance}`);
  } else {
    lines.push('');
    lines.push('⚠ No subscription on file. Use `subscribe ' + slug + ' monthly|annual|internal`.');
  }

  return lines.join('\n');
}

// ─── COMMAND: extend <brand> ───────────────────────────────────────────────
async function cmdExtend(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  await pool.query(
    `INSERT INTO tenant_topups (tenant_id, chats_purchased, chats_remaining, amount_paid, expires_at, expired)
     VALUES ($1, 250, 250, 500, $2, false)`,
    [tenant.id, expiresAt]
  );

  const { year, month } = getCurrentMonthYear();
  await pool.query(
    `INSERT INTO tenant_usage_monthly (tenant_id, year, month, conversation_count, base_cap, top_up_balance)
     VALUES ($1, $2, $3, 0, 1000, 250)
     ON CONFLICT (tenant_id, year, month)
     DO UPDATE SET top_up_balance = tenant_usage_monthly.top_up_balance + 250`,
    [tenant.id, year, month]
  );

  const name = brandName(tenant);
  return [
    `✅ *Extended ${name}*`,
    '',
    `+250 chats added`,
    `Amount: ₹500 (log to next invoice)`,
    `Expires: ${fmtDate(expiresAt)} (90 days)`,
    '',
    `_Topup queued. Customer-facing copy will go out separately if needed._`
  ].join('\n');
}

// ─── COMMAND: pause / unpause ──────────────────────────────────────────────
async function cmdPause(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const { year, month } = getCurrentMonthYear();
  await pool.query(
    `INSERT INTO tenant_usage_monthly (tenant_id, year, month, conversation_count, paused, paused_at)
     VALUES ($1, $2, $3, 0, true, NOW())
     ON CONFLICT (tenant_id, year, month)
     DO UPDATE SET paused = true, paused_at = NOW()`,
    [tenant.id, year, month]
  );

  const name = brandName(tenant);
  return `⏸ *${name}* paused. Customers will not get auto-replies until you \`unpause ${slug}\`.`;
}

async function cmdUnpause(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const { year, month } = getCurrentMonthYear();
  await pool.query(
    `INSERT INTO tenant_usage_monthly (tenant_id, year, month, conversation_count, paused, paused_at)
     VALUES ($1, $2, $3, 0, false, NULL)
     ON CONFLICT (tenant_id, year, month)
     DO UPDATE SET paused = false, paused_at = NULL`,
    [tenant.id, year, month]
  );

  const name = brandName(tenant);
  return `▶ *${name}* unpaused. Auto-replies resume now.`;
}

// ─── COMMAND: topup status ─────────────────────────────────────────────────
async function cmdTopupStatus(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const r = await pool.query(
    `SELECT chats_purchased, chats_remaining, amount_paid, expires_at, expired, created_at
     FROM tenant_topups
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [tenant.id]
  );

  const name = brandName(tenant);
  if (r.rows.length === 0) {
    return `📦 *${name}* — no topups on file.`;
  }

  const lines = [`📦 *${name}* — last ${r.rows.length} topup(s)`, ''];
  for (const row of r.rows) {
    const status = row.expired ? '⛔ expired' :
                   (new Date(row.expires_at) < new Date() ? '⏰ past expiry' : '✅ active');
    lines.push(`${fmtDate(row.created_at)} → exp ${fmtDate(row.expires_at)}`);
    lines.push(`  ${row.chats_remaining}/${row.chats_purchased} left, ₹${row.amount_paid}, ${status}`);
  }
  return lines.join('\n');
}

// ─── COMMAND: subscriptions ────────────────────────────────────────────────
async function cmdSubscriptions() {
  const r = await pool.query(
    `SELECT t.shop_domain, t.store_name, s.plan_type, s.status,
            s.started_at, s.next_billing_date, s.annual_end_date, s.cancelled_at
     FROM tenants t
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
     ORDER BY t.id ASC`
  );

  if (r.rows.length === 0) return '📋 No tenants found.';

  const lines = ['📋 *Subscriptions*', ''];
  for (const row of r.rows) {
    const name = row.store_name || row.shop_domain.replace('.myshopify.com', '');
    if (!row.plan_type) {
      lines.push(`*${name}*: _no plan_`);
    } else {
      const next = row.cancelled_at ? `cancelled ${fmtDate(row.cancelled_at)}` :
                   row.annual_end_date ? `annual ends ${fmtDate(row.annual_end_date)}` :
                   row.next_billing_date ? `next ${fmtDate(row.next_billing_date)}` : '';
      lines.push(`*${name}*: ${row.plan_type} (${row.status})${next ? ' • ' + next : ''}`);
    }
  }
  return lines.join('\n');
}

// ─── COMMAND: subscribe <brand> <plan> ─────────────────────────────────────
async function cmdSubscribe(slug, plan) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const validPlans = ['monthly', 'annual', 'internal'];
  if (!plan || !validPlans.includes(plan.toLowerCase())) {
    return `❌ Plan must be one of: ${validPlans.join(', ')}.\nUsage: \`subscribe ${slug} monthly\``;
  }
  const planType = plan.toLowerCase();

  const today = new Date();
  let nextBilling = null;
  let annualEnd = null;

  if (planType === 'monthly') {
    nextBilling = new Date(today);
    nextBilling.setMonth(nextBilling.getMonth() + 1);
  } else if (planType === 'annual') {
    annualEnd = new Date(today);
    annualEnd.setFullYear(annualEnd.getFullYear() + 1);
  }

  await pool.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_type, started_at, next_billing_date, annual_end_date, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (tenant_id)
     DO UPDATE SET plan_type = $2, started_at = $3, next_billing_date = $4, annual_end_date = $5,
                   status = 'active', cancelled_at = NULL`,
    [tenant.id, planType, today, nextBilling, annualEnd]
  );

  const name = brandName(tenant);
  const lines = [`✅ *${name}* subscribed to *${planType}* plan.`];
  if (nextBilling) lines.push(`Next billing: ${fmtDate(nextBilling)}`);
  if (annualEnd) lines.push(`Annual ends: ${fmtDate(annualEnd)}`);
  if (planType === 'internal') lines.push('No billing — internal use.');
  return lines.join('\n');
}

// ─── DANGEROUS: reset usage ────────────────────────────────────────────────
async function cmdResetUsage(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const { year, month } = getCurrentMonthYear();
  await pool.query(
    `UPDATE tenant_usage_monthly
     SET conversation_count = 0, alerts_sent = '{}'::jsonb, overage_count = 0
     WHERE tenant_id = $1 AND year = $2 AND month = $3`,
    [tenant.id, year, month]
  );
  await pool.query(
    `DELETE FROM tenant_daily_conversations
     WHERE tenant_id = $1 AND conversation_date = CURRENT_DATE`,
    [tenant.id]
  );

  const name = brandName(tenant);
  return `🔄 *${name}* — current month counter reset to 0. Daily dedup cleared for today.`;
}

// ─── DANGEROUS: cancel ─────────────────────────────────────────────────────
async function cmdCancel(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  await pool.query(
    `UPDATE tenant_subscriptions
     SET status = 'cancelled', cancelled_at = NOW()
     WHERE tenant_id = $1`,
    [tenant.id]
  );

  const name = brandName(tenant);
  return [
    `🛑 *${name}* subscription cancelled.`,
    '',
    'Bot stays active until end of billing period.',
    'Manual: charge ₹2000 cancellation fee, log 6-mo Leogo service credit.',
    '_(Phase 8 will automate this.)_'
  ].join('\n');
}

// ─── DANGEROUS: kill ───────────────────────────────────────────────────────
async function cmdKill(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return `❌ No brand found matching "${slug}".`;

  const { year, month } = getCurrentMonthYear();
  await pool.query(
    `INSERT INTO tenant_usage_monthly (tenant_id, year, month, conversation_count, paused, paused_at)
     VALUES ($1, $2, $3, 0, true, NOW())
     ON CONFLICT (tenant_id, year, month)
     DO UPDATE SET paused = true, paused_at = NOW()`,
    [tenant.id, year, month]
  );
  await pool.query(
    `UPDATE tenant_subscriptions
     SET status = 'cancelled', cancelled_at = NOW()
     WHERE tenant_id = $1`,
    [tenant.id]
  );

  const name = brandName(tenant);
  return `💀 *${name}* killed. Paused + subscription cancelled. Bot will not auto-reply.`;
}

// ─── CONFIRMATION FLOW ─────────────────────────────────────────────────────
function setPendingConfirm(founderPhone, command, brand) {
  pendingConfirmations.set(normalizePhone(founderPhone), {
    command, brand, expiresAt: Date.now() + CONFIRM_TIMEOUT_MS
  });
}

function getPendingConfirm(founderPhone) {
  const key = normalizePhone(founderPhone);
  const pending = pendingConfirmations.get(key);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(key);
    return null;
  }
  return pending;
}

function clearPendingConfirm(founderPhone) {
  pendingConfirmations.delete(normalizePhone(founderPhone));
}

// ─── MAIN DISPATCHER ───────────────────────────────────────────────────────
async function dispatch(from, text) {
  const t = text.trim();
  const lower = t.toLowerCase();

  // Confirmation handling first
  if (lower === 'confirm') {
    const pending = getPendingConfirm(from);
    if (!pending) {
      return '⚠ No pending command to confirm. Confirmations expire after 5 minutes.';
    }
    clearPendingConfirm(from);
    if (pending.command === 'reset') return await cmdResetUsage(pending.brand);
    if (pending.command === 'cancel') return await cmdCancel(pending.brand);
    if (pending.command === 'kill') return await cmdKill(pending.brand);
    return '⚠ Unknown pending command — please retry.';
  }
  if (lower === 'no') {
    if (getPendingConfirm(from)) {
      clearPendingConfirm(from);
      return '✅ Cancelled. No changes made.';
    }
    return '_No pending command to cancel._';
  }

  if (lower === 'help') return cmdHelp();

  if (lower === 'usage all') return await cmdUsageAll();
  if (lower.startsWith('usage ')) {
    const brand = t.slice(6).trim();
    if (!brand) return '❌ Usage: `usage <brand>` or `usage all`';
    return await cmdUsageBrand(brand);
  }
  if (lower === 'usage') return cmdHelp();

  if (lower === 'subscriptions') return await cmdSubscriptions();

  if (lower.startsWith('subscribe ')) {
    const parts = t.slice(10).trim().split(/\s+/);
    if (parts.length < 2) return '❌ Usage: `subscribe <brand> monthly|annual|internal`';
    return await cmdSubscribe(parts[0], parts[1]);
  }

  if (lower.startsWith('extend ')) {
    const brand = t.slice(7).trim();
    if (!brand) return '❌ Usage: `extend <brand>`';
    return await cmdExtend(brand);
  }

  if (lower.startsWith('pause ')) {
    const brand = t.slice(6).trim();
    if (!brand) return '❌ Usage: `pause <brand>`';
    return await cmdPause(brand);
  }
  if (lower.startsWith('unpause ')) {
    const brand = t.slice(8).trim();
    if (!brand) return '❌ Usage: `unpause <brand>`';
    return await cmdUnpause(brand);
  }

  if (lower.startsWith('topup status ')) {
    const brand = t.slice(13).trim();
    if (!brand) return '❌ Usage: `topup status <brand>`';
    return await cmdTopupStatus(brand);
  }

  // DANGEROUS — show preview, set pending, wait for `confirm`
  if (lower.startsWith('reset usage ')) {
    const brand = t.slice(12).trim();
    if (!brand) return '❌ Usage: `reset usage <brand>`';
    const tenant = await resolveBrand(brand);
    if (!tenant) return `❌ No brand found matching "${brand}".`;
    const name = brandName(tenant);
    setPendingConfirm(from, 'reset', brand);
    return [
      `⚠ *Confirm reset usage for ${name}?*`,
      '',
      'This will:',
      '• Set this month\'s conversation_count to 0',
      '• Clear alerts_sent flags',
      '• Reset overage_count to 0',
      '• Clear today\'s daily dedup',
      '',
      'Reply *confirm* within 5 minutes, or *no* to abort.'
    ].join('\n');
  }

  if (lower.startsWith('cancel ')) {
    const brand = t.slice(7).trim();
    if (!brand) return '❌ Usage: `cancel <brand>`';
    const tenant = await resolveBrand(brand);
    if (!tenant) return `❌ No brand found matching "${brand}".`;
    const name = brandName(tenant);
    setPendingConfirm(from, 'cancel', brand);
    return [
      `⚠ *Confirm cancel subscription for ${name}?*`,
      '',
      'This will mark the subscription cancelled (effective end of billing period).',
      'Bot stays active until then.',
      '',
      'Reply *confirm* within 5 minutes, or *no* to abort.'
    ].join('\n');
  }

  if (lower.startsWith('kill ')) {
    const brand = t.slice(5).trim();
    if (!brand) return '❌ Usage: `kill <brand>`';
    const tenant = await resolveBrand(brand);
    if (!tenant) return `❌ No brand found matching "${brand}".`;
    const name = brandName(tenant);
    setPendingConfirm(from, 'kill', brand);
    return [
      `💀 *Confirm KILL ${name}?*`,
      '',
      'This is panic mode. It will:',
      '• Pause the bot immediately',
      '• Cancel the subscription',
      '',
      'Reply *confirm* within 5 minutes, or *no* to abort.'
    ].join('\n');
  }

  return '❓ Unknown command. Send `help` for the list.';
}

// ─── PUBLIC ENTRY POINT ────────────────────────────────────────────────────
async function handleFounderCommand({ from, text, phoneNumberId, waToken, sendMessage }) {
  let reply;
  try {
    reply = await dispatch(from, text);
  } catch (err) {
    console.error('[founder] command error:', err);
    reply = `❌ Command failed: ${err.message}`;
  }

  try {
    await sendMessage(from, reply, waToken, phoneNumberId);
    console.log(`[founder] command "${text}" → reply sent (${reply.length} chars)`);
  } catch (err) {
    console.error('[founder] send error:', err);
  }
}

module.exports = {
  isFounderCommand,
  handleFounderCommand,
  _internal: {
    normalizePhone,
    isFounderPhone,
    resolveBrand,
    dispatch,
    pendingConfirmations
  }
};
