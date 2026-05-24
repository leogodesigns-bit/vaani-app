#!/usr/bin/env node
// apply-bug-a.js — Adds subcategory step after "Accessories" tap.
// Run from ~/vaani-app:  node apply-bug-a.js
// Idempotent: safe to re-run.

const fs = require('fs');
const path = require('path');

const HANDLER_PATH = path.resolve('handlers/woofparade.js');
const BACKUP_PATH  = path.resolve('handlers/woofparade.js.backup-bug-a');

if (!fs.existsSync(HANDLER_PATH)) {
  console.error('FATAL: handlers/woofparade.js not found. Run from ~/vaani-app');
  process.exit(1);
}

let src = fs.readFileSync(HANDLER_PATH, 'utf8');
const origLen = src.length;

if (!fs.existsSync(BACKUP_PATH)) {
  fs.writeFileSync(BACKUP_PATH, src);
  console.log('✓ Backup created:', BACKUP_PATH);
} else {
  console.log('• Backup exists, skipping:', BACKUP_PATH);
}

// ─── Patch 1: Add ACCESSORY_SUBCATS constant after CATEGORY_LABEL ────────
// Find the CATEGORY_LABEL closing brace and inject our new const right after.
const SUBCAT_OLD = `  [WELCOME_ROW.BESTSELLERS]: 'Bestsellers',
};`;

const SUBCAT_NEW = `  [WELCOME_ROW.BESTSELLERS]: 'Bestsellers',
};

// PATCH BUG-A: Accessories subcategory step — after customer taps "Accessories",
// show 5 subcategories first instead of jumping straight to mixed product list.
const ACCESSORY_SUBCATS = {
  subcat_bandanas:  { label: 'Bandanas',  match: /(bandana)/i },
  subcat_leashes:   { label: 'Leashes',   match: /(leash)/i },
  subcat_collars:   { label: 'Collars',   match: /(collar)/i },
  subcat_harnesses: { label: 'Harnesses', match: /(harness)/i },
  subcat_combos:    { label: 'Combos',    match: /(collar.*leash|harness.*leash|leash.*collar|leash.*harness|combo)/i },
};

// Map free-text input to subcat IDs so "bandanas", "collars", etc. work without buttons
const ACCESSORY_SUBCAT_TEXT_MATCHERS = {
  subcat_bandanas:  /^(bandana|bandanas)$/i,
  subcat_leashes:   /^(leash|leashes)$/i,
  subcat_collars:   /^(collar|collars)$/i,
  subcat_harnesses: /^(harness|harnesses)$/i,
  subcat_combos:    /^(combo|combos|combo set)$/i,
};`;

if (src.includes('ACCESSORY_SUBCATS')) {
  console.log('• Patch 1 (constants) already applied');
} else {
  const occ = (src.match(/  \[WELCOME_ROW\.BESTSELLERS\]: 'Bestsellers',\n\};/g) || []).length;
  if (occ < 1) {
    console.error('FATAL Patch 1: anchor not found');
    process.exit(1);
  }
  // Replace only the FIRST occurrence (CATEGORY_LABEL closes here; other places may have same key)
  src = src.replace(SUBCAT_OLD, SUBCAT_NEW);
  console.log('✓ Patch 1: added ACCESSORY_SUBCATS + text matchers');
}

// ─── Patch 2: Add sendAccessorySubcatPicker function ────────────────────
// Insert it right BEFORE sendCategoryResults
const PICKER_ANCHOR = 'async function sendCategoryResults(ctx, rowId, page) {';
const PICKER_FN = `// PATCH BUG-A: subcategory picker (sent BEFORE sendCategoryResults for accessories)
async function sendAccessorySubcatPicker(ctx) {
  const { from, waToken, phoneNumberId, history, text, tenant, cart } = ctx;
  const rows = Object.entries(ACCESSORY_SUBCATS).map(([id, def]) => ({
    id,
    title: def.label,
    description: '',
  }));
  await sendList(from,
    \`What kind of accessory? \${PAW}\`,
    [{ title: 'Accessories', rows }],
    waToken, phoneNumberId, 'Choose');
  // Persist that we are now awaiting a subcat tap (helps with free-text matchers)
  await upsertConversation(tenant.id, from, [
    ...(history || []),
    { role: 'user', content: text || '' },
    { role: 'assistant', content: '[woofparade accessory_subcat_picker presented]' },
  ], {
    ...(cart || {}),
    woofparade: {
      ...((cart && cart.woofparade) || {}),
      awaitingAccessorySubcat: true,
    },
  });
}

${PICKER_ANCHOR}`;

if (src.includes('sendAccessorySubcatPicker')) {
  console.log('• Patch 2 (picker fn) already applied');
} else if (!src.includes(PICKER_ANCHOR)) {
  console.error('FATAL Patch 2: anchor not found');
  process.exit(1);
} else {
  src = src.replace(PICKER_ANCHOR, PICKER_FN);
  console.log('✓ Patch 2: added sendAccessorySubcatPicker function');
}

// ─── Patch 3: Hijack the "Accessories tap" router at line 599 ──────────
// Original:
//   if (listReplyId && CATEGORY_HANDLES[listReplyId]) {
//     await sendCategoryResults(ctx, listReplyId, 0);
//     return;
//   }
// New: if it's specifically the Accessories tap AND we haven't picked a subcat yet,
// divert to the subcat picker.
const ROUTER_OLD = `  // Welcome / category list rows
  if (listReplyId && CATEGORY_HANDLES[listReplyId]) {
    await sendCategoryResults(ctx, listReplyId, 0);
    return;
  }`;

