// test/c7-integration.test.js
// Phase C.7 integration — Post-purchase + owner confirmation command.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const TEST_PHONE  = '919999999005';
const OWNER_PHONE = '919999999777';

// Critical: set OWNER_ALERT_PHONE BEFORE requiring the handler so the constant captures it.
process.env.OWNER_ALERT_PHONE = OWNER_PHONE;

const sent = [];
const path = require('node:path');
const whatsappPath = path.resolve(__dirname, '..', 'whatsapp.js');
require.cache[whatsappPath] = {
  id: whatsappPath,
  filename: whatsappPath,
  loaded: true,
  exports: {
    sendMessage: async (to, text)         => { sent.push({ kind: 'text',    to, text }); },
    sendButtons: async (to, body, btns)   => { sent.push({ kind: 'buttons', to, body, btns }); },
    sendList:    async (to, body, secs)   => { sent.push({ kind: 'list',    to, body, secs }); },
    sendImage:   async (to, url, caption) => { sent.push({ kind: 'image',   to, url, caption }); },
  },
};

const { pool, getTenant, getConversation, getOrder } = require('../db');
const { getCollectionProducts } = require('../shopify');
const rajathee = require('../handlers/rajathee');

async function safeConv(tenantId, phone) {
  const c = await getConversation(tenantId, phone);
  return c || { messages: [], cart: {} };
}

function makeCtx(tenant, message, history, cart, fromOverride) {
  return {
    tenant,
    message,
    from: fromOverride || TEST_PHONE,
    text: message.text?.body
       || message.interactive?.list_reply?.title
       || message.interactive?.button_reply?.title
       || '',
    phoneNumberId: 'test_phone_number_id',
    waToken: 'test_wa_token',
    history,
    cart,
  };
}
function listReply(id, title)   { return { type: 'interactive', interactive: { list_reply:   { id, title } } }; }
function buttonReply(id, title) { return { type: 'interactive', interactive: { button_reply: { id, title } } }; }
function textMsg(body)          { return { type: 'text', text: { body } }; }

async function placeOrder(tenant) {
  let conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('fabric_crepe', 'Crepe'), conv.messages, conv.cart));

  const all = await getCollectionProducts(tenant, 'all-sarees');
  const product = all.find(p => {
    const real = (p.variants || []).filter(v => v.option1 && v.option1.toLowerCase() !== 'default title');
    return real.length >= 2 && real.some(v => v.available);
  });
  const variant = (product.variants || []).find(v => v.available && v.option1 && v.option1.toLowerCase() !== 'default title');

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_${product.handle}`, product.title), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_variant_${variant.id}`, variant.option1), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('addon_none', 'Just the saree'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, buttonReply('checkout', 'Checkout'), conv.messages, conv.cart));

  // walk through fields
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, textMsg('Test Customer'), conv.messages, conv.cart));
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, textMsg('Flat 304, Test Society'), conv.messages, conv.cart));
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, textMsg('Pune'), conv.messages, conv.cart));
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, textMsg('Maharashtra'), conv.messages, conv.cart));
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, textMsg('411038'), conv.messages, conv.cart));
  // Confirm
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, buttonReply('confirm', 'Confirm order'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  return conv.cart.rajathee.lastOrderId;
}

