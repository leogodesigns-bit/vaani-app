// scripts/simulate-rajathee-scenarios.js
// One-off in-process runner for the 10 Rajathee test scenarios.
// Uses the same stubs the POST /webhook/test-simulate endpoint uses:
//   - axios.post → no-op for graph.facebook.com
//   - whatsapp.drainSentMessages → suppressed inside upsertConversation
// so the queue survives until we drain it at the end of each scenario.
//
// Writes to the conversations table for TEST_PHONE; the row is reset before
// each scenario.

require('dotenv').config();

const TEST_PHONE = '9999900000';
const TENANT_ID  = 2;

const axios = require('axios');
const waModule = require('../whatsapp');
const { pool, getConversation } = require('../db');
const rajatheeHandler = require('../handlers/rajathee');

const realAxiosPost = axios.post.bind(axios);
const realDrain = waModule.drainSentMessages;

axios.post = async function patchedPost(url, ...rest) {
  if (typeof url === 'string' && url.includes('graph.facebook.com')) {
    return { data: { messages: [{ id: 'sim_' + Date.now() }] } };
  }
  return realAxiosPost(url, ...rest);
};

waModule.drainSentMessages = () => [];

async function loadTenant() {
  const r = await pool.query('SELECT * FROM tenants WHERE id=$1', [TENANT_ID]);
  if (!r.rows[0]) throw new Error('tenant 2 not found');
  return r.rows[0];
}

async function reset() {
  await pool.query('DELETE FROM conversations WHERE tenant_id=$1 AND customer_phone=$2', [TENANT_ID, TEST_PHONE]);
}

async function runOne(tenant, text, { keepState = false, seedCart = null } = {}) {
  if (!keepState) await reset();
  if (seedCart) {
    await pool.query(
      'INSERT INTO conversations (tenant_id, customer_phone, messages, cart) VALUES ($1,$2,$3,$4) ' +
      'ON CONFLICT (tenant_id, customer_phone) DO UPDATE SET cart = EXCLUDED.cart',
      [TENANT_ID, TEST_PHONE, JSON.stringify([]), JSON.stringify(seedCart)]
    );
  }
  const conv = await getConversation(TENANT_ID, TEST_PHONE);
  const ctx = {
    tenant,
    message: { type: 'text', text: { body: text } },
    from: TEST_PHONE,
    text,
    phoneNumberId: 'sim_phone',
    waToken: 'sim_token',
    history: conv?.messages || [],
    cart: conv?.cart || {},
  };
  try {
    await rajatheeHandler.handle(ctx);
  } catch (e) {
    return { error: e.message, messages: [] };
  }
  const messages = realDrain.call(waModule, TEST_PHONE) || [];
  return { messages };
}

function renderMessages(messages) {
  return messages.map(m => '  [' + (m.kind || '?') + '] ' + (m.content || '').replace(/\n/g, ' / ').slice(0, 200)).join('\n');
}

// ─── Assertion helpers ─────────────────────────────────────────────────────
function joined(messages) { return messages.map(m => m.content || '').join('\n\n'); }
function hasText(messages, needle) { return joined(messages).toLowerCase().includes(needle.toLowerCase()); }
function hasRegex(messages, re) { return re.test(joined(messages)); }
function imageCount(messages) { return messages.filter(m => m.kind === 'image').length; }
function listCount(messages) { return messages.filter(m => m.kind === 'list').length; }
function buttonCount(messages) { return messages.filter(m => m.kind === 'buttons').length; }

