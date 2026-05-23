const axios = require('axios');

// PATCH 52a: filter out unlisted/draft products. The admin API returns all
// products by default — only this predicate keeps unlisted/draft items from
// leaking into customer-facing browse/search lists.
// Shopify status values: 'active' | 'draft' | 'archived' | 'unlisted'
function isCustomerVisible(p) {
  if (!p) return false;
  if (p.status && p.status !== 'active') return false;
  if (p.published_at === null || p.published_at === undefined) return false;
  return true;
}

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
    // PATCH 52a: drop unlisted/draft/archived before returning
    const visible = allProducts.filter(isCustomerVisible);
    if (visible.length < allProducts.length) {
      console.log(`🔒 PATCH 52a: hid ${allProducts.length - visible.length} unlisted/draft products from getProducts`);
    }
    return visible;
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
    // PATCH 52a: drop unlisted/draft/archived before returning
    const all = prodRes.data.products || [];
    const visible = all.filter(isCustomerVisible);
    if (visible.length < all.length) {
      console.log(`🔒 PATCH 52a: hid ${all.length - visible.length} unlisted/draft products from collection ${handle}`);
    }
    return visible;
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
  // BACKWARD-COMPAT signature: when called as createDraftOrder(domain, token, items, phone)
  // just creates a minimal draft order (used by Rajathee + legacy paths).
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
      `https://${shopDomain}/admin/api/2025-07/draft_orders.json`,
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

