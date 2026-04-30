// test/rajathee.test.js
// Test harness for handlers/rajathee.js
// Run: node test/rajathee.test.js
//
// Mocks ../whatsapp (transport) and ../db (persistence) so we can run
// the handler with simulated webhook payloads, no network or DB calls.
//
// Each test:
//   1. Builds a tenant + conversation fixture
//   2. Builds a webhook-style ctx (tenant, message, from, text, ...)
//   3. Calls rajathee.handle(ctx)
//   4. Asserts on what got sent and what got persisted

const path = require('path');
const assert = require('assert');

// ─── MOCK STATE (reset per test) ──────────────────────────────────────────
const mocks = {
  sent: [],          // [{ kind, args }]
  persisted: null,   // { tenantId, from, messages, cart }
};

function resetMocks() {
  mocks.sent = [];
  mocks.persisted = null;
}

// ─── INSTALL MOCKS BEFORE HANDLER LOADS ───────────────────────────────────
// We bypass the real ../whatsapp and ../db modules by pre-populating
// require.cache with our fakes. Must run before require('../handlers/rajathee').

function installMock(modulePath, exportsObj) {
  // Resolve from the handlers/ directory so the relative require('..') matches
  const fromHandlers = path.resolve(__dirname, '..', 'handlers', 'placeholder.js');
  const resolved = require.resolve(modulePath, { paths: [path.dirname(fromHandlers)] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
}

const whatsappMock = {
  sendMessage: async (to, body, token, phoneNumberId) => {
    mocks.sent.push({ kind: 'message', to, body, token, phoneNumberId });
  },
  sendButtons: async (to, body, buttons, token, phoneNumberId) => {
    mocks.sent.push({ kind: 'buttons', to, body, buttons, token, phoneNumberId });
  },
  sendList: async (to, body, sections, token, phoneNumberId) => {
    mocks.sent.push({ kind: 'list', to, body, sections, token, phoneNumberId });
  },
  sendImage: async (to, imageUrl, caption, token, phoneNumberId) => {
    mocks.sent.push({ kind: 'image', to, imageUrl, caption, token, phoneNumberId });
  },
};

const dbMock = {
  getConversation: async (tenantId, customerPhone) => {
    return null;
  },
  upsertConversation: async (tenantId, customerPhone, messages, cart) => {
    mocks.persisted = { tenantId, from: customerPhone, messages, cart };
    return { tenant_id: tenantId, customer_phone: customerPhone, messages, cart };
  },
};

installMock('../whatsapp', whatsappMock);
installMock('../db', dbMock);

// ─── NOW load the handler (will use our mocks) ────────────────────────────
const rajathee = require('../handlers/rajathee');

// ─── FIXTURES ─────────────────────────────────────────────────────────────
const tenantRajathee = {
  id: 2,
  shop_domain: 'rajathee.myshopify.com',
  store_name: 'Rajathee',
  flow_template: 'rajathee',
  whatsapp_number: 'TEST_PHONE_NUMBER_ID',
  whatsapp_token: 'TEST_WA_TOKEN',
  shopify_token: 'TEST_SHOPIFY_TOKEN',
  tier: 'free',
};

const tenantWrongFlow = {
  ...tenantRajathee,
  flow_template: 'jhilmil',
};

function buildTextMessage(text) {
  return {
    type: 'text',
    from: '919999999999',
    text: { body: text },
  };
}

function buildButtonReplyMessage(title, id = null) {
  return {
    type: 'interactive',
    from: '919999999999',
    interactive: {
      button_reply: { title, id: id || title.toLowerCase().replace(/\s+/g, '_') },
    },
  };
}

function buildListReplyMessage(title, id) {
  return {
    type: 'interactive',
    from: '919999999999',
    interactive: {
      list_reply: { title, id, description: '' },
    },
  };
}

function buildCtx({ tenant = tenantRajathee, message, history = [], cart = {} } = {}) {
  const text =
    message.type === 'text'
      ? message.text.body
      : message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        '';
  return {
    tenant,
    message,
    from: message.from,
    text,
    phoneNumberId: tenant.whatsapp_number,
    waToken: tenant.whatsapp_token,
    history,
    cart,
  };
}

// ─── ASSERTION HARNESS ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  resetMocks();
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err.message}`);
  }
}

function describe(suite, fn) {
  console.log(`\n${suite}`);
  return fn();
}

// ─── TESTS ────────────────────────────────────────────────────────────────
(async () => {
  console.log('Running Rajathee handler tests...');

  await describe('Tenant guard', async () => {
    await test('skeleton: refuses wrong flow_template (jhilmil tenant)', async () => {
      const ctx = buildCtx({
        tenant: tenantWrongFlow,
        message: buildTextMessage('hi'),
      });
      await rajathee.handle(ctx);
      assert.strictEqual(mocks.sent.length, 0, 'should send nothing on wrong tenant');
      assert.strictEqual(mocks.persisted, null, 'should persist nothing on wrong tenant');
    });

    await test('skeleton: runs on correct tenant (flow_template=rajathee)', async () => {
      const ctx = buildCtx({
        tenant: tenantRajathee,
        message: buildTextMessage('hi'),
      });
      await rajathee.handle(ctx);
      assert.ok(mocks.sent.length >= 1, 'should send at least one message');
      assert.ok(mocks.persisted !== null, 'should persist conversation');
      assert.strictEqual(mocks.persisted.tenantId, tenantRajathee.id);
      assert.strictEqual(mocks.persisted.from, '919999999999');
    });
  });

  // Phase C.1+ tests will be added below as each PDF section is built.

  // ─── REPORT ─────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────');
  console.log(`Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => {
      console.log(`  ${f.name}`);
      console.log(`    ${f.err.stack}`);
    });
    process.exit(1);
  }
  process.exit(0);
})();
