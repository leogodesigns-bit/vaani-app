// routes/shopify-webhook.js
// Shopify webhook handlers for Vaani Pay now (S11) confirmation + S32 tracking link
//
// Handles:
//   - orders/paid     → fire "Payment confirmed! 🎉" with tracking promise (PDF S11)
//   - orders/fulfilled → fire tracking link (PDF S32 Branch 1)
//
// Security:
//   - Verifies HMAC signature using SHOPIFY_WEBHOOK_SECRET_WOOF env var
//   - Uses raw body for signature verification (must be mounted BEFORE express.json())
//
// Idempotency:
//   - X-Shopify-Webhook-Id deduped via shopify_webhook_events table
//   - markOrderPaidByDraft is atomic (only flips awaiting_payment → paid once)

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const {
  getOrderByShopifyDraftId,
  getOrderByShopifyOrderId,
  markOrderPaidByDraft,
  cancelNudges,
  saveShopifyOrderId,
  saveTracking,
  recordWebhookEvent,
  markWebhookProcessed,
  pool,
} = require('../db');

const { sendMessage } = require('../whatsapp');

// ─── HMAC VERIFICATION ─────────────────────────────────────────────────────
// Shopify signs every webhook with HMAC-SHA256 of the raw body using the app's
// API secret. We MUST verify before processing — otherwise anyone can forge a
// "Payment confirmed" call.
function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) return false;
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  // Use timingSafeEqual to defeat timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, 'base64'),
      Buffer.from(hmacHeader, 'base64')
    );
  } catch (e) {
    return false;
  }
}

// ─── TENANT LOOKUP FROM SHOP DOMAIN ────────────────────────────────────────
// Shopify sends X-Shopify-Shop-Domain like 'vs6xap-uz.myshopify.com' (handle)
// We have tenants stored by both pretty domain (thewoofparade.com) and handle.
async function findTenantByShopDomain(shopDomain) {
  if (!shopDomain) return null;
  // Try pretty domain first, then myshopify handle
  const result = await pool.query(
    `SELECT * FROM tenants WHERE shop_domain = $1 OR shop_domain = $2 LIMIT 1`,
    [shopDomain, shopDomain.replace('.myshopify.com', '')]
  );
  if (result.rows[0]) return result.rows[0];

  // Fallback: scan for any tenant matching the handle portion
  const handle = shopDomain.replace(/\.myshopify\.com$/, '');
  const fallback = await pool.query(
    `SELECT * FROM tenants WHERE shop_domain ILIKE $1 OR shop_domain ILIKE $2 LIMIT 1`,
    [`%${handle}%`, `${handle}%`]
  );
  return fallback.rows[0] || null;
}

// ─── PICK WEBHOOK SECRET PER TENANT ────────────────────────────────────────
// Today: only WoofParade has webhooks. Multi-tenant later: store secret per tenant.
function getWebhookSecret(tenant) {
  if (!tenant) return null;
  // Right now we only register webhooks for Woof. When Rajathee is wired,
  // add SHOPIFY_WEBHOOK_SECRET_RAJATHEE env and branch by tenant.id.
  if (tenant.shop_domain === 'thewoofparade.com' || tenant.shop_domain === 'vs6xap-uz.myshopify.com') {
    return process.env.SHOPIFY_WEBHOOK_SECRET_WOOF;
  }
  return null;
}

// ─── WHATSAPP CREDENTIALS PER TENANT ───────────────────────────────────────
// To send "Payment confirmed!" we need the tenant's WhatsApp token + phone_number_id.
function getTenantWhatsAppCreds(tenant) {
  if (!tenant) return null;
  // Tenants table columns: `whatsapp_token` (token) + `whatsapp_number` (phone_number_id).
  // Legacy fallbacks kept for any rows still using older naming.
  return {
    waToken: tenant.whatsapp_token || tenant.wa_token || process.env.WHATSAPP_TOKEN,
    phoneNumberId: tenant.whatsapp_number || tenant.phone_number_id || tenant.wa_phone_number_id,
  };
}