// ─── createCheckoutDraftOrder ─────────────────────────────────────────────
// Full draft order builder for S11 Pay now path. Sets shipping address, customer,
// discount, and tagged note. Returns { id, invoice_url, name, total_price } or null.
// `cart` is the woofparade cart shape (items[], discountAmount, discountLabel, address).
async function createCheckoutDraftOrder(shopDomain, accessToken, opts) {
  const {
    items,            // [{ variantId, productTitle, size, price, kind: 'product' }]
    customerPhone,    // '919371730196'
    customerName,     // 'Shweta Phansalkar'
    address1,         // '123 Main Rd'
    city, state, pin,
    altPhone,         // optional alternate phone
    subtotal,
    discountAmount,   // ₹
    discountLabel,    // e.g. 'WOOF15 15%' or 'Buy 2+ 20%'
    grandTotal,
    internalOrderId,  // our WOOF-XXXXXX-XXX
    sourceTag,        // 'vaani-woofparade'
  } = opts;

  try {
    console.log('[createCheckoutDraftOrder] items received:', JSON.stringify(items));
    if (!items || items.length === 0) {
      console.error('[createCheckoutDraftOrder] no items provided');
      return null;
    }
    const formattedItems = items.map(it => {
      // Strip GID prefix if present (gid://shopify/ProductVariant/123 → 123)
      let vid = it.variantId || it.variant_id;
      if (vid && typeof vid === 'string' && vid.includes('/')) {
        vid = vid.split('/').pop();
      }
      if (vid && !isNaN(parseInt(vid, 10))) {
        return { variant_id: parseInt(vid, 10), quantity: it.quantity || 1 };
      }
      // Fallback to custom line item (e.g. for accessories without variant id)
      return {
        title: it.productTitle || it.title || 'Item',
        quantity: it.quantity || 1,
        price: String(it.price || 0),
      };
    });
    console.log('[createCheckoutDraftOrder] formattedItems:', JSON.stringify(formattedItems));

    // Convert phone like '919371730196' to '+91 93717 30196' for Shopify
    const formattedPhone = customerPhone && customerPhone.length >= 10
      ? `+${customerPhone}`
      : customerPhone;

    // Split customer name into first/last for Shopify
    const nameParts = (customerName || '').trim().split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || 'WhatsApp';

    const draftBody = {
      draft_order: {
        line_items: formattedItems,
        customer: {
          first_name: firstName,
          last_name: lastName,
          phone: formattedPhone,
        },
        shipping_address: {
          first_name: firstName,
          last_name: lastName,
          address1: address1,
          city: city,
          province: state,
          zip: pin,
          country: 'India',
          phone: altPhone ? `+${altPhone}` : formattedPhone,
        },
        billing_address: {
          first_name: firstName,
          last_name: lastName,
          address1: address1,
          city: city,
          province: state,
          zip: pin,
          country: 'India',
          phone: altPhone ? `+${altPhone}` : formattedPhone,
        },
        note: `Vaani WhatsApp order — ${internalOrderId}\nCustomer: ${customerName}\nWhatsApp: +${customerPhone}`,
        note_attributes: [
          { name: 'vaani_internal_order_id', value: internalOrderId || '' },
          { name: 'vaani_source', value: sourceTag || 'vaani-woofparade' },
          { name: 'vaani_customer_phone', value: `+${customerPhone}` },
        ],
        tags: `vaani, whatsapp, ${sourceTag || 'woofparade'}`,
        use_customer_default_address: false,
      },
    };

    // Apply discount as a draft-order-level discount line, not a coupon code.
    // Use fixed_amount so we don't have to maintain a Shopify discount code.
    if (discountAmount && discountAmount > 0) {
      draftBody.draft_order.applied_discount = {
        description: discountLabel || 'Vaani Discount',
        value_type: 'fixed_amount',
        value: String(discountAmount.toFixed ? discountAmount.toFixed(2) : discountAmount),
        amount: String(discountAmount.toFixed ? discountAmount.toFixed(2) : discountAmount),
        title: discountLabel || 'Discount',
      };
    }

    const res = await axios.post(
      `https://${shopDomain}/admin/api/2025-07/draft_orders.json`,
      draftBody,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('[createCheckoutDraftOrder] response keys:', Object.keys(res.data || {}));
    // Shopify normally returns draft_order (singular) on POST, but some API versions
    // return draft_orders (plural array). Handle both.
    let draft = res.data && res.data.draft_order;
    if (!draft && res.data && Array.isArray(res.data.draft_orders)) {
      // Find the draft we just created — match by our internalOrderId in note_attributes
      draft = res.data.draft_orders.find(d =>
        d.note_attributes && d.note_attributes.some(a =>
          a.name === 'vaani_internal_order_id' && a.value === internalOrderId
        )
      );
      // Fallback: most recent draft if no match
      if (!draft && res.data.draft_orders.length > 0) {
        draft = res.data.draft_orders[res.data.draft_orders.length - 1];
        console.warn('[createCheckoutDraftOrder] using last draft as fallback');
      }
    }
    if (!draft) {
      console.error('[createCheckoutDraftOrder] no draft_order in response:', JSON.stringify(res.data));
      return null;
    }
    console.log('[createCheckoutDraftOrder] resolved draft id:', draft.id, 'invoice_url:', draft.invoice_url);
    return {
      id: draft.id,
      invoice_url: draft.invoice_url,
      name: draft.name,
      total_price: draft.total_price,
      subtotal_price: draft.subtotal_price,
      shopify_draft_id: String(draft.id),
    };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ createCheckoutDraftOrder error:', detail);
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
    // PATCH 52a: hide unlisted/draft/archived even on direct handle lookup
    const p = res.data.products?.[0];
    if (p && !isCustomerVisible(p)) {
      console.log(`🔒 PATCH 52a: getProductByHandle(${handle}) hidden — status=${p.status} published_at=${p.published_at}`);
      return null;
    }
    return p || null;
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


// ─── createCustomOrderDraft (S02) ─────────────────────────────────────────
// Creates a placeholder Shopify draft for a custom-order intake from the
// thewoofparade.com /pages/custom-order form. One generic line item
// "Custom Order" at ₹0; price gets updated when Apurv approves with a value.
// Returns { id, name, invoice_url, admin_url } or null on failure.
async function createCustomOrderDraft(shopDomain, accessToken, opts) {
  const {
    customerPhone,   // '918805100535'
    pupName,         // 'Mochi' | null
    designName,      // 'Black Assamese' | null
    summary,         // multi-line readback shown to Apurv
  } = opts || {};

  try {
    const formattedPhone = customerPhone
      ? (customerPhone.startsWith('+') ? customerPhone : '+' + customerPhone)
      : null;

    const titleBits = ['Custom Order'];
    if (designName) titleBits.push('— ' + designName);
    if (pupName)    titleBits.push('for ' + pupName);
    const lineTitle = titleBits.join(' ').replace(/[\r\n]+/g, ' ').slice(0, 250);

    const draftBody = {
      draft_order: {
        line_items: [{
          title: lineTitle,
          quantity: 1,
          price: '0.00',
        }],
        // customer object intentionally omitted — Shopify will collect at checkout
        // (phone is preserved in note_attributes for our DB join + Apurv visibility)
        note: 'Vaani S02 custom-order intake\n' + (summary || ''),
        note_attributes: [
          { name: 'vaani_source', value: 'woofparade-s02' },
          { name: 'vaani_customer_phone', value: formattedPhone || '' },
          { name: 'vaani_pup_name', value: pupName || '' },
          { name: 'vaani_design', value: designName || '' },
          { name: 'vaani_status', value: 'pending_approval' },
        ],
        tags: 'vaani, whatsapp, woofparade-s02, custom-order, pending-approval',
        use_customer_default_address: false,
      },
    };

    const res = await axios.post(
      'https://' + shopDomain + '/admin/api/2024-01/draft_orders.json',
      draftBody,
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    const draft = res.data?.draft_order;
    if (!draft) {
      console.error('❌ createCustomOrderDraft: no draft_order in response. Full data:', JSON.stringify(res.data));
      console.error('   request body was:', JSON.stringify(draftBody));
      return null;
    }
    return {
      id: draft.id,
      name: draft.name,
      invoice_url: draft.invoice_url,
      admin_url: 'https://' + shopDomain + '/admin/draft_orders/' + draft.id,
    };
  } catch (err) {
    console.error('❌ createCustomOrderDraft error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    console.error('   request body was:', JSON.stringify(draftBody));
    return null;
  }
}

// ─── updateDraftOrderPrice (S02 approval) ─────────────────────────────────
// Replaces the draft's single Custom Order line item with the same title at
// the price Apurv specifies. Returns updated invoice_url + total_price.
async function updateDraftOrderPrice(shopDomain, accessToken, draftId, newPrice, lineTitle) {
  try {
    const priceStr = String(Number(newPrice).toFixed(2));
    const res = await axios.put(
      'https://' + shopDomain + '/admin/api/2024-01/draft_orders/' + draftId + '.json',
      {
        draft_order: {
          id: draftId,
          line_items: [{
            title: lineTitle || 'Custom Order',
            quantity: 1,
            price: priceStr,
          }],
        },
      },
      { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' } }
    );
    const draft = res.data.draft_order;
    return {
      id: draft.id,
      name: draft.name,
      invoice_url: draft.invoice_url,
      total_price: draft.total_price,
    };
  } catch (err) {
    console.error('❌ updateDraftOrderPrice error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  getCollectionProducts,
  getProductByHandle,
  getProducts,
  getOrders,
  createDraftOrder,
  createCheckoutDraftOrder,
  formatPrice,
  stripHtml,
  createCustomOrderDraft,
  updateDraftOrderPrice,
};
