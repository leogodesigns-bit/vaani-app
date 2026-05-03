// test/c4-integration.test.js
// Phase C.4 integration — Product detail + variants.

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

const TEST_PHONE = '919999999002';

// Resilient: if getConversation returns null/undefined, fall back to empty.
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

test('C.4 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  const allProducts = await getCollectionProducts(tenant, 'all-sarees');
  const multiVariantProduct = allProducts.find(p => {
    const real = (p.variants || []).filter(v => v.option1 && v.option1.toLowerCase() !== 'default title');
    return real.length >= 2 && real.some(v => v.available);
  });
  assert.ok(multiVariantProduct, 'need a multi-variant product in catalogue');

  const productHandle = multiVariantProduct.handle;
  const realVariants = (multiVariantProduct.variants || []).filter(
    v => v.option1 && v.option1.toLowerCase() !== 'default title'
  );
  const availableVariant = realVariants.find(v => v.available);

  console.log(`[test] Using product: ${multiVariantProduct.title}`);
  console.log(`[test] ${realVariants.length} variants, first available: ${availableVariant?.option1}`);

  await t.test('1. Saree-picker list appears in fabric browse', async () => {
    sent.length = 0;
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('fabric_crepe', 'Crepe'), conv.messages, conv.cart));

    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(lists.length >= 1, 'at least 1 list (saree picker) sent');
    const sareeList = lists.find(l => l.body?.match(/which one|explore/i));
    assert.ok(sareeList, 'saree-picker list present');
    const ids = sareeList.secs[0].rows.map(r => r.id);
    assert.ok(ids.every(id => id.startsWith('product_')), 'all rows are product_*');
  });

  await t.test('2. Tap saree → images + detail + colour list', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      listReply(`product_${productHandle}`, multiVariantProduct.title),
      conv.messages, conv.cart
    ));

    const images = sent.filter(s => s.kind === 'image');
    const texts  = sent.filter(s => s.kind === 'text');
    const lists  = sent.filter(s => s.kind === 'list');

    assert.ok(images.length >= 1 && images.length <= 2, '1-2 images');
    const detail = texts.find(t => t.text.includes(multiVariantProduct.title));
    assert.ok(detail, 'detail text contains title');
    assert.match(detail.text, /₹[\d,]+/);

    const colourList = lists.find(l => l.body?.match(/colour|colours/i));
    assert.ok(colourList, 'colour list shown');
    const variantIds = colourList.secs[0].rows.map(r => r.id);
    assert.ok(variantIds.every(id => id.startsWith('product_variant_')));

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee?.browseMode, 'product_detail');
    assert.equal(conv2.cart.rajathee?.product?.handle, productHandle);
    assert.equal(conv2.cart.rajathee?.priorBrowseMode, 'fabric');
  });

  await t.test('3. Tap variant → variant images + 3 buttons + more-options list', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      listReply(`product_variant_${availableVariant.id}`, availableVariant.option1),
      conv.messages, conv.cart
    ));

    const images = sent.filter(s => s.kind === 'image');
    const texts  = sent.filter(s => s.kind === 'text');
    const btns   = sent.filter(s => s.kind === 'buttons');
    const lists  = sent.filter(s => s.kind === 'list');

    assert.ok(images.length >= 1 && images.length <= 2);
    assert.ok(texts.length >= 1);
    assert.match(texts[0].text, /add this to your cart/i);
    assert.equal(btns.length, 1);
    assert.deepEqual(btns[0].btns, ['Add to cart', 'See more pics', 'Try another colour']);
    assert.equal(lists.length, 1, 'one more-options list');

    const conv2 = await safeConv(tenant.id, TEST_PHONE);
    assert.equal(String(conv2.cart.rajathee?.product?.currentVariantId), String(availableVariant.id));
  });

  await t.test('4. Tap See more pics', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      buttonReply('see_more_pics', 'See more pics'),
      conv.messages, conv.cart
    ));

    const images = sent.filter(s => s.kind === 'image');
    const btns   = sent.filter(s => s.kind === 'buttons');

    if (images.length > 0) {
      assert.ok(images.length <= 3);
      assert.equal(btns.length, 1);
    } else {
      assert.ok(btns.length >= 1, 'guidance buttons when no more pics');
    }
  });

  await t.test('5. Tap Try another colour → colour list re-shown', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      buttonReply('try_another', 'Try another colour'),
      conv.messages, conv.cart
    ));

    const lists = sent.filter(s => s.kind === 'list');
    const colourList = lists.find(l => l.body?.match(/colour|colours/i));
    assert.ok(colourList, 'colour list re-shown');
  });

  await t.test('6. Tap Back to browse → returns to fabric flow', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      listReply('product_more_back', 'Back to browse'),
      conv.messages, conv.cart
    ));

    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(lists.length >= 1, 'something shown');
    const isFabricFlow = lists.some(l =>
      l.body?.match(/what fabric speaks|which one would you like/i)
    );
    assert.ok(isFabricFlow, 'returned to fabric flow');
  });

  await t.test('7. Sold-out variant: graceful', async () => {
    const soldOutVariant = realVariants.find(v => v.available === false);
    if (!soldOutVariant) {
      console.log('[test] No sold-out variant — skipping');
      return;
    }
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(
      tenant,
      listReply(`product_variant_${soldOutVariant.id}`, soldOutVariant.option1),
      conv.messages, conv.cart
    ));

    const texts = sent.filter(s => s.kind === 'text');
    const soldOutMsg = texts.find(t => t.text.match(/sold out/i));
    assert.ok(soldOutMsg, 'sold out message sent');
  });

  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
