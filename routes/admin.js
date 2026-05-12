const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Auth middleware — all routes need ?key=LEOGO_ADMIN_KEY
function requireAdmin(req, res, next) {
  const key = req.query.key || req.body?.key;
  if (!key || key !== process.env.LEOGO_ADMIN_KEY) {
    return res.status(401).send('<h2 style="font-family:Inter,sans-serif;text-align:center;padding:80px">401 — Unauthorized</h2>');
  }
  next();
}

router.use(requireAdmin);

// Helpers
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function timeAgo(d) {
  if (!d) return '';
  const secs = Math.floor((Date.now() - new Date(d)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs/60) + ' min ago';
  if (secs < 86400) return Math.floor(secs/3600) + ' hr ago';
  const days = Math.floor(secs/86400);
  if (days < 7) return days + ' day' + (days>1?'s':'') + ' ago';
  return new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
}
function maskPhone(p) {
  if (!p) return 'Unknown';
  const s = String(p);
  return '+' + s.slice(0,2) + ' ' + s.slice(2,7) + ' ' + s.slice(7);
}

// CSS (shared)
const STYLES = `
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;background:#faf7f2;color:#1a1410;line-height:1.5;-webkit-font-smoothing:antialiased}
.top-bar{background:#1a1410;color:#faf7f2;padding:14px 32px;display:flex;justify-content:space-between;align-items:center}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}
.brand-mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#b8904d,#8a6a35);display:flex;align-items:center;justify-content:center;color:#1a1410;font-weight:700;font-size:13px}
.admin-chip{background:rgba(184,144,77,.2);color:#d4b372;border:1px solid rgba(184,144,77,.4);padding:4px 11px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em}
.page{max-width:1280px;margin:0 auto;padding:24px 32px 48px;display:grid;gap:20px}
.h-title{font-size:22px;font-weight:600;letter-spacing:-.02em;color:#1a1410}
.h-sub{color:#8a7866;font-size:14px;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat-card{background:#fffdf8;border:1px solid #ebe3d3;border-radius:14px;padding:20px 22px}
.stat-num{font-size:28px;font-weight:700;letter-spacing:-.03em;color:#1a1410;line-height:1}
.stat-label{font-size:11.5px;color:#8a7866;margin-top:8px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
.stat-meta{font-size:11.5px;color:#b8904d;margin-top:10px;font-weight:500}
.card{background:#fffdf8;border:1px solid #ebe3d3;border-radius:14px;padding:0;overflow:hidden}
.card-head{padding:18px 24px;border-bottom:1px solid #f0e8d6;display:flex;justify-content:space-between;align-items:center}
.card-title{font-size:15px;font-weight:600;color:#1a1410}
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;padding:12px 24px;font-size:11px;font-weight:600;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;background:#fbf6ea;border-bottom:1px solid #ebe3d3}
.tbl td{padding:14px 24px;font-size:13.5px;color:#1a1410;border-bottom:1px solid #f0e8d6}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover{background:#fbf6ea;cursor:pointer}
.tbl tr.clickable td:first-child{color:#1a1410;font-weight:500}
.pill{display:inline-block;padding:3px 10px;border-radius:14px;font-size:11.5px;font-weight:500;letter-spacing:.02em}
.pill.gold{background:#fef0d8;color:#8a6a35;border:1px solid #e8d5a7}
.pill.sage{background:#e8ede0;color:#4a5c33;border:1px solid #c5d4b3}
.pill.rose{background:#f5e3e0;color:#8a3e35;border:1px solid #e0b8b2}
.pill.gray{background:#f0e8d6;color:#5a4a35;border:1px solid #d4c4a0}
.back-link{display:inline-flex;align-items:center;gap:6px;color:#8a7866;font-size:13px;text-decoration:none;margin-bottom:14px}
.back-link:hover{color:#1a1410}
.chat-thread{padding:24px;max-height:600px;overflow-y:auto;background:linear-gradient(to bottom,#fffdf8,#fbf6ea)}

.bubble{display:inline-block;max-width:70%;padding:10px 14px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:break-word;text-align:left;white-space:pre-wrap;vertical-align:top}
.msg.user .bubble{background:#d4b372;color:#1a1410;border-bottom-right-radius:4px}
.msg.bot .bubble{background:#fffdf8;color:#1a1410;border:1px solid #ebe3d3;border-bottom-left-radius:4px}
.msg{display:block;margin-bottom:8px;clear:both}
.msg.user{text-align:right}
.msg.bot{text-align:left}
.msg.user .bubble{display:inline-block;max-width:70%;padding:10px 14px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:break-word;text-align:left;white-space:pre-wrap;vertical-align:top}
.msg.bot .bubble{display:inline-block;max-width:70%;padding:10px 14px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:break-word;text-align:left;white-space:pre-wrap;vertical-align:top}
.msg .meta{font-size:10.5px;color:#8a7866;margin-top:3px;text-align:right}
.empty{padding:60px 24px;text-align:center;color:#8a7866;font-size:14px}

.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:14px 20px;background:#fffdf8;border:1px solid #ebe3d3;border-radius:14px}
.toolbar input{flex:1;min-width:200px;padding:9px 14px;border:1px solid #ebe3d3;border-radius:9px;font-family:inherit;font-size:13.5px;background:#faf7f2;color:#1a1410}
.toolbar input:focus{outline:none;border-color:#b8904d;background:#fffdf8}
.toolbar .chip{padding:6px 14px;border:1px solid #ebe3d3;border-radius:20px;font-size:12px;font-weight:500;color:#5a4a35;background:#faf7f2;cursor:pointer;transition:all .15s;user-select:none}
.toolbar .chip:hover{background:#fef0d8;border-color:#d4c4a0}
.toolbar .chip.active{background:#1a1410;color:#faf7f2;border-color:#1a1410}
.tbl th.sortable{cursor:pointer;user-select:none}
.tbl th.sortable:hover{color:#1a1410}
.tbl th.sortable::after{content:' ↕';opacity:.4;font-size:10px}
.tbl th.sortable.asc::after{content:' ↑';opacity:1;color:#b8904d}
.tbl th.sortable.desc::after{content:' ↓';opacity:1;color:#b8904d}
.tbl tr.hidden{display:none}
.empty-search{padding:40px 24px;text-align:center;color:#8a7866;font-size:14px}

@media(max-width:900px){.page{padding:16px}.stats{grid-template-columns:repeat(2,1fr)}.top-bar{padding:12px 16px}.tbl td,.tbl th{padding:10px 14px}}
</style>
`;

const HEADER = (subtitle='') => `
<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vaani Admin${subtitle ? ' · '+escapeHtml(subtitle) : ''}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${STYLES}
</head><body>
<header class="top-bar">
  <div class="brand"><div class="brand-mark">L</div>Leogo · Vaani Admin</div>
  <div class="admin-chip">GOD MODE</div>
</header>
`;

// ============ LIST ALL TENANTS ============
router.get('/', async (req, res) => {
  try {
    const tenantsRes = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM conversations c WHERE c.tenant_id = t.id) AS conv_count,
        (SELECT COUNT(*) FROM conversations c WHERE c.tenant_id = t.id AND c.last_active > NOW() - INTERVAL '24 hours') AS active_24h,
        (SELECT MAX(c.last_active) FROM conversations c WHERE c.tenant_id = t.id) AS last_chat
      FROM tenants t
      ORDER BY t.id
    `);
    const tenants = tenantsRes.rows;

    const totalsRes = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tenants) AS tenants,
        (SELECT COUNT(*) FROM conversations) AS conversations,
        (SELECT COUNT(*) FROM conversations WHERE last_active > NOW() - INTERVAL '24 hours') AS active_24h,
        (SELECT COALESCE(SUM(jsonb_array_length(messages)), 0) FROM conversations) AS messages
    `);
    const t = totalsRes.rows[0];

    res.send(`${HEADER('All Tenants')}
<main class="page">
  <div>
    <div class="h-title">All Tenants</div>
    <div class="h-sub">${tenants.length} active client${tenants.length===1?'':'s'} · Live data across Leogo's Vaani deployments</div>
  </div>

  <section class="stats">
    <div class="stat-card"><div class="stat-num">${t.tenants}</div><div class="stat-label">Tenants</div><div class="stat-meta">All clients</div></div>
    <div class="stat-card"><div class="stat-num">${t.conversations}</div><div class="stat-label">Total chats</div><div class="stat-meta">All time</div></div>
    <div class="stat-card"><div class="stat-num">${t.active_24h}</div><div class="stat-label">Active 24h</div><div class="stat-meta">Recent activity</div></div>
    <div class="stat-card"><div class="stat-num">${t.messages}</div><div class="stat-label">Messages</div><div class="stat-meta">All time</div></div>
  </section>

  <div class="toolbar">
    <input id="tsearch" type="text" placeholder="Search by store name or domain..." oninput="filterTenants()">
    <div class="chip" data-filter="all" onclick="setFilter(event,'all')" id="chip-all">All</div>
    <div class="chip" data-filter="active" onclick="setFilter(event,'active')">Active 24h</div>
    <div class="chip" data-filter="free" onclick="setFilter(event,'free')">Free tier</div>
    <div class="chip" data-filter="paid" onclick="setFilter(event,'paid')">Paid tiers</div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Client Tenants</div><span id="row-count" style="font-size:12px;color:#8a7866"></span></div>
    <table class="tbl" id="tenant-table">
      <thead><tr><th class="sortable" data-sort="0">Store</th><th class="sortable" data-sort="1">Brand</th><th>Flow</th><th class="sortable" data-sort="3">Tier</th><th class="sortable" data-sort="4">Conversations</th><th class="sortable" data-sort="5">Active 24h</th><th class="sortable" data-sort="6">Last activity</th></tr></thead>
      <tbody>
        ${tenants.map(t => `
          <tr class="clickable" onclick="location.href='/admin/tenant/${t.id}?key=${escapeHtml(req.query.key)}'">
            <td><strong>${escapeHtml(t.store_name || t.shop_domain)}</strong><br><span style="font-size:11.5px;color:#8a7866">${escapeHtml(t.shop_domain)}</span></td>
            <td>${escapeHtml(t.store_name || '—')}</td>
            <td><span class="pill gray">${escapeHtml(t.flow_template || 'default')}</span></td>
            <td><span class="pill ${t.tier==='free'?'gray':'gold'}">${escapeHtml(t.tier || 'free')}</span></td>
            <td>${t.conv_count}</td>
            <td><span class="pill ${t.active_24h > 0 ? 'sage' : 'gray'}">${t.active_24h}</span></td>
            <td style="color:#8a7866">${t.last_chat ? timeAgo(t.last_chat) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</main>

<script>
  // Mark "All" chip active by default
  document.getElementById('chip-all')?.classList.add('active');

  function updateRowCount() {
    const rows = document.querySelectorAll('#tenant-table tbody tr');
    const visible = Array.from(rows).filter(r => !r.classList.contains('hidden')).length;
    const total = rows.length;
    document.getElementById('row-count').textContent = visible === total ? total + ' tenants' : visible + ' of ' + total;
  }

  function filterTenants() {
    const q = (document.getElementById('tsearch')?.value || '').toLowerCase().trim();
    const activeFilter = document.querySelector('.chip.active')?.dataset.filter || 'all';
    document.querySelectorAll('#tenant-table tbody tr').forEach(r => {
      const text = r.textContent.toLowerCase();
      const matchSearch = !q || text.includes(q);
      let matchFilter = true;
      if (activeFilter === 'active') {
        const active24 = parseInt(r.cells[5]?.textContent || '0', 10);
        matchFilter = active24 > 0;
      } else if (activeFilter === 'free') {
        matchFilter = (r.cells[3]?.textContent || '').toLowerCase().includes('free');
      } else if (activeFilter === 'paid') {
        const tier = (r.cells[3]?.textContent || '').toLowerCase();
        matchFilter = !tier.includes('free') && tier.trim() !== '';
      }
      r.classList.toggle('hidden', !(matchSearch && matchFilter));
    });
    updateRowCount();
  }

  function setFilter(e, filter) {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    filterTenants();
  }

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const idx = +th.dataset.sort;
      const tbody = th.closest('table').querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const asc = !th.classList.contains('asc');
      document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('asc','desc'));
      th.classList.add(asc ? 'asc' : 'desc');
      rows.sort((a, b) => {
        const av = a.cells[idx]?.textContent.trim() || '';
        const bv = b.cells[idx]?.textContent.trim() || '';
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });

  updateRowCount();
</script>

</body></html>`);
  } catch (err) {
    console.error('Admin list err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ============ TENANT DETAIL — list all conversations ============
router.get('/tenant/:id', async (req, res) => {
  try {
    const tid = parseInt(req.params.id);
    const tRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tid]);
    const tenant = tRes.rows[0];
    if (!tenant) return res.status(404).send('Tenant not found');

    const convsRes = await pool.query(`
      SELECT id, customer_phone, last_active, jsonb_array_length(messages) AS msg_count,
        (messages->-1->>'content') AS last_msg,
        (messages->-1->>'role') AS last_role
      FROM conversations
      WHERE tenant_id = $1
      ORDER BY last_active DESC
      LIMIT 100
    `, [tid]);
    const convs = convsRes.rows;

    res.send(`${HEADER(tenant.store_name || tenant.shop_domain)}
<main class="page">
  <div>
    <a class="back-link" href="/admin?key=${escapeHtml(req.query.key)}">← All tenants</a>
    <div class="h-title">${escapeHtml(tenant.store_name || tenant.shop_domain)}</div>
    <div class="h-sub">${escapeHtml(tenant.shop_domain)} · Flow: <strong>${escapeHtml(tenant.flow_template)}</strong> · Tier: <strong>${escapeHtml(tenant.tier)}</strong></div>
  </div>

  <section class="stats">
    <div class="stat-card"><div class="stat-num">${convs.length}</div><div class="stat-label">Conversations</div><div class="stat-meta">Shown</div></div>
    <div class="stat-card"><div class="stat-num">${convs.reduce((s,c)=>s+(c.msg_count||0),0)}</div><div class="stat-label">Total messages</div><div class="stat-meta">All chats</div></div>
    <div class="stat-card"><div class="stat-num">${tenant.whatsapp_number || '—'}</div><div class="stat-label">Phone ID</div><div class="stat-meta">${tenant.whatsapp_token ? 'Connected' : 'Not connected'}</div></div>
    <div class="stat-card"><div class="stat-num" style="color:${tenant.shopify_token?'#5c8244':'#c29838'}">●</div><div class="stat-label">Shopify</div><div class="stat-meta">${tenant.shopify_token?'Connected':'Pending'}</div></div>
  </section>

  <div class="card">
    <div class="card-head"><div class="card-title">All Conversations</div><span style="font-size:12px;color:#8a7866">${convs.length} shown · click any row</span></div>
    ${convs.length === 0 ? '<div class="empty">No conversations yet.<br><span style="font-size:12px">Customer messages will appear here once they message the bot.</span></div>' : `
    <table class="tbl">
      <thead><tr><th>Customer</th><th>Last message</th><th>Msgs</th><th>Last activity</th></tr></thead>
      <tbody>
        ${convs.map(c => `
          <tr class="clickable" onclick="location.href='/admin/conv/${c.id}?key=${escapeHtml(req.query.key)}'">
            <td><strong>${maskPhone(c.customer_phone)}</strong></td>
            <td style="color:#5a4a35;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((c.last_msg || '').slice(0,80))}${(c.last_msg||'').length>80?'…':''}</td>
            <td>${c.msg_count}</td>
            <td style="color:#8a7866">${timeAgo(c.last_active)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    `}
  </div>
</main>
</body></html>`);
  } catch (err) {
    console.error('Admin tenant err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ============ CONVERSATION DETAIL — full chat thread ============
router.get('/conv/:id', async (req, res) => {
  try {
    const cid = parseInt(req.params.id);
    const cRes = await pool.query(`
      SELECT c.*, t.store_name, t.shop_domain, t.flow_template
      FROM conversations c
      JOIN tenants t ON c.tenant_id = t.id
      WHERE c.id = $1
    `, [cid]);
    const conv = cRes.rows[0];
    if (!conv) return res.status(404).send('Conversation not found');

    const msgs = Array.isArray(conv.messages) ? conv.messages : [];

    res.send(`${HEADER('Chat')}
<main class="page">
  <div>
    <a class="back-link" href="/admin/tenant/${conv.tenant_id}?key=${escapeHtml(req.query.key)}">← Back to ${escapeHtml(conv.store_name)}</a>
    <div class="h-title">${maskPhone(conv.customer_phone)}</div>
    <div class="h-sub">${msgs.length} messages · Last active ${timeAgo(conv.last_active)} · <strong>${escapeHtml(conv.store_name)}</strong></div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Conversation thread</div></div>
    <div class="chat-thread">
      ${msgs.length === 0 ? '<div class="empty">No messages in this thread yet.</div>' : msgs.map(m => `
        <div class="msg ${m.role === 'user' ? 'user' : 'bot'}">
          <div>
            <div class="bubble">${escapeHtml(m.content || '[no content]')}</div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  ${conv.cart && Object.keys(conv.cart).length > 0 ? `
  <div class="card">
    <div class="card-head"><div class="card-title">Session state (cart)</div></div>
    <pre style="padding:18px 24px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#5a4a35;overflow-x:auto;background:#fbf6ea">${escapeHtml(JSON.stringify(conv.cart, null, 2))}</pre>
  </div>
  ` : ''}
</main>
</body></html>`);
  } catch (err) {
    console.error('Admin conv err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

module.exports = router;
