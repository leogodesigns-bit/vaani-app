const fs = require('fs');

// 1. Add billing columns to DB
const setupDB = `
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) DEFAULT \\'pending\\'').then(() =>
pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_charge_id VARCHAR(100)')).then(() =>
pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_plan VARCHAR(20) DEFAULT \\'free\\'')).then(() => {
  console.log('✅ Billing columns added');
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
`;
fs.writeFileSync('/tmp/setup-billing-db.js', setupDB);

// 2. Rewrite billing.js with full flow
const billing = `const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const PLANS = {
  free: { name: 'Vaani Free', price: 0, trialDays: 0 },
  standard: { name: 'Vaani Standard', price: 18, trialDays: 7 },
  premium: { name: 'Vaani Premium', price: 48, trialDays: 7 }
};

// Plan features for AI prompt
const PLAN_FEATURES = {
  free: ['product browsing', 'basic Q&A'],
  standard: ['product browsing', 'cart building', 'abandoned cart followup', 'multilingual'],
  premium: ['product browsing', 'cart building', 'abandoned cart followup', 'multilingual', 'custom AI persona', 'priority support']
};

async function createSubscription(shopDomain, accessToken, plan) {
  if (plan === 'free') {
    await pool.query('UPDATE tenants SET tier = \\'free\\', billing_status = \\'active\\', billing_plan = \\'free\\' WHERE shop_domain = $1', [shopDomain]);
    return { status: 'active', plan: 'free' };
  }
  const planDetails = PLANS[plan];
  try {
    const res = await axios.post(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges.json\`,
      {
        recurring_application_charge: {
          name: planDetails.name,
          price: planDetails.price,
          trial_days: planDetails.trialDays,
          return_url: \`\${process.env.APP_URL}/billing/callback?shop=\${shopDomain}&plan=\${plan}\`,
          test: process.env.NODE_ENV !== 'production'
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query(
      'UPDATE tenants SET billing_status = \\'pending\\', billing_plan = $1, billing_charge_id = $2 WHERE shop_domain = $3',
      [plan, String(charge.id), shopDomain]
    );
    return charge;
  } catch (err) {
    console.error('❌ createSubscription error:', err.response?.data || err.message);
    return null;
  }
}

async function activateSubscription(shopDomain, chargeId, accessToken) {
  try {
    await axios.post(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges/\${chargeId}/activate.json\`,
      {},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const tenant = await pool.query('SELECT billing_plan FROM tenants WHERE shop_domain = $1', [shopDomain]);
    const plan = tenant.rows[0]?.billing_plan || 'free';
    await pool.query(
      'UPDATE tenants SET tier = $1, billing_status = \\'active\\' WHERE shop_domain = $2',
      [plan, shopDomain]
    );
    console.log('✅ Subscription activated for', shopDomain, 'plan:', plan);
    return true;
  } catch (err) {
    console.error('❌ activateSubscription error:', err.message);
    return false;
  }
}

async function checkSubscription(shopDomain, accessToken) {
  try {
    const res = await axios.get(
      \`https://\${shopDomain}/admin/api/2024-01/recurring_application_charges.json\`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charges = res.data.recurring_application_charges;
    const active = charges.find(c => c.status === 'active');
    if (active) {
      const plan = active.name.toLowerCase().includes('standard') ? 'standard' : 
                   active.name.toLowerCase().includes('premium') ? 'premium' : 'free';
      await pool.query('UPDATE tenants SET tier = $1, billing_status = \\'active\\' WHERE shop_domain = $2', [plan, shopDomain]);
      return { active: true, plan };
    }
    return { active: false, plan: 'free' };
  } catch (err) {
    return { active: false, plan: 'free' };
  }
}

module.exports = { PLANS, PLAN_FEATURES, createSubscription, activateSubscription, checkSubscription };
`;
fs.writeFileSync('billing.js', billing);
console.log('✅ billing.js rewritten');

// 3. Add billing routes to index.js
let index = fs.readFileSync('index.js', 'utf8');
if (!index.includes('/billing')) {
  index = index.replace(
    "app.use('/webhook', webhookRouter);",
    `app.use('/webhook', webhookRouter);

// Billing callback — merchant approves plan on Shopify, redirected here
app.get('/billing/callback', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tenant = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    if (!tenant.rows[0]) return res.send('Store not found.');
    const { activateSubscription } = require('./billing');
    const activated = await activateSubscription(shop, charge_id, tenant.rows[0].shopify_token);
    pool.end();
    if (activated) {
      res.send('<h2>✅ Vaani \${plan} plan activated!</h2><p>Your WhatsApp AI bot is now live. Close this window and start chatting.</p>');
    } else {
      res.send('<h2>⚠️ Could not activate plan. Please contact support.</h2>');
    }
  } catch (err) {
    console.error('Billing callback error:', err.message);
    res.send('Error activating plan.');
  }
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.send(\`<!DOCTYPE html>
<html>
<head><title>Vaani Pricing</title><style>
body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:20px}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.plan{border:1px solid #ddd;border-radius:12px;padding:24px;text-align:center}
.plan.popular{border-color:#6366f1;box-shadow:0 0 0 2px #6366f1}
.price{font-size:2em;font-weight:bold;margin:12px 0}
.btn{background:#6366f1;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;width:100%;font-size:1em}
ul{text-align:left;padding-left:20px}
</style></head>
<body>
<h1>Vaani Pricing</h1>
<div class="plans">
  <div class="plan">
    <h2>Free</h2>
    <div class="price">₹0/mo</div>
    <ul><li>Product browsing</li><li>Basic Q&A</li></ul>
    <button class="btn" onclick="selectPlan('free')">Get Started</button>
  </div>
  <div class="plan popular">
    <h2>Standard ⭐</h2>
    <div class="price">₹1,499/mo</div>
    <ul><li>Everything in Free</li><li>Cart building</li><li>Abandoned cart</li><li>Multilingual</li><li>7-day trial</li></ul>
    <button class="btn" onclick="selectPlan('standard')">Start Trial</button>
  </div>
  <div class="plan">
    <h2>Premium</h2>
    <div class="price">₹3,999/mo</div>
    <ul><li>Everything in Standard</li><li>Custom AI persona</li><li>Priority support</li><li>7-day trial</li></ul>
    <button class="btn" onclick="selectPlan('premium')">Start Trial</button>
  </div>
</div>
<script>
function selectPlan(plan) {
  const shop = new URLSearchParams(window.location.search).get('shop');
  if (!shop) { alert('Please install Vaani from the Shopify App Store first.'); return; }
  window.location.href = '/billing/create?shop=' + shop + '&plan=' + plan;
}
</script>
</body></html>\`);
});

// Create subscription
app.get('/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const tenant = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    pool.end();
    if (!tenant.rows[0]) return res.send('Store not found. Please install Vaani first.');
    const { createSubscription } = require('./billing');
    const charge = await createSubscription(shop, tenant.rows[0].shopify_token, plan);
    if (plan === 'free' || !charge) return res.redirect('/billing/success?plan=free');
    res.redirect(charge.confirmation_url);
  } catch (err) {
    console.error('Billing create error:', err.message);
    res.send('Error creating subscription.');
  }
});`
  );
  fs.writeFileSync('index.js', index);
  console.log('✅ index.js billing routes added');
} else {
  console.log('ℹ️ Billing routes already in index.js');
}
