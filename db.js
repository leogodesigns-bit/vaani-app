const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').match(/railway|rlwy\.net/) ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5,
});

// Auto-reconnect on transient SSL errors.
pool.on('error', (err) => {
  console.error('[pool] idle client error (will retry):', err.code || err.message);
});

async function initDB() {
  // Base tables (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      shopify_token TEXT,
      whatsapp_number VARCHAR(50),
      whatsapp_token TEXT,
      tier VARCHAR(20) DEFAULT 'free',
      brand_prompt TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id),
      customer_phone VARCHAR(50),
      messages JSONB DEFAULT '[]',
      cart JSONB DEFAULT '{}',
      last_active TIMESTAMP DEFAULT NOW(),
      followup_sent BOOLEAN DEFAULT false,
      UNIQUE(tenant_id, customer_phone)
    );

    CREATE TABLE IF NOT EXISTS analytics (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id),
      date DATE DEFAULT CURRENT_DATE,
      messages_count INTEGER DEFAULT 0,
      carts_created INTEGER DEFAULT 0,
      orders_assisted INTEGER DEFAULT 0
    );
  `);

  // Idempotent column additions — bring older DBs up to current schema
  await pool.query(`
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS categories JSONB;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_notes TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_price_inr INTEGER;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_charge_id VARCHAR(100);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30) DEFAULT 'pending';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_plan VARCHAR(20) DEFAULT 'free';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS store_name VARCHAR(100);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS flow_template VARCHAR(20) DEFAULT 'jhilmil';

    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS monthly_messages INTEGER DEFAULT 0;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_month VARCHAR(7);

    CREATE TABLE IF NOT EXISTS product_scores (
      tenant_id INTEGER,
      product_id TEXT,
      score INTEGER DEFAULT 0,
      PRIMARY KEY (tenant_id, product_id)
    );
  `);

  console.log('✅ Database tables ready');
}

async function getTenant(shopDomain) {
  const res = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shopDomain]);
  return res.rows[0];
}

// createTenant: backwards-compatible.
//   Old call: createTenant(shopDomain, shopifyToken)
//   New call: createTenant({ shopDomain, shopifyToken, whatsappNumber, whatsappToken, tier, brandPrompt, billingStatus, billingPlan, customPriceInr, billingNotes })
async function createTenant(arg1, arg2) {
  const cfg = typeof arg1 === 'object' ? arg1 : { shopDomain: arg1, shopifyToken: arg2 };

  const {
    shopDomain,
    shopifyToken = null,
    whatsappNumber = null,
    whatsappToken = null,
    tier = 'free',
    brandPrompt = null,
    billingStatus = 'pending',
    billingPlan = 'free',
    customPriceInr = null,
    billingNotes = null,
    storeName = null,
    flowTemplate = 'jhilmil'
  } = cfg;

  if (!shopDomain) throw new Error('createTenant: shopDomain is required');

  const res = await pool.query(
    `INSERT INTO tenants (
       shop_domain, shopify_token, whatsapp_number, whatsapp_token,
       tier, brand_prompt, billing_status, billing_plan, custom_price_inr, billing_notes, store_name, flow_template
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (shop_domain) DO UPDATE SET
       shopify_token = COALESCE(EXCLUDED.shopify_token, tenants.shopify_token),
       whatsapp_number = COALESCE(EXCLUDED.whatsapp_number, tenants.whatsapp_number),
       whatsapp_token = COALESCE(EXCLUDED.whatsapp_token, tenants.whatsapp_token),
       tier = COALESCE(EXCLUDED.tier, tenants.tier),
       brand_prompt = COALESCE(EXCLUDED.brand_prompt, tenants.brand_prompt),
       billing_status = COALESCE(EXCLUDED.billing_status, tenants.billing_status),
       billing_plan = COALESCE(EXCLUDED.billing_plan, tenants.billing_plan),
       custom_price_inr = COALESCE(EXCLUDED.custom_price_inr, tenants.custom_price_inr),
       billing_notes = COALESCE(EXCLUDED.billing_notes, tenants.billing_notes),
       store_name = COALESCE(EXCLUDED.store_name, tenants.store_name),
       flow_template = tenants.flow_template
     RETURNING *`,
    [shopDomain, shopifyToken, whatsappNumber, whatsappToken,
     tier, brandPrompt, billingStatus, billingPlan, customPriceInr, billingNotes, storeName, flowTemplate]
  );
  return res.rows[0];
}

// updateTenant: partial update by shop_domain.
//   Example: updateTenant('rajathee.myshopify.com', { whatsappNumber: '12345', tier: 'premium' })
async function updateTenant(shopDomain, fields) {
  if (!shopDomain) throw new Error('updateTenant: shopDomain is required');
  if (!fields || Object.keys(fields).length === 0) {
    return getTenant(shopDomain);
  }

  const colMap = {
    shopifyToken: 'shopify_token',
    whatsappNumber: 'whatsapp_number',
    whatsappToken: 'whatsapp_token',
    tier: 'tier',
    brandPrompt: 'brand_prompt',
    billingStatus: 'billing_status',
    billingPlan: 'billing_plan',
    customPriceInr: 'custom_price_inr',
    billingNotes: 'billing_notes',
    categories: 'categories',
    storeName: 'store_name',
    flowTemplate: 'flow_template'
  };

  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    const col = colMap[key];
    if (!col) continue; // ignore unknown keys
    sets.push(`${col} = $${i++}`);
    values.push(col === 'categories' && value !== null ? JSON.stringify(value) : value);
  }
  if (sets.length === 0) return getTenant(shopDomain);

  values.push(shopDomain);
  const res = await pool.query(
    `UPDATE tenants SET ${sets.join(', ')} WHERE shop_domain = $${i} RETURNING *`,
    values
  );
  return res.rows[0];
}

async function getConversation(tenantId, customerPhone) {
  const res = await pool.query(
    'SELECT * FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenantId, customerPhone]
  );
  return res.rows[0];
}

async function upsertConversation(tenantId, customerPhone, messages, cart) {
  const res = await pool.query(
    `INSERT INTO conversations (tenant_id, customer_phone, messages, cart, last_active)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (tenant_id, customer_phone)
     DO UPDATE SET messages = $3, cart = $4, last_active = NOW()
     RETURNING *`,
    [tenantId, customerPhone, JSON.stringify(messages), JSON.stringify(cart)]
  );
  return res.rows[0];
}

// ─── Orders (PDF Section 9 — post-purchase) ──────────────────────────────

async function saveOrder(orderId, tenantId, customerPhone, items, checkout, subtotal, shipping, grandTotal) {
  await pool.query(
    `INSERT INTO orders (order_id, tenant_id, customer_phone, items, checkout, subtotal, shipping, grand_total, status)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 'awaiting_payment')`,
    [orderId, tenantId, customerPhone, JSON.stringify(items), JSON.stringify(checkout), subtotal, shipping, grandTotal]
  );
}

async function getOrder(orderId) {
  const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
  return r.rows[0] || null;
}

async function markOrderPaid(orderId) {
  const r = await pool.query(
    `UPDATE orders SET status = 'paid', confirmed_at = NOW() WHERE order_id = $1 AND status = 'awaiting_payment' RETURNING *`,
    [orderId]
  );
  return r.rows[0] || null;
}

module.exports = { pool, initDB, getTenant, createTenant, updateTenant, getConversation, upsertConversation ,
  saveOrder, getOrder, markOrderPaid,
};