// ─── ROUTE HANDLER ─────────────────────────────────────────────────────────
// Mounted in index.js BEFORE express.json() so req.body remains a raw Buffer.
router.post('/woof', async (req, res) => {
  const startTime = Date.now();
  const topic = req.get('X-Shopify-Topic') || 'unknown';
  const webhookId = req.get('X-Shopify-Webhook-Id') || `nohwid_${Date.now()}`;
  const shopDomain = req.get('X-Shopify-Shop-Domain') || 'unknown';
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  // index.js's express.json() captures raw bytes into req.rawBody via the verify hook.
  // This preserves the exact bytes Shopify signed, which we need for HMAC.
  const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  console.log(`[shopify-webhook] received topic=${topic} shop=${shopDomain} webhookId=${webhookId}`);

  // Find tenant + verify HMAC
  const tenant = await findTenantByShopDomain(shopDomain);
  if (!tenant) {
    console.error(`[shopify-webhook] no tenant for shop=${shopDomain}`);
    // Return 200 anyway so Shopify doesn't retry forever on unknown shops
    return res.status(200).send('no tenant');
  }

  const secret = getWebhookSecret(tenant);
  if (!secret) {
    console.error(`[shopify-webhook] no webhook secret configured for tenant ${tenant.id}`);
    return res.status(200).send('no secret');
  }

  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    console.error(`[shopify-webhook] HMAC verification FAILED for webhookId=${webhookId}`);
    return res.status(401).send('hmac mismatch');
  }

  // Parse payload after HMAC verification
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('[shopify-webhook] payload parse failed:', e.message);
    return res.status(400).send('bad json');
  }

  // Idempotency: record this webhook id. If duplicate, ack and skip.
  const isNew = await recordWebhookEvent(webhookId, topic, shopDomain, payload);
  if (!isNew) {
    console.log(`[shopify-webhook] duplicate webhookId=${webhookId}, skipping`);
    return res.status(200).send('duplicate, skipped');
  }

  // ACK fast — Shopify expects 200 within 5 seconds
  res.status(200).send('ok');
  console.log(`[shopify-webhook] ACK ${Date.now() - startTime}ms`);

  // Process async (after ACK)
  try {
    if (topic === 'orders/paid') {
      await handleOrderPaid(tenant, payload);
    } else if (topic === 'orders/fulfilled') {
      await handleOrderFulfilled(tenant, payload);
    } else {
      console.log(`[shopify-webhook] unhandled topic: ${topic}`);
    }
    await markWebhookProcessed(webhookId);
  } catch (e) {
    console.error(`[shopify-webhook] processing error for ${topic}:`, e.message, e.stack);
  }
});

// ─── orders/paid → "Payment confirmed!" (PDF S11) ──────────────────────────
async function handleOrderPaid(tenant, payload) {
  // Match by draft_order_id in the order's source_name or by note_attributes
  const shopifyOrderId = String(payload.id || '');
  // The draft order id should be in the order's "source_name" field (set when
  // the order is created from an invoice) OR in our note_attributes.
  let draftId = null;
  if (Array.isArray(payload.note_attributes)) {
    const draftAttr = payload.note_attributes.find(a => a.name === 'vaani_internal_order_id');
    // Also check for shopify-native draft order linkage
    if (draftAttr && draftAttr.value) {
      // Use our internal order id directly — more reliable than draft-link
      const ourOrderId = draftAttr.value;
      const row = await pool.query(
        `SELECT * FROM orders WHERE order_id = $1 LIMIT 1`, [ourOrderId]
      );
      if (row.rows[0]) {
        draftId = row.rows[0].shopify_draft_id;
      }
    }
  }

  // Shopify sets payload.source_name = 'draft_order' and payload.checkout_token
  // The reliable link: draft_order_id is in payload.checkout.draft_order_id or
  // we use the note_attributes-derived internal order id directly.
  // For robustness, try via internal order id first, then draft id.

  let ourOrder = null;
  if (Array.isArray(payload.note_attributes)) {
    const internalAttr = payload.note_attributes.find(a => a.name === 'vaani_internal_order_id');
    if (internalAttr && internalAttr.value) {
      const row = await pool.query(
        `SELECT * FROM orders WHERE order_id = $1 LIMIT 1`, [internalAttr.value]
      );
      ourOrder = row.rows[0] || null;
    }
  }

  if (!ourOrder && draftId) {
    ourOrder = await getOrderByShopifyDraftId(draftId);
  }

  if (!ourOrder) {
    console.warn(`[orders/paid] no matching internal order for Shopify order ${shopifyOrderId}`);
    return;
  }

  // Atomic mark-paid + save shopify_order_id
  const paidRow = await markOrderPaidByDraft(ourOrder.shopify_draft_id, shopifyOrderId);
  if (!paidRow) {
    // Already paid — race condition or duplicate webhook somehow
    console.log(`[orders/paid] order ${ourOrder.order_id} already paid, skipping send`);
    return;
  }

  // S15 — cancel any pending 24-hr unpaid checkout nudge for this customer.
  // Fire-and-forget; if it fails, customer just gets an extra nudge — not fatal.
  cancelNudges(tenant.id, ourOrder.customer_phone, 's15_unpaid_checkout', 'paid')
    .catch(e => console.error('[orders/paid S15] cancelNudges failed:', e.message));

  // Send "Payment confirmed! 🎉" message (PDF S11)
  const creds = getTenantWhatsAppCreds(tenant);
  if (!creds || !creds.waToken || !creds.phoneNumberId) {
    console.error(`[orders/paid] no WhatsApp creds for tenant ${tenant.id} — can't notify customer`);
    return;
  }

  const customerPhone = ourOrder.customer_phone;
  const message =
    `Payment confirmed! 🎉\n` +
    `Order #${ourOrder.order_id} is on its way to being a showstopper.\n` +
    `Tracking link will land here once it ships (usually 1–2 days). 🐾`;

  try {
    await sendMessage(customerPhone, message, creds.waToken, creds.phoneNumberId);
    console.log(`[orders/paid] ✅ sent confirmation for ${ourOrder.order_id} to +${customerPhone}`);
  } catch (e) {
    console.error(`[orders/paid] sendMessage failed for ${ourOrder.order_id}:`, e.message);
  }
}

