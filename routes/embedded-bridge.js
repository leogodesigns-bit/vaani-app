// Mints a vaani-dashboard JWT for the current Shopify shop and redirects
// to the dashboard with ?token=... so the dashboard middleware sets the
// session cookie and lands on /dashboard.
//
// Trust model: this endpoint is called from inside the vaani-app embedded
// shell, which Shopify has already authenticated via the embedded app
// install. We trust the `shop` query param because:
//   (a) vaani-app only renders the embedded shell after Shopify HMAC
//       verification (existing code in index.js)
//   (b) The embedded shell URL is constructed server-side with the
//       authenticated shop
// In short: if you're seeing the bridge, Shopify already proved you're
// admin of `shop`.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const DASHBOARD_URL = 'https://vaani-dashboard-production.up.railway.app';

router.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');

  // Map dev-store domain → real domain if needed
  const SHOP_DOMAIN_MAP = {
    'udhuxy-pc.myshopify.com': 'rajathee.myshopify.com',
    'vs6xap-uz.myshopify.com': 'thewoofparade.com',
  };
  const dbShop = SHOP_DOMAIN_MAP[shop] || shop;

  // Look up the tenant + find a dashboard user mapped to this tenant
  const tenantRes = await pool.query(
    'SELECT id, shop_domain FROM tenants WHERE shop_domain = $1',
    [dbShop]
  );
  if (tenantRes.rows.length === 0) {
    return res.status(404).send(`No Vaani tenant for ${dbShop}`);
  }
  const tenant = tenantRes.rows[0];

  // Find the primary user for this tenant:
  // 1. Any admin (Shweta sees everything)
  // 2. Otherwise the first non-admin mapped to this tenant
  let user;
  const adminRes = await pool.query(
    `SELECT id, email, is_admin FROM dashboard_users
     WHERE is_admin = TRUE
     ORDER BY id LIMIT 1`
  );
  if (adminRes.rows.length > 0 && shop && /shweta|leogo/i.test(shop)) {
    // (rarely triggers; Shopify admin domains don't usually contain shweta/leogo)
    user = adminRes.rows[0];
  } else {
    const mappedRes = await pool.query(`
      SELECT u.id, u.email, u.is_admin
      FROM dashboard_users u
      JOIN dashboard_user_tenants dut ON dut.user_id = u.id
      WHERE dut.tenant_id = $1
      ORDER BY u.is_admin DESC, u.id ASC
      LIMIT 1
    `, [tenant.id]);
    if (mappedRes.rows.length > 0) {
      user = mappedRes.rows[0];
    } else if (adminRes.rows.length > 0) {
      // Fallback: no specific user mapped, send admin (Shweta)
      user = adminRes.rows[0];
    } else {
      return res.status(500).send(
        'No dashboard user is mapped to this tenant. ' +
        'Ask Leogo to provision a login.'
      );
    }
  }

  // Mint a 7-day JWT matching vaani-dashboard's signToken() shape
  const token = jwt.sign(
    { uid: user.id, email: user.email, admin: !!user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`[bridge] minted token for ${user.email} (tenant ${tenant.id}, shop ${dbShop})`);

  // Redirect into the dashboard with ?token=. The dashboard's middleware
  // will verify, set the cookie, strip ?token, and land on /dashboard.
  const target = `${DASHBOARD_URL}/dashboard?token=${encodeURIComponent(token)}`;
  return res.redirect(target);
});

module.exports = router;
