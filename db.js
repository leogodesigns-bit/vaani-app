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
  // ─── Merge captured outbound sends so the dashboard sees real reply text ───
  // Handlers still pass [woofparade S01 …] placeholders; we replace each one
  // with the actual rendered send captured in whatsapp.js, in order.
  try {
    const { drainSentMessages } = require('./whatsapp');
    const drained = drainSentMessages(customerPhone) || [];
    if (drained.length) {
      const msgs = Array.isArray(messages) ? [...messages] : [];
      let drainIdx = 0;
      for (let i = 0; i < msgs.length && drainIdx < drained.length; i++) {
        const m = msgs[i];
        const isPlaceholder = m && m.role === 'assistant' && typeof m.content === 'string'
          && /^\s*\[[^\]]+\]\s*$/.test(m.content);
        if (isPlaceholder) {
          msgs[i] = { ...m, ...drained[drainIdx], debug: m.content };
          drainIdx++;
        }
      }
      // If more sends than placeholders (e.g. handler forgot to log), append the rest.
      while (drainIdx < drained.length) {
        msgs.push(drained[drainIdx]);
        drainIdx++;
      }
      messages = msgs;
    }
  } catch (e) {
    console.error('[upsertConversation] sent-message merge failed (non-fatal):', e.message);
  }

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

// ─── SHOPIFY DRAFT / WEBHOOK HELPERS (Patch 11c) ───────────────────────────

// Link our internal order to a Shopify draft order (when Pay now invoice is created).
async function saveShopifyDraftRef(orderId, shopifyDraftId) {
  await pool.query(
    `UPDATE orders SET shopify_draft_id = $2, payment_link_sent_at = NOW() WHERE order_id = $1`,
    [orderId, String(shopifyDraftId)]
  );
}

// Find our internal order by Shopify draft id (used by orders/paid webhook).
async function getOrderByShopifyDraftId(shopifyDraftId) {
  const r = await pool.query(
    `SELECT * FROM orders WHERE shopify_draft_id = $1 LIMIT 1`,
    [String(shopifyDraftId)]
  );
  return r.rows[0] || null;
}

// Save the Shopify order id once it's known (e.g. from orders/paid webhook payload).
async function saveShopifyOrderId(orderId, shopifyOrderId) {
  await pool.query(
    `UPDATE orders SET shopify_order_id = $2 WHERE order_id = $1`,
    [orderId, String(shopifyOrderId)]
  );
}

// Find our internal order by Shopify order id (used by orders/fulfilled webhook).
async function getOrderByShopifyOrderId(shopifyOrderId) {
  const r = await pool.query(
    `SELECT * FROM orders WHERE shopify_order_id = $1 LIMIT 1`,
    [String(shopifyOrderId)]
  );
  return r.rows[0] || null;
}

// Idempotent mark-paid that uses the draft id (Shopify webhook payload).
// Returns the order row if state actually flipped (first time), null otherwise.
async function markOrderPaidByDraft(shopifyDraftId, shopifyOrderId) {
  // Atomic: only flip awaiting_payment → paid for this draft
  const r = await pool.query(
    `UPDATE orders
     SET status = 'paid',
         confirmed_at = NOW(),
         shopify_order_id = COALESCE(shopify_order_id, $2)
     WHERE shopify_draft_id = $1
       AND status = 'awaiting_payment'
     RETURNING *`,
    [String(shopifyDraftId), shopifyOrderId ? String(shopifyOrderId) : null]
  );
  return r.rows[0] || null;
}

// Save tracking info from orders/fulfilled webhook.
async function saveTracking(orderId, trackingUrl, trackingCompany) {
  await pool.query(
    `UPDATE orders SET tracking_url = $2, tracking_company = $3 WHERE order_id = $1`,
    [orderId, trackingUrl || null, trackingCompany || null]
  );
}