// ─── orders/fulfilled → tracking link (PDF S32 Branch 1) ──────────────────
async function handleOrderFulfilled(tenant, payload) {
  const shopifyOrderId = String(payload.id || '');

  // Find our internal order
  let ourOrder = await getOrderByShopifyOrderId(shopifyOrderId);
  if (!ourOrder && Array.isArray(payload.note_attributes)) {
    const internalAttr = payload.note_attributes.find(a => a.name === 'vaani_internal_order_id');
    if (internalAttr && internalAttr.value) {
      const row = await pool.query(
        `SELECT * FROM orders WHERE order_id = $1 LIMIT 1`, [internalAttr.value]
      );
      ourOrder = row.rows[0] || null;
      if (ourOrder) {
        // Backfill the shopify_order_id link
        await saveShopifyOrderId(ourOrder.order_id, shopifyOrderId);
      }
    }
  }

  if (!ourOrder) {
    console.warn(`[orders/fulfilled] no matching internal order for Shopify order ${shopifyOrderId}`);
    return;
  }

  // Extract tracking info from fulfillments
  const fulfillments = payload.fulfillments || [];
  if (fulfillments.length === 0) {
    console.warn(`[orders/fulfilled] no fulfillments in payload for ${shopifyOrderId}`);
    return;
  }
  const latestFulfillment = fulfillments[fulfillments.length - 1];
  const trackingNumber = latestFulfillment.tracking_number || latestFulfillment.tracking_numbers?.[0] || null;
  const trackingUrl = latestFulfillment.tracking_url || latestFulfillment.tracking_urls?.[0] || null;
  const trackingCompany = latestFulfillment.tracking_company || null;

  // Save tracking on our order
  try {
    await saveTracking(ourOrder.order_id, trackingUrl, trackingCompany);
  } catch (e) {
    console.error(`[orders/fulfilled] saveTracking failed:`, e.message);
  }

  // Send tracking message (PDF S32 Branch 1 — "shipped, here's the link")
  const creds = getTenantWhatsAppCreds(tenant);
  if (!creds || !creds.waToken || !creds.phoneNumberId) {
    console.error(`[orders/fulfilled] no WhatsApp creds for tenant ${tenant.id}`);
    return;
  }

  let message = `Here you go 🐾\n`;
  message += `Order #${ourOrder.order_id} is on its way to you.\n`;
  if (trackingUrl) {
    message += `Tracking: ${trackingUrl}\n`;
  } else if (trackingNumber && trackingCompany) {
    message += `Tracking (${trackingCompany}): ${trackingNumber}\n`;
  } else if (trackingNumber) {
    message += `Tracking number: ${trackingNumber}\n`;
  }
  message += `Expected delivery: 2–3 days.`;

  try {
    await sendMessage(ourOrder.customer_phone, message, creds.waToken, creds.phoneNumberId);
    console.log(`[orders/fulfilled] ✅ sent tracking for ${ourOrder.order_id} to +${ourOrder.customer_phone}`);
  } catch (e) {
    console.error(`[orders/fulfilled] sendMessage failed:`, e.message);
  }
}

module.exports = router;
