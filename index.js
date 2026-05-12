require('dotenv').config();
const express = require('express');
const { initDB, pool } = require('./db');
const { startScheduler } = require('./scheduler');
const app = express();
app.use(async (req, res, next) => {
  if (req.path !== '/') return next();
  const { shop, hmac, session } = req.query;
  if (!shop || !hmac || !session) return next();
  return handleShopifyInstallLanding(req, res);
});
app.use(express.static(__dirname + '/public'));

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use('/shopify', require('./routes/install'));
app.use('/webhook', require('./routes/webhook'));
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
// ── END BILLING ROUTES ───────────────────────────────────────

const crypto = require('crypto');
const axios = require('axios');
const { updateTenant, getTenant, createTenant } = require('./db');

const SHOP_DOMAIN_MAP = {
  'udhuxy-pc.myshopify.com': 'rajathee.myshopify.com',
};

function verifyShopifyHmac(query, secret) {
  const rest = {};
  for (const k of Object.keys(query)) {
    if (k === 'hmac' || k === 'signature') continue;
    rest[k] = query[k];
  }
  const msg = Object.keys(rest).sort().map(k => k + '=' + rest[k]).join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(query.hmac, 'utf8'));
  } catch (e) { return false; }
}

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

async function handleShopifyInstallLanding(req, res) {
  const { shop, hmac, session } = req.query;
  console.log('🔵 Install landing: shop=' + shop + ' session_len=' + (session ? session.length : 0));
  try {
    const secret = process.env.SHOPIFY_API_SECRET_CUSTOM;
    const clientId = process.env.SHOPIFY_API_KEY_CUSTOM;
    if (!secret || !clientId) {
      console.error('Missing SHOPIFY_API_KEY_CUSTOM or SHOPIFY_API_SECRET_CUSTOM env');
      return res.status(500).send('Server misconfigured');
    }
    if (!verifyShopifyHmac(req.query, secret)) {
      console.error('❌ HMAC verification failed');
      return res.status(401).send('Invalid HMAC');
    }
    console.log('✅ HMAC verified');

    const accessToken = await tokenExchange(shop, session, clientId, secret);
    console.log('✅ Got offline token (prefix: ' + accessToken.slice(0, 10) + '...)');

    const dbShop = SHOP_DOMAIN_MAP[shop] || shop;
    const existing = await getTenant({ shopDomain: dbShop });
    if (existing) {
      await updateTenant(dbShop, { shopifyToken: accessToken });
      console.log('✅ Updated tenant ' + dbShop + ' with new token');
    } else {
      await createTenant({ shopDomain: dbShop, shopifyToken: accessToken });
      console.log('✅ Created tenant ' + dbShop + ' with token');
    }

    return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vaani installed</title><style>body{font-family:-apple-system,sans-serif;text-align:center;padding:80px 20px;background:#f8f8ff;color:#222}h1{color:#10b981}p{color:#555;line-height:1.6;max-width:520px;margin:20px auto}.ok{font-size:64px}</style></head><body><div class="ok">✅</div><h1>Vaani Custom installed</h1><p>Connected to <strong>' + shop + '</strong>. The bot is ready to handle orders on WhatsApp.</p><p style="font-size:13px;color:#888;margin-top:40px">You can close this tab.</p></body></html>');
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ Token Exchange error:', detail);
    return res.status(500).send('<html><body style="font-family:sans-serif;padding:60px;text-align:center"><h2 style="color:#ef4444">Installation failed</h2><p>' + err.message + '</p></body></html>');
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 Vaani server running on port ${PORT}`);
  await initDB();
  startScheduler();
});
require('./cron-alerts').start();
