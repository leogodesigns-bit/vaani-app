const axios = require('axios');

async function getProducts(shopDomain, accessToken) {
  try {
    let allProducts = [];
    let url = `https://${shopDomain}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,images,body_html`;

    // Paginate through all products using Shopify cursor-based pagination
    while (url) {
      const res = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });

      allProducts = allProducts.concat(res.data.products);
      console.log(`📦 Fetched ${allProducts.length} products so far...`);

      // Check Link header for next page
      const linkHeader = res.headers['link'] || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }

    console.log(`✅ Total products fetched: ${allProducts.length}`);
    return allProducts;
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
    const formattedItems = lineItems.map(item => {
      if (item.variant_id) {
        return { variant_id: item.variant_id, quantity: item.quantity || 1 };
      }
      return {
        title: item.title,
        quantity: item.quantity || 1,
        price: item.price ? String(item.price).replace('₹', '') : '0'
      };
    });

    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/draft_orders.json`,
      {
        draft_order: {
          line_items: formattedItems,
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
