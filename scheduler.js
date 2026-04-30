// Pool now imported from ./db
const { sendMessage } = require('./whatsapp');
const { getProducts } = require('./shopify');
const { generateCategories } = require('./utils/autoCategorize');

const { pool } = require('./db');

async function checkAbandonedCarts() {
  try {
    // Find conversations with items in cart, inactive for 1+ hours, standard/premium tier
    const result = await pool.query(`
      SELECT c.*, t.shop_domain, t.whatsapp_token, t.whatsapp_number, t.tier
      FROM conversations c
      JOIN tenants t ON c.tenant_id = t.id
      WHERE t.tier IN ('standard', 'premium')
        AND c.cart != '{}'
        AND c.cart IS NOT NULL
        AND c.last_active < NOW() - INTERVAL '1 hour'
        AND (c.followup_sent IS NULL OR c.followup_sent = false)
    `);

    for (const conv of result.rows) {
      const cart = conv.cart;
      if (!cart.items || cart.items.length === 0) continue;

      const itemList = cart.items.map(i => i.title).join(', ');
      const message = `Hi! 👋 You left some items in your cart: ${itemList}. Want to complete your order? Just reply and I'll help you checkout!`;

      const token = conv.whatsapp_token || process.env.WHATSAPP_TOKEN;
      await sendMessage(conv.customer_phone, message, token, conv.whatsapp_number);

      // Mark followup sent
      await pool.query(
        'UPDATE conversations SET followup_sent = true WHERE id = $1',
        [conv.id]
      );
      console.log(`📤 Abandoned cart followup sent to ${conv.customer_phone}`);
    }
  } catch (err) {
    console.error('❌ Scheduler error:', err.message);
  }
}

async function refreshAllCategories() {
  try {
    const result = await pool.query('SELECT * FROM tenants WHERE shopify_token IS NOT NULL');
    for (const tenant of result.rows) {
      if (!tenant.shopify_token || tenant.shopify_token === 'test_token') continue;
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      if (products.length === 0) continue;
      const categories = await generateCategories(products);
      await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(categories), tenant.id]);
      console.log('🔄 Categories refreshed for', tenant.shop_domain, ':', categories.map(c => c.name).join(', '));
    }
  } catch (err) {
    console.error('❌ Category refresh error:', err.message);
  }
}

function startScheduler() {
  // Run abandoned cart check every 30 minutes
  setInterval(checkAbandonedCarts, 30 * 60 * 1000);
  // Run category refresh every 7 days
  setInterval(refreshAllCategories, 7 * 24 * 60 * 60 * 1000);
  console.log('⏰ Abandoned cart scheduler started');
  console.log('🔄 Weekly category refresh scheduled');
}

module.exports = { startScheduler, refreshAllCategories };


