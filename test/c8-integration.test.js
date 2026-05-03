// test/c8-integration.test.js
// Phase C.8 integration — Light styling tips (PDF Section 10).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const TEST_PHONE = '919999999008';

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

async function safeConv(tenantId, phone) {
  const c = await getConversation(tenantId, phone);
  return c || { messages: [], cart: {} };
}

function makeCtx(tenant, message, history, cart) {
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
function listReply(id, title)   { return { type: 'interactive', interactive: { list_reply:   { id, title } } }; }
function buttonReply(id, title) { return { type: 'interactive', interactive: { button_reply: { id, title } } }; }
function textMsg(body)          { return { type: 'text', text: { body } }; }

test('C.8 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  await t.test('1. Tap Styling tips with no product viewed → graceful redirect', async () => {
    sent.length = 0;
    let conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('product_more_styling', 'Styling tips'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /pick a saree first/i.test(t.text)),
      'graceful message when no product viewed');
  });

  await t.test('2. Navigate to a product, tap Styling tips → real LLM response', async () => {
    let conv;
    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('welcome_browse_fabric', 'Browse by fabric'), conv.messages, conv.cart));

    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('fabric_crepe', 'Crepe'), conv.messages, conv.cart));

    const all = await getCollectionProducts(tenant, 'all-sarees');
    const product = all.find(p => {
      const real = (p.variants || []).filter(v => v.option1 && v.option1.toLowerCase() !== 'default title');
      return real.length >= 1;
    });
    const variant = (product.variants || []).find(v => v.available && v.option1 && v.option1.toLowerCase() !== 'default title');

    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply(`product_${product.handle}`, product.title), conv.messages, conv.cart));

    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply(`product_variant_${variant.id}`, variant.option1), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('product_more_styling', 'Styling tips'), conv.messages, conv.cart));

    // Wait briefly for async LLM response.
    const texts = sent.filter(s => s.kind === 'text');
    const stylingMsg = texts.find(t => /✨/.test(t.text));
    assert.ok(stylingMsg, 'styling msg sent (starts with ✨)');
    assert.ok(stylingMsg.text.length > 30, 'has substantial content');

    // Should NOT contain the "pick a saree first" fallback.
    assert.ok(!/pick a saree first/i.test(stylingMsg.text));

    // Buttons offered next.
    const btns = sent.filter(s => s.kind === 'buttons');
    assert.ok(btns.length >= 1, 'follow-up buttons sent');
  });

  await t.test('3. STYLING_SYSTEM_PROMPT contains brand voice', async () => {
    assert.match(rajathee.STYLING_SYSTEM_PROMPT, /Effortless and Elegant/);
    assert.match(rajathee.STYLING_SYSTEM_PROMPT, /Rajathee/);
  });

  await t.test('4. Talk to stylist button (after styling) routes to stylist handoff', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    // Tap "Talk to stylist" (the button that appears after styling tip)
    await rajathee.handle(makeCtx(tenant, buttonReply('talk_to_stylist', 'Talk to stylist'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /stylist will reach out/i.test(t.text)),
      'stylist handoff triggered');
  });

  // Cleanup
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
