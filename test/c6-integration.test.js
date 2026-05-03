// test/c6-integration.test.js
// Phase C.6 integration — Checkout (WhatsApp-managed v1).
// Validates the full state machine: cart → checkout → fields → review → confirm.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

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

const { pool, getTenant, getConversation } = require('../db');
const { getCollectionProducts } = require('../shopify');
const rajathee = require('../handlers/rajathee');

const TEST_PHONE = '919999999004';

async function safeConv(tenantId, phone) {
  const c = await getConversation(tenantId, phone);
  return c || { messages: [], cart: {} };
}

function makeCtx(tenant, message, history = [], cart = {}) {
  return {
    tenant,
    message,
    from: TEST_PHONE,
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
function listReply(id, title) {
  return { type: 'interactive', interactive: { list_reply: { id, title } } };
}
function buttonReply(id, title) {
  return { type: 'interactive', interactive: { button_reply: { id, title } } };
}
function textMsg(body) {
  return { type: 'text', text: { body } };
}

// Helper to set up cart with one saree quickly.
async function seedCart(tenant) {
  // Browse → fabric → product → variant → add to cart → just the saree.
  let conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('fabric_crepe', 'Crepe'), conv.messages, conv.cart));

  const allProducts = await getCollectionProducts(tenant, 'all-sarees');
  const product = allProducts.find(p => {
    const real = (p.variants || []).filter(v => v.option1 && v.option1.toLowerCase() !== 'default title');
    return real.length >= 2 && real.some(v => v.available);
  });
  const availableVariant = (product.variants || []).find(v => v.available && v.option1 && v.option1.toLowerCase() !== 'default title');

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_${product.handle}`, product.title), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_variant_${availableVariant.id}`, availableVariant.option1), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('addon_none', 'Just the saree'), conv.messages, conv.cart));

  return { product, variant: availableVariant };
}

test('C.6 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  await t.test('1. Empty cart Checkout → graceful prompt', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('checkout', 'Checkout'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /cart is empty|find you/i.test(t.text)), 'graceful empty-cart message');
  });

  await t.test('2. Tap Checkout with items → asks for name', async () => {
    await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
    await seedCart(tenant);

    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('checkout', 'Checkout'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /full name/i.test(t.text)), 'asks for name');

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'name');
  });

  await t.test('3. Validation: short name rejected, retry stays on name', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('A'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /full name/i.test(t.text)), 'validation error sent');

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'name', 'still on name step');
    assert.equal(conv2.cart.rajathee?.checkout?.name, null, 'name not saved');
  });

  await t.test('4. Valid name → advance to address1', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('Shweta Salunkhe'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.name, 'Shweta Salunkhe');
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'address1');

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /house\/flat number and street/i.test(t.text)));
  });

  await t.test('5. Walk through address1 → city → state → pin → review', async () => {
    let conv;
    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('Flat 304, Sundar Nagari Society, Karve Road'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('Pune'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('Maharashtra'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('411038'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.address1, 'Flat 304, Sundar Nagari Society, Karve Road');
    assert.equal(conv2.cart.rajathee?.checkout?.city, 'Pune');
    assert.equal(conv2.cart.rajathee?.checkout?.state, 'Maharashtra');
    assert.equal(conv2.cart.rajathee?.checkout?.pin, '411038');
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'review');

    // Last sent batch should include review summary + buttons + edit list.
    const texts = sent.filter(s => s.kind === 'text');
    const btns  = sent.filter(s => s.kind === 'buttons');
    const lists = sent.filter(s => s.kind === 'list');

    assert.ok(texts.some(t => /Order summary/i.test(t.text)), 'order summary shown');
    assert.ok(texts.some(t => /Grand total/i.test(t.text)), 'grand total shown');
    assert.ok(texts.some(t => /Pune/.test(t.text)), 'address shown');
    assert.equal(btns.length, 1, 'review buttons sent');
    assert.deepEqual(btns[0].btns, ['Confirm order', 'Edit address', 'Cancel checkout']);
    assert.equal(lists.length, 1, 'edit list sent');
  });

  await t.test('6. Bad PIN rejected', async () => {
    // Force back to PIN state, then submit bad PIN.
    await pool.query(
      `UPDATE conversations SET cart = jsonb_set(cart, '{rajathee,checkout,step}', '"pin"') WHERE tenant_id = $1 AND customer_phone = $2`,
      [tenant.id, TEST_PHONE]
    );
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('123'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /6 digits/i.test(t.text)));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'pin', 'still on pin');
  });

  await t.test('7. Re-enter PIN → back to review', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('411038'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'review');
  });

  await t.test('8. Edit name via list-row → editingField set, asks for name', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('checkout_edit_name', 'Edit name'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /full name/i.test(t.text)));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.editingField, 'name');
  });

  await t.test('9. Submit new name → editingField cleared, back to review', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('Shweta S'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.name, 'Shweta S');
    assert.equal(conv2.cart.rajathee?.checkout?.editingField, null);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'review');

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /Order summary/i.test(t.text)));
  });

  await t.test('10. Confirm order → confirmation sent + cart cleared', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('confirm', 'Confirm order'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    const orderConfirm = texts.find(t => /Order placed/i.test(t.text));
    assert.ok(orderConfirm, 'order received message sent');
    assert.match(orderConfirm.text, /RAJ-\d+-/, 'order ID format');

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal((conv2.cart.rajathee?.items || []).length, 0, 'cart cleared');
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'confirmed');
    assert.ok(conv2.cart.rajathee?.lastOrderId, 'lastOrderId saved');
    assert.match(conv2.cart.rajathee.lastOrderId, /^RAJ-\d{6}-[A-Z0-9]{3}$/);
  });

  await t.test('11. Shipping math: free above ₹999, ₹80 below', async () => {
    assert.equal(rajathee.calcShipping(500), 80);
    assert.equal(rajathee.calcShipping(998), 80);
    assert.equal(rajathee.calcShipping(999), 0);
    assert.equal(rajathee.calcShipping(1500), 0);
  });

  await t.test('12. Cancel checkout returns to cart actions', async () => {
    await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
    await seedCart(tenant);

    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('checkout', 'Checkout'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('cancel', 'Cancel checkout'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /cancelled/i.test(t.text)));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout, null, 'checkout state cleared');
    assert.ok((conv2.cart.rajathee?.items || []).length > 0, 'cart preserved');
  });

  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
