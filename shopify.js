const axios = require('axios');

// ─── PUBLIC ENDPOINTS (no auth needed) ────────────────────────────────────
async function getCollectionProductsPublic(shopDomain, handle, limit = 20) {
  try {
    const url = `https://${shopDomain}/collections/${handle}/products.json?limit=${limit}`;
    const res = await axios.get(url);
    return res.data.products || [];
  } catch (err) {
    console.error(`❌ getCollectionProductsPublic(${handle}) error:`, err.message);
    return [];
  }
}

async function getProductByHandlePublic(shopDomain, handle) {
  try {
    const url = `https://${shopDomain}/products/${handle}.json`;
    const res = await axios.get(url);
    return res.data.product || null;
  } catch (err) {
    console.error(`❌ getProductByHandlePublic(${handle}) error:`, err.message);
    return null;
  }
}

// ─── AUTHENTICATED ADMIN API ──────────────────────────────────────────────
async function getProducts(shopDomain, accessToken) {
  try {
    let allProducts = [];
    let url = `https://${shopDomain}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,images,body_html`;
    while (url) {
      const res = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });
      allProducts = allProducts.concat(res.data.products);
      console.log(`📦 Fetched ${allProducts.length} products so far...`);
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

async function getCollectionProductsPrivate(shopDomain, accessToken, handle) {
  try {
    const colRes = await axios.get(
      `https://${shopDomain}/admin/api/2024-01/custom_collections.json?handle=${handle}`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    let collection = colRes.data.custom_collections?.[0];
    if (!collection) {
      const smartRes = await axios.get(
        `https://${shopDomain}/admin/api/2024-01/smart_collections.json?handle=${handle}`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      collection = smartRes.data.smart_collections?.[0];
    }
    if (!collection) {
      console.warn(`⚠️ Collection handle '${handle}' not found in private mode.`);
      return [];
    }
    const prodRes = await axios.get(
      `https://${shopDomain}/admin/api/2024-01/products.json?collection_id=${collection.id}&limit=50`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    return prodRes.data.products || [];
  } catch (err) {
    console.error(`❌ getCollectionProductsPrivate(${handle}) error:`, err.message);
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

// ─── MODE-AWARE WRAPPERS ──────────────────────────────────────────────────
async function getCollectionProducts(tenant, handle) {
  const mode = tenant.shopify_mode || 'private';
  if (mode === 'public') {
    return getCollectionProductsPublic(tenant.shop_domain, handle);
  }
  return getCollectionProductsPrivate(tenant.shop_domain, tenant.shopify_token, handle);
}

async function getProductByHandle(tenant, handle) {
  const mode = tenant.shopify_mode || 'private';
  if (mode === 'public') {
    return getProductByHandlePublic(tenant.shop_domain, handle);
  }
  try {
    const res = await axios.get(
      `https://${tenant.shop_domain}/admin/api/2024-01/products.json?handle=${handle}&limit=1`,
      { headers: { 'X-Shopify-Access-Token': tenant.shopify_token } }
    );
    return res.data.products?.[0] || null;
  } catch (err) {
    console.error(`❌ getProductByHandle(${handle}) error:`, err.message);
    return null;
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function formatPrice(priceStr) {
  const num = Math.round(parseFloat(priceStr) || 0);
  return '₹' + num.toLocaleString('en-IN');
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  getCollectionProducts,
  getProductByHandle,
  getProducts,
  getOrders,
  createDraftOrder,
  formatPrice,
  stripHtml,
};
