// ═══════════════════════════════════════════════════════════════════════
// Meta Lead Ads webhook — receives leadgen events from Meta and inserts
// matching rows into onboarding_submissions with source = 'meta-ad'.
//
// Wire-up:
//   1. In Meta App dashboard → Webhooks → Page → subscribe to "leadgen"
//      pointing at https://www.vaani.website/api/meta-leads-webhook
//   2. Set Verify Token in Meta to whatever you put in
//      META_LEADS_VERIFY_TOKEN.
//   3. Make sure your Page has the app subscribed and the token has
//      `leads_retrieval` scope.
//
// Required env vars:
//   META_LEADS_VERIFY_TOKEN       — Any random string. Must match the
//                                   "Verify Token" you enter in Meta App
//                                   dashboard when subscribing.
//   META_LEADS_PAGE_ACCESS_TOKEN  — Long-lived Page access token with
//                                   leads_retrieval scope. Used to fetch
//                                   each lead's field_data from Graph API.
//
// Optional but recommended:
//   META_LEADS_APP_SECRET         — App Secret from Meta App dashboard.
//                                   When set, every POST body is verified
//                                   against the X-Hub-Signature-256 header.
//                                   When unset, signature verification is
//                                   skipped (with a console warning) so
//                                   you can iterate during setup.
//
// First-lead playbook:
//   Until a real lead lands, mapMetaFieldsToColumns() uses guessed Meta
//   keys. Submit one test lead via your Meta form, then check Railway logs
//   for `[meta-leads] field_data:` — copy the actual key names from that
//   payload into the TODO blocks below.
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');
const { pool } = require('../db');

// ───────────────────────────────────────────────────────────
// Mapping — placeholder. Fill these from the first real lead.
// ───────────────────────────────────────────────────────────

function valuesFlat(fieldData) {
  // [{ name, values: [...] }] → { name: firstValue }
  return Object.fromEntries(
    (fieldData || []).map(f => [
      String(f.name || ''),
      Array.isArray(f.values) ? (f.values[0] || '') : String(f.values || '')
    ])
  );
}

function mapMetaFieldsToColumns(fieldData) {
  const f = valuesFlat(fieldData);

  // ─── TODO: confirm these keys from a real lead ────────────────────
  // Standard Meta prefill fields are well known and likely correct:
  const name  = String(f.full_name      || f.name           || '').slice(0, 120);
  const phone = String(f.phone_number   || f.phone          || '').replace(/[^0-9]/g, '').slice(0, 20);
  const email = String(f.email          || '').trim().toLowerCase().slice(0, 160);

  // Custom questions — Meta auto-derives snake_case keys from the question
  // text. These are guesses; replace with the actual keys once seen.
  const businessName = String(
    f.business_name        ||
    f.brand_name           ||
    f.what_is_your_business_name ||
    ''
  ).slice(0, 160);

  const notes = String(
    f.tell_us_about_your_business ||
    f.additional_notes            ||
    f.anything_else_youd_like_us_to_know ||
    ''
  ).slice(0, 2000);

  const services = mapServices(
    f.services_interested        ||
    f.which_services             ||
    f.what_services_are_you_interested_in ||
    ''
  );

  const timeline = mapTimeline(
    f.timeline                   ||
    f.whats_your_timeline        ||
    f.when_do_you_want_to_start  ||
    ''
  );

  return { name, phone, email, businessName, services, timeline, notes };
}

// Meta multi-select arrives in `values: [...]` or as a comma/semicolon list.
// Map every option string to one of our service slugs.
function mapServices(rawValue) {
  // ─── TODO: confirm exact option strings Meta sends ────────────────
  const SERVICE_MAP = {
    // 'WhatsApp Bot (Vaani)':       'vaani_whatsapp',
    // 'Instagram Bot (Vaani)':      'vaani_instagram',
    // 'Social Media Management':    'social_media',
    // 'Shopify Website':            'shopify_website'
  };
  return String(rawValue)
    .split(/[,;]/)
    .map(s => s.trim())
    .map(s => SERVICE_MAP[s])
    .filter(Boolean);
}

function mapTimeline(rawValue) {
  // ─── TODO: confirm option strings Meta sends ──────────────────────
  const TIMELINE_MAP = {
    // 'As soon as possible':        'asap',
    // 'Within a month':             '1_month',
    // '1–3 months':                 '1_3_months',
    // '3+ months':                  '3_plus_months',
    // 'Just exploring':             'exploring'
  };
  return TIMELINE_MAP[String(rawValue).trim()] || null;
}

