const express = require('express');
const crypto = require('crypto');
const router = express.Router();
// Pool now imported from ../db

const { pool } = require('../db');

// HMAC verification middleware — Shopify mandatory webhooks MUST return 401 on invalid
function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    console.warn('⚠️ GDPR webhook hit without HMAC header');
    return res.sendStatus(401);
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error('❌ SHOPIFY_API_SECRET env var missing');
    return res.sendStatus(401);
  }

  // req.rawBody is populated by the verify callback in express.json() (see index.js)
  const body = req.rawBody;
  if (!body) {
    console.warn('⚠️ GDPR webhook had no raw body');
    return res.sendStatus(401);
  }

  const computed = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');

  // Timing-safe comparison
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('⚠️ GDPR webhook HMAC mismatch');
    return res.sendStatus(401);
  }

  next();
}

// Customer data request - GDPR
router.post('/customers/data_request', verifyShopifyHmac, (req, res) => {
  const { shop_domain, customer } = req.body;
  console.log(`📋 GDPR data request for customer ${customer?.id} from ${shop_domain}`);
  res.sendStatus(200);
});

// Customer data deletion - GDPR
router.post('/customers/redact', verifyShopifyHmac, async (req, res) => {
  const { shop_domain, customer } = req.body;
  try {
    const tenant = await pool.query('SELECT id FROM tenants WHERE shop_domain = $1', [shop_domain]);
    if (tenant.rows[0]) {
      await pool.query(
        'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
        [tenant.rows[0].id, customer?.phone]
      );
      console.log(`🗑️ GDPR customer data deleted for ${customer?.phone} from ${shop_domain}`);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('GDPR redact error:', err.message);
    res.sendStatus(200);
  }
});

// Shop data deletion - GDPR
router.post('/shop/redact', verifyShopifyHmac, async (req, res) => {
  const { shop_domain } = req.body;
  try {
    const tenant = await pool.query('SELECT id FROM tenants WHERE shop_domain = $1', [shop_domain]);
    if (tenant.rows[0]) {
      await pool.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant.rows[0].id]);
      await pool.query('DELETE FROM tenants WHERE shop_domain = $1', [shop_domain]);
      console.log(`🗑️ GDPR shop data deleted for ${shop_domain}`);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('GDPR shop redact error:', err.message);
    res.sendStatus(200);
  }
});

module.exports = router;