// Idempotency: record webhook event. Returns true if first time seen, false if duplicate.
// Shopify retries failed webhooks — without this, "Payment confirmed!" could fire 5x.
async function recordWebhookEvent(webhookId, topic, shopDomain, payload) {
  try {
    const r = await pool.query(
      `INSERT INTO shopify_webhook_events (webhook_id, topic, shop_domain, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (webhook_id) DO NOTHING
       RETURNING id`,
      [webhookId, topic, shopDomain, JSON.stringify(payload || {})]
    );
    return r.rows.length > 0;  // true if newly inserted, false if conflict (duplicate)
  } catch (e) {
    console.error('[webhook] recordWebhookEvent error:', e.message);
    // Fail-safe: return false to skip processing rather than risk duplicate sends
    return false;
  }
}

// Mark a webhook event as processed (after successful handling).
async function markWebhookProcessed(webhookId) {
  await pool.query(
    `UPDATE shopify_webhook_events SET processed = TRUE WHERE webhook_id = $1`,
    [webhookId]
  );
}


// ─── NOTIFY-ME WHEN BACK IN STOCK (S13) ────────────────────────────────────
async function saveNotifyRequest(tenantId, customerPhone, productHandle, productTitle, variantSize) {
  const r = await pool.query(
    `INSERT INTO notify_requests (tenant_id, customer_phone, product_handle, product_title, variant_size)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, customerPhone, productHandle, productTitle || null, variantSize || null]
  );
  return r.rows[0];
}

async function getPendingNotifyRequests(tenantId, productHandle, variantSize) {
  const r = await pool.query(
    `SELECT * FROM notify_requests
     WHERE tenant_id = $1 AND product_handle = $2
       AND ($3::text IS NULL OR variant_size = $3)
       AND notified_at IS NULL`,
    [tenantId, productHandle, variantSize || null]
  );
  return r.rows;
}

async function markNotifyRequestSent(id) {
  await pool.query(`UPDATE notify_requests SET notified_at = NOW() WHERE id = $1`, [id]);
}


// ─── SCHEDULED NUDGES (S14 silence-nudges + S15 24hr unpaid + future Day-14) ──
async function scheduleNudge(tenantId, customerPhone, kind, fireAt, payload = {}) {
  // Cancels any existing pending nudge of the same kind for this phone before scheduling.
  // Idempotent: safe to call repeatedly.
  await pool.query(
    `UPDATE scheduled_nudges
       SET cancelled_at = NOW(), cancel_reason = 'superseded'
     WHERE tenant_id = $1 AND customer_phone = $2 AND kind = $3
       AND sent_at IS NULL AND cancelled_at IS NULL`,
    [tenantId, customerPhone, kind]
  );
  const r = await pool.query(
    `INSERT INTO scheduled_nudges (tenant_id, customer_phone, kind, fire_at, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, customerPhone, kind, fireAt, payload]
  );
  return r.rows[0];
}

