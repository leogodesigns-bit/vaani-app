// routes/shopify-webhook.js
// Patch 30: Handles Shopify orders/paid webhook
// Mounted at /shopify-webhook (see index.js line 614)
// Full URL: /shopify-webhook/orders-paid

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../db');
const whatsapp = require('../whatsapp');

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

function verifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  // req.rawBody is set globally by express.json verify callback in index.js line 11
  const body = req.rawBody;
  if (!body || !WEBHOOK_SECRET) return false;
  const hash = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  return hash === hmac;
}

router.post('/orders-paid', async (req, res) => {
  try {
    if (!verifyHmac(req)) {
      console.error('[shopify-webhook] HMAC verification failed');
      return res.status(401).send('Unauthorized');
    }

    const order = req.body; // already parsed by express.json
    const shopDomain = req.headers['x-shopify-shop-domain'];

    console.log(`[shopify-webhook] orders/paid received: ${order.name} for ${shopDomain}`);

    // Find tenant by shop domain
    const tenantRes = await db.query(
      'SELECT id, brand_name, voice, whatsapp_token, phone_number_id FROM tenants WHERE shop_domain = $1',
      [shopDomain]
    );
    if (tenantRes.rows.length === 0) {
      console.error(`[shopify-webhook] No tenant for shop ${shopDomain}`);
      return res.status(200).send('OK');
    }
    const tenant = tenantRes.rows[0];

    const customerPhone = (order.phone || (order.customer && order.customer.phone) || '').replace(/\D/g, '');
    if (!customerPhone) {
      console.error(`[shopify-webhook] No phone on order ${order.name}`);
      return res.status(200).send('OK');
    }

    const isVaaniOrder = (order.tags || '').includes('vaani-bot');
    if (!isVaaniOrder) {
      console.log(`[shopify-webhook] Order ${order.name} not from Vaani, skipping`);
      return res.status(200).send('OK');
    }

    const thankYouMsg = buildThankYouMessage(tenant, order);
    await whatsapp.sendMessage(customerPhone, thankYouMsg, tenant.whatsapp_token, tenant.phone_number_id);

    await db.query(
      `UPDATE order_intents
       SET status = 'paid', shopify_order_id = $1, paid_at = NOW()
       WHERE tenant_id = $2 AND customer_phone = $3 AND status = 'pending_payment'`,
      [order.id, tenant.id, customerPhone]
    );

    res.status(200).send('OK');
  } catch (err) {
    console.error('[shopify-webhook] orders/paid error:', err);
    res.status(500).send('Error');
  }
});

function buildThankYouMessage(tenant, order) {
  const orderName = order.name;
  const total = `₹${order.total_price}`;

  if (tenant.voice === 'woofparade') {
    return `Yay! Payment received 🎉\n\nOrder ${orderName} is confirmed — ${total}\nApurv from our team will pack it up and share tracking within 24 hours.\n\nPaws crossed your pup loves it 🐾`;
  }
  if (tenant.voice === 'rajathee') {
    return `Thank you! Payment received ✨\n\nOrder ${orderName} confirmed — ${total}\nWe'll share tracking within 24 hours.\n\nElegance, on the way 💛`;
  }
  return `Payment received! Order ${orderName} confirmed — ${total}\nWe'll share tracking within 24 hours.`;
}

module.exports = router;
