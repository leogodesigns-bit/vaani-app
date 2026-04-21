const axios = require('axios');

async function getProducts(shopDomain, accessToken) {
  try {
    const res = await axios.get(
      `https://${shopDomain}/admin/api/2024-01/products.json?limit=50&fields=id,title,variants,images,body_html`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    return res.data.products;
  } catch (err) {
    console.error('❌ getProducts error:', err.message);
    return [];
  }
}

async function getOrders(shopDomain, accessToken, customerId) {
  try {
    const res = await axios.get(
      `https://${shopDomain}/admin/api/2024-01/orders.json?customer_id=${customerId}&status=any&limit=5`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    return res.data.orders;
  } catch (err) {
    console.error('❌ getOrders error:', err.message);
    return [];
  }
}

async function createDraftOrder(shopDomain, accessToken, lineItems, customerPhone) {
  try {
    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/draft_orders.json`,
      {
        draft_order: {
          line_items: lineItems,
          note: `WhatsApp order from ${customerPhone}`
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    return res.data.draft_order;
  } catch (err) {
    console.error('❌ createDraftOrder error:', err.message);
    return null;
  }
}

module.exports = { getProducts, getOrders, createDraftOrder };
