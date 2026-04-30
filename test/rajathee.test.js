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

  // ─── PHASE C.1 — PDF Section 1 (Welcome flow) ─────────────────────
  const { WELCOME_BODY, WELCOME_ROW } = rajathee;

  await describe('Phase C.1 — Welcome flow', async () => {

    await test('greeting "hi" sends a list with the locked Welcome body', async () => {
      const ctx = buildCtx({ message: buildTextMessage('hi') });
      await rajathee.handle(ctx);

      const lists = mocks.sent.filter(s => s.kind === 'list');
      assert.strictEqual(lists.length, 1, 'should send exactly one list');
      assert.strictEqual(lists[0].body, WELCOME_BODY, 'body must match locked WELCOME_BODY');
    });

    await test('Welcome list has exactly 5 rows', async () => {
      const ctx = buildCtx({ message: buildTextMessage('hi') });
      await rajathee.handle(ctx);

      const list = mocks.sent.find(s => s.kind === 'list');
      assert.ok(list, 'expected a list message');
      assert.strictEqual(list.sections.length, 1, 'one section');
      assert.strictEqual(list.sections[0].rows.length, 5, 'exactly 5 rows');
    });

    await test('Welcome list row IDs match the WELCOME_ROW contract', async () => {
      const ctx = buildCtx({ message: buildTextMessage('hi') });
      await rajathee.handle(ctx);

      const list = mocks.sent.find(s => s.kind === 'list');
      const ids = list.sections[0].rows.map(r => r.id);
      const expected = [
        WELCOME_ROW.BROWSE_FABRIC,
        WELCOME_ROW.BROWSE_COLOUR,
        WELCOME_ROW.BESTSELLERS,
        WELCOME_ROW.AKSHAY,
        WELCOME_ROW.STYLING,
      ];
      assert.deepStrictEqual(ids, expected, 'row IDs must match contract in order');
    });

    await test('Welcome row titles are exactly as the PDF specifies', async () => {
      const ctx = buildCtx({ message: buildTextMessage('hi') });
      await rajathee.handle(ctx);

      const list = mocks.sent.find(s => s.kind === 'list');
      const titles = list.sections[0].rows.map(r => r.title);
      assert.deepStrictEqual(titles, [
        'Browse by fabric',
        'Browse by colour',
        'Bestsellers',
        'Akshay Tritiya',
        "I'd like styling help",
      ]);
    });

    await test('voice rules: Welcome body has no exclamation marks', async () => {
      // PDF voice rules: "No exclamation marks unless quoting a customer."
      assert.ok(!WELCOME_BODY.includes('!'), 'WELCOME_BODY must not contain "!"');
    });

    await test('voice rules: Welcome body uses canonical brand tagline', async () => {
      // Founder-supplied tagline (replaces "Where heritage drapes elegance" placeholder).
      assert.ok(
        WELCOME_BODY.includes('Effortless and Elegant Sarees for Women on the Move'),
        'WELCOME_BODY must contain the canonical brand tagline'
      );
    });

    // Greeting variants — all should produce the same Welcome list.
    const greetings = ['hi', 'hello', 'hey', 'helo', 'namaste', 'namaskar', 'start', 'help'];
    for (const greeting of greetings) {
      await test(`greeting variant: "${greeting}" triggers Welcome`, async () => {
        const ctx = buildCtx({ message: buildTextMessage(greeting) });
        await rajathee.handle(ctx);
        const list = mocks.sent.find(s => s.kind === 'list');
        assert.ok(list, `"${greeting}" must trigger Welcome list`);
        assert.strictEqual(list.body, WELCOME_BODY);
      });
    }

    await test('greeting variant: "Hi!!!" with caps and punctuation triggers Welcome', async () => {
      const ctx = buildCtx({ message: buildTextMessage('Hi!!!') });
      await rajathee.handle(ctx);
      const list = mocks.sent.find(s => s.kind === 'list');
      assert.ok(list, 'mixed-case + punctuation must still match');
    });

    await test('greeting variant: "  hello  " (whitespace) triggers Welcome', async () => {
      const ctx = buildCtx({ message: buildTextMessage('  hello  ') });
      await rajathee.handle(ctx);
      const list = mocks.sent.find(s => s.kind === 'list');
      assert.ok(list, 'whitespace-padded greeting must still match');
    });

    await test('Welcome persists conversation with [welcome shown] marker', async () => {
      const ctx = buildCtx({ message: buildTextMessage('hi') });
      await rajathee.handle(ctx);
      assert.ok(mocks.persisted, 'should persist');
      const lastAssistantMsg = mocks.persisted.messages
        .filter(m => m.role === 'assistant')
        .pop();
      assert.strictEqual(lastAssistantMsg.content, '[rajathee welcome shown]');
    });

    await test('wrong-tenant guard holds even on a greeting', async () => {
      const ctx = buildCtx({
        tenant: tenantWrongFlow,
        message: buildTextMessage('hi'),
      });
      await rajathee.handle(ctx);
      assert.strictEqual(mocks.sent.length, 0, 'wrong tenant must send nothing');
      assert.strictEqual(mocks.persisted, null, 'wrong tenant must persist nothing');
    });

    await test('non-greeting on fresh conversation does NOT trigger Welcome', async () => {
      // E.g. random text that isn't a known intent and isn't ambiguous.
      // Phase C.1 logs and returns; future phases will add real handlers.
      const ctx = buildCtx({ message: buildTextMessage('random unmatched text here') });
      await rajathee.handle(ctx);
      const lists = mocks.sent.filter(s => s.kind === 'list');
      assert.strictEqual(lists.length, 0, 'no Welcome list for unmatched non-greeting');
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
