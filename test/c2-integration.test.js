// test/c2-integration.test.js
// Live integration test for Phase C.2 — Browse by fabric.
// Connects to the real DB to load the Rajathee tenant,
// then simulates webhook taps and verifies handler dispatch + state.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();

if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

// ── MUST mock whatsapp.js BEFORE requiring handler ──
// Mutate Node's require cache so the handler's destructured imports
// pick up our mocked versions, not the real Meta API callers.
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

// Now safe to require handler — it'll get our mocked whatsapp.js.
const { pool, getTenant, getConversation } = require('../db');
const rajathee = require('../handlers/rajathee');

const TEST_PHONE = '919999999000';

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

test('C.2 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant, 'Rajathee tenant must exist in DB');
  assert.equal(tenant.flow_template, 'rajathee', 'must have rajathee flow');
  assert.equal(tenant.shopify_mode, 'public', 'must have public shopify_mode');

  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenant.id, TEST_PHONE]
  );

  await t.test('1. tap Browse by fabric → fabric picker', async () => {
    sent.length = 0;
    const ctx = makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'));
    await rajathee.handle(ctx);

    assert.equal(sent.length, 1, 'one message sent');
    assert.equal(sent[0].kind, 'list', 'sent a list');
    assert.match(sent[0].body, /What fabric speaks to you today/);
    assert.equal(sent[0].secs[0].rows.length, 6, 'six fabric rows');

    const ids = sent[0].secs[0].rows.map(r => r.id).sort();
    assert.deepEqual(ids, [
      'fabric_classic_cotton', 'fabric_crepe', 'fabric_modal_satin',
      'fabric_mul_cotton', 'fabric_silk_blend', 'fabric_silk_edit',
    ]);
  });

  await t.test('2. tap Crepe → 3 product images + voice line + buttons', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      listReply('fabric_crepe', 'Crepe'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const images = sent.filter(s => s.kind === 'image');
    const texts  = sent.filter(s => s.kind === 'text');
    const btns   = sent.filter(s => s.kind === 'buttons');

    assert.equal(images.length, 3, '3 product images');
    assert.equal(texts.length,  1, '1 voice line');
    assert.equal(btns.length,   1, '1 button row');

    assert.equal(
      texts[0].text,
      'From the Crepe Edit. Light, fluid, the kind of drape you can wear all day without thinking about it.',
      'voice line verbatim'
    );

    for (const img of images) {
      assert.match(img.caption, /\n₹[\d,]+$/, 'caption: name + ₹price');
      assert.ok(img.url?.startsWith('https://cdn.shopify.com/'), 'Shopify CDN');
    }

    const conv2 = await getConversation(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee.fabric, 'fabric_crepe');
    assert.equal(conv2.cart.rajathee.page, 0);
    assert.equal(conv2.cart.rajathee.totalShown, 3);
    assert.equal(conv2.cart.rajathee.productHandles.length, 3);
  });

  await t.test('3. tap Show 3 more → next page', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      buttonReply('show_more', 'Show 3 more'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const images = sent.filter(s => s.kind === 'image');
    assert.ok(images.length >= 1 && images.length <= 3, 'between 1 and 3 products');

    const conv2 = await getConversation(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee.page, 1);
    assert.ok(conv2.cart.rajathee.totalShown > 3);
  });

  await t.test('4. tap Switch fabric → picker again', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      buttonReply('switch_fabric', 'Switch fabric'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'list');
    assert.match(sent[0].body, /What fabric speaks to you today/);
  });

  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenant.id, TEST_PHONE]
  );
  await pool.end();
});
