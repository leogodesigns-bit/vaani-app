const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
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
  console.log('✅ Database tables ready');
}

async function getTenant(shopDomain) {
  const res = await pool.query('SELECT * FROM tenants WHERE shop_domain = $1', [shopDomain]);
  return res.rows[0];
}

async function createTenant(shopDomain, shopifyToken) {
  const res = await pool.query(
    'INSERT INTO tenants (shop_domain, shopify_token) VALUES ($1, $2) ON CONFLICT (shop_domain) DO UPDATE SET shopify_token = $2 RETURNING *',
    [shopDomain, shopifyToken]
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

module.exports = { initDB, getTenant, createTenant, getConversation, upsertConversation };
