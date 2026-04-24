const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Demo WhatsApp link — click-to-chat with IKAA demo store
const DEMO_WA_LINK = 'https://wa.me/15556338949?text=Hi';

router.get('/', async (req, res) => {
  const shop = req.query.shop;
  const firstInstall = req.query.first_install === '1';

  if (!shop) return res.send(`
    <html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;background:#f8f8ff">
    <h2>Vaani Dashboard</h2>
    <p>Please open this page from your Shopify admin.</p>
    </body></html>
  `);

  const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
  const tenant = t.rows[0];
  if (!tenant) return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">Store not found. Please install Vaani first.</h2>');

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
  const hasOwnWA = !!(tenant.whatsapp_number && tenant.whatsapp_token);

  res.send(`<!DOCTYPE html>
<html><head><title>Vaani Dashboard — ${shop}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f8ff;color:#1a1a2e;line-height:1.5}
.header{background:#1a1a2e;color:white;padding:18px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.header h1{font-size:1.3em;font-weight:600}
.badge{background:${tierColor};color:white;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;text-transform:capitalize}
.container{max-width:900px;margin:24px auto;padding:0 20px;display:grid;gap:18px}
.card{background:white;border-radius:16px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.05)}
.card h2{font-size:0.85em;color:#666;margin-bottom:14px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600}
.hero{background:linear-gradient(135deg,#10b981,#059669);color:white;border-radius:16px;padding:28px;text-align:center;box-shadow:0 4px 16px rgba(16,185,129,0.25)}
.hero h2{color:white;font-size:1.35em;margin-bottom:8px;text-transform:none;letter-spacing:0}
.hero p{opacity:0.95;margin-bottom:20px;font-size:15px}
.hero .wa-btn{display:inline-flex;align-items:center;gap:10px;background:white;color:#059669;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.1);transition:transform 0.1s}
.hero .wa-btn:hover{transform:translateY(-1px)}
.hero .wa-btn svg{width:22px;height:22px}
.hero small{display:block;opacity:0.85;margin-top:14px;font-size:13px}
.welcome-banner{background:#fef3c7;border:1px solid #fbbf24;border-radius:12px;padding:14px 18px;color:#78350f;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px}
.stat{background:#f8f8ff;border-radius:12px;padding:16px;text-align:center}
.stat .num{font-size:1.8em;font-weight:700;color:#1a1a2e}
.stat .label{font-size:12px;color:#888;margin-top:4px}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;color:#666;margin-bottom:6px;font-weight:500}
.field input,.field textarea{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;outline:none;font-family:inherit}
.field input:focus,.field textarea:focus{border-color:#6366f1}
.field textarea{height:80px;resize:vertical}
.btn{padding:11px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn.primary{background:#6366f1;color:white}
.btn.outline{background:white;border:1.5px solid #6366f1;color:#6366f1}
.copy-box{background:#f1f5f9;border-radius:8px;padding:10px 14px;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;cursor:pointer}
.copy-box:hover{background:#e2e8f0}
.tag{background:#e0e7ff;color:#4338ca;padding:3px 10px;border-radius:20px;font-size:13px;margin:3px 4px 3px 0;display:inline-block}
details{border-radius:12px;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.05)}
details summary{padding:18px 24px;cursor:pointer;font-weight:600;font-size:14px;color:#1a1a2e;list-style:none;display:flex;justify-content:space-between;align-items:center}
details summary::after{content:'▾';color:#999;transition:transform 0.2s}
details[open] summary::after{transform:rotate(180deg)}
details .content{padding:0 24px 22px;border-top:1px solid #f1f5f9;padding-top:18px}
.status-good{color:#10b981;font-weight:600}
.status-pending{color:#f59e0b;font-weight:600}
.support{text-align:center;color:#888;font-size:13px;padding:16px 0}
.support a{color:#6366f1;text-decoration:none}
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

  ${firstInstall ? `
  <div class="welcome-banner">
    🎉 <strong>Vaani is installed!</strong> Click the green button below to chat with a live demo and see exactly how Vaani will work for your customers.
  </div>
  ` : ''}

  <!-- HERO: Try Vaani Demo CTA -->
  <div class="hero">
    <h2>See Vaani in action — chat with our demo store</h2>
    <p>Vaani is now connected to <strong>${shop}</strong>. Tap below to open WhatsApp and chat with a live demo (Ikaa Jewellery store). Browse products, build a shortlist, and get a real checkout link — in under 60 seconds.</p>
    <a href="${DEMO_WA_LINK}" target="_blank" class="wa-btn">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
      Chat with Vaani on WhatsApp
    </a>
    <small>Best viewed on a phone with WhatsApp installed. Opens in a new tab.</small>
  </div>

  <!-- STATUS -->
  <div class="card">
    <h2>Setup Status</h2>
    <div style="display:grid;gap:10px;font-size:14px">
      <div>✅ <span class="status-good">Shopify connected</span> — Vaani has access to your products and draft orders</div>
      <div>✅ <span class="status-good">Demo mode active</span> — Try Vaani instantly with our demo number (above)</div>
      <div>${hasOwnWA ? '✅ <span class="status-good">Your WhatsApp number connected</span> — customers can chat with your own branded number' : '⏳ <span class="status-pending">Your WhatsApp Business number</span> — optional, connect below when ready to go live with your own number'}</div>
    </div>
  </div>

  <!-- STATS -->
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
        <div class="label">Bot: Active</div>
      </div>
    </div>
  </div>

  <!-- BRAND PERSONA -->
  <div class="card">
    <h2>Bot Persona</h2>
    <div class="field">
      <label>How should Vaani introduce itself to your customers?</label>
      <textarea id="brand_prompt" placeholder="e.g. You are Priya, a friendly assistant for our store. Speak warmly and suggest products based on occasions.">${tenant.brand_prompt || ''}</textarea>
    </div>
    <button class="btn primary" onclick="saveBrand()">Save Persona</button>
  </div>

  <!-- ADVANCED: Connect own WhatsApp -->
  <details>
    <summary>Advanced: Connect your own WhatsApp Business number</summary>
    <div class="content">
      <p style="font-size:14px;color:#666;margin-bottom:18px">Once you're ready to go live with your own branded WhatsApp number, paste your Meta WhatsApp Business API credentials here. Until then, you can keep testing with our demo number above.</p>

      <div class="field">
        <label>Your webhook URL (paste this in Meta Developer Console → WhatsApp → Configuration)</label>
        <div class="copy-box" onclick="copy(this)">${process.env.APP_URL}/webhook</div>
      </div>
      <div class="field">
        <label>Verify Token (paste this in Meta Developer Console too)</label>
        <div class="copy-box" onclick="copy(this)">${process.env.WHATSAPP_VERIFY_TOKEN || 'vaani_verify_token'}</div>
      </div>
      <div class="field">
        <label>Phone Number ID (from Meta)</label>
        <input type="text" id="phone_number_id" value="${tenant.whatsapp_number || ''}" placeholder="e.g. 997421573464360">
      </div>
      <div class="field">
        <label>WhatsApp Access Token (from Meta)</label>
        <input type="password" id="whatsapp_token" value="${tenant.whatsapp_token ? '••••••••' : ''}" placeholder="Paste your Meta access token">
      </div>
      <button class="btn primary" onclick="saveWhatsApp()">Save My WhatsApp Settings</button>

      <p style="font-size:13px;color:#888;margin-top:16px">Need help? <a href="mailto:leogodesigns@gmail.com" style="color:#6366f1">Email us</a> and we'll walk you through Meta setup.</p>
    </div>
  </details>

  <!-- CATEGORIES -->
  <details>
    <summary>Product Categories (auto-detected from your store)</summary>
    <div class="content">
      <p style="font-size:14px;color:#666;margin-bottom:12px">Vaani automatically groups your products into browseable categories. Refreshes weekly, or refresh manually:</p>
      <div style="margin-bottom:16px">
        ${tenant.categories ? tenant.categories.map(c => `<span class="tag">${c.name}</span>`).join('') : '<span style="color:#999;font-size:14px">No categories yet — send a message to your bot to generate them, or click refresh below.</span>'}
      </div>
      <button class="btn outline" onclick="refreshCategories()">🔄 Refresh Categories Now</button>
    </div>
  </details>

  ${tenant.tier === 'free' ? `
  <div class="card" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white">
    <h2 style="color:white;opacity:0.9">Upgrade</h2>
    <p style="font-size:14px;opacity:0.95;margin-bottom:14px">You're on the free plan (${s.messages_this_month || 0}/70 messages used this month). Upgrade for unlimited messages + cart building + abandoned cart recovery.</p>
    <a href="/pricing?shop=${shop}"><button class="btn" style="background:white;color:#6366f1;font-weight:700">View Plans — 7-day Free Trial</button></a>
  </div>
  ` : ''}

  <div class="support">
    Need help? Email <a href="mailto:leogodesigns@gmail.com">leogodesigns@gmail.com</a> — we reply within 24 hours.
  </div>

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
  alert(data.success ? '✅ Persona saved!' : '❌ Error: ' + data.error);
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