const ROUTER_NEW = `  // Welcome / category list rows
  if (listReplyId && CATEGORY_HANDLES[listReplyId]) {
    // PATCH BUG-A: Accessories taps go through a subcategory picker first
    if (listReplyId === WELCOME_ROW.ACCESSORIES) {
      await sendAccessorySubcatPicker(ctx);
      return;
    }
    await sendCategoryResults(ctx, listReplyId, 0);
    return;
  }

  // PATCH BUG-A: subcategory tap (after Accessories) → set subcat + fetch products
  if (listReplyId && ACCESSORY_SUBCATS[listReplyId]) {
    ctx.cart = ctx.cart || {};
    ctx.cart.woofparade = ctx.cart.woofparade || {};
    ctx.cart.woofparade.accessorySubcat = listReplyId;
    ctx.cart.woofparade.awaitingAccessorySubcat = false;
    await sendCategoryResults(ctx, WELCOME_ROW.ACCESSORIES, 0);
    return;
  }

  // PATCH BUG-A + Bug-E partial: free-text subcat match (bandanas / collars / leashes / harnesses / combos)
  // Only fires when we're actively awaiting a subcat OR the user explicitly typed an accessory subcat name.
  {
    const subcatIdFromText = Object.entries(ACCESSORY_SUBCAT_TEXT_MATCHERS)
      .find(([_, re]) => re.test(trimmed));
    if (subcatIdFromText) {
      ctx.cart = ctx.cart || {};
      ctx.cart.woofparade = ctx.cart.woofparade || {};
      ctx.cart.woofparade.accessorySubcat = subcatIdFromText[0];
      ctx.cart.woofparade.awaitingAccessorySubcat = false;
      await sendCategoryResults(ctx, WELCOME_ROW.ACCESSORIES, 0);
      return;
    }
  }`;

if (src.includes('PATCH BUG-A: Accessories taps go through a subcategory picker')) {
  console.log('• Patch 3 (router) already applied');
} else if (!src.includes(ROUTER_OLD)) {
  console.error('FATAL Patch 3: router anchor not found exactly. Showing what we tried:');
  console.error(ROUTER_OLD);
  process.exit(1);
} else {
  src = src.replace(ROUTER_OLD, ROUTER_NEW);
  console.log('✓ Patch 3: hijacked Accessories tap + added subcat router + free-text matcher');
}

// ─── Patch 4: Filter products in sendCategoryResults by subcat ─────────
// Insert filter logic right after `products = filterInStock(productsRaw);`
const FILTER_ANCHOR = 'let products = filterInStock(productsRaw);';
const FILTER_NEW = `let products = filterInStock(productsRaw);

  // PATCH BUG-A: when viewing Accessories and a subcat is set, filter products
  if (rowId === WELCOME_ROW.ACCESSORIES && ctx.cart?.woofparade?.accessorySubcat) {
    const sub = ACCESSORY_SUBCATS[ctx.cart.woofparade.accessorySubcat];
    if (sub) {
      products = products.filter(p =>
        sub.match.test(p.handle || '') || sub.match.test(p.title || '')
      );
    }
  }`;

if (src.includes('PATCH BUG-A: when viewing Accessories and a subcat is set')) {
  console.log('• Patch 4 (filter) already applied');
} else {
  const occ = (src.match(/let products = filterInStock\(productsRaw\);/g) || []).length;
  if (occ !== 1) {
    console.error('FATAL Patch 4: expected 1 occurrence of anchor, found', occ);
    process.exit(1);
  }
  src = src.replace(FILTER_ANCHOR, FILTER_NEW);
  console.log('✓ Patch 4: added subcat filter inside sendCategoryResults');
}

// ─── Patch 5: Clear subcat when going back to menu / sendWelcome ──────
// (Optional but clean — prevents stale subcat sticking around)
// Find sendWelcome function definition and inject a clear at the top.
const CLEAR_ANCHOR = 'async function sendWelcome(ctx) {';
const CLEAR_NEW = `async function sendWelcome(ctx) {
  // PATCH BUG-A: clear any sticky accessory subcat when returning to welcome
  if (ctx.cart?.woofparade) {
    ctx.cart.woofparade.accessorySubcat = null;
    ctx.cart.woofparade.awaitingAccessorySubcat = false;
  }`;

if (src.includes('PATCH BUG-A: clear any sticky accessory subcat')) {
  console.log('• Patch 5 (sendWelcome clear) already applied');
} else if (!src.includes(CLEAR_ANCHOR)) {
  console.log('⚠ Patch 5: sendWelcome anchor not found — non-fatal, subcat may persist across sessions');
} else {
  src = src.replace(CLEAR_ANCHOR, CLEAR_NEW);
  console.log('✓ Patch 5: added subcat clear in sendWelcome');
}

fs.writeFileSync(HANDLER_PATH, src);
console.log('');
console.log('handlers/woofparade.js: ' + origLen + ' → ' + src.length + ' chars (delta ' + (src.length - origLen) + ')');
console.log('');
console.log('Next steps:');
console.log('  1. node -c handlers/woofparade.js   # syntax check');
console.log('  2. grep -n "PATCH BUG-A" handlers/woofparade.js   # verify markers');
console.log('  3. git add handlers/woofparade.js apply-bug-a.js');
console.log('  4. git commit -m "Bug A: Accessory subcategory step + free-text matchers"');
console.log('  5. git push');
console.log('');
console.log('Rollback if anything goes wrong:');
console.log('  cp handlers/woofparade.js.backup-bug-a handlers/woofparade.js');
