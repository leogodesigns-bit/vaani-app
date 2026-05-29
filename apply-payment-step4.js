// Step 4 — UPI branch: dynamic per-order QR + handler.
// Adds: qrcode dep, routes/qr.js (renders the QR), /qr mount in index.js,
// and handlePaymentUPI() in rajathee.js. SAFE: handler isn't called yet.
const fs = require('fs');
const path = require('path');

// ---- 1) package.json: add qrcode dependency ----
const PKG = path.join(__dirname, 'package.json');
let pkg = fs.readFileSync(PKG, 'utf8');
if (!pkg.includes('"qrcode"')) {
  const pkgAnchor = '  "dependencies": {\n    "@anthropic-ai/sdk": "^0.90.0",';
  if (!pkg.includes(pkgAnchor)) { console.error('❌ package.json anchor not found'); process.exit(1); }
  pkg = pkg.replace(pkgAnchor, '  "dependencies": {\n    "qrcode": "^1.5.4",\n    "@anthropic-ai/sdk": "^0.90.0",');
  fs.writeFileSync(PKG, pkg);
  console.log('• package.json: added qrcode');
} else { console.log('• package.json: qrcode already present'); }

// ---- 2) routes/qr.js (new file) ----
const QRFILE = path.join(__dirname, 'routes', 'qr.js');
if (!fs.existsSync(QRFILE)) {
  const qrSrc = [
    "const express = require('express');",
    "const router = express.Router();",
    "const QRCode = require('qrcode');",
    "const { getOrder } = require('../db');",
    "",
    "// Rajathee UPI payee (IDBI merchant VPA).",
    "const UPI_VPA   = 'idb260300711947@idbi';",
    "const UPI_PAYEE = 'LVSG SAREES OPC PVT LTD';",
    "",
    "// GET /qr/:orderId.png — dynamic UPI QR with the exact order amount baked in.",
    "router.get('/:orderId.png', async (req, res) => {",
    "  try {",
    "    const orderId = req.params.orderId;",
    "    const order = await getOrder(orderId).catch(() => null);",
    "    if (!order) return res.status(404).send('order not found');",
    "    const amount = Number(order.grand_total || 0).toFixed(2);",
    "    const link = 'upi://pay?pa=' + encodeURIComponent(UPI_VPA)",
    "      + '&pn=' + encodeURIComponent(UPI_PAYEE)",
    "      + '&am=' + amount + '&cu=INR&tn=' + encodeURIComponent(orderId);",
    "    const png = await QRCode.toBuffer(link, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });",
    "    res.set('Content-Type', 'image/png');",
    "    res.set('Cache-Control', 'public, max-age=86400');",
    "    res.send(png);",
    "  } catch (e) {",
    "    console.error('[qr route] error:', e.message);",
    "    res.status(500).send('qr error');",
    "  }",
    "});",
    "",
    "module.exports = router;",
    "",
  ].join('\n');
  fs.writeFileSync(QRFILE, qrSrc);
  console.log('• created routes/qr.js');
} else { console.log('• routes/qr.js already exists'); }

// ---- 3) index.js: mount /qr ----
const IDX = path.join(__dirname, 'index.js');
let idx = fs.readFileSync(IDX, 'utf8');
if (!idx.includes("require('./routes/qr')")) {
  const idxAnchor = "app.use('/shopify-webhook', require('./routes/shopify-webhook'));";
  if (!idx.includes(idxAnchor)) { console.error('❌ index.js mount anchor not found'); process.exit(1); }
  idx = idx.replace(idxAnchor, idxAnchor + "\napp.use('/qr', require('./routes/qr'));");
  fs.writeFileSync(IDX, idx);
  console.log('• index.js: mounted /qr');
} else { console.log('• index.js: /qr already mounted'); }

// ---- 4) handlers/rajathee.js: public-url const + handlePaymentUPI ----
const RAJ = path.join(__dirname, 'handlers', 'rajathee.js');
let raj = fs.readFileSync(RAJ, 'utf8');
if (!raj.includes('handlePaymentUPI')) {
  const constAnchor = "  COD:  'Cash on Delivery',\n};";
  if (!raj.includes(constAnchor)) { console.error('❌ rajathee PAYMENT_BTN anchor not found'); process.exit(1); }
  const pubConst = constAnchor + "\n\nconst VAANI_PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN\n  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN\n  : 'https://vaani-app-production-6407.up.railway.app';";
  raj = raj.replace(constAnchor, pubConst);

  const fnAnchor = "async function handleCheckoutConfirm(ctx) {";
  if (!raj.includes(fnAnchor)) { console.error('❌ rajathee handleCheckoutConfirm anchor not found'); process.exit(1); }
  const upiFn = "// ─── UPI branch — dynamic QR; team confirms on dashboard / via 'confirmed RAJ-XXX' ─\n"
    + "async function handlePaymentUPI(ctx) {\n"
    + "  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;\n"
    + "  const r = cart.rajathee || {};\n"
    + "  const co = r.checkout || {};\n"
    + "  const items = r.items || [];\n\n"
    + "  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {\n"
    + "    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);\n"
    + "    return;\n"
    + "  }\n\n"
    + "  const orderId  = generateOrderId(co.phone || from);\n"
    + "  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);\n"
    + "  const shipping = calcShipping(subtotal);\n"
    + "  const grand    = subtotal + shipping;\n\n"
    + "  try {\n"
    + "    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);\n"
    + "  } catch (e) { console.error('[rajathee upi] saveOrder failed:', e.message); }\n\n"
    + "  const qrUrl = VAANI_PUBLIC_URL + '/qr/' + orderId + '.png';\n"
    + "  await sendImage(from, qrUrl, '📲 Scan to pay ' + formatPrice(grand) + ' via any UPI app', waToken, phoneNumberId);\n"
    + "  await sendMessage(from,\n"
    + "    'Order *' + orderId + '* — total *' + formatPrice(grand) + '*.\\n\\n' +\n"
    + "    'Once you have paid, reply here with your *UPI reference number* (the 12-digit ref in your payment app) or a screenshot. ' +\n"
    + "    'Our team will verify it and your confirmation will land right here ✨',\n"
    + "    waToken, phoneNumberId);\n\n"
    + "  await sendOwnerAlert(ctx, items, co, orderId);\n\n"
    + "  await upsertConversation(tenant.id, from, [\n"
    + "    ...history,\n"
    + "    { role: 'user', content: text },\n"
    + "    { role: 'assistant', content: '[rajathee upi_order=' + orderId + ']' },\n"
    + "  ], {\n"
    + "    ...cart,\n"
    + "    rajathee: {\n"
    + "      ...r,\n"
    + "      items: [],\n"
    + "      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId, paymentMethod: 'upi' },\n"
    + "      lastOrderId: orderId,\n"
    + "    },\n"
    + "  });\n"
    + "}\n\n";
  raj = raj.replace(fnAnchor, upiFn + fnAnchor);
  fs.writeFileSync(RAJ, raj);
  console.log('• rajathee.js: added VAANI_PUBLIC_URL + handlePaymentUPI()');
} else { console.log('• rajathee.js: handlePaymentUPI already present'); }

console.log('✅ Step 4 applied.');
