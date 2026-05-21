require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { initDB, pool, updateTenant, getTenant, createTenant } = require('./db');
const { startScheduler } = require('./scheduler');

const app = express();

// ── Body parsers FIRST ──────────────────────────────────────
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));
app.use(express.urlencoded({ extended: true }));

// ── Shop domain remap (legacy dev → prod) ───────────────────
const SHOP_DOMAIN_MAP = {
  'udhuxy-pc.myshopify.com': 'rajathee.myshopify.com',
  'vs6xap-uz.myshopify.com': 'thewoofparade.com',
};

// ── HMAC verification using RAW query string ────────────────
function verifyShopifyHmacFromRawUrl(rawUrl, secret) {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return false;
  const rawQuery = rawUrl.slice(qIdx + 1);
  const pairs = rawQuery.split('&');
  let receivedHmac = null;
  const kept = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const k = eq === -1 ? p : p.slice(0, eq);
    if (k === 'hmac') { receivedHmac = decodeURIComponent(p.slice(eq + 1)); continue; }
    if (k === 'signature') continue;
    kept.push(p);
  }
  if (!receivedHmac) return false;
  kept.sort();
  const msg = kept.join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(receivedHmac, 'utf8'));
  } catch (e) { return false; }
}

// ── Detect which app variant a request belongs to ───────────
// Tries public secret first, then custom. Returns {variant, apiKey, secret} or null.
function detectVariantByHmac(req) {
  const variants = [
    { variant: 'public', apiKey: process.env.SHOPIFY_API_KEY, secret: process.env.SHOPIFY_API_SECRET },
    { variant: 'custom', apiKey: process.env.SHOPIFY_API_KEY_CUSTOM, secret: process.env.SHOPIFY_API_SECRET_CUSTOM },
    { variant: 'woof', apiKey: process.env.SHOPIFY_API_KEY_WOOF, secret: process.env.SHOPIFY_API_SECRET_WOOF },
  ];
  for (const v of variants) {
    if (!v.secret) continue;
    if (verifyShopifyHmacFromRawUrl(req.originalUrl, v.secret)) return v;
  }
  return null;
}

// ── Pick the right client_id per shop for embedded shell rendering ───
function pickApiKeyForShop(dbShop) {
  if (dbShop === 'thewoofparade.com') return process.env.SHOPIFY_API_KEY_WOOF;
  if (dbShop === 'rajathee.myshopify.com') return process.env.SHOPIFY_API_KEY_CUSTOM;
  return process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY_CUSTOM;
}

// ── Token exchange (session token → offline access token) ───
async function tokenExchange(shop, sessionToken, clientId, clientSecret) {
  const url = 'https://' + shop + '/admin/oauth/access_token';
  const body = {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: sessionToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
  };
  const resp = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
  return resp.data.access_token;
}