// ───────────────────────────────────────────────────────────
// Signature verification (X-Hub-Signature-256)
// ───────────────────────────────────────────────────────────

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_LEADS_APP_SECRET;
  if (!secret) {
    console.warn('[meta-leads] META_LEADS_APP_SECRET not set — skipping signature check');
    return true;
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody || '')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (_) {
    return false;
  }
}

// ───────────────────────────────────────────────────────────
// Graph API fetch — get field_data for one leadgen_id
// ───────────────────────────────────────────────────────────

function fetchLeadFromGraph(leadgenId) {
  const token = process.env.META_LEADS_PAGE_ACCESS_TOKEN;
  if (!token) return Promise.reject(new Error('META_LEADS_PAGE_ACCESS_TOKEN not set'));

  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(leadgenId)}` +
              `?fields=id,created_time,ad_id,form_id,field_data` +
              `&access_token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(`Graph API: ${data.error.message}`));
          resolve(data);
        } catch (err) {
          reject(new Error(`Graph API parse error: ${err.message}; body=${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Graph API timeout')); });
  });
}

// ───────────────────────────────────────────────────────────
// Process one lead — fetch, map, insert
// ───────────────────────────────────────────────────────────

async function processLead(leadgenId) {
  try {
    const lead = await fetchLeadFromGraph(leadgenId);

    // Log full field_data so user can copy real keys into the TODOs above.
    console.log(`[meta-leads] field_data for leadgen_id=${leadgenId}:`,
      JSON.stringify(lead.field_data, null, 2));

    const m = mapMetaFieldsToColumns(lead.field_data || []);

    // Required columns can't be NULL — fall back to placeholders so the
    // row still lands and the admin can clean up in the UI.
    const result = await pool.query(
      `INSERT INTO onboarding_submissions
         (name, business_name, phone, email,
          services_interested, timeline, source,
          meta_leadgen_id, additional_notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'meta-ad', $7, $8, 'new')
       ON CONFLICT (meta_leadgen_id) DO NOTHING
       RETURNING id`,
      [
        m.name         || 'Meta Lead',
        m.businessName || `(Meta Lead — business name pending)`,
        m.phone        || '',
        m.email        || '',
        m.services,
        m.timeline,
        leadgenId,
        m.notes        || null
      ]
    );

    if (result.rowCount > 0) {
      console.log(`[meta-leads] inserted onboarding_submissions id=${result.rows[0].id} for leadgen_id=${leadgenId}`);
    } else {
      console.log(`[meta-leads] duplicate leadgen_id=${leadgenId}, skipped`);
    }
  } catch (err) {
    console.error('[meta-leads] processLead error:', err && err.message,
      `(leadgen_id=${leadgenId})`);
  }
}

// ───────────────────────────────────────────────────────────
// GET — webhook verification
// ───────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = process.env.META_LEADS_VERIFY_TOKEN;
  if (!expected) {
    console.error('[meta-leads] META_LEADS_VERIFY_TOKEN not set; rejecting verification');
    return res.status(500).send('verify token not configured');
  }

  if (mode === 'subscribe' && token === expected) {
    console.log('[meta-leads] webhook verified');
    return res.status(200).send(String(challenge || ''));
  }

  console.warn('[meta-leads] verification failed',
    { mode, token_provided: !!token });
  return res.status(403).send('verification failed');
});

// ───────────────────────────────────────────────────────────
// POST — incoming lead notifications
// ───────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  // Verify signature (best-effort — log + accept during setup).
  const sig = req.headers['x-hub-signature-256'];
  const sigOk = verifySignature(req.rawBody || '', sig);
  if (!sigOk) {
    console.warn('[meta-leads] X-Hub-Signature-256 mismatch; dropping payload');
    // Still 200 so Meta doesn't retry forever. Set APP_SECRET to enforce.
    return res.status(200).send('EVENT_RECEIVED');
  }

  // ACK fast — Meta requires a 200 within 5 seconds.
  res.status(200).send('EVENT_RECEIVED');

  // Then process async, one lead at a time, fire-and-forget.
  const body    = req.body || {};
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== 'leadgen') continue;
      const leadgenId = change.value && change.value.leadgen_id;
      if (!leadgenId) {
        console.warn('[meta-leads] leadgen change without leadgen_id:', JSON.stringify(change));
        continue;
      }
      setImmediate(() => processLead(String(leadgenId)));
    }
  }
});

module.exports = router;
