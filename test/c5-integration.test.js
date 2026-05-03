// test/c5-integration.test.js
// Phase C.5 integration — Add-ons (Fall & Pico, Ready to Wear) + cart state.

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

const TEST_PHONE = '919999999003';

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

// Helper: walk the customer through fabric → crepe → first multi-variant saree
// → first available variant. Leaves cart in 'variant selected' state.
async function navigateToVariant(tenant) {
  // 1. Browse by fabric
  let conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'), conv.messages, conv.cart));

  // 2. Tap Crepe
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply('fabric_crepe', 'Crepe'), conv.messages, conv.cart));

  // 3. Find a multi-variant available product in the catalogue
  const allProducts = await getCollectionProducts(tenant, 'all-sarees');
  const product = allProducts.find(p => {
    const real = (p.variants || []).filter(v => v.option1 && v.option1.toLowerCase() !== 'default title');
    return real.length >= 2 && real.some(v => v.available);
  });
  if (!product) throw new Error('No multi-variant available product found');
  const availableVariant = (product.variants || []).find(v => v.available && v.option1 && v.option1.toLowerCase() !== 'default title');

  // 4. Tap product
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_${product.handle}`, product.title), conv.messages, conv.cart));

  // 5. Tap variant
  conv = await safeConv(tenant.id, TEST_PHONE);
  await rajathee.handle(makeCtx(tenant, listReply(`product_variant_${availableVariant.id}`, availableVariant.option1), conv.messages, conv.cart));

  return { product, variant: availableVariant };
}

test('C.5 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);

  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  // Helper to reset cart between sub-tests.
  async function resetAndNavigate() {
    await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
    return await navigateToVariant(tenant);
  }

  await t.test('1. Tap Add to cart → "Added" message + 4-row addon list', async () => {
    const { product, variant } = await resetAndNavigate();

    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('add_to_cart', 'Add to cart'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    const lists = sent.filter(s => s.kind === 'list');

    assert.ok(texts.length >= 1, 'confirmation text sent');
    assert.match(texts[0].text, /Added/, 'message says "Added"');
    assert.match(texts[0].text, /Fall & Pico|Ready to Wear/, 'mentions add-on options');

    assert.equal(lists.length, 1, 'one list sent');
    assert.equal(lists[0].secs[0].rows.length, 4, '4 addon rows');
    const ids = lists[0].secs[0].rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['addon_both', 'addon_fp', 'addon_none', 'addon_rtw']);

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    assert.equal(items.length, 1, 'one saree in cart');
    assert.equal(items[0].kind, 'saree');
    assert.equal(String(items[0].variantId), String(variant.id));
  });

  await t.test('2. Tap Add Fall & Pico → cart = saree + F&P', async () => {
    const { variant } = await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_fp', 'Add Fall & Pico'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    assert.equal(items.length, 2, 'saree + F&P');
    assert.equal(items[0].kind, 'saree');
    assert.equal(items[1].kind, 'fall_pico');
    assert.equal(items[1].price, 180);
    assert.equal(items[1].variantId, '47195287748791');

    // Confirmation text + cart action buttons.
    const texts = sent.filter(s => s.kind === 'text');
    const btns  = sent.filter(s => s.kind === 'buttons');
    assert.match(texts[0].text, /Fall & Pico added/i);
    assert.equal(btns.length, 1);
    assert.deepEqual(btns[0].btns, ['Browse more sarees', 'View cart', 'Checkout']);
  });

  await t.test('3. Tap Add Ready to Wear → cart = saree + RTW (no auto F&P)', async () => {
    await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_rtw', 'Add Ready to Wear'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    assert.equal(items.length, 2, 'saree + RTW only (no auto-F&P)');
    assert.equal(items[1].kind, 'ready_to_wear');
    assert.equal(items[1].price, 1100);

    // No fall_pico item present.
    const fp = items.find(it => it.kind === 'fall_pico');
    assert.equal(fp, undefined, 'F&P NOT auto-added');
  });

  await t.test('4. Tap Add both → cart = saree + F&P + RTW', async () => {
    await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_both', 'Add both'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    assert.equal(items.length, 3, 'saree + F&P + RTW');
    const kinds = items.map(it => it.kind);
    assert.ok(kinds.includes('fall_pico'));
    assert.ok(kinds.includes('ready_to_wear'));
  });

  await t.test('5. Tap Just the saree → cart = saree only', async () => {
    await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_none', 'Just the saree'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    assert.equal(items.length, 1, 'saree only');
    assert.equal(items[0].kind, 'saree');

    const texts = sent.filter(s => s.kind === 'text');
    assert.match(texts[0].text, /just the saree/i);
  });

  await t.test('6. Tap View cart → cart summary shown', async () => {
    await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_both', 'Add both'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('view_cart', 'View cart'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.length >= 1);
    assert.match(texts[0].text, /Your cart/);
    assert.match(texts[0].text, /Subtotal/);
  });

  await t.test('7. Cart subtotal math is correct', async () => {
    const { variant } = await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_both', 'Add both'), conv.messages, conv.cart));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    const items = conv2.cart.rajathee?.items || [];
    const total = items.reduce((s, it) => s + (it.price || 0), 0);
    const sareePrice = parseFloat(variant.price);
    assert.equal(total, sareePrice + 180 + 1100, 'saree + 180 + 1100');

    const summary = rajathee.formatCartSummary(items);
    assert.match(summary, /Subtotal/);
    assert.match(summary, /Fall & Pico/);
    assert.match(summary, /Ready to Wear/);
  });

  await t.test('8. Tap Checkout → starts address collection (C.6 active)', async () => {
    await resetAndNavigate();
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('atc', 'Add to cart'), conv.messages, conv.cart));
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('addon_none', 'Just the saree'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, buttonReply('checkout', 'Checkout'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.match(texts[0].text, /full name|details/i, 'checkout flow asks for name');

    // C.6: cart should now have a checkout state machine started
    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.checkout?.step, 'name', 'checkout step set to name');
  });

  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
