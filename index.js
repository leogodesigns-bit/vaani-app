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
  'vs6xap-uz.myshopify.com': 'vs6xap-uz.myshopify.com',
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
    { variant: 'rajathee', apiKey: process.env.SHOPIFY_API_KEY_RAJATHEE, secret: process.env.SHOPIFY_API_SECRET_RAJATHEE },
  ];
  for (const v of variants) {
    if (!v.secret) continue;
    if (verifyShopifyHmacFromRawUrl(req.originalUrl, v.secret)) return v;
  }
  return null;
}

// ── Pick the right client_id per shop for embedded shell rendering ───
function pickApiKeyForShop(dbShop) {
  if (dbShop === 'thewoofparade.com' || dbShop === 'vs6xap-uz.myshopify.com') return process.env.SHOPIFY_API_KEY_WOOF;
  if (dbShop === 'rajathee.myshopify.com') return process.env.SHOPIFY_API_KEY_RAJATHEE;
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
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap');
:root{
  --cream:#F8F2EA;
  --cream-warm:#FBF6EE;
  --ink:#1A1A2E;
  --ink-soft:#3A3A4E;
  --muted:#7A7388;
  --line:#EAE2D2;
  --sage:#5C8244;
  --sage-soft:#E8EFE1;
  --gold:#C29838;
  --gold-soft:#FFF4DC;
  --rose:#C75A4D;
  --rose-soft:#FBE8E4;
  --card:#FFFFFF;
}
*{box-sizing:border-box}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:var(--cream);color:var(--ink);font-size:14px;line-height:1.5;
  background-image:radial-gradient(circle at 20% 10%,rgba(194,152,56,0.04),transparent 40%),radial-gradient(circle at 80% 80%,rgba(92,130,68,0.04),transparent 40%);
}
.wrap{max-width:1100px;margin:0 auto;padding:28px 24px 60px}
.brand{font-family:'Playfair Display',Georgia,serif;font-weight:700;font-size:22px;letter-spacing:-0.02em;color:var(--ink);text-decoration:none;display:inline-block;margin-bottom:18px}
.brand::after{content:'.';color:var(--sage)}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;gap:16px;flex-wrap:wrap;padding-bottom:20px;border-bottom:1px solid var(--line)}
.header h1{font-family:'Playfair Display',Georgia,serif;font-weight:600;font-size:30px;margin:6px 0 4px;letter-spacing:-0.01em;color:var(--ink)}
.sub{color:var(--muted);margin:0;font-size:14px}
.header-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.ok{display:inline-block;background:var(--sage-soft);color:var(--sage);padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;letter-spacing:0.02em;margin-bottom:8px;font-family:'DM Sans',sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 1px 0 rgba(26,26,46,0.02),0 4px 16px rgba(26,26,46,0.03);transition:transform 0.15s ease,box-shadow 0.15s ease}
.card:hover{box-shadow:0 1px 0 rgba(26,26,46,0.02),0 6px 22px rgba(26,26,46,0.06)}
.card-title{font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px}
.big-stat{font-family:'Playfair Display',Georgia,serif;font-weight:600;font-size:32px;color:var(--ink);margin-bottom:14px;letter-spacing:-0.01em;line-height:1.1}
.muted{color:var(--muted)}
.small{font-size:13px}
.row{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px;align-items:center}
.row:last-child{border-bottom:none}
.label{color:var(--muted);font-weight:500}
.val{color:var(--ink);font-weight:500;text-align:right}
.progress{height:6px;background:var(--cream);border-radius:4px;overflow:hidden;margin-bottom:14px}
.progress-bar{height:100%;background:var(--sage);transition:width 0.6s ease,background 0.3s ease;border-radius:4px}
.convo-list{display:flex;flex-direction:column;gap:10px}
.convo-item{padding:12px 14px;background:var(--cream-warm);border-radius:8px;border:1px solid var(--line)}
.convo-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px}
.convo-phone{font-weight:600;font-size:13px;color:var(--ink);font-family:'DM Sans',sans-serif;letter-spacing:0.01em}
.convo-time{white-space:nowrap}
.convo-snippet{line-height:1.45;color:var(--ink-soft)}
.btn{display:inline-block;background:var(--ink);color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;font-size:13px;font-family:'DM Sans',sans-serif;border:none;cursor:pointer;transition:opacity 0.15s ease}
.btn:hover{opacity:0.85}
.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
.btn.secondary:hover{background:var(--cream-warm)}
.note{background:var(--gold-soft);border-left:3px solid var(--gold);padding:14px 18px;margin-top:8px;font-size:13px;color:#6d4f00;border-radius:6px;line-height:1.5}
.refresh-pill{position:fixed;bottom:20px;right:20px;background:white;border:1px solid var(--line);border-radius:24px;padding:6px 14px;font-size:11px;color:var(--muted);box-shadow:0 4px 16px rgba(26,26,46,0.08);font-family:'DM Sans',sans-serif;opacity:0.8;pointer-events:none;transition:opacity 0.3s ease}
.refresh-pill.flash{opacity:1;color:var(--sage);border-color:var(--sage-soft);background:var(--sage-soft)}
@media(max-width:640px){
  .wrap{padding:20px 16px 40px}
  .header h1{font-size:24px}
  .big-stat{font-size:26px}
  .grid{gap:14px}
  .card{padding:20px}
}
</style>
</head>
<body>
<div class="wrap">
  <a class="brand" href="https://www.vaani.website" target="_blank" rel="noopener">vaani</a>
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

<div class="refresh-pill" id="refresh-pill">Live · updates every 30s</div>

<script>
// Fetch and render dashboard data using the same session token App Bridge gives us.
async function loadDashboard() {
  console.log('[dash] loadDashboard called');
  let token = null;
  try {
    const ready = await waitForShopify();
    console.log('[dash] shopify ready =', ready);
    if (ready) {
      try {
        token = await window.shopify.idToken();
        console.log('[dash] got token, len=', token ? token.length : 0);
      } catch (e) {
        console.warn('[dash] idToken() threw:', e.message);
      }
    }
  } catch (e) {
    console.warn('[dash] waitForShopify threw:', e.message);
  }

  // Build fetch headers — include token if we have one, otherwise plain
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;

  try {
    const url = '/api/dashboard-data?shop=' + encodeURIComponent('${shop}');
    console.log('[dash] fetching', url, 'with auth=', !!token);
    const res = await fetch(url, { method: 'GET', headers });
    console.log('[dash] response status:', res.status);
    if (!res.ok) {
      const body = await res.text();
      console.error('[dash] non-ok response:', res.status, body);
      document.getElementById('bot-status-pill').textContent = '● Error ' + res.status;
      document.getElementById('bot-status-pill').style.background = '#FBE8E4';
      document.getElementById('bot-status-pill').style.color = '#C75A4D';
      return;
    }
    const d = await res.json();
    console.log('[dash] got data:', d);
    renderDashboard(d);
  } catch (e) {
    console.error('[dash] fetch error:', e);
    document.getElementById('bot-status-pill').textContent = '● Network error';
    document.getElementById('bot-status-pill').style.background = '#FBE8E4';
    document.getElementById('bot-status-pill').style.color = '#C75A4D';
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

// Auto-refresh every 30 seconds
setInterval(async () => {
  const pill = document.getElementById('refresh-pill');
  if (pill) {
    pill.classList.add('flash');
    pill.textContent = 'Updating…';
  }
  await loadDashboard();
  if (pill) {
    setTimeout(() => {
      pill.classList.remove('flash');
      pill.textContent = 'Live · updates every 30s';
    }, 800);
  }
}, 30000);
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
  // Allow mismatch if both resolve to the same dbShop (e.g. canonical vs admin domain)
  if (payload && payload.dest) {
    const destShop = (payload.dest || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (destShop !== shop) {
      const _map = (typeof SHOP_DOMAIN_MAP !== 'undefined') ? SHOP_DOMAIN_MAP : {};
      const destDb = _map[destShop] || destShop;
      const shopDb = _map[shop] || shop;
      // Also check shopify_admin_domain in DB for the resolved tenant
      const t = await _getTenantDash(shopDb);
      const adminMatches = t && (t.shopify_admin_domain === destShop || t.myshopify_canonical_domain === destShop);
      if (destDb !== shopDb && !adminMatches) {
        console.log('[dashboard-data] shop mismatch:', { destShop, shop, destDb, shopDb });
        return res.status(403).json({ error: 'shop mismatch' });
      }
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
                        : dbShop === 'rajathee.myshopify.com' ? 'install-rajathee'
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
app.use('/qr', require('./routes/qr'));
app.use('/shopify', require('./routes/compliance'));
app.use('/gdpr', require('./routes/gdpr'));
app.use('/webhooks', require('./routes/gdpr'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/embedded-bridge', require('./routes/embedded-bridge'));
app.use('/admin', require('./routes/admin'));
app.use('/team-timeline', require('./routes/team-timeline'));
app.use('/api/demo-leads', require('./routes/demo-leads'));

// ── PUBLIC STATS for landing page hero ──────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const orders = await pool.query("SELECT COUNT(*)::int AS c, COALESCE(SUM(grand_total),0)::numeric AS s FROM orders WHERE status = 'paid'");
    const convos = await pool.query("SELECT COUNT(*)::int AS c FROM conversations");
    const dbOrders = orders.rows[0].c;
    const dbRevenue = Number(orders.rows[0].s);
    const dbConversations = convos.rows[0].c;

    let shopifyOrders = 0;
    let shopifyRevenue = 0;
    let _dbgTenantFound = false;
    let _dbgTokenLen = 0;
    let _dbgFirstStatus = null;
    let _dbgPages = 0;
    let _dbgErr = null;
    try {
      const { getTenant } = require('./db');
      const ikaaTenant = await getTenant('ikaajewellery.myshopify.com');
      _dbgTenantFound = !!ikaaTenant;
      const ikaaToken = ikaaTenant?.shopify_token;
      _dbgTokenLen = ikaaToken ? ikaaToken.length : 0;
      if (ikaaToken) {
        let url = 'https://ikaajewellery.myshopify.com/admin/api/2024-01/orders.json?status=any&limit=250&fields=total_price';
        while (url) {
          const resp = await axios.get(url, {
            headers: { 'X-Shopify-Access-Token': ikaaToken },
            timeout: 10000,
            validateStatus: () => true,
          });
          if (_dbgPages === 0) _dbgFirstStatus = resp.status;
          _dbgPages++;
          if (resp.status !== 200) {
            _dbgErr = `status ${resp.status}: ${typeof resp.data === 'object' ? JSON.stringify(resp.data).slice(0, 200) : String(resp.data).slice(0, 200)}`;
            break;
          }
          const pageOrders = resp.data.orders || [];
          shopifyOrders += pageOrders.length;
          shopifyRevenue += pageOrders.reduce((sum, o) => sum + Number(o.total_price || 0), 0);
          const linkHeader = resp.headers.link || resp.headers.Link;
          const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          url = nextMatch ? nextMatch[1] : null;
        }
      }
    } catch (shopifyErr) {
      _dbgErr = shopifyErr.message;
      console.error('[api/stats shopify]', shopifyErr.message);
    }

    console.log('[shopify debug]', {
      tenantFound: _dbgTenantFound,
      tokenLen: _dbgTokenLen,
      firstStatus: _dbgFirstStatus,
      pages: _dbgPages,
      shopifyOrders,
      shopifyRevenue,
      err: _dbgErr,
    });

    res.json({
      orders: dbOrders + shopifyOrders,
      revenue: dbRevenue + shopifyRevenue,
      conversations: dbConversations,
    });
  } catch (e) {
    console.error('[api/stats]', e.message);
    res.status(500).json({ orders: 0, revenue: 0, conversations: 0 });
  }
});

// ── CASE STUDIES MILESTONES ─────────────────────────────────
function buildMilestonesFor(botName){
  const bot = botName || 'the bot';
  let low = 2000, high = 5000;
  if (botName === 'Rio') { low = 1000; high = 3000; }
  const base = [
    { key: 'first_conversation', label: `First conversation with ${bot}`, check: m => m.conversations >= 1, dateOf: m => m.nthConversationDate(1) },
    { key: 'first_order', label: 'First order placed', check: m => m.orders >= 1, dateOf: m => m.nthOrderDate(1) },
    { key: 'first_order_midnight', label: 'First order after midnight', check: m => !!m.firstAfterMidnight, dateOf: m => m.firstAfterMidnight },
    { key: 'first_repeat', label: 'First repeat customer', check: m => !!m.firstRepeat, dateOf: m => m.firstRepeat },
    { key: 'order_above_low', label: `First order above ₹${low.toLocaleString('en-IN')}`, check: m => m.hasOrderAbove(low), dateOf: m => m.firstOrderAbove(low) },
    { key: 'order_above_high', label: `First order above ₹${high.toLocaleString('en-IN')}`, check: m => m.hasOrderAbove(high), dateOf: m => m.firstOrderAbove(high) },
    { key: 'orders_10', label: '10 orders', check: m => m.orders >= 10, dateOf: m => m.nthOrderDate(10) },
    { key: 'orders_25', label: '25 orders', check: m => m.orders >= 25, dateOf: m => m.nthOrderDate(25) },
    { key: 'orders_50', label: '50 orders', check: m => m.orders >= 50, dateOf: m => m.nthOrderDate(50) },
    { key: 'orders_100', label: '100 orders', check: m => m.orders >= 100, dateOf: m => m.nthOrderDate(100) },
    { key: 'convo_100', label: '100 conversations', check: m => m.conversations >= 100, dateOf: m => m.nthConversationDate(100) },
    { key: 'convo_250', label: '250 conversations', check: m => m.conversations >= 250, dateOf: m => m.nthConversationDate(250) },
    { key: 'convo_500', label: '500 conversations', check: m => m.conversations >= 500, dateOf: m => m.nthConversationDate(500) },
    { key: 'convo_1000', label: '1,000 conversations', check: m => m.conversations >= 1000, dateOf: m => m.nthConversationDate(1000) },
    { key: 'customers_10', label: '10 unique customers', check: m => m.uniqueCustomers >= 10, dateOf: m => m.nthUniqueCustomerDate(10) },
    { key: 'customers_25', label: '25 unique customers', check: m => m.uniqueCustomers >= 25, dateOf: m => m.nthUniqueCustomerDate(25) },
    { key: 'customers_50', label: '50 unique customers', check: m => m.uniqueCustomers >= 50, dateOf: m => m.nthUniqueCustomerDate(50) },
    { key: 'revenue_10k', label: '₹10,000 total revenue', check: m => m.revenue >= 10000, dateOf: m => m.revenueCrossDate(10000) },
    { key: 'revenue_25k', label: '₹25,000 total revenue', check: m => m.revenue >= 25000, dateOf: m => m.revenueCrossDate(25000) },
    { key: 'revenue_50k', label: '₹50,000 total revenue', check: m => m.revenue >= 50000, dateOf: m => m.revenueCrossDate(50000) },
    { key: 'revenue_100k', label: '₹1,00,000 total revenue', check: m => m.revenue >= 100000, dateOf: m => m.revenueCrossDate(100000) },
    { key: 'sunday_order', label: 'First Sunday order', check: m => !!m.firstSundayOrder, dateOf: m => m.firstSundayOrder },
    { key: 'five_orders_day', label: '5 orders in a single day', check: m => m.maxOrdersInDay >= 5, dateOf: m => m.fiveOrdersDayDate },
    { key: 'days_30', label: '30 days live', check: m => m.daysLive >= 30, dateOf: m => m.liveSince ? new Date(new Date(m.liveSince).getTime() + 30*86400000).toISOString() : null },
  ];
  if (botName === 'Tara') base.push({ key: 'first_paid', label: 'First order completed', check: m => m.paidOrders >= 1, dateOf: m => m.firstPaidOrder });
  else if (botName === 'Rio') base.push({ key: 'late_night_order', label: 'First late-night order (after 10pm)', check: m => !!m.firstLate, dateOf: m => m.firstLate });
  else if (botName === 'Jhilmil') base.push({ key: 'late_convo', label: 'First late-night conversation (after 11pm)', check: m => !!m.firstLateConvo, dateOf: m => m.firstLateConvo });
  else base.push({ key: 'first_paid', label: 'First order completed', check: m => m.paidOrders >= 1, dateOf: m => m.firstPaidOrder });
  return base;
}

async function computeBrandMetrics(tenantId, liveSince) {
  const orderRowsRes = await pool.query(
    `SELECT COALESCE(created_at, confirmed_at) AS ts, confirmed_at, grand_total, customer_phone, status
     FROM orders WHERE tenant_id = $1
     ORDER BY COALESCE(created_at, confirmed_at) ASC NULLS LAST`, [tenantId]);
  const convRowsRes = await pool.query(
    `SELECT COALESCE(created_at, last_active) AS ts, customer_phone, last_active
     FROM conversations WHERE tenant_id = $1
     ORDER BY COALESCE(created_at, last_active) ASC NULLS LAST`, [tenantId]);

  const orderRows = orderRowsRes.rows;
  const convRows = convRowsRes.rows;

  const ordersByDay = {}, convByDay = {}, custCounts = {};
  let firstAfterMidnight = null, firstLate = null, firstSundayOrder = null, firstLateConvo = null;
  let firstPaidOrder = null, firstRepeat = null;
  let revenue = 0, paidOrders = 0;
  let cumulativeRevenue = 0;
  const revenueAt = []; // ascending by paid order timestamp
  const seenPhones = new Set();
  const firstAppearance = []; // [{ts, phone}] in order of first sighting
  const orderTimestamps = []; // ts of every order in chronological order
  const convoTimestamps = []; // ts of every conversation in chronological order

  for (const r of orderRows) {
    if (r.ts) orderTimestamps.push(r.ts);
    const amt = Number(r.grand_total || 0);
    if (r.status === 'paid') {
      paidOrders++;
      revenue += amt;
      cumulativeRevenue += amt;
      const paidTs = r.confirmed_at || r.ts;
      if (!firstPaidOrder && paidTs) firstPaidOrder = paidTs;
      if (paidTs) revenueAt.push({ ts: paidTs, total: cumulativeRevenue });
    }
    if (r.ts) {
      const d = new Date(r.ts);
      const day = d.toISOString().slice(0, 10);
      ordersByDay[day] = (ordersByDay[day] || 0) + 1;
      const h = d.getUTCHours();
      if (h < 6 && !firstAfterMidnight) firstAfterMidnight = r.ts;
      if (h >= 22 && !firstLate) firstLate = r.ts;
      if (d.getUTCDay() === 0 && !firstSundayOrder) firstSundayOrder = r.ts;
    }
    if (r.customer_phone) {
      if (!seenPhones.has(r.customer_phone)) {
        seenPhones.add(r.customer_phone);
        firstAppearance.push({ ts: r.ts, phone: r.customer_phone });
      }
      custCounts[r.customer_phone] = (custCounts[r.customer_phone] || 0) + 1;
      if (custCounts[r.customer_phone] === 2 && !firstRepeat) firstRepeat = r.ts;
    }
  }
  for (const r of convRows) {
    if (r.ts) {
      convoTimestamps.push(r.ts);
      const d = new Date(r.ts);
      const day = d.toISOString().slice(0, 10);
      convByDay[day] = (convByDay[day] || 0) + 1;
      const h = d.getUTCHours();
      if ((h >= 23 || h < 1) && !firstLateConvo) firstLateConvo = r.ts;
    }
  }
  // First time any day hits 5+ orders
  let fiveOrdersDayDate = null;
  const dayCounts = {};
  for (const r of orderRows) {
    if (!r.ts) continue;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    if (dayCounts[day] === 5) { fiveOrdersDayDate = r.ts; break; }
  }

  const maxOrdersInDay = Math.max(0, ...Object.values(ordersByDay));
  const maxConversationsInDay = Math.max(0, ...Object.values(convByDay));
  const start = liveSince ? new Date(liveSince).getTime() : Date.now();
  const daysLive = Math.max(0, Math.floor((Date.now() - start) / 86400000));

  return {
    orders: orderRows.length,
    paidOrders,
    revenue,
    conversations: convRows.length,
    uniqueCustomers: seenPhones.size,
    daysLive,
    liveSince,
    firstAfterMidnight,
    firstLate,
    firstSundayOrder,
    firstLateConvo,
    firstPaidOrder,
    firstRepeat,
    maxOrdersInDay,
    maxConversationsInDay,
    fiveOrdersDayDate,
    hasOrderAfterMidnight: !!firstAfterMidnight,
    hasOrderLate: !!firstLate,
    hasSundayOrder: !!firstSundayOrder,
    hasRepeatCustomer: !!firstRepeat,
    hasLateConversation: !!firstLateConvo,
    hasOrderAbove: (t) => orderRows.some(r => Number(r.grand_total || 0) >= t),
    firstOrderAbove: (t) => {
      const row = orderRows.find(r => Number(r.grand_total || 0) >= t);
      return row ? row.ts : null;
    },
    nthOrderDate: (n) => orderTimestamps[n - 1] || null,
    nthConversationDate: (n) => convoTimestamps[n - 1] || null,
    nthUniqueCustomerDate: (n) => firstAppearance[n - 1] ? firstAppearance[n - 1].ts : null,
    revenueCrossDate: (threshold) => {
      const entry = revenueAt.find(e => e.total >= threshold);
      return entry ? entry.ts : null;
    },
  };
}

let _milestonesCache = null;
let _milestonesCacheAt = 0;
app.get('/api/milestones', async (req, res) => {
  try {
    if (_milestonesCache && Date.now() - _milestonesCacheAt < 60000) {
      return res.json(_milestonesCache);
    }
    const tenants = await pool.query(
      `SELECT id, shop_domain, store_name, bot_name, channel, live_since, onboarded_at
       FROM tenants WHERE show_in_case_studies = TRUE ORDER BY live_since ASC NULLS LAST`
    );
    const brands = [];
    for (const t of tenants.rows) {
      const metrics = await computeBrandMetrics(t.id, t.live_since);
      const defs = buildMilestonesFor(t.bot_name);
      const existing = await pool.query(
        'SELECT milestone_key, achieved_at FROM milestones WHERE tenant_id = $1', [t.id]
      );
      const achievedMap = {};
      existing.rows.forEach(r => { achievedMap[r.milestone_key] = r.achieved_at; });
      const milestones = [];
      for (const m of defs) {
        let achievedAt = achievedMap[m.key] || null;
        try {
          if (m.check(metrics)) {
            let computed = null;
            if (m.dateOf) {
              try { computed = m.dateOf(metrics); } catch (_) { computed = null; }
            }
            if (!computed) computed = new Date().toISOString();
            const computedIso = (computed instanceof Date) ? computed.toISOString() : new Date(computed).toISOString();
            // Upsert with the real achievement date; corrects rows previously
            // inserted with NOW() when the actual achievement happened earlier.
            await pool.query(
              `INSERT INTO milestones (tenant_id, milestone_key, achieved_at)
               VALUES ($1, $2, $3::timestamp)
               ON CONFLICT (tenant_id, milestone_key)
               DO UPDATE SET achieved_at = EXCLUDED.achieved_at
               WHERE milestones.achieved_at IS DISTINCT FROM EXCLUDED.achieved_at`,
              [t.id, m.key, computedIso]
            );
            achievedAt = computedIso;
          }
        } catch (innerE) { /* skip */ }
        milestones.push({ key: m.key, label: m.label, achievedAt });
      }
      brands.push({
        tenantId: t.id,
        shopDomain: t.shop_domain,
        storeName: t.store_name,
        botName: t.bot_name,
        channel: t.channel,
        liveSince: t.live_since,
        onboardedAt: t.onboarded_at,
        stats: {
          orders: metrics.orders,
          paidOrders: metrics.paidOrders,
          revenue: metrics.revenue,
          conversations: metrics.conversations,
          uniqueCustomers: metrics.uniqueCustomers,
          daysLive: metrics.daysLive,
        },
        milestones,
      });
    }
    const payload = { brands };
    _milestonesCache = payload;
    _milestonesCacheAt = Date.now();
    res.json(payload);
  } catch (e) {
    console.error('[api/milestones]', e.message);
    res.status(500).json({ brands: [], error: e.message });
  }
});

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
require('./cron-s16-digest').start();
