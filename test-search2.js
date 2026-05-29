const { Pool } = require('pg');
require('dotenv').config();
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT id, shop_domain, shopify_token, flow_template FROM tenants WHERE id=2");
  const { findSareeFromText } = require('./handlers/rajathee-product-search');
  const queries = ['chandani', 'red silk saree', 'mul cotton blue', 'Blue Rizz', 'Chandani Pankhuri', 'kaatha', 'Bone Bandana'];
  for (const q of queries) {
    const r = await findSareeFromText(rows[0], q);
    const tag = r.mode.toUpperCase();
    if (r.best) console.log(`[${tag}] "${q}" → ${r.best.title}`);
    else if (r.candidates) console.log(`[${tag}] "${q}" → ${r.candidates.length} cards`);
    else console.log(`[${tag}] "${q}" → no match`);
  }
  await pool.end();
})();
