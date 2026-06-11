const express = require('express');
const router = express.Router();
const { pool } = require('../db');

let sendMessage;
try { sendMessage = require('../whatsapp').sendMessage; } catch (_) {}

// Per-IP rate limiter (mirrors routes/demo-leads.js).
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

const ALLOWED_SERVICES = new Set([
  'vaani_whatsapp',
  'vaani_instagram',
  'social_media',
  'shopify_website'
]);

const ALLOWED_TIMELINES = new Set([
  'asap', '1_month', '1_3_months', '3_plus_months', 'exploring'
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(v, max) {
  return (typeof v === 'string') ? v.trim().slice(0, max) : '';
}

router.post('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    if (!ipAllowed(ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const b = req.body || {};
    const name           = clean(b.name, 120);
    const businessName   = clean(b.business_name, 160);
    const phoneRaw       = clean(b.phone, 30);
    const email          = clean(b.email, 160).toLowerCase();
    const businessAbout  = clean(b.business_description, 2000);
    const instagram      = clean(b.instagram_handle, 80).replace(/^@/, '');
    const website        = clean(b.current_website, 200);
    const timeline       = clean(b.timeline, 40);
    const notes          = clean(b.additional_notes, 2000);
    const source         = clean(b.source, 60) || 'get-started';

    const services = Array.isArray(b.services_interested) ? b.services_interested : [];
    const cleanServices = [...new Set(services.filter(s => ALLOWED_SERVICES.has(s)))].slice(0, 4);

    if (!name)         return res.status(400).json({ ok: false, error: 'name_required' });
    if (!businessName) return res.status(400).json({ ok: false, error: 'business_name_required' });
    if (!phoneRaw)     return res.status(400).json({ ok: false, error: 'phone_required' });
    if (!email)        return res.status(400).json({ ok: false, error: 'email_required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
    if (cleanServices.length === 0) return res.status(400).json({ ok: false, error: 'service_required' });
    if (timeline && !ALLOWED_TIMELINES.has(timeline)) {
      return res.status(400).json({ ok: false, error: 'invalid_timeline' });
    }

    const phoneDigits = phoneRaw.replace(/[^0-9]/g, '');
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      return res.status(400).json({ ok: false, error: 'invalid_phone' });
    }

    // Dedupe by email within the last 10 minutes — protects against
    // double-submit while still allowing the same lead to update later.
    const recent = await pool.query(
      `SELECT id FROM onboarding_submissions
       WHERE LOWER(email) = $1 AND created_at > NOW() - INTERVAL '10 minutes'
       LIMIT 1`,
      [email]
    );
    if (recent.rowCount > 0) {
      return res.json({ ok: true, deduped: true, id: recent.rows[0].id });
    }

    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);

    const inserted = await pool.query(
      `INSERT INTO onboarding_submissions
         (name, business_name, phone, email, services_interested,
          business_description, instagram_handle, current_website,
          timeline, additional_notes, source, client_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [name, businessName, phoneDigits, email, cleanServices,
       businessAbout || null, instagram || null, website || null,
       timeline || null, notes || null, source, ip || null, ua || null]
    );

    fireTeamAlert({
      name, businessName, phone: phoneDigits, email,
      services: cleanServices, timeline
    }).catch(err => console.error('[onboarding] alert failed:', err && err.message));

    res.json({ ok: true, id: inserted.rows[0].id });
  } catch (err) {
    console.error('[onboarding] handler error:', err && err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

const SERVICE_LABELS = {
  vaani_whatsapp:  'Vaani WhatsApp Bot',
  vaani_instagram: 'Vaani Instagram Bot',
  social_media:    'Social Media Management',
  shopify_website: 'Shopify Website'
};

async function fireTeamAlert({ name, businessName, phone, email, services, timeline }) {
  const to = process.env.FOUNDER_PHONE;
  const token = process.env.WHATSAPP_TOKEN || process.env.META_TOKEN_VAANI || process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!to || !token || !phoneNumberId || !sendMessage) return;

  const svc = (services || []).map(s => SERVICE_LABELS[s] || s).join(', ');
  const text =
    `New onboarding lead 🎉\n` +
    `Name: ${name}\n` +
    `Business: ${businessName}\n` +
    `Phone: +${phone}\n` +
    `Email: ${email}\n` +
    `Services: ${svc || '—'}` +
    (timeline ? `\nTimeline: ${timeline}` : '');

  await sendMessage(to, text, token, phoneNumberId);
}

module.exports = router;
