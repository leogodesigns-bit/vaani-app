// test/c10-integration.test.js
// Phase C.10 integration — Stylist handoff (PDF Section 11).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const TEST_PHONE    = '919999999010';
const STYLIST_PHONE = '919999999888';
process.env.STYLIST_PHONE = STYLIST_PHONE;

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
function listReply(id, title) { return { type: 'interactive', interactive: { list_reply: { id, title } } }; }
function textMsg(body)        { return { type: 'text', text: { body } }; }

test('C.10 integration', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  await t.test('1. Tap "Talk to a stylist" → ack + browse buttons sent to customer', async () => {
    sent.length = 0;
    let conv = await safeConv(tenant.id, TEST_PHONE);
    // Welcome first to seed history.
    await rajathee.handle(makeCtx(tenant, textMsg('hi'), conv.messages, conv.cart));

    sent.length = 0;
    conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('welcome_styling_help', 'Talk to a stylist'), conv.messages, conv.cart));

    const customerTexts = sent.filter(s => s.kind === 'text' && s.to === TEST_PHONE);
    assert.ok(customerTexts.some(t => /stylist will reach out/i.test(t.text)), 'customer ack sent');

    const customerBtns = sent.filter(s => s.kind === 'buttons' && s.to === TEST_PHONE);
    assert.ok(customerBtns.length >= 1, 'browse buttons sent to customer');
    assert.ok(customerBtns[0].btns.some(b => /Browse/i.test(b)), 'has Browse option');
  });

  await t.test('2. Stylist receives alert with customer phone + recent messages', async () => {
    const stylistMsg = sent.find(s => s.kind === 'text' && s.to === STYLIST_PHONE);
    assert.ok(stylistMsg, 'stylist alert sent');
    assert.match(stylistMsg.text, /Stylist help requested/i, 'has header');
    assert.match(stylistMsg.text, new RegExp('\\+' + TEST_PHONE), 'has customer phone');
    assert.match(stylistMsg.text, /Cart/i, 'has cart section');
    assert.match(stylistMsg.text, /Recent messages/i, 'has messages section');
  });

  await t.test('3. Empty cart shows "(empty)" in stylist alert', async () => {
    const stylistMsg = sent.find(s => s.kind === 'text' && s.to === STYLIST_PHONE);
    assert.match(stylistMsg.text, /\(empty\)/, 'shows empty cart');
  });

  await t.test('4. With cart items, stylist alert shows them', async () => {
    // Manually inject cart items.
    await pool.query(
      `UPDATE conversations SET cart = $1::jsonb WHERE tenant_id = $2 AND customer_phone = $3`,
      [JSON.stringify({
        rajathee: {
          items: [
            { kind: 'saree', productTitle: 'Test Saree', price: 1990, variantId: 'v1' },
            { kind: 'fall_pico', productTitle: 'Fall & Pico', price: 180, variantId: 'fp1' }
          ],
          product: { handle: 'test-saree-handle' }
        }
      }), tenant.id, TEST_PHONE]
    );

    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, listReply('welcome_styling_help', 'Talk to a stylist'), conv.messages, conv.cart));

    const stylistMsg = sent.find(s => s.kind === 'text' && s.to === STYLIST_PHONE);
    assert.ok(stylistMsg, 'stylist alert sent');
    assert.match(stylistMsg.text, /Test Saree/, 'cart item shown');
    assert.match(stylistMsg.text, /test-saree-handle/, 'last viewed shown');
  });

  // Cleanup
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
