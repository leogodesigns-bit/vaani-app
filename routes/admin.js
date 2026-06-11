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
.pill.blue{background:#dde6ee;color:#33526b;border:1px solid #b8ccd9}
.pill.orange{background:#fbd8b9;color:#8a4a23;border:1px solid #ecb88a}
.pill.purple{background:#e6dceb;color:#5a3a6e;border:1px solid #ccbad4}
.pill.teal{background:#cee2dd;color:#1f4d47;border:1px solid #a8cdc4}
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

const SUBNAV_STYLES = `
<style>
.subnav{background:#fffdf8;border-bottom:1px solid #ebe3d3;padding:0 32px;display:flex;gap:6px;align-items:center;overflow-x:auto}
.subnav a{display:inline-flex;align-items:center;gap:6px;padding:14px 16px;font-size:13px;font-weight:500;color:#8a7866;text-decoration:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
.subnav a:hover{color:#1a1410}
.subnav a.active{color:#1a1410;border-bottom-color:#b8904d}
.subnav a .count{background:#f0e8d6;color:#5a4a35;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
.subnav a.active .count{background:#fef0d8;color:#8a6a35}
@media(max-width:900px){.subnav{padding:0 16px}.subnav a{padding:12px 12px}}

/* New Lead button + modal (leads page) */
.btn-newlead{margin-left:auto;background:#1a1410;color:#faf7f2;border:none;padding:9px 16px;border-radius:9px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s}
.btn-newlead:hover{background:#3a2e22}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(26,20,16,.55);z-index:200;align-items:flex-start;justify-content:center;padding:60px 20px 20px;overflow-y:auto;backdrop-filter:blur(2px)}
.modal-overlay.open{display:flex}
.modal{background:#fffdf8;border:1px solid #ebe3d3;border-radius:14px;max-width:560px;width:100%;box-shadow:0 30px 80px rgba(26,20,16,.35);max-height:calc(100vh - 80px);overflow-y:auto}
.modal-header{padding:18px 24px;border-bottom:1px solid #f0e8d6;display:flex;justify-content:space-between;align-items:center}
.modal-header h2{font-size:16px;font-weight:600;color:#1a1410;margin:0}
.modal-close{background:none;border:none;font-size:20px;color:#8a7866;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px}
.modal-close:hover{background:#fbf6ea;color:#1a1410}
.modal-body{padding:20px 24px 24px}
.modal-row{margin-bottom:14px}
.modal-label{display:block;font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:6px}
.modal-input,.modal-select{width:100%;padding:9px 12px;border:1px solid #ebe3d3;border-radius:8px;font-family:inherit;font-size:13.5px;background:#faf7f2;color:#1a1410;transition:border-color .15s}
.modal-input:focus,.modal-select:focus{outline:none;border-color:#b8904d;background:#fffdf8}
.modal-services{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.modal-svc-opt{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #ebe3d3;border-radius:8px;background:#faf7f2;cursor:pointer;font-size:13px;color:#1a1410;transition:all .15s}
.modal-svc-opt:hover{background:#fef0d8;border-color:#d4c4a0}
.modal-svc-opt input{accent-color:#b8904d;cursor:pointer}
.modal-svc-opt input:checked + span{font-weight:500}
.modal-svc-opt:has(input:checked){background:#fef0d8;border-color:#b8904d}
.modal-error{background:rgba(196,74,74,.08);border:1px solid rgba(196,74,74,.3);color:#9E2A2A;border-radius:8px;padding:10px 12px;font-size:12.5px;margin-bottom:12px;display:none}
.modal-error.show{display:block}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;padding-top:8px;border-top:1px solid #f0e8d6;margin-top:18px;padding-top:16px}
.modal-actions .btn-cancel{background:transparent;border:1px solid #ebe3d3;color:#5a4a35;padding:9px 18px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer}
.modal-actions .btn-cancel:hover{background:#fbf6ea}
.modal-actions .btn-submit{background:#b8904d;color:white;border:none;padding:9px 18px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer}
.modal-actions .btn-submit:hover{background:#8a6a35}
@media(max-width:560px){.modal-services{grid-template-columns:1fr}}
</style>
`;

const HEADER = (subtitle='', active='tenants', adminKey='') => `
<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vaani Admin${subtitle ? ' · '+escapeHtml(subtitle) : ''}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
${STYLES}
${SUBNAV_STYLES}
</head><body>
<header class="top-bar">
  <div class="brand"><div class="brand-mark">L</div>Leogo · Vaani Admin</div>
  <div class="admin-chip">GOD MODE</div>
</header>
<nav class="subnav">
  <a href="/admin?key=${escapeHtml(adminKey)}" class="${active==='tenants'?'active':''}">Tenants</a>
  <a href="/admin/leads?key=${escapeHtml(adminKey)}" class="${active==='leads'?'active':''}">Leads</a>
</nav>
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
        (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(messages)='array' THEN jsonb_array_length(messages) ELSE 0 END), 0) FROM conversations) AS messages
    `);
    const t = totalsRes.rows[0];

    res.send(`${HEADER('All Tenants', 'tenants', req.query.key)}
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
      SELECT id, customer_phone, last_active, CASE WHEN jsonb_typeof(messages)='array' THEN jsonb_array_length(messages) ELSE 0 END AS msg_count,
        (messages->-1->>'content') AS last_msg,
        (messages->-1->>'role') AS last_role
      FROM conversations
      WHERE tenant_id = $1
      ORDER BY last_active DESC
      LIMIT 100
    `, [tid]);
    const convs = convsRes.rows;

    res.send(`${HEADER(tenant.store_name || tenant.shop_domain, 'tenants', req.query.key)}
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

    res.send(`${HEADER('Chat', 'tenants', req.query.key)}
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

// ============ LEADS — onboarding form submissions ============

const SERVICE_LABELS = {
  vaani_whatsapp:  'Vaani WhatsApp',
  vaani_instagram: 'Vaani Instagram',
  social_media:    'Social Media',
  shopify_website: 'Shopify Website'
};

const TIMELINE_LABELS = {
  asap:           'ASAP',
  '1_month':      'Within a month',
  '1_3_months':   '1–3 months',
  '3_plus_months':'3+ months',
  exploring:      'Exploring'
};

const LEAD_STATUSES = new Set([
  'new', 'contacted', 'negotiating',
  'onboarding_sent', 'onboarding_submitted',
  'active', 'lost', 'archived'
]);

// Defines the visual + label for every status. Keep this map as the
// single source of truth — pill colors, filter chip labels, and
// action-button labels all derive from it.
const STATUS_META = {
  new:                  { cls: 'gold',   text: 'New' },                     // yellow
  contacted:            { cls: 'blue',   text: 'Contacted' },               // blue
  negotiating:          { cls: 'orange', text: 'Negotiating' },             // orange
  onboarding_sent:      { cls: 'purple', text: 'Onboarding sent' },         // purple
  onboarding_submitted: { cls: 'teal',   text: 'Onboarding submitted' },    // teal
  active:               { cls: 'sage',   text: 'Active' },                  // green
  lost:                 { cls: 'rose',   text: 'Lost' },                    // red
  archived:             { cls: 'gray',   text: 'Archived' }                 // grey
};

function statusPill(status) {
  const s = STATUS_META[status] || STATUS_META.new;
  return `<span class="pill ${s.cls}">${s.text}</span>`;
}

function formatPhone(p) {
  if (!p) return '—';
  const s = String(p);
  if (s.length === 12 && s.startsWith('91')) {
    return '+91 ' + s.slice(2, 7) + ' ' + s.slice(7);
  }
  return '+' + s;
}

function websiteLink(url) {
  if (!url) return '';
  const u = url.startsWith('http') ? url : 'https://' + url;
  return u;
}

// ----- list view -----
router.get('/leads', async (req, res) => {
  try {
    const leadsRes = await pool.query(`
      SELECT id, name, business_name, phone, email, services_interested,
             timeline, status, created_at
      FROM onboarding_submissions
      ORDER BY created_at DESC
      LIMIT 500
    `);
    const leads = leadsRes.rows;

    const statsRes = await pool.query(`
      SELECT
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE status = 'new')                      AS new_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS week_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS day_count
      FROM onboarding_submissions
    `);
    const s = statsRes.rows[0];

    res.send(`${HEADER('Leads', 'leads', req.query.key)}
<main class="page">
  <div>
    <div class="h-title">Leads</div>
    <div class="h-sub">Submissions from vaani.website/get-started — newest first</div>
  </div>

  <section class="stats">
    <div class="stat-card"><div class="stat-num">${s.total}</div><div class="stat-label">Total leads</div><div class="stat-meta">All time</div></div>
    <div class="stat-card"><div class="stat-num">${s.new_count}</div><div class="stat-label">New</div><div class="stat-meta">Awaiting reply</div></div>
    <div class="stat-card"><div class="stat-num">${s.week_count}</div><div class="stat-label">Last 7 days</div><div class="stat-meta">Recent</div></div>
    <div class="stat-card"><div class="stat-num">${s.day_count}</div><div class="stat-label">Last 24h</div><div class="stat-meta">Today</div></div>
  </section>

  <div class="toolbar">
    <input id="lsearch" type="text" placeholder="Search name, business, email, phone..." oninput="filterLeads()">
    <div class="chip active" data-filter="all" onclick="setFilter(event,'all')">All</div>
    <div class="chip" data-filter="new" onclick="setFilter(event,'new')">New</div>
    <div class="chip" data-filter="contacted" onclick="setFilter(event,'contacted')">Contacted</div>
    <div class="chip" data-filter="negotiating" onclick="setFilter(event,'negotiating')">Negotiating</div>
    <div class="chip" data-filter="onboarding_sent" onclick="setFilter(event,'onboarding_sent')">Onboarding sent</div>
    <div class="chip" data-filter="onboarding_submitted" onclick="setFilter(event,'onboarding_submitted')">Onboarding submitted</div>
    <div class="chip" data-filter="active" onclick="setFilter(event,'active')">Active</div>
    <div class="chip" data-filter="lost" onclick="setFilter(event,'lost')">Lost</div>
    <div class="chip" data-filter="archived" onclick="setFilter(event,'archived')">Archived</div>
    <button type="button" class="btn-newlead" onclick="document.getElementById('newleadModal').classList.add('open')">+ New Lead</button>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Onboarding submissions</div><span id="row-count" style="font-size:12px;color:#8a7866"></span></div>
    ${leads.length === 0 ? '<div class="empty">No leads yet.<br><span style="font-size:12px">Submissions to /get-started will land here.</span></div>' : `
    <table class="tbl" id="leads-table">
      <thead><tr>
        <th class="sortable" data-sort="0">Name</th>
        <th class="sortable" data-sort="1">Business</th>
        <th>Services</th>
        <th class="sortable" data-sort="3">Timeline</th>
        <th class="sortable" data-sort="4">Status</th>
        <th class="sortable" data-sort="5">Submitted</th>
      </tr></thead>
      <tbody>
        ${leads.map(l => `
          <tr class="clickable" data-status="${escapeHtml(l.status || 'new')}" onclick="location.href='/admin/lead/${l.id}?key=${escapeHtml(req.query.key)}'">
            <td><strong>${escapeHtml(l.name)}</strong><br><span style="font-size:11.5px;color:#8a7866">${escapeHtml(l.email)}</span></td>
            <td>${escapeHtml(l.business_name)}<br><span style="font-size:11.5px;color:#8a7866">${formatPhone(l.phone)}</span></td>
            <td>${(l.services_interested || []).map(svc => `<span class="pill gray" style="margin-right:4px">${escapeHtml(SERVICE_LABELS[svc] || svc)}</span>`).join('')}</td>
            <td style="color:#5a4a35">${escapeHtml(TIMELINE_LABELS[l.timeline] || '—')}</td>
            <td>${statusPill(l.status || 'new')}</td>
            <td style="color:#8a7866">${timeAgo(l.created_at)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    `}
  </div>
</main>

<!-- New Lead modal -->
<div class="modal-overlay" id="newleadModal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <div class="modal-header">
      <h2>Add a new lead</h2>
      <button type="button" class="modal-close" onclick="document.getElementById('newleadModal').classList.remove('open')" aria-label="Close">×</button>
    </div>
    <form class="modal-body" method="POST" action="/admin/leads/create?key=${escapeHtml(req.query.key)}" autocomplete="off">
      <div class="modal-error" id="modalError"></div>

      <div class="modal-row">
        <label class="modal-label" for="nl_name">Name</label>
        <input class="modal-input" id="nl_name" name="name" required maxlength="120" placeholder="Priya Sharma">
      </div>
      <div class="modal-row">
        <label class="modal-label" for="nl_business">Business name</label>
        <input class="modal-input" id="nl_business" name="business_name" required maxlength="160" placeholder="Their brand">
      </div>
      <div class="modal-row">
        <label class="modal-label" for="nl_phone">Phone</label>
        <input class="modal-input" id="nl_phone" name="phone" required maxlength="20" placeholder="919876543210" inputmode="tel">
      </div>
      <div class="modal-row">
        <label class="modal-label" for="nl_email">Email</label>
        <input class="modal-input" id="nl_email" name="email" type="email" required maxlength="160" placeholder="priya@brand.com">
      </div>

      <div class="modal-row">
        <label class="modal-label">Services interested in</label>
        <div class="modal-services">
          <label class="modal-svc-opt"><input type="checkbox" name="services" value="vaani_whatsapp"><span>Vaani WhatsApp Bot</span></label>
          <label class="modal-svc-opt"><input type="checkbox" name="services" value="vaani_instagram"><span>Vaani Instagram Bot</span></label>
          <label class="modal-svc-opt"><input type="checkbox" name="services" value="social_media"><span>Social Media Management</span></label>
          <label class="modal-svc-opt"><input type="checkbox" name="services" value="shopify_website"><span>Shopify Website</span></label>
        </div>
      </div>

      <div class="modal-row">
        <label class="modal-label" for="nl_timeline">Timeline</label>
        <select class="modal-select" id="nl_timeline" name="timeline">
          <option value="">— Not specified —</option>
          <option value="asap">As soon as possible</option>
          <option value="1_month">Within a month</option>
          <option value="1_3_months">1–3 months</option>
          <option value="3_plus_months">3+ months</option>
          <option value="exploring">Just exploring</option>
        </select>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn-cancel" onclick="document.getElementById('newleadModal').classList.remove('open')">Cancel</button>
        <button type="submit" class="btn-submit">Create lead</button>
      </div>
    </form>
  </div>
</div>

<script>
  // Surface a server-side validation error stashed in ?err=…
  (function(){
    const errMap = {
      missing_field: 'Please fill in all required fields (name, business, phone, email).',
      invalid_email: 'That email address looks invalid.',
      invalid_phone: 'Phone must be 8–15 digits.',
      service_required: 'Pick at least one service.',
      invalid_timeline: 'Invalid timeline value.',
      server_error: 'Something went wrong creating the lead. Try again.'
    };
    const params = new URLSearchParams(window.location.search);
    const err = params.get('err');
    if (err && errMap[err]) {
      const box = document.getElementById('modalError');
      box.textContent = errMap[err];
      box.classList.add('show');
      document.getElementById('newleadModal').classList.add('open');
    }
    // Esc to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') document.getElementById('newleadModal').classList.remove('open');
    });
  })();

  function updateRowCount() {
    const rows = document.querySelectorAll('#leads-table tbody tr');
    const visible = Array.from(rows).filter(r => !r.classList.contains('hidden')).length;
    const total = rows.length;
    const el = document.getElementById('row-count');
    if (el) el.textContent = visible === total ? total + ' lead' + (total===1?'':'s') : visible + ' of ' + total;
  }

  function filterLeads() {
    const q = (document.getElementById('lsearch')?.value || '').toLowerCase().trim();
    const activeFilter = document.querySelector('.chip.active')?.dataset.filter || 'all';
    document.querySelectorAll('#leads-table tbody tr').forEach(r => {
      const text = r.textContent.toLowerCase();
      const matchSearch = !q || text.includes(q);
      const matchFilter = activeFilter === 'all' || r.dataset.status === activeFilter;
      r.classList.toggle('hidden', !(matchSearch && matchFilter));
    });
    updateRowCount();
  }

  function setFilter(e, filter) {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    filterLeads();
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
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });

  updateRowCount();
</script>

</body></html>`);
  } catch (err) {
    console.error('Admin leads err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ----- detail view -----
router.get('/lead/:id', async (req, res) => {
  try {
    const lid = parseInt(req.params.id);
    if (!Number.isFinite(lid)) return res.status(400).send('Invalid lead id');
    const lr = await pool.query('SELECT * FROM onboarding_submissions WHERE id = $1', [lid]);
    const lead = lr.rows[0];
    if (!lead) return res.status(404).send('Lead not found');

    const odr = await pool.query('SELECT * FROM onboarding_details WHERE lead_id = $1', [lid]);
    const details = odr.rows[0] || null;

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers.host || 'www.vaani.website';
    const onboardingUrl = `${protocol}://${host}/onboarding?lead=${lid}`;

    const VLAB     = { yes: 'Yes', no: 'No', not_sure: 'Not sure' };
    const LANG     = { english: 'English', hindi: 'Hindi', marathi: 'Marathi', other: 'Other' };
    const TONE     = { fun: 'Fun & Casual', professional: 'Professional', mix: 'Mix of both' };
    const DOM      = { yes: 'Yes', no: 'No, not yet' };
    const LOGO     = { yes: 'Yes', no: 'Not yet' };
    const VSVC     = { whatsapp: 'WhatsApp Bot', instagram: 'Instagram Bot' };
    const CREATION = { full_service: 'Full service (we shoot & edit)', editing_only: 'Editing only (raw videos sent in)' };

    const kvRow = (label, value) => {
      if (value === null || value === undefined || value === '') return '';
      return `<tr><td style="color:#8a7866;width:200px;vertical-align:top">${escapeHtml(label)}</td><td>${value}</td></tr>`;
    };
    const detailsCard = (title, rowsHtml) =>
      `<div class="card"><div class="card-head"><div class="card-title">${escapeHtml(title)}</div></div><table class="tbl"><tbody>${rowsHtml || '<tr><td colspan="2" style="color:#8a7866;font-size:13px;padding:18px 24px">— No details submitted —</td></tr>'}</tbody></table></div>`;

    let onboardingSection = '';

    if (!details) {
      const alreadySent = lead.status === 'onboarding_sent';
      const headPill = alreadySent
        ? '<span class="pill purple">Onboarding sent</span>'
        : '<span class="pill gray">Not yet sent</span>';
      const intro = alreadySent
        ? `Link below was already marked as sent. Copy it again if you need to re-send.`
        : `Send this link to ${escapeHtml(lead.name.split(' ')[0])} to collect their setup details. Click <strong>Start Onboarding</strong> once you've shared it — that marks the lead as sent.`;
      const startBtn = alreadySent ? '' : `
        <form method="POST" action="/admin/lead/${lid}/start-onboarding?key=${escapeHtml(req.query.key)}" style="margin:0">
          <button type="submit" class="chip" style="padding:9px 18px;border:none;background:#b8904d;color:white;cursor:pointer;font-family:inherit;border-radius:9px;font-weight:500">Start Onboarding →</button>
        </form>`;
      onboardingSection = `
  <div class="card">
    <div class="card-head">
      <div class="card-title">Onboarding</div>
      ${headPill}
    </div>
    <div style="padding:18px 24px">
      <p style="color:#5a4a35;font-size:13.5px;line-height:1.55;margin-bottom:14px">${intro}</p>
      <div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">
        <input type="text" readonly value="${escapeHtml(onboardingUrl)}" id="onbUrl" style="flex:1;min-width:280px;padding:9px 14px;border:1px solid #ebe3d3;border-radius:9px;font-family:'JetBrains Mono',monospace;font-size:12.5px;background:#fbf6ea;color:#1a1410">
        <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('onbUrl').value).then(()=>{this.textContent='Copied ✓';setTimeout(()=>this.textContent='Copy link',1800)})" class="chip" style="padding:9px 16px;border:1px solid #ebe3d3;cursor:pointer;font-family:inherit;background:#fffdf8">Copy link</button>
        <a href="${escapeHtml(onboardingUrl)}" target="_blank" rel="noopener" class="chip" style="padding:9px 16px;border:1px solid #ebe3d3;cursor:pointer;font-family:inherit;background:#fffdf8;text-decoration:none;color:#1a1410">Open ↗</a>
        ${startBtn}
      </div>
    </div>
  </div>`;
    } else {
      const vd  = details.vaani_details   || null;
      const sd  = details.social_details  || null;
      const shd = details.shopify_details || null;
      const cards = [];

      cards.push(`
  <div class="card">
    <div class="card-head">
      <div class="card-title">Onboarding</div>
      <span class="pill sage">Submitted ${escapeHtml(timeAgo(details.created_at))}</span>
    </div>
    <div style="padding:18px 24px;font-size:13.5px;color:#5a4a35;line-height:1.55">
      Client submitted their onboarding details on ${new Date(details.created_at).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' })}. Full breakdown below.
    </div>
  </div>`);

      if (vd) {
        const vaaniSvcs = Array.isArray(vd.services) ? vd.services : [];
        const svcHtml = vaaniSvcs.length === 0 ? null
          : vaaniSvcs.map(s => `<span class="pill gold" style="margin-right:6px">${escapeHtml(VSVC[s] || s)}</span>`).join('');
        const rows = [
          kvRow('Vaani services',   svcHtml),
          kvRow('WhatsApp number',  vd.whatsapp_number ? `<a href="tel:${escapeHtml(String(vd.whatsapp_number).replace(/[^0-9+]/g,''))}" style="color:#1a1410;text-decoration:none">${escapeHtml(vd.whatsapp_number)}</a>` : null),
          kvRow('Instagram handle (bot)', vd.instagram_handle ? `<a href="https://instagram.com/${escapeHtml(vd.instagram_handle)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">@${escapeHtml(vd.instagram_handle)} ↗</a>` : null),
          kvRow('Meta Business Manager access', VLAB[vd.meta_access] || null),
          kvRow('Shopify store URL', vd.shopify_url ? `<a href="${escapeHtml(websiteLink(vd.shopify_url))}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">${escapeHtml(vd.shopify_url)} ↗</a>` : null),
          kvRow('Preferred language', LANG[vd.language] || null),
          kvRow('Bot persona name', vd.persona_name ? `<strong>${escapeHtml(vd.persona_name)}</strong>` : null)
        ].filter(Boolean).join('');
        cards.push(detailsCard('Vaani — AI sales bot', rows));
      }

      if (sd) {
        const compHtml = (sd.competitors || [])
          .map(c => `<a href="https://instagram.com/${escapeHtml(c)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none;margin-right:10px">@${escapeHtml(c)} ↗</a>`)
          .join('');
        const rows = [
          kvRow('Instagram handle', sd.instagram_handle ? `<a href="https://instagram.com/${escapeHtml(sd.instagram_handle)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">@${escapeHtml(sd.instagram_handle)} ↗</a>` : null),
          kvRow('Content tone', TONE[sd.tone] || null),
          kvRow('Competitor references', compHtml || null),
          kvRow('Content creation', CREATION[sd.content_creation] || null),
          kvRow('City', sd.city ? escapeHtml(sd.city) : null)
        ].filter(Boolean).join('');
        cards.push(detailsCard('Social Media Management', rows));
      }

      if (shd) {
        const refsHtml = (shd.references || [])
          .map(r => `<a href="${escapeHtml(websiteLink(r))}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none;display:block">${escapeHtml(r)} ↗</a>`)
          .join('');
        const rows = [
          kvRow('Has domain', DOM[shd.has_domain] || null),
          kvRow('Domain', shd.domain ? `<a href="${escapeHtml(websiteLink(shd.domain))}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">${escapeHtml(shd.domain)} ↗</a>` : null),
          kvRow('Product categories', shd.categories ? `<div style="white-space:pre-wrap;line-height:1.55">${escapeHtml(shd.categories)}</div>` : null),
          kvRow('Reference sites', refsHtml || null),
          kvRow('Has logo', LOGO[shd.has_logo] || null),
          kvRow('Brand colors', shd.brand_colors ? escapeHtml(shd.brand_colors) : null)
        ].filter(Boolean).join('');
        cards.push(detailsCard('Shopify Website', rows));
      }

      const uf = Array.isArray(details.uploaded_files) ? details.uploaded_files : [];
      if (uf.length || details.final_notes) {
        const filesHtml = uf.length === 0 ? null
          : uf.map(u => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none;display:block">${escapeHtml(u)} ↗</a>`).join('');
        const rows = [
          kvRow('Brand files', filesHtml),
          kvRow('Final notes', details.final_notes ? `<div style="white-space:pre-wrap;line-height:1.55">${escapeHtml(details.final_notes)}</div>` : null)
        ].filter(Boolean).join('');
        cards.push(detailsCard('Files & final notes', rows));
      }

      onboardingSection = cards.join('');
    }

    const services = (lead.services_interested || [])
      .map(s => SERVICE_LABELS[s] || s);
    const igLink = lead.instagram_handle
      ? `<a href="https://instagram.com/${escapeHtml(lead.instagram_handle)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">@${escapeHtml(lead.instagram_handle)} ↗</a>`
      : '—';
    const webHref = lead.current_website ? websiteLink(lead.current_website) : '';
    const webLink = lead.current_website
      ? `<a href="${escapeHtml(webHref)}" target="_blank" rel="noopener" style="color:#b8904d;text-decoration:none">${escapeHtml(lead.current_website)} ↗</a>`
      : '—';

    res.send(`${HEADER(lead.name || ('Lead #' + lid), 'leads', req.query.key)}
<main class="page">
  <div>
    <a class="back-link" href="/admin/leads?key=${escapeHtml(req.query.key)}">← All leads</a>
    <div class="h-title">${escapeHtml(lead.name)} · ${escapeHtml(lead.business_name)}</div>
    <div class="h-sub">
      Submitted ${timeAgo(lead.created_at)} ·
      Status: ${statusPill(lead.status || 'new')}
      ${lead.contacted_at ? ' · Contacted ' + timeAgo(lead.contacted_at) : ''}
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-title">Contact</div>
      <form method="POST" action="/admin/lead/${lid}/status?key=${escapeHtml(req.query.key)}" style="display:flex;gap:8px">
        ${lead.status !== 'contacted'   ? `<button type="submit" name="status" value="contacted"   class="chip" style="border:1px solid #b8ccd9;background:#dde6ee;color:#33526b;cursor:pointer;font-family:inherit">Contacted</button>` : ''}
        ${lead.status !== 'negotiating' ? `<button type="submit" name="status" value="negotiating" class="chip" style="border:1px solid #ecb88a;background:#fbd8b9;color:#8a4a23;cursor:pointer;font-family:inherit">Negotiating</button>` : ''}
        ${lead.status !== 'active'      ? `<button type="submit" name="status" value="active"      class="chip" style="border:1px solid #c5d4b3;background:#e8ede0;color:#4a5c33;cursor:pointer;font-family:inherit">Mark Active</button>` : ''}
        ${lead.status !== 'lost'        ? `<button type="submit" name="status" value="lost"        class="chip" style="border:1px solid #e0b8b2;background:#f5e3e0;color:#8a3e35;cursor:pointer;font-family:inherit">Mark Lost</button>` : ''}
        ${lead.status !== 'archived'    ? `<button type="submit" name="status" value="archived"    class="chip" style="border:1px solid #d4c4a0;background:#f0e8d6;color:#5a4a35;cursor:pointer;font-family:inherit">Archive</button>` : ''}
      </form>
    </div>
    <div style="padding:18px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px 28px">
      <div><div style="font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px">Phone</div><div style="font-size:14px"><a href="tel:+${escapeHtml(lead.phone)}" style="color:#1a1410;text-decoration:none">${formatPhone(lead.phone)}</a></div></div>
      <div><div style="font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px">Email</div><div style="font-size:14px"><a href="mailto:${escapeHtml(lead.email)}" style="color:#1a1410;text-decoration:none">${escapeHtml(lead.email)}</a></div></div>
      <div><div style="font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px">Instagram</div><div style="font-size:14px">${igLink}</div></div>
      <div><div style="font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px">Website</div><div style="font-size:14px">${webLink}</div></div>
      <div><div style="font-size:11px;color:#8a7866;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px">Timeline</div><div style="font-size:14px">${escapeHtml(TIMELINE_LABELS[lead.timeline] || '—')}</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Services interested in</div></div>
    <div style="padding:18px 24px">
      ${services.length === 0 ? '<span style="color:#8a7866;font-size:13px">None specified.</span>' :
        services.map(s => `<span class="pill gold" style="margin-right:6px;margin-bottom:6px;display:inline-block">${escapeHtml(s)}</span>`).join('')}
    </div>
  </div>

  ${onboardingSection}

  <div class="card">
    <div class="card-head"><div class="card-title">About the business</div></div>
    <div style="padding:18px 24px;font-size:14px;color:#1a1410;line-height:1.6;white-space:pre-wrap">${escapeHtml(lead.business_description || '— No description provided —')}</div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Anything else</div></div>
    <div style="padding:18px 24px;font-size:14px;color:#1a1410;line-height:1.6;white-space:pre-wrap">${escapeHtml(lead.additional_notes || '— Nothing extra —')}</div>
  </div>

  <div class="card">
    <div class="card-head"><div class="card-title">Submission metadata</div></div>
    <table class="tbl">
      <tbody>
        <tr><td style="color:#8a7866;width:180px">Submitted</td><td>${new Date(lead.created_at).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' })}</td></tr>
        <tr><td style="color:#8a7866">Source</td><td>${escapeHtml(lead.source || '—')}</td></tr>
        <tr><td style="color:#8a7866">Client IP</td><td style="font-family:'JetBrains Mono',monospace;font-size:12px">${escapeHtml(lead.client_ip || '—')}</td></tr>
        <tr><td style="color:#8a7866">User agent</td><td style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#5a4a35;word-break:break-all">${escapeHtml(lead.user_agent || '—')}</td></tr>
      </tbody>
    </table>
  </div>
</main>
</body></html>`);
  } catch (err) {
    console.error('Admin lead detail err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ----- status update -----
router.post('/lead/:id/status', async (req, res) => {
  try {
    const lid = parseInt(req.params.id);
    if (!Number.isFinite(lid)) return res.status(400).send('Invalid lead id');
    const next = String(req.body?.status || '').trim();
    if (!LEAD_STATUSES.has(next)) return res.status(400).send('Invalid status');

    await pool.query(
      `UPDATE onboarding_submissions
         SET status = $1,
             contacted_at = CASE WHEN $1 = 'contacted' THEN NOW() ELSE contacted_at END
       WHERE id = $2`,
      [next, lid]
    );
    res.redirect(`/admin/lead/${lid}?key=${encodeURIComponent(req.query.key)}`);
  } catch (err) {
    console.error('Admin lead status err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ----- Start onboarding (admin marks lead as 'onboarding_sent') -----
router.post('/lead/:id/start-onboarding', async (req, res) => {
  try {
    const lid = parseInt(req.params.id);
    if (!Number.isFinite(lid)) return res.status(400).send('Invalid lead id');
    await pool.query(
      `UPDATE onboarding_submissions
          SET status = 'onboarding_sent',
              contacted_at = COALESCE(contacted_at, NOW())
        WHERE id = $1`,
      [lid]
    );
    res.redirect(`/admin/lead/${lid}?key=${encodeURIComponent(req.query.key)}`);
  } catch (err) {
    console.error('Admin start-onboarding err:', err);
    res.status(500).send('<h2>Error: ' + escapeHtml(err.message) + '</h2>');
  }
});

// ----- Create a new lead from the admin modal -----
const ALLOWED_LEAD_SERVICES = new Set(['vaani_whatsapp','vaani_instagram','social_media','shopify_website']);
const ALLOWED_LEAD_TIMELINES = new Set(['asap','1_month','1_3_months','3_plus_months','exploring']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/leads/create', async (req, res) => {
  const key = encodeURIComponent(req.query.key || '');
  const back = (err) => res.redirect(`/admin/leads?key=${key}&err=${err}`);

  try {
    const b = req.body || {};
    const name         = String(b.name || '').trim().slice(0, 120);
    const businessName = String(b.business_name || '').trim().slice(0, 160);
    const email        = String(b.email || '').trim().slice(0, 160).toLowerCase();
    const phoneDigits  = String(b.phone || '').replace(/[^0-9]/g, '');
    const timelineRaw  = String(b.timeline || '').trim();

    if (!name || !businessName || !phoneDigits || !email) return back('missing_field');
    if (!EMAIL_RE.test(email)) return back('invalid_email');
    if (phoneDigits.length < 8 || phoneDigits.length > 15) return back('invalid_phone');
    if (timelineRaw && !ALLOWED_LEAD_TIMELINES.has(timelineRaw)) return back('invalid_timeline');

    // services_interested can arrive as a string (one box) or array (many).
    const rawSvcs = Array.isArray(b.services) ? b.services : (b.services ? [b.services] : []);
    const services = [...new Set(rawSvcs.filter(s => ALLOWED_LEAD_SERVICES.has(s)))];
    if (services.length === 0) return back('service_required');

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);

    const ins = await pool.query(
      `INSERT INTO onboarding_submissions
         (name, business_name, phone, email, services_interested,
          timeline, source, client_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [name, businessName, phoneDigits, email, services,
       timelineRaw || null, 'admin-created', ip || null, ua || null]
    );
    res.redirect(`/admin/lead/${ins.rows[0].id}?key=${key}`);
  } catch (err) {
    console.error('Admin lead-create err:', err && err.message);
    return back('server_error');
  }
});

module.exports = router;
