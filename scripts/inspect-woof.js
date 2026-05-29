#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * inspect-woof.js v3 — Vaani Woof Parade inspector
 *
 * v3 fixes the handle() contract:
 *   Real signature (from routes/webhook.js:289-318):
 *     const conv = await getConversation(tenant.id, from);
 *     const history = conv?.messages || [];
 *     const cart = conv?.cart || {};
 *     await woofparadeHandler.handle({
 *       tenant, message, from, text, phoneNumberId, waToken, history, cart
 *     });
 *
 *   v2 was passing nested {message:{from, text:{body}}} — handler destructures
 *   {from, text} from ctx directly. v3 passes flat ctx.
 *
 *   Also: phoneNumberId now read from tenant.whatsapp_number (legacy column
 *   that stores the phone_number_id), waToken from process.env.WHATSAPP_TOKEN.
 *
 * Three parts:
 *   1. STATIC HEALTH CHECK    — env vars, DB schema, Shopify/Meta pings, code drift
 *   2. BUTTON COVERAGE MATRIX — every button label, individually fired with proper ctx
 *   3. PERSONA SCENARIOS      — 4 full multi-step flows
 *
 * Real WhatsApp sends → FOUNDER_TEST_PHONE (+91 8805100535) with [PERSONA N] prefix,
 * 2-sec rate-limit. Real Shopify drafts in persona A, deleted after assert.
 * Test phones use prefix 91999000xxx.
 *
 * Output: /tmp/woof-inspection-YYYY-MM-DD-HHMM.md
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const TENANT_ID = 10;
const FOUNDER_TEST_PHONE = '918805100535';
const TEST_PHONE_PREFIX = '91999000';
const WA_RATE_LIMIT_MS = 120000;  // 2 min between each WA send (avoids Meta pair rate limit 131056)

const argv = process.argv.slice(2);
const FLAGS = {
  static:   argv.includes('--static')   || argv.includes('--all') || argv.length === 0,
  matrix:   argv.includes('--matrix')   || argv.includes('--all') || argv.length === 0,
  personas: argv.includes('--personas') || argv.includes('--all') || argv.length === 0,
  dry:      argv.includes('--dry'),
};

const REPO_ROOT = path.resolve(__dirname, '..');
process.chdir(REPO_ROOT);

const TS = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const REPORT_PATH = `/tmp/woof-inspection-${TS}.md`;
const reportLines = [];

function log(line) {
  console.log(line);
  reportLines.push(line);
}
function header(text) { log(''); log('## ' + text); log(''); }
function subheader(text) { log(''); log('### ' + text); log(''); }
const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ', skip: '⏭️ ' };

