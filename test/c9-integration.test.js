// test/c9-integration.test.js
// Phase C.9 — Smart Q&A: FAQ classification, off-topic warning + mute, unmute paths.

require('dotenv').config();

// Alias DATABASE_PUBLIC_URL to DATABASE_URL for db.js (same pattern as c10).
// .env may have an empty DATABASE_URL line which beats DATABASE_PUBLIC_URL,
// so we always overwrite when DATABASE_PUBLIC_URL is set.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const { test } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  idleTimeoutMillis: 60000,
});
pool.on('error', (e) => console.error('[pg pool error]', e.message));

const TEST_PHONE = '919999999091';
const sent = [];

const whatsappMock = {
  sendMessage: async (to, body) => { sent.push({ kind: 'message', to, body }); },
  sendButtons: async (to, body, buttons) => { sent.push({ kind: 'buttons', to, body, buttons }); },
  sendList: async (to, body, sections) => { sent.push({ kind: 'list', to, body, sections }); },
  sendImage: async (to, imageUrl, caption) => { sent.push({ kind: 'image', to, imageUrl, caption }); },
};

require.cache[require.resolve('../whatsapp')] = { exports: whatsappMock };
const rajathee = require('../handlers/rajathee');

function textMsg(text) {
  return { from: TEST_PHONE, type: 'text', text: { body: text } };
}

function makeCtx(tenant, message, history, cart) {
  return {
    tenant,
    from: TEST_PHONE,
    text: message.text?.body || '',
    message,
    phoneNumberId: tenant.phone_number_id || 'test-phone',
    waToken: 'test-token',
    history: history || [],
    cart: cart || {},
  };
}

async function fetchTenant() {
  const r = await pool.query("SELECT * FROM tenants WHERE shop_domain = 'rajathee.myshopify.com'");
  return r.rows[0];
}

async function resetConv(tenantId) {
  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenantId, TEST_PHONE]
  );
}

test('C.9 integration — Smart Q&A', async (t) => {
  const tenant = await fetchTenant();

  await t.test('1. Shipping question → FAQ shipping answer + welcome', async () => {
    sent.length = 0;
    await resetConv(tenant.id);
    await rajathee.handle(makeCtx(tenant, textMsg('when will my order arrive')));
    const messages = sent.filter(s => s.kind === 'message');
    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(messages.some(m => /4-5 days|free.*999|tracking/i.test(m.body)),
      'shipping FAQ answer sent');
    assert.strictEqual(lists.length, 1, 'welcome list shown after FAQ');
  });

  await t.test('2. Returns question → FAQ returns answer', async () => {
    sent.length = 0;
    await resetConv(tenant.id);
    await rajathee.handle(makeCtx(tenant, textMsg('can I return this saree')));
    const messages = sent.filter(s => s.kind === 'message');
    assert.ok(messages.some(m => /7 days|unworn|original packaging/i.test(m.body)),
      'returns FAQ answer sent');
  });

  await t.test('3. Sizing question → FAQ sizing answer', async () => {
    sent.length = 0;
    await resetConv(tenant.id);
    await rajathee.handle(makeCtx(tenant, textMsg('how long is the saree')));
    const messages = sent.filter(s => s.kind === 'message');
    assert.ok(messages.some(m => /6\.2|6\.5|fall.*pico|ready to wear/i.test(m.body)),
      'sizing FAQ answer sent');
  });

  await t.test('4. Payment question → FAQ payment answer', async () => {
    sent.length = 0;
    await resetConv(tenant.id);
    await rajathee.handle(makeCtx(tenant, textMsg('do you take credit cards')));
    const messages = sent.filter(s => s.kind === 'message');
    assert.ok(messages.some(m => /UPI|GPay|rajathee\.com/i.test(m.body)),
      'payment FAQ answer sent');
  });

  await t.test('5. First off-topic → warning + welcome (NOT muted yet)', async () => {
    sent.length = 0;
    await resetConv(tenant.id);
    await rajathee.handle(makeCtx(tenant, textMsg('do you sell shoes')));
    const messages = sent.filter(s => s.kind === 'message');
    const lists = sent.filter(s => s.kind === 'list');
    assert.ok(messages.some(m => /sarees|saree question/i.test(m.body)),
      'off-topic warning sent');
    assert.strictEqual(lists.length, 1, 'welcome list shown after warning');

    // Verify NOT muted yet
    const r = await pool.query(
      'SELECT cart FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
      [tenant.id, TEST_PHONE]
    );
    const muted = r.rows[0]?.cart?.rajathee?.muted;
    assert.notStrictEqual(muted, true, 'should not be muted after 1st off-topic');
  });

  await t.test('6. Second off-topic → mute message + cart.muted=true', async () => {
    sent.length = 0;
    // State from test 5 is preserved (offTopicCount=1, not muted).
    await rajathee.handle(makeCtx(tenant, textMsg('are you hiring'),
      [], { rajathee: { offTopicCount: 1 } }));
    const messages = sent.filter(s => s.kind === 'message');
    assert.ok(messages.some(m => /wait|saree question/i.test(m.body)),
      'mute message sent');

    // Verify NOW muted in DB
    const r = await pool.query(
      'SELECT cart FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
      [tenant.id, TEST_PHONE]
    );
    const muted = r.rows[0]?.cart?.rajathee?.muted;
    assert.strictEqual(muted, true, 'should be muted after 2nd off-topic');
  });

  await t.test('7. Muted + non-saree text → silent (no response)', async () => {
    sent.length = 0;
    // Cart explicitly muted in ctx
    await rajathee.handle(makeCtx(tenant, textMsg('what is the time'),
      [], { rajathee: { muted: true } }));
    assert.strictEqual(sent.length, 0, 'no messages sent when muted + non-saree');
  });

  await t.test('8. Muted + saree keyword → unmutes + welcomes', async () => {
    sent.length = 0;
    await rajathee.handle(makeCtx(tenant, textMsg('show me a silk saree'),
      [], { rajathee: { muted: true } }));
    // Should unmute and treat as fresh request.
    const lists = sent.filter(s => s.kind === 'list');
    // At minimum, it should have responded (not silent)
    assert.ok(sent.length > 0, 'should respond when saree keyword unmutes');
  });

  // Cleanup
  await pool.query(
    'DELETE FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
    [tenant.id, TEST_PHONE]
  );
  await pool.end();
});
