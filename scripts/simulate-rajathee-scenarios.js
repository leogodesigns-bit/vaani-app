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
  {
    name: '12. "Show more products" after bestseller browse — paginates, no welcome bounce',
    inputs: [
      { text: 'bestsellers' },
      { text: 'Show more products', keepState: true },
    ],
    checks: (msgs) => {
      // Slice to focus on messages from the SECOND turn only.
      // First turn sends ~6 msgs (3 cards + voice + CTA + buttons), so anything after that.
      const tailIdx = msgs.findIndex(m => /Show more/.test(m.content || ''));
      const second = tailIdx >= 0 ? msgs.slice(tailIdx) : msgs.slice(-6);
      return [
        ['second batch has product cards',     second.filter(m => m.kind === 'image').length >= 1],
        ['no welcome greeting after Show more', !second.some(m => /Welcome to Rajathee/i.test(m.content || ''))],
      ];
    },
  },
  {
    name: '13. Smart Add-to-cart tap with multiple sarees → re-shows picker, no welcome',
    inputs: [
      { text: 'bestsellers' },
      { text: 'Add to cart 🛒', keepState: true },
    ],
    checks: (msgs) => {
      const tail = msgs.slice(-3);
      return [
        ['picker list re-sent',  tail.some(m => m.kind === 'list' && /Pick a saree to add/i.test(m.content || ''))],
        ['no welcome bounce',    !tail.some(m => /Welcome to Rajathee/i.test(m.content || ''))],
      ];
    },
  },
  {
    name: '14. Typing a colour in product detail → variant flow, no welcome bounce',
    inputs: [{
      text: 'Purple',
      seedCart: {
        rajathee: {
          browseMode: 'product_detail',
          product: {
            handle: 'meera-bloom-ivory-crepe-abstract-floral-saree',
            id: 999999,
            currentVariantId: null,
            picsShownCount: 2,
            availableColours: [
              { id: '47057060790455', name: 'Blue',     price: '1190.00' },
              { id: '47057060823223', name: 'Red',      price: '1190.00' },
              { id: '47057060855991', name: 'Purple',   price: '1190.00' },
              { id: '47057060888759', name: 'Sky Blue', price: '1190.00' },
            ],
          },
        },
      },
    }],
    checks: (msgs) => ([
      ['variant images sent',           msgs.filter(m => m.kind === 'image').length >= 1],
      ['variant caption with price',    hasText(msgs, '₹1,190')],
      ['Add to cart button presented',  msgs.some(m => m.kind === 'buttons' && /Add to cart/.test(m.content || ''))],
      ['no welcome bounce',             !msgs.some(m => /Welcome to Rajathee/i.test(m.content || ''))],
    ]),
  },
  {
    name: '15. Address typed mid-checkout never becomes coupon (stuck awaitingCoupon)',
    inputs: [{
      text: 'Poorva Konde',
      seedCart: {
        rajathee: {
          items: [{ kind:'saree', productHandle:'x', productTitle:'X', price:1190, quantity:1 }],
          awaitingCoupon: true,
          checkout: { step: 'name', name:null, address1:null, city:null, state:null, pin:null, phone:TEST_PHONE },
        },
      },
    }],
    checks: (msgs) => ([
      ['no "Coupon noted" persisted',          !msgs.some(m => /Coupon.*noted/i.test(m.content || ''))],
      ['name validated, next field requested', msgs.some(m => /house\/flat|address|street/i.test(m.content || ''))],
    ]),
  },
  {
    name: '16. "Ready to Wear" addon does not double-charge with Pico Fall',
    inputs: [{
      text: 'Ready to Wear',
      seedCart: {
        rajathee: {
          items: [{ kind:'saree', productHandle:'x', productTitle:'X', price:1190, quantity:1 }],
          pendingSareeVariantId: 'V1',
        },
      },
    }],
    checks: (msgs) => ([
      ['RTW line in cart summary',     msgs.some(m => /•\s*Ready to Wear/i.test(m.content || ''))],
      ['no separate Fall & Pico line', !msgs.some(m => /•\s*Fall\s*&\s*Pico|•\s*Pico\s*Fall/i.test(m.content || ''))],
    ]),
  },
  {
    name: '17. Long input at coupon step is rejected, not persisted',
    inputs: [{
      text: 'POORVAKONDEDESHMUKHSHIVTEJCOLONYDAGADOBA',
      seedCart: {
        rajathee: {
          items: [{ kind:'saree', productHandle:'x', productTitle:'X', price:1190, quantity:1 }],
          awaitingCoupon: true,
        },
      },
    }],
    checks: (msgs) => ([
      ['rejection message shown',         msgs.some(m => /coupon codes are usually short|doesn't look like a coupon/i.test(m.content || ''))],
      ['no "Coupon noted" persisted',     !msgs.some(m => /Coupon.*noted/i.test(m.content || ''))],
    ]),
  },
  {
    name: '18. Add to cart works for bestseller-only product (not in all-sarees)',
    inputs: [{
      text: 'Add to cart',
      seedCart: {
        rajathee: {
          browseMode: 'product_detail',
          product: {
            handle: 'soumya-plain-mul-cotton-saree',  // exists in best-sellers, NOT in all-sarees
            id: 999999,
            currentVariantId: null,                    // single-variant, falls back to variants[0]
            picsShownCount: 2,
          },
        },
      },
    }],
    checks: (msgs) => ([
      ['no "Couldn\'t find" error',  !msgs.some(m => /Couldn't find that one/i.test(m.content || ''))],
      ['add confirmation shown',     msgs.some(m => /Added.*cart/i.test(m.content || ''))],
      ['addon prompt shown',         msgs.some(m => m.kind === 'buttons' && /Ready to Wear/.test(m.content || ''))],
    ]),
  },
  {
    name: '19. "Edit cart?" after payment menu → cart view, not off-topic',
    inputs: [{
      text: 'Edit cart?',
      seedCart: {
        rajathee: {
          items: [{ kind:'saree', productHandle:'x', productTitle:'X', price:1190, quantity:1 }],
          checkout: { step:'payment_method', name:'T', address1:'A', city:'C', state:'S', pin:'400001', phone:TEST_PHONE },
        },
      },
    }],
    checks: (msgs) => ([
      ['cart summary shown',      msgs.some(m => /Your cart/i.test(m.content || ''))],
      ['no off-topic warning',    !msgs.some(m => /I'm here to help you find the right saree/i.test(m.content || ''))],
      ['coupon/checkout actions', msgs.some(m => m.kind === 'buttons' && /Apply coupon|Checkout/.test(m.content || ''))],
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