const counters = { ok: 0, warn: 0, fail: 0 };
function check(label, status, detail) {
  counters[status]++;
  const icon = ICON[status] || '';
  log(`- ${icon} **${label}** — ${detail || ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────────────────────────────────────
const DB_URL =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:hPUxuUBbuGhvfVYsqfKpnbWKAUTFypqx@shinkansen.proxy.rlwy.net:41185/railway';

const pool = new Pool({ connectionString: DB_URL });

async function dbq(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

let TENANT = null;
async function loadTenant() {
  const rows = await dbq('SELECT * FROM tenants WHERE id = $1', [TENANT_ID]);
  if (!rows.length) {
    log(`❌ FATAL: tenant ${TENANT_ID} not found`);
    process.exit(1);
  }
  TENANT = rows[0];
  return TENANT;
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp send stubs — capture + route real sends to FOUNDER_TEST_PHONE
// ─────────────────────────────────────────────────────────────────────────────
const captured = [];
let testTag = '[INSPECT]';
let lastSendAt = 0;

async function rateLimit() {
  const since = Date.now() - lastSendAt;
  if (since < WA_RATE_LIMIT_MS) await sleep(WA_RATE_LIMIT_MS - since);
  lastSendAt = Date.now();
}

function wrapMessage(originalText) { return `${testTag}\n${originalText}`; }

function installWhatsAppStubs() {
  let wa;
  try { wa = require('../whatsapp'); }
  catch (e) {
    log(`⚠️  Could not load ../whatsapp: ${e.message}`);
    return;
  }
  const realSend = wa.sendMessage;
  const realButtons = wa.sendButtons;
  const realList = wa.sendList;
  const realImage = wa.sendImage;

  wa.sendMessage = async (to, body, token, phoneNumberId) => {
    captured.push({ type: 'message', to, body });
    if (FLAGS.dry) return;
    await rateLimit();
    try { await realSend(FOUNDER_TEST_PHONE, wrapMessage(body), token, phoneNumberId); }
    catch (e) { console.warn('   [WA send failed]', e.message); }
  };
  wa.sendButtons = async (to, body, buttons, token, phoneNumberId) => {
    captured.push({ type: 'buttons', to, body, buttons });
    if (FLAGS.dry) return;
    await rateLimit();
    try { await realButtons(FOUNDER_TEST_PHONE, wrapMessage(body), buttons, token, phoneNumberId); }
    catch (e) { console.warn('   [WA buttons failed]', e.message); }
  };
  wa.sendList = async (to, body, sections, token, phoneNumberId, buttonText) => {
    captured.push({ type: 'list', to, body, sections, buttonText });
    if (FLAGS.dry) return;
    await rateLimit();
    try { await realList(FOUNDER_TEST_PHONE, wrapMessage(body), sections, token, phoneNumberId, buttonText); }
    catch (e) { console.warn('   [WA list failed]', e.message); }
  };
  wa.sendImage = async (to, imgUrl, caption, token, phoneNumberId) => {
    captured.push({ type: 'image', to, imgUrl, caption });
    if (FLAGS.dry) return;
    await rateLimit();
    try { await realImage(FOUNDER_TEST_PHONE, imgUrl, wrapMessage(caption || ''), token, phoneNumberId); }
    catch (e) { console.warn('   [WA image failed]', e.message); }
  };
}
function clearCapture() { captured.length = 0; }

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — STATIC HEALTH CHECK (unchanged from v2.1)
// ─────────────────────────────────────────────────────────────────────────────
async function runStaticChecks() {
  header('PART 1 — STATIC HEALTH CHECK');

  subheader('1.1  Environment variables');
  const ENV_GROUPS = [
    { label: 'ANTHROPIC_API_KEY', names: ['ANTHROPIC_API_KEY'] },
    { label: 'DB connection URL', names: ['DATABASE_URL', 'POSTGRES_URL'] },
    { label: 'FOUNDER_PHONE', names: ['FOUNDER_PHONE'] },
    { label: 'SHOPIFY_WEBHOOK_SECRET_WOOF', names: ['SHOPIFY_WEBHOOK_SECRET_WOOF'] },
    { label: 'Meta webhook verify token', names: ['WHATSAPP_VERIFY_TOKEN', 'META_VERIFY_TOKEN', 'META_WEBHOOK_VERIFY_TOKEN'] },
  ];
  for (const g of ENV_GROUPS) {
    const found = g.names.find(n => process.env[n]);
    if (found) check(`env ${g.label}`, 'ok', `set via ${found}`);
    else check(`env ${g.label}`, 'warn', `missing (checked: ${g.names.join(', ')})`);
  }
  const META_TOKEN = process.env.WHATSAPP_TOKEN || process.env.META_TOKEN_VAANI || process.env.META_ACCESS_TOKEN;
  if (META_TOKEN) check('Meta access token (env)', 'ok', `found via ${
    process.env.WHATSAPP_TOKEN ? 'WHATSAPP_TOKEN' :
    process.env.META_TOKEN_VAANI ? 'META_TOKEN_VAANI' : 'META_ACCESS_TOKEN'}`);
  else check('Meta access token (env)', 'fail', 'none of WHATSAPP_TOKEN / META_TOKEN_VAANI / META_ACCESS_TOKEN set');

  subheader('1.2  Database tables');
  const REQUIRED_TABLES = [
    'tenants', 'conversations', 'orders', 'pup_profiles', 'scheduled_nudges',
    'notify_requests', 'shopify_webhook_events',
    'tenant_usage_monthly', 'tenant_topups', 'tenant_subscriptions', 'tenant_daily_conversations',
    'dashboard_users', 'dashboard_user_tenants',
    'analytics', 'team_messages', 'tenant_settings',
  ];
  const existing = (await dbq(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).map((r) => r.table_name);
  for (const t of REQUIRED_TABLES) {
    if (existing.includes(t)) check(`table ${t}`, 'ok', 'exists');
    else check(`table ${t}`, 'fail', 'MISSING');
  }

  subheader('1.3  Tenant 10 (Woof Parade) row health');
  await loadTenant();
  const fields = [
    ['shop_domain', 'thewoofparade.com'],
    ['shopify_admin_domain', 'the-woof-parade-2.myshopify.com'],
    ['myshopify_canonical_domain', 'vs6xap-uz.myshopify.com'],
    ['shopify_token', null],
    ['whatsapp_number', '1104656069401620'], // legacy: phone_number_id
    ['flow_template', 'woofparade'],
    ['store_name', null],
  ];
  for (const [col, expected] of fields) {
    const val = TENANT[col];
    if (val === null || val === undefined || val === '') {
      check(`tenant.${col}`, 'fail', 'NULL');
    } else if (expected && val !== expected) {
      check(`tenant.${col}`, 'warn', `is "${val}" — expected "${expected}"`);
    } else {
      const display = col === 'shopify_token' ? String(val).slice(0, 12) + '…' : val;
      check(`tenant.${col}`, 'ok', String(display));
    }
  }
  const ta = TENANT.templates_approved || {};
  const sosApproved = ta.vaani_team_sos === 'approved';
  check('tenants.templates_approved.vaani_team_sos', sosApproved ? 'ok' : 'fail',
    sosApproved ? 'approved' : JSON.stringify(ta));
  check('tenants.template_namespace',
    TENANT.template_namespace && TENANT.template_namespace !== 'pending_namespace_fetch' ? 'ok' : 'fail',
    TENANT.template_namespace || 'NULL');

  subheader('1.4  Shopify Admin API reachability');
  try {
    const r = await axios.get(
      `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/shop.json`,
      { headers: { 'X-Shopify-Access-Token': TENANT.shopify_token }, timeout: 8000 }
    );
    check('Shopify /shop.json', 'ok', `${r.data.shop.name} (plan: ${r.data.shop.plan_name})`);
  } catch (e) {
    check('Shopify /shop.json', 'fail', e.response?.data?.errors || e.message);
  }
  try {
    const all = [];
    let url = `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/products.json?limit=250&fields=id,title,handle,status,published_at,options,variants`;
    while (url) {
      const r = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': TENANT.shopify_token }, timeout: 10000,
      });
      all.push(...(r.data.products || []));
      const link = r.headers.link || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    const active = all.filter(p => p.status === 'active' && p.published_at);
    const unlisted = all.filter(p => p.status !== 'active' || !p.published_at);
    check('Shopify total products', 'ok', `${all.length} (${active.length} customer-visible, ${unlisted.length} hidden by P52a)`);
    const multiVar = active.filter(p => {
      const avail = p.variants.filter(v => v.inventory_quantity > 0);
      const nonSize = avail.filter(v => !['XS','S','M','L','XL','2XL'].includes(String(v.option1||'').toUpperCase()));
      return nonSize.length >= 2;
    });
    check('Multi-variant products (P50 picker)', 'ok',
      `${multiVar.length}: ${multiVar.map(p => p.title).join(', ') || 'none'}`);
  } catch (e) {
    check('Shopify product scan', 'fail', e.message);
  }

  subheader('1.5  Meta WhatsApp Cloud API reachability');
  if (!META_TOKEN) {
    check('Meta WA ping', 'fail', 'no token available');
  } else {
    const PHONE_NUMBER_ID = TENANT.whatsapp_number || '1104656069401620';
    const WABA_ID = process.env.WOOF_WABA_ID || '1259998665902070';
    try {
      const r = await axios.get(
        `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${META_TOKEN}` }, timeout: 8000 }
      );
      check('Meta /phone_number_id', 'ok', `${r.data.verified_name} (${r.data.display_phone_number})`);
    } catch (e) {
      check('Meta /phone_number_id', 'fail', e.response?.data?.error?.message || e.message);
    }
    try {
      const r = await axios.get(
        `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates?fields=name,status,language&limit=50`,
        { headers: { Authorization: `Bearer ${META_TOKEN}` }, timeout: 8000 }
      );
      const approved = (r.data.data || []).filter(t => t.status === 'APPROVED');
      const sos = approved.find(t => t.name === 'vaani_team_sos');
      check('Meta templates approved', 'ok', `${approved.length} total`);
      check('Template vaani_team_sos', sos ? 'ok' : 'fail',
        sos ? 'APPROVED' : 'NOT FOUND or NOT APPROVED');
    } catch (e) {
      check('Meta templates', 'fail', e.response?.data?.error?.message || e.message);
    }
  }

  subheader('1.6  Code drift markers');
  const PATCHES = [
    ['routes/shopify-webhook.js', 'PATCH 47 (3-domain match)', 'myshopify_canonical_domain'],
    ['handlers/woofparade.js',    'PATCH 48',                  'Patch 48: detect question-like replies'],
    ['handlers/woofparade.js',    'PATCH 49 (FAQ refund)',     'isPolicyQuery'],
    ['handlers/woofparade.js',    'PATCH 50 (variant picker)', 'awaitingVariantPick'],
    ['handlers/woofparade.js',    'PATCH 51 (dedup)',          'rawChoices'],
    ['shopify.js',                'PATCH 52a (isCustomerVisible)', 'isCustomerVisible'],
  ];
  for (const [file, name, marker] of PATCHES) {
    const fp = path.join(REPO_ROOT, file);
    if (!fs.existsSync(fp)) { check(`${name}`, 'fail', `${file} missing`); continue; }
    const src = fs.readFileSync(fp, 'utf8');
    if (src.includes(marker)) check(`${name}`, 'ok', `marker present in ${file}`);
    else check(`${name}`, 'fail', `"${marker}" not found in ${file}`);
  }

  subheader('1.7  Recent webhook events (last 24h)');
  try {
    const totalEv = await dbq(
      `SELECT COUNT(*)::int AS n FROM shopify_webhook_events
       WHERE received_at > NOW() - INTERVAL '24 hours' AND shop_domain IN ($1, $2, $3)`,
      [TENANT.shop_domain, TENANT.shopify_admin_domain, TENANT.myshopify_canonical_domain]
    );
    const unproc = await dbq(
      `SELECT COUNT(*)::int AS n FROM shopify_webhook_events
       WHERE received_at > NOW() - INTERVAL '24 hours' AND processed = false
       AND shop_domain IN ($1, $2, $3)`,
      [TENANT.shop_domain, TENANT.shopify_admin_domain, TENANT.myshopify_canonical_domain]
    );
    check('Total webhook events 24h', 'ok', String(totalEv[0].n));
    if (unproc[0].n === 0) check('Unprocessed webhook events 24h', 'ok', '0');
    else check('Unprocessed webhook events 24h', 'warn', `${unproc[0].n} stuck`);
  } catch (e) {
    check('Webhook events scan', 'warn', e.message);
  }

  subheader('1.8  Pending / overdue nudges');
  try {
    const nudges = await dbq(
      `SELECT kind, COUNT(*)::int AS n FROM scheduled_nudges
       WHERE tenant_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL AND fire_at < NOW()
       GROUP BY kind ORDER BY kind`,
      [TENANT_ID]
    );
    if (!nudges.length) check('Overdue nudges', 'ok', 'none');
    else for (const n of nudges) check(`Overdue: ${n.kind}`, 'warn', `${n.n} pending`);
    const pending = await dbq(
      `SELECT kind, COUNT(*)::int AS n FROM scheduled_nudges
       WHERE tenant_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
       GROUP BY kind ORDER BY kind`,
      [TENANT_ID]
    );
    if (!pending.length) check('Pending nudges (any)', 'ok', 'none');
    else for (const n of pending) check(`Pending: ${n.kind}`, 'ok', `${n.n} scheduled`);
  } catch (e) {
    check('Nudges scan', 'warn', e.message);
  }

  subheader('1.9  Abandoned drafts');
  try {
    const aban = await dbq(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE tenant_id = $1 AND status = 'awaiting_payment' AND created_at < NOW() - INTERVAL '24 hours'`,
      [TENANT_ID]
    );
    const n = aban[0].n;
    if (n === 0) check('Abandoned drafts > 24h', 'ok', '0');
    else check('Abandoned drafts > 24h', 'warn', `${n} awaiting_payment`);
  } catch (e) {
    check('Abandoned drafts scan', 'warn', e.message);
  }

  subheader('1.10  Usage & subscription snapshot');
  try {
    const sub = await dbq(
      `SELECT plan_type, status, started_at, next_billing_date, credit_balance
       FROM tenant_subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [TENANT_ID]
    );
    if (sub.length) {
      const s = sub[0];
      check('Subscription row', 'ok',
        `plan=${s.plan_type} status=${s.status} next_billing=${s.next_billing_date || 'n/a'} credit=${s.credit_balance}`);
    } else {
      check('Subscription row', 'warn', 'none');
    }
    const now = new Date();
    const usage = await dbq(
      `SELECT year, month, conversation_count, base_cap, top_up_balance, effective_cap, paused, overage_count
       FROM tenant_usage_monthly
       WHERE tenant_id = $1 AND year = $2 AND month = $3`,
      [TENANT_ID, now.getUTCFullYear(), now.getUTCMonth() + 1]
    );
    if (usage.length) {
      const u = usage[0];
      const pct = u.effective_cap ? Math.round(100 * u.conversation_count / u.effective_cap) : 0;
      const status = u.paused ? '⏸ PAUSED' : (pct >= 100 ? '🔴' : pct >= 90 ? '🟡' : '🟢');
      check('Current-month usage', 'ok',
        `${u.year}-${String(u.month).padStart(2,'0')}: ${u.conversation_count}/${u.effective_cap} (${pct}%) ${status}` +
        (u.overage_count ? ` overage=${u.overage_count}` : ''));
    } else {
      check('Current-month usage', 'warn',
        `no row for ${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`);
    }
  } catch (e) {
    check('Usage scan', 'warn', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a proper ctx matching routes/webhook.js exactly
// ─────────────────────────────────────────────────────────────────────────────
function buildMessage(from, text) {
  return {
    from,
    id: `wamid.test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: text },
  };
}

