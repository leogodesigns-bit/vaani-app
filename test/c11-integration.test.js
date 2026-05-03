// test/c11-integration.test.js
// Phase C.11 integration — Edge cases (PDF Section 12).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

require('dotenv').config();
if (process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const TEST_PHONE = '919999999011';

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

function textMsg(body)    { return { type: 'text', text: { body } }; }
function audioMsg()       { return { type: 'audio', audio: { id: 'fake-audio-123' } }; }
function imageMsg()       { return { type: 'image', image: { id: 'fake-image-456' } }; }
function stickerMsg()     { return { type: 'sticker', sticker: { id: 'fake-sticker-789' } }; }

test('C.11 integration — Edge cases', async (t) => {
  const tenant = await getTenant('rajathee.myshopify.com');
  assert.ok(tenant);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);

  await t.test('1. Audio message → "can\'t listen to voice notes" + welcome list', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, audioMsg(), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(texts.some(t => /voice notes/i.test(t.text)),
      'voice note ack sent');
    assert.strictEqual(lists.length, 1, 'welcome list shown after non-text ack');
  });

  await t.test('2. Image message → "can\'t see images" + welcome list', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, imageMsg(), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(texts.some(t => /can't see images/i.test(t.text)),
      'image ack sent');
    assert.strictEqual(lists.length, 1, 'welcome list shown after non-text ack');
  });

  await t.test('3. Sticker message → "can\'t see images" path', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, stickerMsg(), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /can't see images/i.test(t.text)),
      'sticker handled like image');
  });

  await t.test('4. Hindi नमस्ते greeting → welcome list (Devanagari)', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('\u0928\u092E\u0938\u094D\u0924\u0947'), conv.messages, conv.cart));

    const lists = sent.filter(s => s.kind === 'list');
    assert.strictEqual(lists.length, 1, 'devanagari namaste triggers welcome');
  });

  await t.test('5. "namaste" Hinglish greeting → welcome list', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('namaste'), conv.messages, conv.cart));

    const lists = sent.filter(s => s.kind === 'list');
    assert.strictEqual(lists.length, 1, 'hinglish namaste triggers welcome');
  });

  await t.test('6. "stylist" keyword → routes to stylist handoff', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('stylist'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    assert.ok(texts.some(t => /stylist will reach out/i.test(t.text)),
      'stylist keyword triggers handoff');
  });

  await t.test('7. Random off-topic text → soft prompt + welcome', async () => {
    sent.length = 0;
    const conv = await safeConv(tenant.id, TEST_PHONE);
    await rajathee.handle(makeCtx(tenant, textMsg('do you sell shoes'), conv.messages, conv.cart));

    const texts = sent.filter(s => s.kind === 'text');
    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(texts.some(t => /sarees|find the right one/i.test(t.text)),
      'off-topic prompt sent');
    assert.strictEqual(lists.length, 1, 'welcome list shown after off-topic prompt');
  });

  // Cleanup
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2', [tenant.id, TEST_PHONE]);
  await pool.end();
});
