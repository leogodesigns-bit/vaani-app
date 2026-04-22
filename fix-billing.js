const fs = require('fs');

// Rewrite billing.js with all 4 tiers
const billing = `const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const PLANS = {
  free:     { name: 'Vaani Free',     price: 0,  trialDays: 0, usd: 0  },
  standard: { name: 'Vaani Standard', price: 18, trialDays: 7, usd: 18 },
  premium:  { name: 'Vaani Premium',  price: 48, trialDays: 7, usd: 48 },
  custom:   { name: 'Vaani Custom',   price: null, trialDays: 7, usd: null }
};

const PLAN_FEATURES = {
  free:     ['product browsing', 'basic Q&A'],
  standard: ['product browsing', 'cart building', 'abandoned cart', 'multilingual'],
  premium:  ['product browsing', 'cart building', 'abandoned cart', 'multilingual', 'custom AI persona', 'priority support'],
  custom:   ['everything in premium', 'custom flows', 'dedicated setup', 'direct support from Leogo']
};

// Standard Shopify recurring charge
async function createSubscription(shopDomain, accessToken, plan) {
  if (plan === 'free') {
    await pool.query('UPDATE tenants SET tier = $1, billing_status = $2, billing_plan = $3 WHERE shop_domain = $4',
      ['free', 'active', 'free', shopDomain]);
    return { status: 'active', plan: 'free' };
  }
  if (plan === 'custom') return null; // Custom handled separately
  const planDetails = PLANS[plan];
  try {
    const res = await axios.post(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges.json\`,
      { recurring_application_charge: {
          name: planDetails.name,
          price: planDetails.usd,
          trial_days: planDetails.trialDays,
          return_url: \`\${process.env.APP_URL}/billing/callback?shop=\${shopDomain}&plan=\${plan}\`,
          test: process.env.NODE_ENV !== 'production'
      }},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query('UPDATE tenants SET billing_status = $1, billing_plan = $2, billing_charge_id = $3 WHERE shop_domain = $4',
      ['pending', plan, String(charge.id), shopDomain]);
    return charge;
  } catch (err) {
    console.error('❌ createSubscription error:', err.response?.data || err.message);
    return null;
  }
}

// Custom price charge — for external custom merchants via Shopify
async function createCustomSubscription(shopDomain, accessToken, priceUSD, label) {
  try {
    const res = await axios.post(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges.json\`,
      { recurring_application_charge: {
          name: \`Vaani Custom — \${label}\`,
          price: priceUSD,
          trial_days: 7,
          return_url: \`\${process.env.APP_URL}/billing/callback?shop=\${shopDomain}&plan=custom\`,
          test: process.env.NODE_ENV !== 'production'
      }},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query('UPDATE tenants SET billing_status = $1, billing_plan = $2, billing_charge_id = $3 WHERE shop_domain = $4',
      ['pending', 'custom', String(charge.id), shopDomain]);
    return charge;
  } catch (err) {
    console.error('❌ createCustomSubscription error:', err.message);
    return null;
  }
}

// Activate after merchant approves on Shopify
async function activateSubscription(shopDomain, chargeId, accessToken) {
  try {
    await axios.post(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges/\${chargeId}/activate.json\`,
      {},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const t = await pool.query('SELECT billing_plan FROM tenants WHERE shop_domain = $1', [shopDomain]);
    const plan = t.rows[0]?.billing_plan || 'free';
    await pool.query('UPDATE tenants SET tier = $1, billing_status = $2 WHERE shop_domain = $3',
      [plan, 'active', shopDomain]);
    console.log('✅ Activated', shopDomain, plan);
    return true;
  } catch (err) {
    console.error('❌ activateSubscription error:', err.message);
    return false;
  }
}

// Manually activate Leogo clients (no Shopify billing)
async function activateLeogoClient(shopDomain, customPriceINR, notes) {
  await pool.query(
    'UPDATE tenants SET tier = $1, billing_status = $2, billing_plan = $3, brand_prompt = COALESCE(brand_prompt, $4) WHERE shop_domain = $5',
    ['custom', 'active_leogo', 'custom', notes || '', shopDomain]
  );
  console.log('✅ Leogo client activated:', shopDomain, '₹' + customPriceINR + '/mo');
  return true;
}

module.exports = { PLANS, PLAN_FEATURES, createSubscription, createCustomSubscription, activateSubscription, activateLeogoClient };
`;
fs.writeFileSync('billing.js', billing);
console.log('✅ billing.js written');

// Add billing columns to tenants table setup
const dbSetup = `
const { Pool } = require('pg');
const pool = new Pool({ connectionString: '${process.env.DATABASE_URL || 'postgresql://postgres:hPUxuUBbuGhvfVYsqfKpnbWKAUTFypqx@shinkansen.proxy.rlwy.net:41185/railway'}', ssl: { rejectUnauthorized: false } });
Promise.all([
  pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30) DEFAULT 'pending'"),
  pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_charge_id VARCHAR(100)"),
  pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_plan VARCHAR(20) DEFAULT 'free'"),
  pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_price_inr INTEGER"),
  pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_notes TEXT")
]).then(() => { console.log('✅ DB columns added'); pool.end(); }).catch(e => { console.error(e.message); pool.end(); });
`;
fs.writeFileSync('/tmp/billing-db.js', dbSetup);