async function cancelNudges(tenantId, customerPhone, kindOrNull, reason = 'cancelled') {
  // Cancel one kind (if kindOrNull provided) or all pending nudges for this phone.
  const params = [tenantId, customerPhone, reason];
  let sql = `UPDATE scheduled_nudges
               SET cancelled_at = NOW(), cancel_reason = $3
             WHERE tenant_id = $1 AND customer_phone = $2
               AND sent_at IS NULL AND cancelled_at IS NULL`;
  if (kindOrNull) {
    params.push(kindOrNull);
    sql += ` AND kind = $4`;
  }
  sql += ` RETURNING id, kind`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function getDueNudges(limit = 50) {
  // Fetch due nudges and atomically mark them with attempts++ to avoid double-fire.
  const r = await pool.query(
    `UPDATE scheduled_nudges
        SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM scheduled_nudges
         WHERE fire_at <= NOW()
           AND sent_at IS NULL
           AND cancelled_at IS NULL
           AND attempts < 3
         ORDER BY fire_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit]
  );
  return r.rows;
}

async function markNudgeSent(id) {
  await pool.query(`UPDATE scheduled_nudges SET sent_at = NOW() WHERE id = $1`, [id]);
}

async function markNudgeError(id, err) {
  await pool.query(`UPDATE scheduled_nudges SET last_error = $2 WHERE id = $1`, [id, String(err).slice(0, 500)]);
}

// ─── PATCH 22: S20 / S35 opt-in persistence ────────────────────────────────
// `kind` examples: 'international', 'pin_nonserviceable', 'notify_restock'.
// `meta` is freeform JSONB (e.g. { pin: '797001' } for pin opt-ins).
// Idempotent: relies on unique index (tenant, phone, kind) from 005_patch22.sql.
async function saveOptIn(tenantId, customerPhone, kind, meta = null) {
  try {
    await pool.query(
      `INSERT INTO woofparade_optins (tenant_id, customer_phone, kind, meta)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, customer_phone, kind)
       DO UPDATE SET meta = EXCLUDED.meta, created_at = NOW()`,
      [tenantId, customerPhone, kind, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error('[db saveOptIn] error:', e.message);
  }
}

// ─── PATCH 22: S30 tag order to specific pup (Branch B / C) ────────────────
async function tagOrderToPup(orderId, pupName) {
  try {
    await pool.query(
      `UPDATE orders SET tagged_pup = $2 WHERE order_id = $1`,
      [orderId, pupName]
    );
  } catch (e) {
    console.error('[db tagOrderToPup] error:', e.message);
  }
}

// ─── PATCH 22: S5.5 founder `note [pup] [text]` persistence ────────────────
// Appends to existing notes if pup profile exists; creates lightweight row otherwise.
async function savePupNote(tenantId, customerPhone, pupName, note) {
  try {
    const r = await pool.query(
      `SELECT id, notes FROM pup_profiles
       WHERE tenant_id = $1 AND customer_phone = $2 AND LOWER(pup_name) = LOWER($3)
       ORDER BY id DESC LIMIT 1`,
      [tenantId, customerPhone, pupName]
    );
    if (r.rows.length) {
      const existing = r.rows[0].notes ? r.rows[0].notes + '\n' : '';
      const stamped = `${existing}[${new Date().toISOString().slice(0, 10)}] ${note}`;
      await pool.query(
        `UPDATE pup_profiles SET notes = $2 WHERE id = $1`,
        [r.rows[0].id, stamped]
      );
    } else {
      await pool.query(
        `INSERT INTO pup_profiles (tenant_id, customer_phone, pup_name, notes)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, customerPhone || 'founder-note', pupName, note]
      );
    }
  } catch (e) {
    console.error('[db savePupNote] error:', e.message);
  }
}

module.exports = { pool, initDB, getTenant, createTenant, updateTenant, getConversation, upsertConversation ,
  saveOrder, getOrder, markOrderPaid,
  saveShopifyDraftRef, getOrderByShopifyDraftId,
  saveShopifyOrderId, getOrderByShopifyOrderId,
  markOrderPaidByDraft, saveTracking,
  recordWebhookEvent, markWebhookProcessed,
  saveNotifyRequest, getPendingNotifyRequests, markNotifyRequestSent,
  scheduleNudge, cancelNudges, getDueNudges, markNudgeSent, markNudgeError,
  saveOptIn, tagOrderToPup, savePupNote,
};

// ─── Patch 31: Admin domain resolution ────────────────────────────────────
// Returns the Shopify Admin API domain (the *.myshopify.com handle) for a
// given shop_domain. The shop_domain in our DB is often a public/custom
// domain like 'thewoofparade.com' which does NOT work for Admin API calls.
// Falls back to the input if no admin domain is stored.
async function getAdminDomain(shopDomain) {
  if (!shopDomain) return shopDomain;
  // If already a myshopify handle, skip lookup
  if (shopDomain.endsWith('.myshopify.com')) return shopDomain;
  try {
    const res = await pool.query(
      'SELECT shopify_admin_domain FROM tenants WHERE shop_domain = $1 LIMIT 1',
      [shopDomain]
    );
    if (res.rows[0] && res.rows[0].shopify_admin_domain) {
      return res.rows[0].shopify_admin_domain;
    }
  } catch (err) {
    console.error('[db.getAdminDomain] lookup failed for', shopDomain, ':', err.message);
  }
  return shopDomain;
}

module.exports.getAdminDomain = getAdminDomain;