async function buildCtx(from, text) {
  // Mirror routes/webhook.js exactly
  let conv = null;
  try {
    const { getConversation } = require('../db');
    conv = await getConversation(TENANT_ID, from);
  } catch (e) {
    log(`   _getConversation failed: ${e.message}_`);
  }
  const history = conv?.messages || [];
  const cart = conv?.cart || {};
  return {
    tenant: TENANT,
    message: buildMessage(from, text),
    from,
    text,
    phoneNumberId: TENANT.whatsapp_number || '1104656069401620',
    waToken: process.env.WHATSAPP_TOKEN || process.env.META_TOKEN_VAANI || '',
    history,
    cart,
  };
}

async function send(phone, text) {
  const woofparade = require('../handlers/woofparade');
  const ctx = await buildCtx(phone, text);
  clearCapture();
  await woofparade.handle(ctx);
  return [...captured];
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — BUTTON COVERAGE MATRIX
// ─────────────────────────────────────────────────────────────────────────────
async function runButtonMatrix() {
  header('PART 2 — BUTTON COVERAGE MATRIX');

  const src = fs.readFileSync(path.join(REPO_ROOT, 'handlers/woofparade.js'), 'utf8');

  function extractConstants(prefix) {
    const re = new RegExp(`const\\s+${prefix}\\s*=\\s*\\{([^}]*)\\}`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(src))) {
      const body = m[1];
      const kvRe = /\w+:\s*['"`]([^'"`]+)['"`]/g;
      let kv;
      while ((kv = kvRe.exec(body))) out.push({ src: prefix, label: kv[1] });
    }
    return out;
  }

  const constants = [
    ...extractConstants('PRODUCT_BTN'),
    ...extractConstants('PICKED_BTN'),
    ...extractConstants('SIZE_BTN'),
    ...extractConstants('POSTPURCHASE_BTN'),
    ...extractConstants('ORDER_OPS_BTN'),
    ...extractConstants('WELCOME_ROW'),
    ...extractConstants('CHECKOUT_BTN'),
  ];

  const literals = [
    'Add to cart', 'XS', 'S', 'M', 'L', 'XL', '2XL',
    'Confirm order', 'Edit address', 'Cancel checkout',
    'Yes, talk to a human', "No, you're fine 🧡",
    'Show more', 'Show 3 more', 'Back to menu',
    'In 2 hours', 'Tomorrow morning', 'Pick a time',
    'Our accessories',
  ];

  const allButtons = [
    ...constants,
    ...literals.map(l => ({ src: 'literal', label: l })),
  ];
  const dedup = Array.from(new Map(allButtons.map(b => [b.label, b])).values());

  log(`_Discovered ${dedup.length} distinct button labels to test._`);
  log('');

  const phone = `${TEST_PHONE_PREFIX}999`;
  testTag = '[MATRIX]';

  // Seed a sample product to give product/size/cart buttons context
  let sampleProduct = null;
  try {
    const r = await axios.get(
      `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/products.json?limit=1&status=active&fields=id,title,handle,variants,price`,
      { headers: { 'X-Shopify-Access-Token': TENANT.shopify_token } }
    );
    sampleProduct = r.data.products?.[0];
  } catch (_) {}

  // Seed via upsertConversation so the bot's own getConversation returns the
  // shape it expects.
  async function seedConv() {
    const { upsertConversation } = require('../db');
    const cart = {
      woofparade: {
        product: sampleProduct ? {
          handle: sampleProduct.handle,
          title: sampleProduct.title,
          price: parseFloat(sampleProduct.variants?.[0]?.price || 0),
        } : null,
        items: [],
        checkout: {
          name: 'Test User',
          addressLine: '123 Test St',
          city: 'Pune',
          state: 'Maharashtra',
          pin: '411001',
        },
        categoryRowId: 'cat_accessories',
      }
    };
    try {
      await upsertConversation(TENANT_ID, phone, [], cart);
    } catch (e) {
      // Fall back to raw INSERT if upsertConversation has a different signature
      await dbq(
        `INSERT INTO conversations (tenant_id, customer_phone, messages, cart, last_active)
         VALUES ($1, $2, '[]'::jsonb, $3::jsonb, NOW())
         ON CONFLICT (tenant_id, customer_phone) DO UPDATE
           SET messages = '[]'::jsonb, cart = EXCLUDED.cart, last_active = NOW()`,
        [TENANT_ID, phone, JSON.stringify(cart)]
      );
    }
  }

  let pass = 0, warn = 0, fail = 0;
  for (let i = 0; i < dedup.length; i++) {
    const b = dedup[i];
    try {
      await seedConv();
      const out = await send(phone, b.label);

      if (out.length === 0) {
        check(`${b.label} (${b.src})`, 'warn', 'no outbound (handler may be silent or label dead)');
        warn++;
      } else {
        const types = out.map(c => c.type).join('+');
        check(`${b.label} (${b.src})`, 'ok', `${out.length} sends (${types})`);
        pass++;
      }
    } catch (e) {
      check(`${b.label} (${b.src})`, 'fail', `THREW: ${e.message}`);
      fail++;
    }
  }

  log('');
  log(`**Matrix totals:** ✅ ${pass}  ⚠️ ${warn}  ❌ ${fail}`);

  await dbq(
    `DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone LIKE $2`,
    [TENANT_ID, `${TEST_PHONE_PREFIX}%`]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — PERSONA SCENARIOS
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupPhone(phone) {
  await dbq('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [TENANT_ID, phone]);
  await dbq('DELETE FROM orders WHERE tenant_id = $1 AND customer_phone = $2', [TENANT_ID, phone]);
  await dbq('DELETE FROM pup_profiles WHERE tenant_id = $1 AND customer_phone = $2', [TENANT_ID, phone]);
  await dbq('DELETE FROM scheduled_nudges WHERE tenant_id = $1 AND customer_phone = $2', [TENANT_ID, phone]);
  await dbq('DELETE FROM notify_requests WHERE tenant_id = $1 AND customer_phone = $2', [TENANT_ID, phone]);
}

async function ensureEmptyConv(phone) {
  await dbq(
    `INSERT INTO conversations (tenant_id, customer_phone, messages, cart, last_active)
     VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, NOW())
     ON CONFLICT (tenant_id, customer_phone) DO NOTHING`,
    [TENANT_ID, phone]
  );
}

async function cleanupTestDrafts() {
  try {
    const r = await axios.get(
      `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/draft_orders.json?status=open&limit=50`,
      { headers: { 'X-Shopify-Access-Token': TENANT.shopify_token } }
    );
    const drafts = (r.data.draft_orders || []).filter(d =>
      (d.note || '').includes('vaani_inspection_test') ||
      (d.tags || '').includes('vaani_inspection_test')
    );
    for (const d of drafts) {
      try {
        await axios.delete(
          `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/draft_orders/${d.id}.json`,
          { headers: { 'X-Shopify-Access-Token': TENANT.shopify_token } }
        );
        log(`   _Cleaned up leftover test draft ${d.id}_`);
      } catch (_) {}
    }
  } catch (_) {}
}

async function personaNewCustomer() {
  subheader('Persona A — New customer (browse → variant pick → checkout → draft)');
  const phone = `${TEST_PHONE_PREFIX}001`;
  testTag = '[PERSONA A — new customer]';

  await cleanupPhone(phone);
  await ensureEmptyConv(phone);

  let out = await send(phone, 'Hi');
  if (out.some(c => /Welcome|Hey there|showstopper|woof|Hey friend|Hi there/i.test(c.body || ''))) {
    check('Turn 1 "Hi" → welcome', 'ok', `${out.length} sends`);
  } else {
    check('Turn 1 "Hi" → welcome', 'fail', `unexpected: ${JSON.stringify(out.slice(0,1))}`);
  }

  out = await send(phone, 'Accessories');
  if (out.some(c => c.type === 'image' || c.type === 'list' || /our top|accessor|here are/i.test(c.body || ''))) {
    check('Turn 2 "Accessories" → product list', 'ok', `${out.length} sends`);
  } else {
    check('Turn 2 "Accessories" → product list', 'warn', `unexpected types: ${out.map(c=>c.type).join(',')}`);
  }

  out = await send(phone, '1');
  const sawDetail = out.some(c => /Add to cart|Like it|Which size|tap to choose|Pick a/i.test(c.body || ''));
  if (sawDetail) check('Turn 3 "1" → product detail', 'ok', `${out.length} sends`);
  else check('Turn 3 "1" → product detail', 'warn', `unexpected: ${out.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  out = await send(phone, 'Add to cart');
  const sawAddOrPicker = out.some(c =>
    /Added.*shortlist|Pick a|Which one for your pup|added to cart|in your shortlist/i.test(c.body || '')
  );
  if (sawAddOrPicker) check('Turn 4 "Add to cart"', 'ok', `${out.length} sends`);
  else check('Turn 4 "Add to cart"', 'fail', `unexpected: ${out.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  out = await send(phone, 'Checkout');
  const sawCheckout = out.some(c => /name|address|pincode|details|share/i.test(c.body || ''));
  if (sawCheckout) check('Turn 5 "Checkout" → asks for details', 'ok', `${out.length} sends`);
  else check('Turn 5 "Checkout" → asks for details', 'warn', `unexpected: ${out.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  out = await send(phone,
    'Test Inspector\n123 Inspection Lane, Test Society\nPune\nMaharashtra\n411001');
  const sawConfirm = out.some(c => /Confirm/i.test(c.body || '') || (c.buttons || []).some(b => /Confirm/i.test(b)));
  if (sawConfirm) check('Turn 6 address → asks confirm', 'ok', `${out.length} sends`);
  else check('Turn 6 address → asks confirm', 'warn', `unexpected: ${out.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  out = await send(phone, 'Confirm order');
  const sawInvoice = out.some(c => /invoice|payment link|invoices\//i.test(c.body || ''));
  if (sawInvoice) check('Turn 7 "Confirm order" → invoice link', 'ok', `${out.length} sends`);
  else check('Turn 7 "Confirm order" → invoice link', 'warn', `unexpected: ${out.map(c=>c.body?.slice(0,50)).join(' | ')}`);

  const orders = await dbq(
    `SELECT order_id, status, shopify_draft_id FROM orders
     WHERE tenant_id = $1 AND customer_phone = $2 ORDER BY created_at DESC LIMIT 1`,
    [TENANT_ID, phone]
  );
  if (orders.length && orders[0].shopify_draft_id) {
    check('DB: order row + draft id', 'ok',
      `order ${orders[0].order_id} → draft ${orders[0].shopify_draft_id}`);
    if (!FLAGS.dry) {
      try {
        await axios.delete(
          `https://${TENANT.shopify_admin_domain}/admin/api/2024-10/draft_orders/${orders[0].shopify_draft_id}.json`,
          { headers: { 'X-Shopify-Access-Token': TENANT.shopify_token } }
        );
        check('Shopify draft cleanup', 'ok', `deleted ${orders[0].shopify_draft_id}`);
      } catch (e) {
        check('Shopify draft cleanup', 'warn',
          `could not delete ${orders[0].shopify_draft_id}: ${e.message}`);
      }
    }
  } else {
    check('DB: order row + draft id', 'fail',
      orders.length ? 'order created but no shopify_draft_id' : 'no order row');
  }

  const nudges = await dbq(
    `SELECT kind FROM scheduled_nudges WHERE tenant_id = $1 AND customer_phone = $2`,
    [TENANT_ID, phone]
  );
  if (nudges.some(n => /s15|unpaid|checkout/i.test(n.kind))) {
    check('S15 unpaid-checkout nudge scheduled', 'ok', nudges.map(n=>n.kind).join(', '));
  } else {
    check('S15 unpaid-checkout nudge scheduled', 'warn',
      `nudges found: ${nudges.map(n=>n.kind).join(', ') || 'none'}`);
  }

  await cleanupPhone(phone);
}

async function personaRepeatCustomer() {
  subheader('Persona B — Repeat customer (prior paid order + pup name)');
  const phone = `${TEST_PHONE_PREFIX}002`;
  testTag = '[PERSONA B — repeat customer]';

  await cleanupPhone(phone);
  await ensureEmptyConv(phone);

  await dbq(
    `INSERT INTO orders (order_id, tenant_id, customer_phone, items, checkout,
                         subtotal, shipping, grand_total, status, created_at, confirmed_at)
     VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb,
             599, 0, 599, 'paid', NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days')`,
    [`TEST-B-${Date.now()}`, TENANT_ID, phone]
  );
  try {
    await dbq(
      `INSERT INTO pup_profiles (tenant_id, customer_phone, pup_name)
       VALUES ($1, $2, 'Mochi')`,
      [TENANT_ID, phone]
    );
  } catch (e) {
    log(`   _pup_profiles seed skipped: ${e.message}_`);
  }

  const out = await send(phone, 'Hi');
  const sawReturning = out.some(c => /Welcome back|Mochi|how.*Mochi/i.test(c.body || ''));
  if (sawReturning) check('Returning welcome (Mochi)', 'ok', `${out.length} sends`);
  else check('Returning welcome (Mochi)', 'warn',
    `unexpected: ${out.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  const out2 = await send(phone, 'Order help');
  const sawHelp = out2.some(c =>
    /track|order|modify|address|change/i.test(c.body || '') ||
    (c.buttons||[]).some(b=>/Track|Modify|Address/i.test(b))
  );
  if (sawHelp) check('Order help → shows options', 'ok', `${out2.length} sends`);
  else check('Order help → shows options', 'warn',
    `unexpected: ${out2.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  await cleanupPhone(phone);
}

async function personaModifyOrder() {
  subheader('Persona C — Modify-order (paid 4h ago, change address)');
  const phone = `${TEST_PHONE_PREFIX}003`;
  testTag = '[PERSONA C — modify order]';

  await cleanupPhone(phone);
  await ensureEmptyConv(phone);

  await dbq(
    `INSERT INTO orders (order_id, tenant_id, customer_phone, items, checkout,
                         subtotal, shipping, grand_total, status, created_at, confirmed_at)
     VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb,
             1399, 0, 1399, 'paid', NOW() - INTERVAL '4 hours', NOW() - INTERVAL '4 hours')`,
    [`TEST-C-${Date.now()}`, TENANT_ID, phone]
  );

  await send(phone, 'Hi');
  const out1 = await send(phone, 'Order help');
  check('Order help on paid order', out1.length > 0 ? 'ok' : 'warn', `${out1.length} sends`);

  const out2 = await send(phone, 'Change address');
  const sawAddrAsk = out2.some(c => /address|new.*address|share/i.test(c.body || ''));
  if (sawAddrAsk) check('"Change address" → asks new address', 'ok', `${out2.length} sends`);
  else check('"Change address" → asks new address', 'warn',
    `unexpected: ${out2.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  const out3 = await send(phone,
    'New address: 456 Updated Blvd, Pune, Maharashtra, 411002');
  const sawHandoff = out3.some(c => /team|reach out|update.*shortly|Apurv/i.test(c.body || ''));
  if (sawHandoff) check('Address change → SOS to team', 'ok', `${out3.length} sends`);
  else check('Address change → SOS to team', 'warn',
    `unexpected: ${out3.map(c=>c.body?.slice(0,40)).join(' | ')}`);

  await cleanupPhone(phone);
}

async function personaComplaint() {
  subheader('Persona D — Complaint (damaged collar)');
  const phone = `${TEST_PHONE_PREFIX}004`;
  testTag = '[PERSONA D — complaint]';

  await cleanupPhone(phone);
  await ensureEmptyConv(phone);

  await dbq(
    `INSERT INTO orders (order_id, tenant_id, customer_phone, items, checkout,
                         subtotal, shipping, grand_total, status, created_at, confirmed_at)
     VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb,
             799, 0, 799, 'paid', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')`,
    [`TEST-D-${Date.now()}`, TENANT_ID, phone]
  );

  await send(phone, 'Hi');

  const out = await send(phone, 'The collar I received is damaged');
  const sawSorry = out.some(c => /so sorry|reach out|team|Apurv|Kashmira/i.test(c.body || ''));
  if (sawSorry) check('S18 complaint → sorry + handoff', 'ok', `${out.length} sends`);
  else check('S18 complaint → sorry + handoff', 'fail',
    `unexpected: ${out.map(c=>c.body?.slice(0,50)).join(' | ')}`);

  const looksLikeFaq = out.some(c => /policy|7-day|return.*exchange|policies\//i.test(c.body || ''));
  if (looksLikeFaq) check('No FAQ misfire on complaint (P49)', 'fail', 'FAQ answer fired — regression');
  else check('No FAQ misfire on complaint (P49)', 'ok', '');

  const out2 = await send(phone, "What's your refund policy");
  const sawPolicy = out2.some(c => /7-day|return.*exchange|policies\/refund|policies\//i.test(c.body || ''));
  if (sawPolicy) check('Policy query → FAQ answer (P49)', 'ok', '');
  else check('Policy query → FAQ answer (P49)', 'fail',
    `unexpected: ${out2.map(c=>c.body?.slice(0,50)).join(' | ')}`);

  await cleanupPhone(phone);
}

async function runPersonas() {
  header('PART 3 — PERSONA SCENARIOS');
  await cleanupTestDrafts();
  try { await personaNewCustomer(); }    catch (e) { check('Persona A', 'fail', `${e.message}\n${e.stack?.split('\n').slice(0,3).join('\n')}`); }
  try { await personaRepeatCustomer(); } catch (e) { check('Persona B', 'fail', e.message); }
  try { await personaModifyOrder(); }    catch (e) { check('Persona C', 'fail', e.message); }
  try { await personaComplaint(); }      catch (e) { check('Persona D', 'fail', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  log(`# Vaani Woof Parade — Inspection Report (v3)`);
  log(`_Generated: ${new Date().toISOString()}_`);
  log(`_Tenant: ${TENANT_ID}, real WA target: ${FOUNDER_TEST_PHONE}, dry-run: ${FLAGS.dry}_`);
  log('');
  log(`Flags active: ${Object.entries(FLAGS).filter(([k,v])=>v).map(([k])=>k).join(', ')}`);

  installWhatsAppStubs();
  await loadTenant();

  if (FLAGS.static)   await runStaticChecks();
  if (FLAGS.matrix)   await runButtonMatrix();
  if (FLAGS.personas) await runPersonas();

  log('');
  log('---');
  log(`## SUMMARY`);
  log(`- ✅ Pass: ${counters.ok}`);
  log(`- ⚠️ Warn: ${counters.warn}`);
  log(`- ❌ Fail: ${counters.fail}`);
  log('');
  log(`Report: \`${REPORT_PATH}\``);

  fs.writeFileSync(REPORT_PATH, reportLines.join('\n'));
  await pool.end();
  process.exit(counters.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  reportLines.push(`\n## FATAL ERROR\n\n\`\`\`\n${e.stack}\n\`\`\``);
  try { fs.writeFileSync(REPORT_PATH, reportLines.join('\n')); } catch (_) {}
  process.exit(2);
});