// Add pricing page + billing routes to index.js
let index = fs.readFileSync('index.js', 'utf8');
if (!index.includes('/pricing')) {
  index = index.replace(
    "app.use('/webhook', webhookRouter);",
    `app.use('/webhook', webhookRouter);

app.get('/pricing', (req, res) => {
  const shop = req.query.shop || '';
  res.send(\`<!DOCTYPE html>
<html><head><title>Vaani Pricing</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f8f8ff;padding:40px 20px}
h1{text-align:center;margin-bottom:8px;color:#1a1a2e}
.sub{text-align:center;color:#666;margin-bottom:40px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;max-width:960px;margin:0 auto}
.plan{background:white;border:2px solid #eee;border-radius:16px;padding:28px;text-align:center}
.plan.popular{border-color:#6366f1}
.badge{background:#6366f1;color:white;font-size:11px;padding:3px 10px;border-radius:20px;display:inline-block;margin-bottom:8px}
.price{font-size:2.2em;font-weight:700;margin:12px 0 4px;color:#1a1a2e}
.price span{font-size:0.4em;color:#666}
ul{text-align:left;margin:16px 0 24px;padding-left:18px;color:#444;font-size:14px;line-height:2}
.btn{width:100%;padding:13px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;background:#6366f1;color:white}
.btn.outline{background:white;border:2px solid #6366f1;color:#6366f1}
.btn.dark{background:#1a1a2e}
</style></head>
<body>
<h1>Vaani Pricing</h1>
<p class="sub">WhatsApp AI Sales Bot for Shopify</p>
<div class="plans">
  <div class="plan">
    <h2>Free</h2>
    <div class="price">₹0<span>/mo</span></div>
    <ul><li>Product browsing</li><li>Basic Q&A</li><li>Unlimited messages</li></ul>
    <button class="btn outline" onclick="go('free')">Get Started</button>
  </div>
  <div class="plan popular">
    <div class="badge">Most Popular</div>
    <h2>Standard</h2>
    <div class="price">₹1,499<span>/mo</span></div>
    <ul><li>Everything in Free</li><li>Cart building</li><li>Abandoned cart recovery</li><li>Multilingual support</li><li>7-day free trial</li></ul>
    <button class="btn" onclick="go('standard')">Start Free Trial</button>
  </div>
  <div class="plan">
    <h2>Premium</h2>
    <div class="price">₹3,999<span>/mo</span></div>
    <ul><li>Everything in Standard</li><li>Custom AI persona</li><li>Custom greeting flow</li><li>Priority support</li><li>7-day free trial</li></ul>
    <button class="btn" onclick="go('premium')">Start Free Trial</button>
  </div>
  <div class="plan">
    <h2>Custom</h2>
    <div class="price" style="font-size:1.4em">Let's talk</div>
    <ul><li>Everything in Premium</li><li>Built for your brand</li><li>Custom flows & logic</li><li>Direct Leogo support</li><li>Flexible pricing</li></ul>
    <button class="btn dark" onclick="contactUs()">Contact Us</button>
  </div>
</div>
<script>
const shop = '\${shop}';
function go(plan) {
  if (!shop) { alert('Please install Vaani from Shopify first.'); return; }
  window.location.href = '/billing/create?shop=' + shop + '&plan=' + plan;
}
function contactUs() {
  window.open('https://wa.me/919403345612?text=Hi! I want to know more about Vaani Custom plan for my Shopify store ' + shop, '_blank');
}
</script>
</body></html>\`);
});

app.get('/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  if (plan === 'custom') return res.redirect('https://wa.me/919403345612?text=Hi! I want Vaani Custom plan for ' + shop);
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    pool.end();
    if (!t.rows[0]) return res.send('Store not found. Please install Vaani first.');
    const { createSubscription } = require('./billing');
    const charge = await createSubscription(shop, t.rows[0].shopify_token, plan);
    if (!charge || charge.status === 'active') return res.redirect('/billing/success?plan=' + plan);
    res.redirect(charge.confirmation_url);
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.get('/billing/callback', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    pool.end();
    if (!t.rows[0]) return res.send('Store not found.');
    const { activateSubscription } = require('./billing');
    await activateSubscription(shop, charge_id, t.rows[0].shopify_token);
    res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:60px">✅ Vaani ' + plan + ' activated!<br><br><small>Close this window and start chatting on WhatsApp.</small></h2>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.get('/billing/success', (req, res) => {
  res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:60px">✅ Vaani activated!<br><br><small>Close this window.</small></h2>');
});

// Admin — activate Leogo client manually (secret URL)
app.post('/admin/activate-leogo', async (req, res) => {
  const { secret, shop, price_inr, notes } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { activateLeogoClient } = require('./billing');
  await activateLeogoClient(shop, price_inr, notes);
  res.json({ success: true, message: shop + ' activated as Leogo custom client at ₹' + price_inr + '/mo' });
});`
  );
  fs.writeFileSync('index.js', index);
  console.log('✅ index.js billing routes added');
} else {
  console.log('ℹ️ Routes already exist');
}