// ─── Scenarios ─────────────────────────────────────────────────────────────
const scenarios = [
  {
    name: '1. "Hi" — greeting + menu',
    inputs: [{ text: 'Hi' }],
    checks: (msgs) => ([
      ['greeting text present',  hasRegex(msgs, /welcome|hi|hello|namaste|tara/i)],
      ['menu buttons sent',      buttonCount(msgs) >= 1],
      ['mentions browse fabric', hasText(msgs, 'fabric')],
      ['mentions browse colour', hasText(msgs, 'colour')],
    ]),
  },
  {
    name: '2. "sarees under 1500" — price filter',
    inputs: [{ text: 'sarees under 1500' }],
    checks: (msgs) => ([
      ['budget header includes ₹1,500', hasText(msgs, '₹1,500')],
      ['at least 1 product card shown', imageCount(msgs) >= 1],
      ['"Add to cart 🛒" CTA present',  hasText(msgs, 'Add to cart')],
    ]),
  },
  {
    name: '3. "1000 se kam" — Hindi budget',
    inputs: [{ text: '1000 se kam' }],
    checks: (msgs) => ([
      ['budget header includes ₹1,000', hasText(msgs, '₹1,000')],
      ['empty-budget message OR cards', hasRegex(msgs, /under.*₹1,000|couldn't find/i)],
    ]),
  },
  {
    name: '4. "show me bestsellers" — bestseller products',
    inputs: [{ text: 'show me bestsellers' }],
    checks: (msgs) => ([
      ['mentions bestsellers',          hasRegex(msgs, /bestseller|most-loved/i)],
      ['at least 1 product card shown', imageCount(msgs) >= 1],
    ]),
  },
  {
    name: '5. "show me silk sarees" — fabric filter + CTA',
    inputs: [{ text: 'show me silk sarees' }],
    checks: (msgs) => ([
      ['at least 1 product card shown', imageCount(msgs) >= 1],
      ['"Add to cart 🛒" CTA present',  hasText(msgs, 'Add to cart')],
      ['mentions silk',                 hasText(msgs, 'silk')],
    ]),
  },
  {
    name: '6. "I want to talk to a stylist" — handoff followup',
    inputs: [{ text: 'I want to talk to a stylist' }],
    checks: (msgs) => ([
      ['confirmation "Of course"',          hasText(msgs, 'Of course')],
      ['wait-time message (20-30 mins)',    hasText(msgs, '20-30')],
      ['draped link present',               hasText(msgs, '/#draped')],
      ['bestseller cards shown',            imageCount(msgs) >= 3],
    ]),
  },
  {
    name: '7. "blue sarees" — colour filter',
    inputs: [{ text: 'blue sarees' }],
    checks: (msgs) => ([
      ['at least 1 product card shown', imageCount(msgs) >= 1],
      ['"Add to cart 🛒" CTA present',  hasText(msgs, 'Add to cart')],
    ]),
  },
  {
    name: '8. "show me cotton sarees" — products + Add-to-cart CTA',
    inputs: [{ text: 'show me cotton sarees' }],
    checks: (msgs) => ([
      ['at least 3 product cards',     imageCount(msgs) >= 3],
      ['"Add to cart 🛒" CTA present', hasText(msgs, 'Add to cart')],
    ]),
  },
  {
    name: '9. "where is my order #12345" — order inquiry',
    inputs: [{ text: 'where is my order #12345' }],
    checks: (msgs) => ([
      ['acknowledges order',  hasRegex(msgs, /order.*#?12345/i)],
      ['mentions team/Nikita', hasRegex(msgs, /Nikita|team/i)],
    ]),
  },
  {
    name: '10. "not sure which one" after browsing — reviews/draped link',
    inputs: [
      { text: 'show me silk sarees' },
      { text: 'not sure which one', keepState: true },
    ],
    checks: (msgs) => ([
      ['draped link surfaces', hasText(msgs, '/#draped')],
    ]),
  },
  {
    name: '11. "Checkout" with address on file — straight to payment menu',
    inputs: [{
      text: 'Checkout',
      seedCart: {
        rajathee: {
          items: [{ kind: 'saree', productHandle: 'meera-bloom', productTitle: 'Meera Bloom', price: 1190, quantity: 1 }],
          checkout: { name: 'Test User', address1: '12 Test St', city: 'Mumbai', state: 'MH', pin: '400001', phone: TEST_PHONE },
        },
      },
    }],
    checks: (msgs) => ([
      ['payment menu shown',           hasText(msgs, 'How would you like to pay')],
      ['order total appears',          hasText(msgs, '₹1,190')],
      ['no address re-collection',     !hasText(msgs, 'Full Name')],
    ]),
  },
];

async function main() {
  const tenant = await loadTenant();
  console.log('═══ Rajathee scenario simulator ═══');
  console.log('tenant:', tenant.shop_domain, '| flow:', tenant.flow_template);
  console.log('');

  let pass = 0, fail = 0;
  for (const sc of scenarios) {
    console.log('───', sc.name, '───');
    let allMsgs = [];
    for (const inp of sc.inputs) {
      const r = await runOne(tenant, inp.text, { keepState: !!inp.keepState, seedCart: inp.seedCart || null });
      if (r.error) {
        console.log('  ERROR:', r.error);
        break;
      }
      console.log('  → input:', JSON.stringify(inp.text));
      console.log(renderMessages(r.messages));
      allMsgs = allMsgs.concat(r.messages);
    }
    const results = sc.checks(allMsgs);
    const failed = results.filter(r => !r[1]);
    if (failed.length === 0) {
      console.log('  ✅ PASS');
      pass++;
    } else {
      console.log('  ❌ FAIL — failed checks:');
      for (const [name] of failed) console.log('     •', name);
      fail++;
    }
    console.log('');
  }

  console.log('═══ Summary ═══');
  console.log('PASS:', pass, '/ FAIL:', fail, '/ TOTAL:', scenarios.length);

  await reset();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
