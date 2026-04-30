const fs = require('fs');

// 1. Add weekly category refresh to scheduler.js
let scheduler = fs.readFileSync('scheduler.js', 'utf8');
scheduler = scheduler.replace(
  `const { Pool } = require('pg');
const { sendMessage } = require('./whatsapp');`,
  `const { Pool } = require('pg');
const { sendMessage } = require('./whatsapp');
const { getProducts } = require('./shopify');
const { generateCategories } = require('./utils/autoCategorize');`
);

scheduler = scheduler.replace(
  `function startScheduler() {
  // Run every 30 minutes
  setInterval(checkAbandonedCarts, 30 * 60 * 1000);
  console.log('⏰ Abandoned cart scheduler started');
}`,
  `async function refreshAllCategories() {
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

module.exports = { startScheduler, refreshAllCategories };`
);
scheduler = scheduler.replace(
  `module.exports = { startScheduler };`,
  ``
);
fs.writeFileSync('scheduler.js', scheduler);
console.log('✅ scheduler.js updated');

// 2. Add manual refresh command to webhook.js
let webhook = fs.readFileSync('routes/webhook.js', 'utf8');
webhook = webhook.replace(
  `const { generateCategories } = require('../utils/autoCategorize');`,
  `const { generateCategories } = require('../utils/autoCategorize');
const { refreshAllCategories } = require('../scheduler');`
);
webhook = webhook.replace(
  `    const isMoreCategories = text.toLowerCase().includes('more categor');`,
  `    const isMoreCategories = text.toLowerCase().includes('more categor');
    const isRefreshCmd = text.toLowerCase().trim() === 'refresh categories' || text.toLowerCase().trim() === '/refresh';`
);
webhook = webhook.replace(
  `    if (isMoreCategories &&`,
  `    if (isRefreshCmd) {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const newCats = await generateCategories(products);
      await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(newCats), tenant.id]);
      await sendMessage(from, '✅ Categories refreshed! New categories: ' + newCats.map(c => c.name).join(', '), waToken, phoneNumberId);
      return;
    }

    if (isMoreCategories &&`
);
fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ webhook.js updated');
