const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Vaani Dashboard</h2>
    <p>Add <code>?shop=yourstore.myshopify.com</code> to the URL</p>
    </body></html>
  `);

  const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
  const tenant = t.rows[0];
  if (!tenant) return res.status(404).send('<h2>Store not found. Please install Vaani first.</h2>');

  // Get message stats
  const stats = await pool.query(
    `SELECT COUNT(*) as total_conversations,
     SUM(CASE WHEN message_month = $1 THEN monthly_messages ELSE 0 END) as messages_this_month
     FROM conversations WHERE tenant_id = $2`,
    [new Date().toISOString().slice(0, 7), tenant.id]
  );
  const s = stats.rows[0];

  const tierColors = { free: '#94a3b8', standard: '#6366f1', premium: '#f59e0b', custom: '#10b981' };
  const tierColor = tierColors[tenant.tier] || '#94a3b8';
  const msgLimit = tenant.tier === 'free' ? 70 : '∞';
  const categories = tenant.categories ? tenant.categories.map(c => c.name).join(', ') : 'Not generated yet';

  res.send(`<!DOCTYPE html>
<html><head><title>Vaani Dashboard — ${shop}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f8f8ff;color:#1a1a2e}
.header{background:#1a1a2e;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:1.4em}
.badge{background:${tierColor};color:white;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;text-transform:capitalize}
.container{max-width:900px;margin:32px auto;padding:0 20px;display:grid;gap:20px}
.card{background:white;border-radius:16px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
.card h2{font-size:1em;color:#666;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px}
.stat{background:#f8f8ff;border-radius:12px;padding:16px;text-align:center}
.stat .num{font-size:2em;font-weight:700;color:#1a1a2e}
.stat .label{font-size:12px;color:#888;margin-top:4px}
.field{margin-bottom:16px}
.field label{display:block;font-size:13px;color:#666;margin-bottom:6px;font-weight:500}
.field input,.field textarea{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;outline:none}
.field input:focus,.field textarea:focus{border-color:#6366f1}
.field textarea{height:80px;resize:vertical}
.btn{padding:11px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn.primary{background:#6366f1;color:white}
.btn.success{background:#10b981;color:white}
.btn.outline{background:white;border:2px solid #6366f1;color:#6366f1}
.btn.danger{background:#ef4444;color:white}
.row{display:flex;gap:12px;flex-wrap:wrap}
.status-dot{width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;margin-right:6px}
.copy-box{background:#f1f5f9;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:13px;word-break:break-all;cursor:pointer;position:relative}
.copy-box:hover{background:#e2e8f0}
.tag{background:#e0e7ff;color:#4338ca;padding:3px 10px;border-radius:20px;font-size:13px;margin:3px;display:inline-block}
.upgrade-banner{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border-radius:16px;padding:24px;text-align:center}
.upgrade-banner h2{color:white;font-size:1.2em;margin-bottom:8px}
.upgrade-banner p{opacity:0.9;margin-bottom:16px;font-size:14px}
</style></head>
<body>

<div class="header">
  <h1>🤖 Vaani Dashboard</h1>
  <div style="display:flex;align-items:center;gap:12px">
    <span style="font-size:13px;opacity:0.7">${shop}</span>
    <span class="badge">${tenant.tier || 'free'}</span>
  </div>
</div>

<div class="container">

  <!-- Stats -->
  <div class="card">
    <h2>This Month</h2>
    <div class="stats">
      <div class="stat">
        <div class="num">${s.messages_this_month || 0}</div>
        <div class="label">Messages sent</div>
      </div>
      <div class="stat">
        <div class="num">${msgLimit}</div>
        <div class="label">Monthly limit</div>
      </div>
      <div class="stat">
        <div class="num">${s.total_conversations || 0}</div>
        <div class="label">Total conversations</div>
      </div>
      <div class="stat">
        <div class="num" style="color:#10b981">●</div>
        <div class="label">Bot status: Active</div>
      </div>
    </div>
  </div>

  <!-- WhatsApp Setup -->
  <div class="card">
    <h2>WhatsApp Setup</h2>
    <div class="field">
      <label>Webhook URL (add this in Meta Developer Console)</label>
      <div class="copy-box" onclick="copy(this)">${process.env.APP_URL}/webhook</div>
    </div>
    <div class="field">
      <label>Verify Token</label>
      <div class="copy-box" onclick="copy(this)">${process.env.WHATSAPP_VERIFY_TOKEN || 'vaani_verify_token'}</div>
    </div>
    <div class="field">
      <label>Phone Number ID</label>
      <input type="text" id="phone_number_id" value="${tenant.whatsapp_number || ''}" placeholder="e.g. 997421573464360">
    </div>
    <div class="field">
      <label>WhatsApp Access Token</label>
      <input type="password" id="whatsapp_token" value="${tenant.whatsapp_token ? '••••••••' : ''}" placeholder="Paste your Meta access token">
    </div>
    <button class="btn primary" onclick="saveWhatsApp()">Save WhatsApp Settings</button>
  </div>

  <!-- Brand Settings -->
  <div class="card">
    <h2>Brand Settings</h2>
    <div class="field">
      <label>Bot Persona (how your bot introduces itself and its tone)</label>
      <textarea id="brand_prompt" placeholder="e.g. You are Priya, a friendly assistant for Ikaa Jewellery. Speak warmly and suggest products based on occasions.">${tenant.brand_prompt || ''}</textarea>
    </div>
    <button class="btn primary" onclick="saveBrand()">Save Brand Settings</button>
  </div>

  <!-- Categories -->
  <div class="card">
    <h2>Product Categories</h2>
    <p style="font-size:14px;color:#666;margin-bottom:12px">Auto-detected from your Shopify catalog. Refreshes weekly.</p>
    <div style="margin-bottom:16px">
      ${tenant.categories ? tenant.categories.map(c => `<span class="tag">${c.name}</span>`).join('') : '<span style="color:#999;font-size:14px">No categories yet — send a message to your bot to generate them.</span>'}
    </div>
    <button class="btn outline" onclick="refreshCategories()">🔄 Refresh Categories Now</button>
  </div>

  ${tenant.tier === 'free' ? `
  <!-- Upgrade Banner -->
  <div class="upgrade-banner">
    <h2>Upgrade to Standard ⚡</h2>
    <p>You're on the free plan (${s.messages_this_month || 0}/70 messages used). Upgrade for unlimited messages, cart building, abandoned cart recovery, and multilingual support.</p>
    <a href="/pricing?shop=${shop}"><button class="btn" style="background:white;color:#6366f1;font-weight:700">View Plans — Start 7-day Free Trial</button></a>
  </div>
  ` : ''}

</div>

<script>
function copy(el) {
  navigator.clipboard.writeText(el.textContent.trim());
  const orig = el.textContent;
  el.textContent = '✅ Copied!';
  setTimeout(() => el.textContent = orig, 1500);
}

async function saveWhatsApp() {
  const phone = document.getElementById('phone_number_id').value;
  const token = document.getElementById('whatsapp_token').value;
  if (token === '••••••••') { alert('Please enter your actual access token'); return; }
  const res = await fetch('/dashboard/update', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ shop: '${shop}', whatsapp_number: phone, whatsapp_token: token })
  });
  const data = await res.json();
  alert(data.success ? '✅ WhatsApp settings saved!' : '❌ Error: ' + data.error);
}

async function saveBrand() {
  const prompt = document.getElementById('brand_prompt').value;
  const res = await fetch('/dashboard/update', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ shop: '${shop}', brand_prompt: prompt })
  });
  const data = await res.json();
  alert(data.success ? '✅ Brand settings saved!' : '❌ Error: ' + data.error);
}

async function refreshCategories() {
  const btn = event.target;
  btn.textContent = '⏳ Refreshing...';
  btn.disabled = true;
  const res = await fetch('/dashboard/refresh-categories', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ shop: '${shop}' })
  });
  const data = await res.json();
  if (data.success) {
    alert('✅ Categories refreshed: ' + data.categories.join(', '));
    location.reload();
  } else {
    alert('❌ Error: ' + data.error);
    btn.textContent = '🔄 Refresh Categories Now';
    btn.disabled = false;
  }
}
</script>
</body></html>`);
});

// Update tenant settings
router.post('/update', async (req, res) => {
  const { shop, whatsapp_number, whatsapp_token, brand_prompt } = req.body;
  if (!shop) return res.json({ error: 'Shop required' });
  try {
    const updates = [];
    const values = [];
    let i = 1;
    if (whatsapp_number) { updates.push(`whatsapp_number = $${i++}`); values.push(whatsapp_number); }
    if (whatsapp_token) { updates.push(`whatsapp_token = $${i++}`); values.push(whatsapp_token); }
    if (brand_prompt !== undefined) { updates.push(`brand_prompt = $${i++}`); values.push(brand_prompt); }
    if (!updates.length) return res.json({ error: 'Nothing to update' });
    values.push(shop);
    await pool.query(`UPDATE tenants SET ${updates.join(', ')} WHERE shop_domain = $${i}`, values);
    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Refresh categories
router.post('/refresh-categories', async (req, res) => {
  const { shop } = req.body;
  try {
    const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
    const tenant = t.rows[0];
    if (!tenant) return res.json({ error: 'Store not found' });
    const { getProducts } = require('../shopify');
    const { generateCategories } = require('../utils/autoCategorize');
    const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
    const categories = await generateCategories(products);
    await pool.query('UPDATE tenants SET categories = $1 WHERE shop_domain = $2', [JSON.stringify(categories), shop]);
    res.json({ success: true, categories: categories.map(c => c.name) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
