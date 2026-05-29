// Step 1 — adds the payment-mode menu (constants + handlePaymentMenu).
// SAFE: defines new code only; nothing calls it yet, so the live flow is unchanged.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'handlers', 'rajathee.js');

let src = fs.readFileSync(FILE, 'utf8');
if (src.includes('PAYMENT_BTN')) {
  console.log('⏭  Step 1 already applied (PAYMENT_BTN found). No changes made.');
  process.exit(0);
}

// 1) Add a PAYMENT checkout step
const stepAnchor = "  REVIEW:   'review',\n  CONFIRMED:'confirmed',";
if (!src.includes(stepAnchor)) { console.error('❌ anchor #1 (CHECKOUT_STEP) not found'); process.exit(1); }
src = src.replace(stepAnchor, "  REVIEW:   'review',\n  PAYMENT:  'payment_method',\n  CONFIRMED:'confirmed',");

// 2) Add PAYMENT_BTN constants right after the CHECKOUT_BTN block
const btnAnchor = "  CANCEL:     'Cancel checkout',\n};";
if (!src.includes(btnAnchor)) { console.error('❌ anchor #2 (CHECKOUT_BTN) not found'); process.exit(1); }
const paymentBtns = btnAnchor + `

// ─── Payment-mode buttons (Card / UPI / COD) ──────────────────────────────
const PAYMENT_BTN = {
  CARD: 'Pay by Card',
  UPI:  'Pay by UPI',
  COD:  'Cash on Delivery',
};`;
src = src.replace(btnAnchor, paymentBtns);

// 3) Add the handlePaymentMenu function just before handleCheckoutConfirm
const fnAnchor = "async function handleCheckoutConfirm(ctx) {";
if (!src.includes(fnAnchor)) { console.error('❌ anchor #3 (handleCheckoutConfirm) not found'); process.exit(1); }
const menuFn = `// ─── Payment-mode menu — shown after address is collected ─────────────────
async function handlePaymentMenu(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand = subtotal + shipping;

  await sendButtons(from,
    '*How would you like to pay?*\\n\\n' +
    'Order total: ' + formatPrice(grand) +
    (shipping === 0 ? ' (free shipping)' : ' incl. ' + formatPrice(shipping) + ' shipping') + '\\n\\n' +
    '💳 *Card* — pay securely online\\n' +
    '📲 *UPI* — scan & pay\\n' +
    '📦 *COD* — ₹100 advance now, rest on delivery',
    [PAYMENT_BTN.CARD, PAYMENT_BTN.UPI, PAYMENT_BTN.COD],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee payment_menu_shown]' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: { ...co, step: CHECKOUT_STEP.PAYMENT } },
  });
}

`;
src = src.replace(fnAnchor, menuFn + fnAnchor);

fs.writeFileSync(FILE, src);
console.log('✅ Step 1 applied: added CHECKOUT_STEP.PAYMENT, PAYMENT_BTN, and handlePaymentMenu().');
