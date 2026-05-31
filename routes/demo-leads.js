const express = require('express');
const router = express.Router();
const { pool } = require('../db');

let sendMessage;
try { sendMessage = require('../whatsapp').sendMessage; } catch (_) {}

const ipBuckets = new Map();
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 10;
function ipAllowed(ip) {
  const now = Date.now();
  const arr = (ipBuckets.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (arr.length >= IP_LIMIT) { ipBuckets.set(ip, arr); return false; }
  arr.push(now);
  ipBuckets.set(ip, arr);
  return true;
}

router.post('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    if (!ipAllowed(ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const { name, phone, timestamp, source } = req.body || {};
    if (!name || !phone || typeof name !== 'string' || typeof phone !== 'string') {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }
    const cleanName = name.trim().slice(0, 80);
    const cleanPhone = phone.replace(/[^0-9]/g, '').slice(0, 15);
    if (cleanPhone.length !== 12 || !cleanPhone.startsWith('91')) {
      return res.status(400).json({ ok: false, error: 'invalid_phone' });
    }

    const recent = await pool.query(
      `SELECT id FROM demo_leads WHERE phone = $1 AND created_at > NOW() - INTERVAL '5 minutes' LIMIT 1`,
      [cleanPhone]
    );
    if (recent.rowCount > 0) {
      return res.json({ ok: true, deduped: true });
    }

    const ts = timestamp ? new Date(timestamp) : null;
    const safeTs = (ts && !isNaN(ts.valueOf())) ? ts : null;
    const safeSource = (typeof source === 'string') ? source.slice(0, 60) : null;

    const inserted = await pool.query(
      `INSERT INTO demo_leads (name, phone, source, client_ts) VALUES ($1,$2,$3,$4) RETURNING id`,
      [cleanName, cleanPhone, safeSource, safeTs]
    );

    fireTeamAlert({ name: cleanName, phone: cleanPhone, source: safeSource })
      .catch(err => console.error('[demo-leads] alert failed:', err && err.message));

    res.json({ ok: true, id: inserted.rows[0].id });
  } catch (err) {
    console.error('[demo-leads] handler error:', err && err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

async function fireTeamAlert({ name, phone, source }) {
  const to = process.env.FOUNDER_PHONE;
  const token = process.env.WHATSAPP_TOKEN || process.env.META_TOKEN_VAANI || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!to || !token || !phoneNumberId || !sendMessage) return;
  const text = `New demo lead 🎉\nName: ${name}\nPhone: +${phone}\nSource: ${source || 'demo'}`;
  await sendMessage(to, text, token, phoneNumberId);
}

module.exports = router;
