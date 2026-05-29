// Step 2 — Card branch (creates Shopify draft order + sends secure checkout link).
// SAFE: defines handlePaymentCard() + adds two imports. Nothing calls it yet.
// Shipping is added as a line item ONLY when > 0, so the Shopify total always
// matches Tara's quoted total (free-shipping orders add nothing).
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'handlers', 'rajathee.js');

let src = fs.readFileSync(FILE, 'utf8');
if (src.includes('handlePaymentCard')) {
  console.log('⏭  Step 2 already applied (handlePaymentCard found). No changes made.');
  process.exit(0);
}

// 1) import createCheckoutDraftOrder from ../shopify
const shopAnchor = "const { getCollectionProducts, getProductByHandle, formatPrice, stripHtml } = require('../shopify');";
if (!src.includes(shopAnchor)) { console.error('❌ anchor #1 (shopify require) not found'); process.exit(1); }
src = src.replace(shopAnchor, "const { getCollectionProducts, getProductByHandle, formatPrice, stripHtml, createCheckoutDraftOrder } = require('../shopify');");

// 2) import saveShopifyDraftRef from ../db
const dbAnchor = "const { getConversation, upsertConversation, saveOrder, getOrder, markOrderPaid } = require('../db');";
if (!src.includes(dbAnchor)) { console.error('❌ anchor #2 (db require) not found'); process.exit(1); }
src = src.replace(dbAnchor, "const { getConversation, upsertConversation, saveOrder, getOrder, markOrderPaid, saveShopifyDraftRef } = require('../db');");

// 3) add handlePaymentCard before handleCheckoutConfirm
const fnAnchor = "async function handleCheckoutConfirm(ctx) {";
if (!src.includes(fnAnchor)) { console.error('❌ anchor #3 (handleCheckoutConfirm) not found'); process.exit(1); }
const cardFn = `// ─── Card branch — Shopify checkout link (auto-confirm comes via orders/paid webhook) ─
async function handlePaymentCard(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const orderId  = generateOrderId(co.phone || from);
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;

  try {
    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);
  } catch (e) { console.error('[rajathee card] saveOrder failed:', e.message); }

  // Add shipping as a line item so the Shopify total matches Tara exactly.
  const draftItems = shipping > 0
    ? [...items, { kind: 'shipping', productTitle: 'Shipping', price: shipping, quantity: 1 }]
    : items;

  let linkSent = false;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const draft = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
        items: draftItems,
        customerPhone: from,
        customerName: co.name,
        address1: co.address1,
        city: co.city,
        state: co.state,
        pin: co.pin,
        subtotal,
        discountAmount: co.discount || 0,
        discountLabel: co.discountLabel || '',
        grandTotal: grand,
        internalOrderId: orderId,
        sourceTag: 'vaani-rajathee',
      });
      if (draft && draft.invoice_url) {
        try { await saveShopifyDraftRef(orderId, draft.shopify_draft_id); }
        catch (e) { console.error('[rajathee card] saveShopifyDraftRef failed:', e.message); }
        await sendMessage(from,
          '💳 *Pay securely here:*\\n' + draft.invoice_url + '\\n\\n' +
          'The moment your payment is in, I\\'ll confirm your order right here ✨\\n' +
          'Estimated delivery after payment: 5–7 working days.',
          waToken, phoneNumberId);
        linkSent = true;
        console.log('[rajathee card] draft ' + draft.shopify_draft_id + ' invoice sent for ' + orderId);
      }
    } catch (e) { console.error('[rajathee card] draft creation failed:', e.message); }
  }

  if (!linkSent) {
    await sendMessage(from,
      'Got your order ✨ Our team will send you a payment link shortly — usually within an hour.',
      waToken, phoneNumberId);
    await pingTeam(ctx, 'ops',
      '⚠️ Vaani: Shopify card link FAILED for ' + orderId + '\\n' +
      'Customer: ' + co.name + ' (+' + from + ')\\nPlease send a manual payment link.',
      { sosType: 'NEW ORDER', summary: 'Card link failed for ' + orderId });
  }

  await sendOwnerAlert(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee card_order=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items: [],
      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId, paymentMethod: 'card' },
      lastOrderId: orderId,
    },
  });
}

`;
src = src.replace(fnAnchor, cardFn + fnAnchor);

fs.writeFileSync(FILE, src);
console.log('✅ Step 2 applied: imports added + handlePaymentCard() defined.');