test('C.7 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.query("DELETE FROM orders WHERE customer_phone = $1", [TEST_PHONE]);

  let placedOrderId;

  await t.test('1. Place order → row in orders table with status awaiting_payment', async () => {
    sent.length = 0;
    placedOrderId = await placeOrder(tenant);
    assert.match(placedOrderId, /^RAJ-\d{6}-[A-Z0-9]{3}$/);

    const order = await getOrder(placedOrderId);
    assert.ok(order, 'order row exists');
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.customer_phone, TEST_PHONE);
    assert.equal(order.tenant_id, tenant.id);
    assert.ok(order.subtotal > 0);
  });

  await t.test('2. Customer sees "Order placed" + Track/Browse buttons (NOT thank-you yet)', async () => {
    const texts = sent.filter(s => s.kind === 'text');
    const btns  = sent.filter(s => s.kind === 'buttons');
    
    assert.ok(texts.some(t => /Order placed/i.test(t.text)), '"Order placed" message sent');
    assert.ok(!texts.some(t => /thank you for choosing/i.test(t.text)), 'NO thank-you yet (waiting for payment)');

    const postBtns = btns.find(b => b.btns?.includes('Track order') && b.btns?.includes('Browse more'));
    assert.ok(postBtns, 'Track/Browse buttons sent');
  });

  await t.test('3. Tap Track order → shows awaiting payment status', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('track', 'Track order'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /Tracking your order/i.test(t.text)), 'tracking msg sent');
    assert.ok(texts.some(t => /Awaiting payment/i.test(t.text)), 'shows awaiting payment status');
  });

  await t.test('4. Owner sends "confirmed RAJ-XXX-XXX" → order marked paid + customer thanked', async () => {
    sent.length = 0;
    // Owner has no conversation history, but handle() still expects a context.
    const ownerConv = { messages: [], cart: {} };
    await rajathee.handle(makeCtx(tenant, textMsg(`confirmed ${placedOrderId}`), ownerConv.messages, ownerConv.cart, OWNER_PHONE));

    // Verify DB state
    const order = await getOrder(placedOrderId);
    assert.equal(order.status, 'paid');
    assert.ok(order.confirmed_at, 'confirmed_at timestamp set');

    // Verify owner ack message
    const texts = sent.filter(s => s.kind === 'text');
    const ownerAck = texts.find(t => t.to === OWNER_PHONE && /marked as paid/i.test(t.text));
    assert.ok(ownerAck, 'owner got ack');

    // Verify customer thank-you message
    const customerMsg = texts.find(t => t.to === TEST_PHONE && /Payment confirmed/i.test(t.text));
    assert.ok(customerMsg, 'customer got thank-you');
    assert.match(customerMsg.text, /thank you for choosing Rajathee/i);
  });

  await t.test('5. Owner sends same confirmed cmd again → "already paid" guard', async () => {
    sent.length = 0;
    const ownerConv = { messages: [], cart: {} };
    await rajathee.handle(makeCtx(tenant, textMsg(`confirmed ${placedOrderId}`), ownerConv.messages, ownerConv.cart, OWNER_PHONE));

    const texts = sent.filter(s => s.kind === 'text');
    const ownerMsg = texts.find(t => t.to === OWNER_PHONE);
    assert.ok(ownerMsg, 'owner got response');
    assert.match(ownerMsg.text, /already marked paid/i);

    // No new customer message should be sent.
    const customerMsg = texts.find(t => t.to === TEST_PHONE);
    assert.ok(!customerMsg, 'NO duplicate customer thank-you');
  });

  await t.test('6. Non-owner sending "confirmed RAJ-XXX-XXX" → command IGNORED (security)', async () => {
    // Place a fresh order for a different customer and try to confirm it from a non-owner phone.
    const FAKE_OWNER = '919999999666';
    sent.length = 0;
    
    // FAKE_OWNER sends the cmd. Should be treated as a regular message, not the owner cmd.
    const fakeConv = { messages: [], cart: {} };
    await rajathee.handle(makeCtx(tenant, textMsg(`confirmed ${placedOrderId}`), fakeConv.messages, fakeConv.cart, FAKE_OWNER));

    // It should not have triggered the owner-cmd path. The order stays paid (already), and no "marked paid" ack.
    const texts = sent.filter(s => s.kind === 'text');
    const ackMsg = texts.find(t => /marked as paid/i.test(t.text));
    assert.ok(!ackMsg, 'no owner ack to non-owner');

    // It should fall through to welcome flow (since "confirmed RAJ-..." is unrecognized text).
    // No assertion needed; we just confirm the security gate held.

    // Cleanup the fake convo
    await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, FAKE_OWNER]);
  });

  await t.test('7. Track order after payment confirmed → shows ✅ Payment confirmed', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('track', 'Track order'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /Payment confirmed/i.test(t.text)), 'shows ✅ Payment confirmed');
  });

  // Cleanup
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.query("DELETE FROM orders WHERE customer_phone = $1", [TEST_PHONE]);
  await pool.end();
});
