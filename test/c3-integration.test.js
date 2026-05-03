// test/c3-integration.test.js
// Live integration test for Phase C.3 — Browse by colour.
// Mirrors C.2 structure: real Rajathee tenant, real Shopify data, mocked WhatsApp send.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();

if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

// Mock whatsapp.js BEFORE requiring the handler.
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
const rajathee = require('../handlers/rajathee');

const TEST_PHONE = '919999999001'; // distinct from C.2's test phone

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

test('C.3 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant, 'Rajathee tenant must exist');
  assert.equal(tenant.flow_template, 'rajathee');
  assert.equal(tenant.shopify_mode, 'public');

  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenant.id, TEST_PHONE]
  );

  await t.test('1. tap Browse by colour → colour picker (10 rows)', async () => {
    sent.length = 0;
    const ctx = makeCtx(tenant, listReply('welcome_browse_colour', 'Browse by colour'));
    await rajathee.handle(ctx);

    assert.equal(sent.length, 1, 'one message sent');
    assert.equal(sent[0].kind, 'list', 'sent a list');
    assert.match(sent[0].body, /Which palette draws you in/);
    assert.equal(sent[0].secs[0].rows.length, 10, 'ten colour rows');

    const ids = sent[0].secs[0].rows.map(r => r.id).sort();
    assert.deepEqual(ids, [
      'colour_black_grey', 'colour_blue_teal', 'colour_brown_beige',
      'colour_green_olive', 'colour_ivory_white', 'colour_pastels',
      'colour_pink_rose', 'colour_purple_plum', 'colour_red_maroon',
      'colour_yellow_mustard',
    ]);
  });

  await t.test('2. tap Pink & Rose → real pink products + voice + buttons', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      listReply('colour_pink_rose', 'Pink & Rose'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const images = sent.filter(s => s.kind === 'image');
    const texts  = sent.filter(s => s.kind === 'text');
    const btns   = sent.filter(s => s.kind === 'buttons');

    assert.ok(images.length >= 1, 'at least 1 pink product image');
    assert.ok(images.length <= 3, 'at most 3 per page');
    assert.equal(texts.length, 1, '1 voice line');
    assert.equal(btns.length, 1, '1 button row');

    // PDF Section 15 locked voice line for Pink & Rose.
    assert.equal(
      texts[0].text,
      'Pink and rose — soft, romantic, endlessly wearable.',
      'voice line verbatim from PDF Section 15'
    );

    for (const img of images) {
      assert.match(img.caption, /\n₹[\d,]+$/);
      assert.ok(img.url?.startsWith('https://cdn.shopify.com/'));
    }

    const conv2 = await getConversation(tenant.id, TEST_PHONE);
    assert.equal(conv2.cart.rajathee.browseMode, 'colour');
    assert.equal(conv2.cart.rajathee.colour, 'colour_pink_rose');
    assert.equal(conv2.cart.rajathee.page, 0);
    assert.equal(conv2.cart.rajathee.totalShown, images.length);
  });

  await t.test('3. tap Show 3 more (in colour mode) → next page', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      buttonReply('show_more', 'Show 3 more'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const conv2 = await getConversation(tenant.id, TEST_PHONE);
    // Either we got more products (page advanced) OR we exhausted and went back to picker.
    if (conv2.cart.rajathee.browseMode === 'colour' && conv2.cart.rajathee.page > 0) {
      assert.equal(conv2.cart.rajathee.page, 1, 'page advanced to 1');
      assert.ok(conv2.cart.rajathee.totalShown > 3, 'totalShown grew past 3');
    } else {
      // Exhausted. Picker shown again. That's also valid behaviour.
      const lists = sent.filter(s => s.kind === 'list');
      assert.ok(lists.length >= 1, 'picker re-shown when exhausted');
    }
  });

  await t.test('4. tap Switch colour → picker again', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      buttonReply('switch_colour', 'Switch colour'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(lists.length >= 1, 'colour picker shown');
    assert.match(lists[0].body, /Which palette draws you in/);
  });

  await t.test('5. tap Pastels → "coming soon" message + picker', async () => {
    sent.length = 0;
    const conv = await getConversation(tenant.id, TEST_PHONE);
    const ctx = makeCtx(
      tenant,
      listReply('colour_pastels', 'Pastels'),
      conv.messages || [],
      conv.cart || {}
    );
    await rajathee.handle(ctx);

    const texts = sent.filter(s => s.kind === 'text');
    const lists = sent.filter(s => s.kind === 'list');

    assert.ok(texts.length >= 1, 'coming-soon text sent');
    assert.match(texts[0].text, /coming soon/i, 'mentions coming soon');
    assert.ok(lists.length >= 1, 'picker re-shown after coming-soon');
  });

  await t.test('6. variant matching: Ready to wear is NOT a colour', async () => {
    // Pure unit-style assertion against exported helper.
    assert.equal(
      rajathee.variantMatchesColour('Ready to wear', 'colour_pink_rose'),
      false,
      'Ready to wear must never match a colour group'
    );
    assert.equal(
      rajathee.variantMatchesColour('READY TO WEAR', 'colour_pink_rose'),
      false,
      'case-insensitive Ready to wear filter'
    );
  });

  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenant.id, TEST_PHONE]
  );
  await pool.end();
});