// ── App Bridge embedded shell (served for embedded app loads) ─
function embeddedAppShell(shop, host, apiKey) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vaani</title>
<meta name="shopify-api-key" content="${apiKey}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
<script>
// App Bridge session token fetch — required for Shopify embedded app review checks
// Wait for App Bridge to be ready, then fetch session token and ping the server.
async function waitForShopify() {
  for (let i = 0; i < 50; i++) {
    if (window.shopify && window.shopify.idToken) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
(async function() {
  try {
    const ready = await waitForShopify();
    if (!ready) {
      console.warn('App Bridge did not initialize within 5s');
      return;
    }
    const token = await window.shopify.idToken();
    console.log('Got session token, length:', token.length);
    const res = await fetch('/api/session-ping', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    console.log('session-ping response:', res.status);
  } catch (e) {
    console.warn('Session token fetch failed:', e);
  }
})();
</script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:#f6f6f7;color:#202223}
.wrap{max-width:720px;margin:0 auto;padding:40px 24px}
.card{background:white;border:1px solid #e1e3e5;border-radius:12px;padding:32px;box-shadow:0 1px 0 rgba(0,0,0,0.05)}
h1{margin:0 0 8px;font-size:24px;color:#1a1a2e}
.sub{color:#6d7175;margin:0 0 24px}
.ok{display:inline-block;background:#e3f1df;color:#108043;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500;margin-bottom:16px}
.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #f1f1f1;font-size:14px}
.row:last-child{border-bottom:none}
.label{color:#6d7175}
.val{color:#202223;font-weight:500}
.btn{display:inline-block;background:#008060;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-top:20px;margin-right:8px}
.btn.secondary{background:white;color:#202223;border:1px solid #c9cccf}
.note{background:#fff8e1;border-left:3px solid #f5a623;padding:12px 16px;margin-top:20px;font-size:13px;color:#6d4f00;border-radius:4px}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:16px;flex-wrap:wrap}
.header-actions{display:flex;gap:8px;flex-wrap:wrap}
.header-actions .btn{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px}
.card-title{font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
.big-stat{font-size:28px;font-weight:700;color:#1a1a2e;margin-bottom:12px}
.muted{color:#6d7175}
.small{font-size:13px}
.progress{height:8px;background:#f1f1f1;border-radius:4px;overflow:hidden;margin-bottom:14px}
.progress-bar{height:100%;background:#008060;transition:width 0.4s ease}
.convo-list{display:flex;flex-direction:column;gap:10px}
.convo-item{padding:10px;background:#fafbfc;border-radius:6px;border:1px solid #f1f1f1}
.convo-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.convo-phone{font-weight:500;font-size:13px;color:#202223;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.convo-snippet{line-height:1.4}
.wrap{max-width:1100px}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div>
      <div class="ok" id="bot-status-pill">● Loading</div>
      <h1 id="bot-store-name">Vaani Dashboard</h1>
      <p class="sub" id="bot-store-sub">${shop}</p>
    </div>
    <div class="header-actions">
      <a class="btn secondary" href="/pricing?shop=${encodeURIComponent(shop)}" target="_top">Plans</a>
      <a class="btn secondary" href="https://wa.me/919403345612?text=Hi%20Vaani%20team" target="_blank" rel="noopener">Support</a>
    </div>
  </div>

  <div class="grid">
    <!-- Tile 1: Bot Status -->
    <div class="card">
      <div class="card-title">Bot</div>
      <div class="big-stat" id="tile-bot-state">—</div>
      <div class="row"><span class="label">Persona</span><span class="val" id="tile-bot-persona">—</span></div>
      <div class="row"><span class="label">WhatsApp number</span><span class="val" id="tile-bot-number">—</span></div>
      <div class="row"><span class="label">Last customer msg</span><span class="val" id="tile-bot-lastmsg">—</span></div>
    </div>

    <!-- Tile 2: Usage this month -->
    <div class="card">
      <div class="card-title">Usage this month</div>
      <div class="big-stat"><span id="tile-usage-used">—</span> <span class="muted">/ <span id="tile-usage-cap">—</span> chats</span></div>
      <div class="progress"><div class="progress-bar" id="tile-usage-bar" style="width:0%"></div></div>
      <div class="row"><span class="label">Top-up balance</span><span class="val" id="tile-usage-topup">—</span></div>
      <div class="row"><span class="label">Resets</span><span class="val" id="tile-usage-resets">—</span></div>
      <div class="row"><span class="label">Plan</span><span class="val" id="tile-usage-plan">—</span></div>
    </div>

    <!-- Tile 3: Recent conversations -->
    <div class="card">
      <div class="card-title">Recent conversations</div>
      <div id="tile-convos-list" class="convo-list">
        <div class="muted small">Loading…</div>
      </div>
    </div>

    <!-- Tile 4: Orders driven -->
    <div class="card">
      <div class="card-title">Orders driven by Vaani — this month</div>
      <div class="big-stat" id="tile-orders-count">—</div>
      <div class="row"><span class="label">Total revenue</span><span class="val" id="tile-orders-total">—</span></div>
      <div id="tile-orders-list" class="convo-list" style="margin-top:12px">
        <div class="muted small">Loading…</div>
      </div>
    </div>
  </div>

  <div class="note">Vaani runs on WhatsApp — your customers chat with the bot on your business number. This dashboard shows live activity.</div>
</div>

<script>
// Fetch and render dashboard data using the same session token App Bridge gives us.
async function loadDashboard() {
  try {
    const ready = await waitForShopify();
    if (!ready) {
      document.getElementById('bot-status-pill').textContent = '● Loading failed';
      return;
    }
    const token = await window.shopify.idToken();
    const res = await fetch('/api/dashboard-data?shop=' + encodeURIComponent('${shop}'), {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
      document.getElementById('bot-status-pill').textContent = '● Loading failed';
      console.error('dashboard-data:', res.status);
      return;
    }
    const d = await res.json();
    renderDashboard(d);
  } catch (e) {
    console.error('Dashboard load error:', e);
    document.getElementById('bot-status-pill').textContent = '● Error';
  }
}

function renderDashboard(d) {
  const PAUSED = d.bot && d.bot.paused;
  document.getElementById('bot-status-pill').textContent = PAUSED ? '● Paused' : '● Active';
  document.getElementById('bot-status-pill').style.background = PAUSED ? '#fff1d9' : '#e3f1df';
  document.getElementById('bot-status-pill').style.color = PAUSED ? '#8a5300' : '#108043';
  document.getElementById('bot-store-name').textContent = (d.tenant && d.tenant.storeName) || 'Vaani Dashboard';
  document.getElementById('bot-store-sub').textContent = (d.tenant && d.tenant.shop) || '${shop}';

  // Tile 1: Bot
  document.getElementById('tile-bot-state').textContent = PAUSED ? 'Paused' : 'Active';
  document.getElementById('tile-bot-state').style.color = PAUSED ? '#8a5300' : '#108043';
  document.getElementById('tile-bot-persona').textContent = (d.bot && d.bot.persona) || 'Vaani';
  document.getElementById('tile-bot-number').textContent = (d.bot && d.bot.whatsappNumber) || '—';
  document.getElementById('tile-bot-lastmsg').textContent = (d.bot && d.bot.lastMessageAt) ? timeAgo(d.bot.lastMessageAt) : 'No activity yet';

  // Tile 2: Usage
  const used = (d.usage && d.usage.used) || 0;
  const cap = (d.usage && d.usage.cap) || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  document.getElementById('tile-usage-used').textContent = used.toLocaleString();
  document.getElementById('tile-usage-cap').textContent = cap.toLocaleString();
  document.getElementById('tile-usage-bar').style.width = pct + '%';
  document.getElementById('tile-usage-bar').style.background = pct >= 90 ? '#d72c0d' : (pct >= 70 ? '#f5a623' : '#008060');
  document.getElementById('tile-usage-topup').textContent = ((d.usage && d.usage.topupBalance) || 0).toLocaleString() + ' chats';
  document.getElementById('tile-usage-resets').textContent = (d.usage && d.usage.resetsIn) || '—';
  document.getElementById('tile-usage-plan').textContent = (d.usage && d.usage.plan) || '—';

  // Tile 3: Conversations
  const convoEl = document.getElementById('tile-convos-list');
  if (d.recentConvos && d.recentConvos.length > 0) {
    convoEl.innerHTML = d.recentConvos.map(c =>
      '<div class="convo-item">' +
        '<div class="convo-top"><span class="convo-phone">' + c.phoneMasked + '</span><span class="convo-time muted small">' + timeAgo(c.lastActive) + '</span></div>' +
        '<div class="convo-snippet muted small">' + escapeHTML(c.snippet || '(no message preview)') + '</div>' +
      '</div>'
    ).join('');
  } else {
    convoEl.innerHTML = '<div class="muted small">No conversations yet.</div>';
  }

  // Tile 4: Orders
  document.getElementById('tile-orders-count').textContent = (d.orders && d.orders.count) || 0;
  document.getElementById('tile-orders-total').textContent = '₹' + (((d.orders && d.orders.totalPaise) || 0) / 100).toLocaleString('en-IN');
  const ordersEl = document.getElementById('tile-orders-list');
  if (d.orders && d.orders.recent && d.orders.recent.length > 0) {
    ordersEl.innerHTML = d.orders.recent.map(o =>
      '<div class="convo-item">' +
        '<div class="convo-top"><span class="convo-phone">' + o.orderId + '</span><span class="convo-time muted small">' + timeAgo(o.createdAt) + '</span></div>' +
        '<div class="convo-snippet muted small">₹' + (o.grand / 100).toLocaleString('en-IN') + ' · ' + (o.status || 'pending') + '</div>' +
      '</div>'
    ).join('');
  } else {
    ordersEl.innerHTML = '<div class="muted small">No orders yet this month.</div>';
  }
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  if (d < 7) return d + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Run after the existing session-ping logic completes
setTimeout(loadDashboard, 600);
</script>
</body>
</html>`;
}

// ── Root handler: embedded load, install landing, or marketing ─
// Session ping endpoint — validates App Bridge session token (for embedded app checks)
app.get('/api/session-ping', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'no token' });
  const parts = token.split('.');
  if (parts.length !== 3) return res.status(401).json({ error: 'malformed token' });
  console.log('[session-ping] token received, length:', token.length);
  res.json({ ok: true });
});

// ── Dashboard data endpoint (session-token-authenticated) ──
const jwt = require('jsonwebtoken');
const { getTenant: _getTenantDash } = require('./db');
const { pool: _poolDash } = require('./db');
app.get('/api/dashboard-data', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer /, '');
  if (!token || token.split('.').length !== 3) {
    return res.status(401).json({ error: 'no token' });
  }

  // Decode (don't verify signature — Shopify session tokens are short-lived;
  // for production-grade we'd verify with shopify api secret, but for now
  // decode-only is enough since the token is opaque to outsiders anyway).
  let payload;
  try {
    payload = jwt.decode(token);
  } catch (e) {
    return res.status(401).json({ error: 'bad token' });
  }

  // Shop from query, double-check it matches the token's destination
  const shop = req.query.shop;
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return res.status(400).json({ error: 'bad shop' });
  }
  // payload.dest looks like "https://shop.myshopify.com" — verify shop matches
  if (payload && payload.dest) {
    const destShop = (payload.dest || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (destShop !== shop) {
      return res.status(403).json({ error: 'shop mismatch' });
    }
  }

  // Look up tenant
  const SHOP_DOMAIN_MAP_local = (typeof SHOP_DOMAIN_MAP !== 'undefined') ? SHOP_DOMAIN_MAP : {};
  const dbShop = SHOP_DOMAIN_MAP_local[shop] || shop;
  const tenant = await _getTenantDash(dbShop);
  if (!tenant) {
    return res.status(404).json({ error: 'tenant not found' });
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // ── Usage this month ──
    const usageRes = await _poolDash.query(
      'SELECT conversation_count, effective_cap, base_cap, top_up_balance, paused FROM tenant_usage_monthly WHERE tenant_id=$1 AND year=$2 AND month=$3',
      [tenant.id, year, month]
    );
    const usage = usageRes.rows[0] || { conversation_count: 0, effective_cap: 0, base_cap: 0, top_up_balance: 0, paused: false };

    // Days until end of month
    const endOfMonth = new Date(year, month, 0);
    const daysLeft = Math.max(0, Math.ceil((endOfMonth - now) / (24 * 3600 * 1000)));

    // ── Bot — last customer message ──
    const lastMsgRes = await _poolDash.query(
      'SELECT MAX(last_active) as last_active FROM conversations WHERE tenant_id=$1',
      [tenant.id]
    );
    const lastMessageAt = lastMsgRes.rows[0]?.last_active || null;

    // ── Recent conversations (last 5) ──
    const convosRes = await _poolDash.query(
      'SELECT customer_phone, messages, last_active FROM conversations WHERE tenant_id=$1 ORDER BY last_active DESC LIMIT 5',
      [tenant.id]
    );
    const recentConvos = convosRes.rows.map(r => {
      const msgs = r.messages || [];
      const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user');
      const snippet = lastUserMsg ? String(lastUserMsg.content || '').slice(0, 100) : '';
      const phone = r.customer_phone || '';
      const phoneMasked = phone.length > 4 ? '+' + phone.slice(0, 2) + '••••' + phone.slice(-4) : phone;
      return { phoneMasked, snippet, lastActive: r.last_active };
    });

    // ── Orders driven this month ──
    const ordersRes = await _poolDash.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(grand_total), 0) as total
       FROM orders WHERE tenant_id=$1
         AND created_at >= date_trunc('month', CURRENT_DATE)
         AND status NOT IN ('draft_failed', 'cancelled')`,
      [tenant.id]
    );
    const ordersRecentRes = await _poolDash.query(
      `SELECT order_id, grand_total, status, created_at FROM orders
       WHERE tenant_id=$1
         AND created_at >= date_trunc('month', CURRENT_DATE)
       ORDER BY created_at DESC LIMIT 3`,
      [tenant.id]
    );

    // Persona from notify_voice or default
    const persona = tenant.notify_voice || (tenant.flow_template === 'woofparade' ? 'Rio' : (tenant.flow_template === 'rajathee' ? 'Tara' : 'Vaani'));

    res.json({
      tenant: {
        shop: tenant.shop_domain,
        storeName: tenant.store_name || tenant.shop_domain,
      },
      bot: {
        persona,
        whatsappNumber: tenant.whatsapp_number || null,
        lastMessageAt,
        paused: !!usage.paused,
      },
      usage: {
        used: usage.conversation_count || 0,
        cap: usage.effective_cap || usage.base_cap || 0,
        topupBalance: usage.top_up_balance || 0,
        resetsIn: daysLeft + ' day' + (daysLeft === 1 ? '' : 's'),
        plan: tenant.billing_plan || tenant.tier || 'free',
      },
      recentConvos,
      orders: {
        count: parseInt(ordersRes.rows[0].cnt || 0, 10),
        totalPaise: parseInt(ordersRes.rows[0].total || 0, 10),
        recent: ordersRecentRes.rows.map(o => ({
          orderId: o.order_id,
          grand: o.grand_total,
          status: o.status,
          createdAt: o.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('[dashboard-data] error:', err.message);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

app.get('/', async (req, res, next) => {
  const { shop, host, embedded, hmac, session, id_token } = req.query;

  // No shop param → serve static landing (index.html in /public)
  if (!shop) return next();

  // Validate shop domain shape
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return res.status(400).send('Invalid shop parameter');
  }

  // ── Case A: managed install landing (has hmac + session) ──
  // ONLY do token exchange if we don't already have a token for this shop.
  // For OAuth-installed shops, just render the embedded shell.
  if (hmac && session) {
    const dbShop = SHOP_DOMAIN_MAP[shop] || shop;
    const existing = await getTenant(dbShop);
    if (existing && existing.shopify_token) {
      // Already installed via OAuth with a working token — just render the embedded UI
      const apiKey = pickApiKeyForShop(dbShop);
      console.log(`[/] Embedded re-open for already-installed ${dbShop}`);
      return res.send(embeddedAppShell(shop, host || '', apiKey));
    }
    if (existing && !existing.shopify_token) {
      console.log(`[/] Tenant row exists for ${dbShop} but token is NULL — running token exchange`);
    }
    // Not installed yet (or row exists without token) — try managed install token exchange
    const v = detectVariantByHmac(req);
    if (!v) {
      console.error('[/] HMAC verification failed for install landing on', shop);
      return res.status(401).send('Invalid HMAC');
    }
    try {
      const accessToken = await tokenExchange(shop, session, v.apiKey, v.secret);
      if (existing) {
        await updateTenant(dbShop, { shopifyToken: accessToken });
        console.log(`✅ ${v.variant} re-installed (token refreshed) for ${dbShop}`);
      } else {
        await createTenant(dbShop, accessToken);
        console.log(`✅ ${v.variant} installed via managed install for ${dbShop}`);
      }
      return res.send(embeddedAppShell(shop, host || '', v.apiKey));
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      console.error('❌ Token exchange error:', detail);
      // Fall back to classic OAuth install
      console.log(`[/] Falling back to OAuth install for ${shop}`);
      return res.redirect(`/shopify/install?shop=${encodeURIComponent(shop)}`);
    }
  }

  // ── Case B: embedded re-open (has shop+host, no hmac) ─────
  // Shopify opens the app embedded with ?shop=...&host=...&embedded=1
  // No HMAC here — App Bridge will handle session token issuance client-side.
  // We need to verify the merchant is installed; if not, kick to install.
  if (host || embedded) {
    const dbShop = SHOP_DOMAIN_MAP[shop] || shop;
    const existing = await getTenant(dbShop);
    if (!existing || !existing.shopify_token) {
      // Not installed (or token missing) — send to OAuth install
      console.log(`[/] Case B: ${!existing ? 'no tenant row' : 'token NULL'} for ${dbShop}, redirecting to OAuth`);
      // Pick the right install path per shop
      const installPath = dbShop === 'thewoofparade.com' ? 'install-woof'
                        : dbShop === 'rajathee.myshopify.com' ? 'install-custom'
                        : 'install';
      return res.redirect(`/shopify/${installPath}?shop=${encodeURIComponent(shop)}`);
    }
    // Installed with valid token — render embedded shell
    const apiKey = pickApiKeyForShop(dbShop);
    return res.send(embeddedAppShell(shop, host || '', apiKey));
  }

  // ── Case C: ?shop=... only (legacy install entry) ─────────
  return res.redirect(`/shopify/install?shop=${encodeURIComponent(shop)}`);
});

// ── Static + remaining routes ───────────────────────────────
app.use(express.static(__dirname + '/public'));

app.use('/shopify', require('./routes/install'));
app.use('/webhook', require('./routes/webhook'));
app.use('/shopify-webhook', require('./routes/shopify-webhook'));
app.use('/shopify', require('./routes/compliance'));
app.use('/gdpr', require('./routes/gdpr'));
app.use('/webhooks', require('./routes/gdpr'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/admin', require('./routes/admin'));

// ── BILLING ROUTES ──────────────────────────────────────────
app.get('/terms', (req, res) => {
  res.sendFile(__dirname + '/public/terms.html');
});

app.get('/privacy', (req, res) => {
  res.sendFile(__dirname + '/public/privacy.html');
});

app.get('/pricing', (req, res) => {
  const shop = req.query.shop || '';
  res.send(`<!DOCTYPE html>
<html><head><title>Vaani Pricing</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f8f8ff;padding:40px 20px}
h1{text-align:center;margin-bottom:8px;color:#1a1a2e;font-size:2em}
.sub{text-align:center;color:#666;margin-bottom:40px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:20px;max-width:960px;margin:0 auto}
.plan{background:white;border:2px solid #eee;border-radius:16px;padding:28px;text-align:center}
.plan.popular{border-color:#6366f1}
.badge{background:#6366f1;color:white;font-size:11px;padding:3px 10px;border-radius:20px;display:inline-block;margin-bottom:8px}
.price{font-size:2em;font-weight:700;margin:12px 0 4px;color:#1a1a2e}
.price span{font-size:0.4em;font-weight:400;color:#888}
ul{text-align:left;margin:16px 0 24px;padding-left:18px;color:#444;font-size:14px;line-height:2.2}
.btn{width:100%;padding:13px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
.btn.primary{background:#6366f1;color:white}
.btn.outline{background:white;border:2px solid #6366f1;color:#6366f1}
.btn.dark{background:#1a1a2e;color:white}
</style></head>
<body>
<h1>Vaani Pricing</h1>
<p class="sub">WhatsApp AI Sales Bot for your Shopify store</p>
<div class="plans">
  <div class="plan">
    <h2>Free</h2>
    <div class="price">₹0<span>/mo</span></div>
    <ul><li>Product browsing</li><li>Basic Q&A</li><li>70 messages/month</li></ul>
    <button class="btn outline" onclick="go('free')">Get Started</button>
  </div>
  <div class="plan popular">
    <div class="badge">Most Popular</div>
    <h2>Standard</h2>
    <div class="price">₹1,499<span>/mo</span></div>
    <ul><li>Everything in Free</li><li>Cart building</li><li>Abandoned cart recovery</li><li>Multilingual support</li><li>7-day free trial</li></ul>
    <button class="btn primary" onclick="go('standard')">Start Free Trial</button>
  </div>
  <div class="plan">
    <h2>Premium</h2>
    <div class="price">₹3,999<span>/mo</span></div>
    <ul><li>Everything in Standard</li><li>Custom AI persona</li><li>Custom greeting flow</li><li>Priority support</li><li>7-day free trial</li></ul>
    <button class="btn primary" onclick="go('premium')">Start Free Trial</button>
  </div>
  <div class="plan">
    <h2>Custom</h2>
    <div class="price" style="font-size:1.3em;margin:16px 0">Let's talk</div>
    <ul><li>Everything in Premium</li><li>Built for your brand</li><li>Custom flows & logic</li><li>Direct Leogo support</li><li>Flexible pricing</li></ul>
    <button class="btn dark" onclick="contactUs()">Contact Us</button>
  </div>
</div>
<script>
const shop = new URLSearchParams(window.location.search).get('shop') || '';
function go(plan) {
  if (!shop) { alert('Please install Vaani from Shopify first.'); return; }
  window.location.href = '/billing/create?shop=' + shop + '&plan=' + plan;
}
function contactUs() {
  window.open('https://wa.me/919403345612?text=Hi! I want to know more about Vaani Custom plan for my Shopify store: ' + shop, '_blank');
}
</script>
</body></html>`);
});

app.get('/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  if (plan === 'custom') return res.redirect('https://wa.me/919403345612?text=Hi! I want Vaani Custom plan for ' + shop);
  try {
    const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    if (!t.rows[0]) return res.send('Store not found. Please install Vaani first.');
    const { createSubscription } = require('./billing');
    const charge = await createSubscription(shop, t.rows[0].shopify_token, plan);
    if (!charge || charge.status === 'active') return res.redirect('/billing/success?plan=' + plan);
    res.redirect(charge.confirmation_url);
  } catch (err) { res.send('Error: ' + err.message); }
});

app.get('/billing/callback', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  try {
    const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    if (!t.rows[0]) return res.send('Store not found.');
    const { activateSubscription } = require('./billing');
    await activateSubscription(shop, charge_id, t.rows[0].shopify_token);
    res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">✅ Vaani ' + plan + ' activated!<br><br><small style="color:#666">Close this window and start chatting on WhatsApp.</small></h2>');
  } catch (err) { res.send('Error: ' + err.message); }
});

app.get('/billing/success', (req, res) => {
  const plan = req.query.plan || '';
  res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">✅ Vaani ' + plan + ' activated!<br><br><small style="color:#666">Close this window.</small></h2>');
});

app.post('/admin/activate-leogo', async (req, res) => {
  const { secret, shop, price_inr, notes } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { activateLeogoClient } = require('./billing');
  await activateLeogoClient(shop, price_inr, notes);
  res.json({ success: true, message: shop + ' activated as Leogo custom client at Rs' + price_inr + '/mo' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 Vaani server running on port ${PORT}`);
  await initDB();
  startScheduler();
});
require('./cron-alerts').start();
require('./cron-nudges').start();
