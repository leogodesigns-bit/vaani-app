const express = require('express');
const router = express.Router();
// Pool now imported from ../db

const { pool } = require('../db');

// Demo WhatsApp link — click-to-chat with IKAA demo store
const DEMO_WA_LINK = 'https://wa.me/15556338949?text=Hi';

// Sample data for fresh installs (CLEARLY labeled as "Example preview" in the UI)
const SAMPLE_CONVERSATIONS = [
  { initials: 'PS', name: 'Priya S.', preview: 'Shortlisted 2 silver rings', time: '12 min ago', color: 'gold' },
  { initials: 'RK', name: 'Rohan K.', preview: 'Checkout link sent — ₹2,450', time: '1 hr ago', color: 'sage' },
  { initials: 'AM', name: 'Anjali M.', preview: 'Browsing earrings collection', time: '3 hrs ago', color: 'rose' }
];

router.get('/', async (req, res) => {
  const shop = req.query.shop;
  const firstInstall = req.query.first_install === '1';

  if (!shop) return res.send(`
    <html><body style="font-family:'Inter',-apple-system,sans-serif;text-align:center;padding:80px;background:#faf7f2;color:#1a1410">
    <h2 style="font-weight:500">Vaani Dashboard</h2>
    <p style="color:#8a7866">Please open this page from your Shopify admin.</p>
    </body></html>
  `);

  const t = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shop]);
  const tenant = t.rows[0];
  if (!tenant) return res.status(404).send(`
    <html><body style="font-family:'Inter',sans-serif;text-align:center;padding:80px;background:#faf7f2;color:#1a1410">
    <h2 style="font-weight:500">Store not found</h2>
    <p style="color:#8a7866">Please install Vaani first.</p>
    </body></html>
  `);

  // Get message stats
  const stats = await pool.query(
    `SELECT COUNT(*) as total_conversations,
     SUM(CASE WHEN message_month = $1 THEN monthly_messages ELSE 0 END) as messages_this_month
     FROM conversations WHERE tenant_id = $2`,
    [new Date().toISOString().slice(0, 7), tenant.id]
  );
  const s = stats.rows[0];

  // Get recent conversations (real data)
  const recentConvs = await pool.query(
    `SELECT id, customer_phone, last_active, jsonb_array_length(messages) AS msg_count,
            (messages->-1->>'content') AS last_msg
     FROM conversations
     WHERE tenant_id = $1
     ORDER BY last_active DESC
     LIMIT 5`,
    [tenant.id]
  ).catch((err) => { console.error('Dashboard query err:', err.message); return { rows: [] }; })

  const hasRealConversations = recentConvs.rows.length > 0;
  const conversationsToShow = hasRealConversations
    ? recentConvs.rows.map((c, i) => ({
        initials: maskInitials(c.customer_number),
        name: maskNumber(c.customer_number),
        preview: c.last_action || 'Active chat',
        time: timeAgo(c.updated_at),
        color: ['gold', 'sage', 'rose', 'gold', 'sage'][i] || 'gold'
      }))
    : SAMPLE_CONVERSATIONS;

  const tierLabels = {
    free: 'Free',
    standard: 'Standard',
    premium: 'Premium',
    custom: 'Custom'
  };
  const tierLabel = tierLabels[tenant.tier] || 'Free';
  const msgLimit = tenant.tier === 'free' ? 70 : '∞';
  const hasOwnWA = !!(tenant.whatsapp_number && tenant.whatsapp_token);
  const messagesThisMonth = Number(s.messages_this_month) || 0;
  const totalConversations = Number(s.total_conversations) || 0;

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<title>Vaani — ${shop}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #faf7f2;
    color: #1a1410;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
  }

  /* ============ HEADER ============ */
  .top-bar {
    background: #1a1410;
    color: #faf7f2;
    padding: 14px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #2a1f18;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .brand-mark {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    background: linear-gradient(135deg, #b8904d 0%, #8a6a35 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #1a1410;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: -0.02em;
  }
  .shop-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 13px;
    color: #c9b690;
  }
  .shop-meta .sep { color: #5a4a35; }
  .tier-chip {
    background: rgba(184, 144, 77, 0.15);
    color: #d4b372;
    border: 1px solid rgba(184, 144, 77, 0.3);
    padding: 4px 11px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  /* ============ WELCOME BANNER ============ */
  .welcome-banner {
    max-width: 1200px;
    margin: 24px auto 0;
    background: linear-gradient(135deg, #fff8eb 0%, #fef0d8 100%);
    border: 1px solid #e8d5a7;
    border-radius: 12px;
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    color: #6b4d1e;
  }
  .welcome-banner .wb-icon {
    font-size: 18px;
  }
  .welcome-banner strong { color: #3d2a0e; font-weight: 600; }

  /* ============ LAYOUT ============ */
  .page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 32px 48px;
    display: grid;
    gap: 20px;
  }

  /* ============ HERO ============ */
  .hero {
    background: #1a1410;
    color: #faf7f2;
    border-radius: 16px;
    padding: 32px 36px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 32px;
    align-items: center;
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: '';
    position: absolute;
    top: -100px;
    right: -100px;
    width: 280px;
    height: 280px;
    background: radial-gradient(circle, rgba(184, 144, 77, 0.12) 0%, transparent 70%);
    pointer-events: none;
  }
  .hero-content {
    position: relative;
    z-index: 1;
  }
  .hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #d4b372;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .hero-eyebrow::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #25d366;
    box-shadow: 0 0 0 4px rgba(37, 211, 102, 0.2);
  }
  .hero h1 {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 10px;
    color: #faf7f2;
    line-height: 1.2;
  }
  .hero p {
    color: #a89a82;
    font-size: 14.5px;
    line-height: 1.55;
    max-width: 520px;
  }
  .hero p strong { color: #d4b372; font-weight: 500; }
  .hero-cta {
    position: relative;
    z-index: 1;
  }
  .wa-btn {
    background: #25d366;
    color: #022d1b;
    padding: 14px 24px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 14.5px;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    white-space: nowrap;
    transition: transform 0.15s, background 0.15s;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }
  .wa-btn:hover { background: #20bd5a; transform: translateY(-1px); }
  .wa-btn:active { transform: translateY(0); }
  .wa-btn svg { width: 18px; height: 18px; }
  .hero-hint {
    color: #6b5a42;
    font-size: 12px;
    margin-top: 10px;
    display: block;
  }

  /* ============ STATS GRID ============ */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  .stat-card {
    background: #fffdf8;
    border: 1px solid #ebe3d3;
    border-radius: 14px;
    padding: 20px 22px;
  }
  .stat-num {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: #1a1410;
    line-height: 1;
    font-feature-settings: 'tnum' 1, 'lnum' 1;
  }
  .stat-num .unit {
    font-size: 15px;
    font-weight: 500;
    color: #8a7866;
    margin-left: 2px;
  }
  .stat-label {
    font-size: 11.5px;
    color: #8a7866;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .stat-meta {
    font-size: 11.5px;
    color: #b8904d;
    margin-top: 10px;
    font-weight: 500;
  }

  /* ============ TWO-COLUMN ============ */
  .two-col {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 20px;
  }

  /* ============ CARDS ============ */
  .card {
    background: #fffdf8;
    border: 1px solid #ebe3d3;
    border-radius: 14px;
    padding: 24px 26px;
  }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid #f0e8d6;
  }
  .card-title {
    font-size: 12px;
    font-weight: 600;
    color: #8a7866;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .card-title-main {
    font-size: 15px;
    font-weight: 600;
    color: #1a1410;
    letter-spacing: -0.01em;
  }
  .preview-badge {
    background: #fef0d8;
    color: #8a6a35;
    font-size: 10.5px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 10px;
    letter-spacing: 0.02em;
    border: 1px solid #e8d5a7;
  }

  /* ============ CONVERSATIONS ============ */
  .conv-list {
    display: flex;
    flex-direction: column;
  }
  .conv-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 0;
    border-bottom: 1px solid #f0e8d6;
  }
  .conv-item:last-child { border-bottom: none; padding-bottom: 0; }
  .conv-item:first-child { padding-top: 0; }
  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    flex-shrink: 0;
  }
  .avatar.gold { background: #fef0d8; color: #8a6a35; }
  .avatar.sage { background: #e8ede0; color: #4a5c33; }
  .avatar.rose { background: #f5e3e0; color: #8a3e35; }
  .conv-body { flex: 1; min-width: 0; }
  .conv-name {
    font-size: 13.5px;
    font-weight: 500;
    color: #1a1410;
    line-height: 1.3;
  }
  .conv-preview {
    font-size: 12px;
    color: #8a7866;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conv-time {
    font-size: 11.5px;
    color: #8a7866;
    flex-shrink: 0;
  }

  /* ============ STATUS LIST ============ */
  .status-list { display: flex; flex-direction: column; gap: 4px; }
  .status-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 0;
    font-size: 13.5px;
    color: #1a1410;
    border-bottom: 1px solid #f0e8d6;
  }
  .status-item:last-child { border-bottom: none; padding-bottom: 0; }
  .status-item:first-child { padding-top: 0; }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.good { background: #5c8244; box-shadow: 0 0 0 3px rgba(92, 130, 68, 0.15); }
  .status-dot.pending { background: #c29838; box-shadow: 0 0 0 3px rgba(194, 152, 56, 0.15); }
  .status-label { flex: 1; font-weight: 500; }
  .status-desc { color: #8a7866; font-size: 12px; font-weight: 400; }

  /* ============ PERSONA ============ */
  .persona-textarea {
    width: 100%;
    min-height: 90px;
    padding: 12px 14px;
    border: 1px solid #ebe3d3;
    border-radius: 10px;
    font-family: inherit;
    font-size: 13.5px;
    color: #1a1410;
    background: #faf7f2;
    resize: vertical;
    line-height: 1.55;
    transition: border 0.15s;
  }
  .persona-textarea:focus {
    outline: none;
    border-color: #b8904d;
    background: #fffdf8;
  }

  /* ============ BUTTONS ============ */
  .btn {
    padding: 10px 18px;
    border: 1px solid #1a1410;
    background: #1a1410;
    color: #faf7f2;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn:hover { background: #2a1f18; }
  .btn.ghost {
    background: transparent;
    color: #1a1410;
    border: 1px solid #ebe3d3;
  }
  .btn.ghost:hover { background: #faf7f2; border-color: #d4c4a0; }
  .btn-row { margin-top: 14px; display: flex; gap: 10px; align-items: center; }

  /* ============ ACCORDION ============ */
  details.accordion {
    background: #fffdf8;
    border: 1px solid #ebe3d3;
    border-radius: 14px;
    overflow: hidden;
  }
  details.accordion summary {
    padding: 18px 26px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: #1a1410;
    list-style: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
  }
  details.accordion summary::-webkit-details-marker { display: none; }
  details.accordion summary::after {
    content: '';
    width: 8px;
    height: 8px;
    border-right: 1.5px solid #8a7866;
    border-bottom: 1.5px solid #8a7866;
    transform: rotate(45deg);
    transition: transform 0.2s;
    margin-top: -4px;
  }
  details.accordion[open] summary::after { transform: rotate(-135deg); margin-top: 2px; }
  details.accordion .ac-content {
    padding: 4px 26px 24px;
    border-top: 1px solid #f0e8d6;
    margin-top: -1px;
    padding-top: 18px;
  }

  /* ============ ADVANCED ============ */
  .field { margin-bottom: 14px; }
  .field label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #5a4a35;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .field input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid #ebe3d3;
    border-radius: 9px;
    font-family: inherit;
    font-size: 13.5px;
    color: #1a1410;
    background: #faf7f2;
    transition: border 0.15s;
  }
  .field input:focus {
    outline: none;
    border-color: #b8904d;
    background: #fffdf8;
  }
  .copy-box {
    background: #faf7f2;
    border: 1px solid #ebe3d3;
    border-radius: 9px;
    padding: 10px 14px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12.5px;
    color: #5a4a35;
    word-break: break-all;
    cursor: pointer;
    transition: background 0.15s;
  }
  .copy-box:hover { background: #fef9ed; border-color: #d4c4a0; }

  /* ============ CATEGORY TAGS ============ */
  .tag-cloud { margin: 6px 0 16px; }
  .cat-tag {
    display: inline-block;
    padding: 5px 12px;
    margin: 3px 5px 3px 0;
    background: #fef0d8;
    color: #6b4d1e;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid #e8d5a7;
  }

  /* ============ UPGRADE ============ */
  .upgrade-card {
    background: linear-gradient(135deg, #1a1410 0%, #2a1f18 100%);
    color: #faf7f2;
    border-radius: 14px;
    padding: 24px 26px;
    border: 1px solid #3a2f25;
  }
  .upgrade-card .eyebrow {
    color: #d4b372;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .upgrade-card h3 {
    font-size: 17px;
    font-weight: 600;
    color: #faf7f2;
    letter-spacing: -0.01em;
    margin-bottom: 8px;
  }
  .upgrade-card p {
    color: #a89a82;
    font-size: 13.5px;
    line-height: 1.55;
    margin-bottom: 16px;
  }
  .upgrade-card .btn {
    background: #d4b372;
    color: #1a1410;
    border: none;
    font-weight: 600;
  }
  .upgrade-card .btn:hover { background: #b8904d; }

  /* ============ FOOTER ============ */
  .footer {
    text-align: center;
    color: #8a7866;
    font-size: 13px;
    padding: 8px 0;
  }
  .footer a { color: #b8904d; text-decoration: none; font-weight: 500; }
  .footer a:hover { color: #8a6a35; text-decoration: underline; }

  /* ============ TOAST ============ */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1a1410;
    color: #faf7f2;
    padding: 12px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 500;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    z-index: 100;
    border: 1px solid #b8904d;
  }
  .toast.show { opacity: 1; transform: translateY(0); }

  /* ============ RESPONSIVE ============ */
  @media (max-width: 900px) {
    .page { padding: 16px; }
    .hero { grid-template-columns: 1fr; gap: 20px; padding: 24px; }
    .hero h1 { font-size: 22px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .two-col { grid-template-columns: 1fr; }
    .top-bar { padding: 12px 16px; }
    .shop-meta .sep { display: none; }
  }
  @media (max-width: 480px) {
    .stats { grid-template-columns: 1fr; }
    .hero { padding: 20px; }
  }
</style>
</head>
<body>

<header class="top-bar">
  <div class="brand">
    <div class="brand-mark">V</div>
    Vaani
  </div>
  <div class="shop-meta">
    <span>${escapeHtml(shop)}</span>
    <span class="sep">·</span>
    <span class="tier-chip">${tierLabel}</span>
  </div>
</header>

${firstInstall ? `
<div class="welcome-banner">
  <span class="wb-icon">✦</span>
  <span><strong>Welcome to Vaani.</strong> Your store is connected. Tap the WhatsApp button below to see exactly what your customers will experience.</span>
</div>
` : ''}

<main class="page">

  <!-- HERO -->
  <section class="hero">
    <div class="hero-content">
      <span class="hero-eyebrow">Demo active</span>
      <h1>Experience Vaani the way your customers will</h1>
      <p>Open WhatsApp and chat with a live demo running on <strong>${escapeHtml(shop)}</strong>. Browse your products, build a shortlist, and receive a real Shopify checkout link — all in under 60 seconds.</p>
    </div>
    <div class="hero-cta">
      <a href="${DEMO_WA_LINK}" target="_blank" rel="noopener" class="wa-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
        Open WhatsApp demo
      </a>
      <span class="hero-hint">Opens in new tab · Best on mobile</span>
    </div>
  </section>

  <!-- STATS -->
  <section class="stats">
    <div class="stat-card">
      <div class="stat-num">${messagesThisMonth.toLocaleString('en-IN')}</div>
      <div class="stat-label">Messages this month</div>
      <div class="stat-meta">Limit: ${msgLimit}</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${totalConversations.toLocaleString('en-IN')}</div>
      <div class="stat-label">Total conversations</div>
      <div class="stat-meta">${totalConversations === 0 ? 'Your first chat will appear here' : 'All time'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${totalConversations > 0 ? Math.round(messagesThisMonth / Math.max(totalConversations, 1)) : '—'}</div>
      <div class="stat-label">Avg messages per chat</div>
      <div class="stat-meta">${totalConversations > 0 ? 'This month' : 'Awaiting first chat'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:#5c8244">●</div>
      <div class="stat-label">Bot status</div>
      <div class="stat-meta">Active — responding now</div>
    </div>
  </section>

  <!-- TWO-COLUMN: Conversations + Status -->
  <section class="two-col">
    <!-- Recent conversations -->
    <div class="card">
      <div class="card-head">
        <div class="card-title-main">Recent conversations</div>
        ${!hasRealConversations ? '<span class="preview-badge">Example preview</span>' : ''}
      </div>
      <div class="conv-list">
        ${conversationsToShow.map(c => `
          <div class="conv-item" ${c.id ? `onclick="location.href='/dashboard/chat/${c.id}?shop=${encodeURIComponent(shop)}'" style="cursor:pointer"` : ''}>
            <div class="avatar ${c.color}">${escapeHtml(c.initials)}</div>
            <div class="conv-body">
              <div class="conv-name">${escapeHtml(c.name)}${c.msgCount ? ` <span style="color:#8a7866;font-weight:400;font-size:11.5px">· ${c.msgCount} msgs</span>` : ''}</div>
              <div class="conv-preview">${escapeHtml(c.preview)}</div>
            </div>
            <div class="conv-time">${escapeHtml(c.time)}</div>
          </div>
        `).join('')}
      </div>
      ${!hasRealConversations ? `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid #f0e8d6;font-size:12.5px;color:#8a7866;text-align:center;line-height:1.5">
          These are sample conversations for illustration.<br>Your real customer chats will appear here once Vaani starts receiving messages.
        </div>
      ` : ''}
    </div>

    <!-- Setup status -->
    <div class="card">
      <div class="card-head">
        <div class="card-title-main">Setup status</div>
      </div>
      <div class="status-list">
        <div class="status-item">
          <span class="status-dot good"></span>
          <div class="status-label">Shopify connected <span class="status-desc">— products &amp; orders</span></div>
        </div>
        <div class="status-item">
          <span class="status-dot good"></span>
          <div class="status-label">Demo mode <span class="status-desc">— try above</span></div>
        </div>
        <div class="status-item">
          <span class="status-dot ${hasOwnWA ? 'good' : 'pending'}"></span>
          <div class="status-label">${hasOwnWA ? 'WhatsApp connected' : 'WhatsApp — optional'} <span class="status-desc">${hasOwnWA ? '— your own branded number' : '— connect below when ready'}</span></div>
        </div>
        <div class="status-item">
          <span class="status-dot ${tenant.brand_prompt ? 'good' : 'pending'}"></span>
          <div class="status-label">Bot persona <span class="status-desc">${tenant.brand_prompt ? '— configured' : '— default voice (edit below)'}</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- PERSONA -->
  <section class="card">
    <div class="card-head">
      <div class="card-title-main">Bot persona</div>
    </div>
    <p style="font-size:13px;color:#8a7866;margin-bottom:12px">How should Vaani introduce itself to your customers?</p>
    <textarea class="persona-textarea" id="brand_prompt" placeholder="e.g. You are Priya, a warm and helpful assistant for our store. Greet customers by name when possible, suggest products based on occasions, and keep replies short and kind.">${escapeHtml(tenant.brand_prompt || '')}</textarea>
    <div class="btn-row">
      <button class="btn" onclick="saveBrand()">Save persona</button>
    </div>
  </section>

  <!-- CATEGORIES -->
  <details class="accordion">
    <summary>Product categories</summary>
    <div class="ac-content">
      <p style="font-size:13px;color:#8a7866;margin-bottom:12px">Vaani auto-organises your products into browseable categories. Refreshes weekly, or refresh now:</p>
      <div class="tag-cloud">
        ${tenant.categories && tenant.categories.length ? tenant.categories.map(c => `<span class="cat-tag">${escapeHtml(c.name || c)}</span>`).join('') : '<span style="color:#8a7866;font-size:13px">No categories yet — send a message to your bot to generate them, or refresh now.</span>'}
      </div>
      <button class="btn ghost" onclick="refreshCategories(event)">Refresh categories</button>
    </div>
  </details>

  <!-- ADVANCED: Connect own WhatsApp -->
  <details class="accordion">
    <summary>Advanced · Connect your own WhatsApp Business number</summary>
    <div class="ac-content">
      <p style="font-size:13px;color:#8a7866;margin-bottom:16px;line-height:1.6">Ready to go live with your own branded WhatsApp number? Paste your Meta WhatsApp Business API credentials below. Until then, keep testing with the demo number above.</p>

      <div class="field">
        <label>Webhook URL — paste in Meta Developer Console</label>
        <div class="copy-box" onclick="copyToClipboard(this)">${escapeHtml(process.env.APP_URL || '')}/webhook</div>
      </div>
      <div class="field">
        <label>Verify Token — also for Meta</label>
        <div class="copy-box" onclick="copyToClipboard(this)">${escapeHtml(process.env.WHATSAPP_VERIFY_TOKEN || 'vaani_verify_token')}</div>
      </div>
      <div class="field">
        <label>Phone Number ID (from Meta)</label>
        <input type="text" id="phone_number_id" value="${escapeHtml(tenant.whatsapp_number || '')}" placeholder="e.g. 997421573464360">
      </div>
      <div class="field">
        <label>WhatsApp Access Token (from Meta)</label>
        <input type="password" id="whatsapp_token" value="${tenant.whatsapp_token ? '••••••••' : ''}" placeholder="Paste your Meta access token">
      </div>
      <div class="btn-row">
        <button class="btn" onclick="saveWhatsApp()">Save settings</button>
        <a href="mailto:leogodesigns@gmail.com" style="color:#b8904d;font-size:13px;text-decoration:none;font-weight:500">Need help with Meta setup?</a>
      </div>
    </div>
  </details>

  ${tenant.tier === 'free' ? `
  <section class="upgrade-card">
    <div class="eyebrow">Upgrade</div>
    <h3>Unlock unlimited messages</h3>
    <p>You've used ${messagesThisMonth} of 70 free messages this month. Upgrade to Standard for unlimited messages, abandoned cart recovery, and priority support — 7 day free trial.</p>
    <a href="/pricing?shop=${encodeURIComponent(shop)}"><button class="btn">View plans</button></a>
  </section>
  ` : ''}

  <div class="footer">
    Need a hand? Email <a href="mailto:leogodesigns@gmail.com">leogodesigns@gmail.com</a> — we reply within 24 hours.
  </div>

</main>

<div class="toast" id="toast"></div>

<script>
  function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.borderColor = type === 'error' ? '#c23838' : '#b8904d';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2600);
  }

  function copyToClipboard(el) {
    navigator.clipboard.writeText(el.textContent.trim());
    showToast('Copied to clipboard');
  }

  async function saveWhatsApp() {
    const phone = document.getElementById('phone_number_id').value.trim();
    const token = document.getElementById('whatsapp_token').value.trim();
    if (token === '••••••••') {
      showToast('Please enter your actual access token', 'error');
      return;
    }
    try {
      const res = await fetch('/dashboard/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ shop: ${JSON.stringify(shop)}, whatsapp_number: phone, whatsapp_token: token })
      });
      const data = await res.json();
      showToast(data.success ? 'WhatsApp settings saved' : ('Error: ' + (data.error || 'unknown')), data.success ? 'ok' : 'error');
      if (data.success) setTimeout(() => location.reload(), 1000);
    } catch (e) {
      showToast('Network error — please retry', 'error');
    }
  }

  async function saveBrand() {
    const prompt = document.getElementById('brand_prompt').value;
    try {
      const res = await fetch('/dashboard/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ shop: ${JSON.stringify(shop)}, brand_prompt: prompt })
      });
      const data = await res.json();
      showToast(data.success ? 'Persona saved' : ('Error: ' + (data.error || 'unknown')), data.success ? 'ok' : 'error');
    } catch (e) {
      showToast('Network error — please retry', 'error');
    }
  }

  async function refreshCategories(evt) {
    const btn = evt.target;
    const originalText = btn.textContent;
    btn.textContent = 'Refreshing...';
    btn.disabled = true;
    try {
      const res = await fetch('/dashboard/refresh-categories', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ shop: ${JSON.stringify(shop)} })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Categories refreshed — ' + data.categories.length + ' groups');
        setTimeout(() => location.reload(), 1000);
      } else {
        showToast('Error: ' + (data.error || 'unknown'), 'error');
        btn.textContent = originalText;
        btn.disabled = false;
      }
    } catch (e) {
      showToast('Network error — please retry', 'error');
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
</script>

</body></html>`);
});

// --- helpers ---

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskNumber(num) {
  if (!num) return 'Customer';
  const s = String(num);
  if (s.length <= 4) return s;
  return '+' + s.slice(0, 2) + ' •••• ' + s.slice(-4);
}

function maskInitials(num) {
  if (!num) return 'C';
  const s = String(num);
  return s.slice(-2).toUpperCase();
}

function timeAgo(d) {
  if (!d) return '';
  const now = new Date();
  const then = new Date(d);
  const secs = Math.floor((now - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' hr ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + ' day' + (days > 1 ? 's' : '') + ' ago';
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// --- API routes ---

router.post('/update', async (req, res) => {
  const { shop, whatsapp_number, whatsapp_token, brand_prompt } = req.body;
  if (!shop) return res.json({ error: 'Shop required' });
  try {
    const updates = [];
    const values = [];
    let i = 1;
    if (whatsapp_number !== undefined) { updates.push(`whatsapp_number = $${i++}`); values.push(whatsapp_number || null); }
    if (whatsapp_token) { updates.push(`whatsapp_token = $${i++}`); values.push(whatsapp_token); }
    if (brand_prompt !== undefined) { updates.push(`brand_prompt = $${i++}`); values.push(brand_prompt); }
    if (!updates.length) return res.json({ error: 'Nothing to update' });
    values.push(shop);
    await pool.query(`UPDATE tenants SET ${updates.join(', ')} WHERE shop_domain = $${i}`, values);
    res.json({ success: true });
  } catch (err) {
    console.error('Dashboard update error:', err.message);
    res.json({ error: err.message });
  }
});

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
    res.json({ success: true, categories: categories.map(c => c.name || c) });
  } catch (err) {
    console.error('Category refresh error:', err.message);
    res.json({ error: err.message });
  }
});


// ============ CONVERSATION THREAD VIEWER (for shop owner) ============
router.get('/chat/:id', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('<h2 style="font-family:Inter,sans-serif;text-align:center;padding:80px">Shop required</h2>');

  try {
    const cid = parseInt(req.params.id);
    const cRes = await pool.query(
      `SELECT c.*, t.shop_domain, t.store_name, t.flow_template
       FROM conversations c JOIN tenants t ON c.tenant_id = t.id
       WHERE c.id = $1 AND t.shop_domain = $2`,
      [cid, shop]
    );
    const conv = cRes.rows[0];
    if (!conv) return res.status(404).send('<h2 style="font-family:Inter,sans-serif;text-align:center;padding:80px">Conversation not found</h2>');

    const msgs = Array.isArray(conv.messages) ? conv.messages : [];

    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat — ${escapeHtml(conv.store_name || shop)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;background:#faf7f2;color:#1a1410;line-height:1.5}
.top-bar{background:#1a1410;color:#faf7f2;padding:14px 32px;display:flex;justify-content:space-between;align-items:center}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}
.brand-mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#b8904d,#8a6a35);display:flex;align-items:center;justify-content:center;color:#1a1410;font-weight:700;font-size:13px}
.page{max-width:900px;margin:0 auto;padding:24px 32px 48px}
.back-link{display:inline-flex;align-items:center;gap:6px;color:#8a7866;font-size:13px;text-decoration:none;margin-bottom:14px}
.back-link:hover{color:#1a1410}
.h-title{font-size:22px;font-weight:600;letter-spacing:-.02em;color:#1a1410}
.h-sub{color:#8a7866;font-size:14px;margin-top:4px}
.card{background:#fffdf8;border:1px solid #ebe3d3;border-radius:14px;overflow:hidden;margin-top:18px}
.card-head{padding:18px 24px;border-bottom:1px solid #f0e8d6;display:flex;justify-content:space-between;align-items:center}
.card-title{font-size:15px;font-weight:600;color:#1a1410}
.chat-thread{padding:24px;max-height:75vh;overflow-y:auto;background:linear-gradient(to bottom,#fffdf8,#fbf6ea)}
.msg{margin-bottom:10px;display:flex}
.msg.user{justify-content:flex-end}
.msg.bot{justify-content:flex-start}
.bubble{max-width:75%;padding:10px 14px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;white-space:pre-wrap}
.msg.user .bubble{background:#d4b372;color:#1a1410;border-bottom-right-radius:4px}
.msg.bot .bubble{background:#fffdf8;color:#1a1410;border:1px solid #ebe3d3;border-bottom-left-radius:4px}
.empty{padding:60px 24px;text-align:center;color:#8a7866;font-size:14px}
@media(max-width:700px){.page{padding:16px}.top-bar{padding:12px 16px}}
</style>
</head><body>
<header class="top-bar"><div class="brand"><div class="brand-mark">V</div>Vaani</div></header>
<main class="page">
  <a class="back-link" href="/dashboard?shop=${encodeURIComponent(shop)}">← Back to dashboard</a>
  <div class="h-title">${maskNumber(conv.customer_phone)}</div>
  <div class="h-sub">${msgs.length} messages · Last active ${timeAgo(conv.last_active)}</div>

  <div class="card">
    <div class="card-head"><div class="card-title">Conversation</div></div>
    <div class="chat-thread">
      ${msgs.length === 0 ? '<div class="empty">No messages yet.</div>' : msgs.map(m => `
        <div class="msg ${m.role === 'user' ? 'user' : 'bot'}">
          <div class="bubble">${escapeHtml(m.content || '[no content]')}</div>
        </div>
      `).join('')}
    </div>
  </div>
</main>
</body></html>`);
  } catch (err) {
    console.error('Chat view err:', err.message);
    res.status(500).send('<h2>Error: ' + (err.message) + '</h2>');
  }
});


module.exports = router;
