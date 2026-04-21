const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Customer data request - GDPR
router.post('/customers/data_request', (req, res) => {
  const { shop_domain, customer } = req.body;
  console.log(`📋 GDPR data request for customer ${customer?.id} from ${shop_domain}`);
  res.sendStatus(200);
});

// Customer data deletion - GDPR
router.post('/customers/redact', async (req, res) => {
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
router.post('/shop/redact', async (req, res) => {
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
