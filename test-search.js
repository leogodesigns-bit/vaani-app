const { Pool } = require('pg');
require('dotenv').config();

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT id, shop_domain, shopify_token, flow_template FROM tenants WHERE id=2");
  const tenant = rows[0];
  console.log('Tenant:', tenant.shop_domain, 'has token:', tenant.shopify_token ? 'YES' : 'NO');

  const { findSareeFromText } = require('./handlers/rajathee-product-search');
  const queries = ['chandani', 'red silk saree', 'mul cotton blue', 'banana'];
  for (const q of queries) {
    const r = await findSareeFromText(tenant, q);
    console.log('\nQuery:', q, '→', r.mode);
    if (r.best) console.log('  best:', r.best.title);
    if (r.candidates) console.log('  cands:', r.candidates.map(c => c.title).join(' | '));
  }
  await pool.end();
})();
