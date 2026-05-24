#!/usr/bin/env node
// apply-bug-f-g.js — Two related fixes:
// Bug F: When viewing a specific accessory subcat (e.g. Collars), exclude combos
//        unless customer explicitly picked Combos.
// Bug G: "Continue shopping" returns to the last accessory subcat (not generic welcome).
//
// Run from ~/vaani-app:  node apply-bug-f-g.js
// Idempotent.

const fs = require('fs');
const path = require('path');

const HANDLER_PATH = path.resolve('handlers/woofparade.js');
const BACKUP_PATH  = path.resolve('handlers/woofparade.js.backup-bug-f-g');

if (!fs.existsSync(HANDLER_PATH)) {
  console.error('FATAL: handlers/woofparade.js not found');
  process.exit(1);
}

let src = fs.readFileSync(HANDLER_PATH, 'utf8');
const origLen = src.length;

if (!fs.existsSync(BACKUP_PATH)) {
  fs.writeFileSync(BACKUP_PATH, src);
  console.log('✓ Backup created:', BACKUP_PATH);
}

if (src.includes('PATCH BUG-F-G')) {
  console.log('• Already applied — exiting');
  process.exit(0);
}

// ─── Patch 1 (Bug F): Strict subcat filtering — exclude combos from non-combo subcats ──
// Inside sendCategoryResults, after the existing subcat filter block, add an
// extra step that removes combo products when the active subcat is NOT subcat_combos.
const F_ANCHOR = `  // PATCH BUG-A: when viewing Accessories and a subcat is set, filter products
  if (rowId === WELCOME_ROW.ACCESSORIES && ctx.cart?.woofparade?.accessorySubcat) {
    const sub = ACCESSORY_SUBCATS[ctx.cart.woofparade.accessorySubcat];
    if (sub) {
      products = products.filter(p =>
        sub.match.test(p.handle || '') || sub.match.test(p.title || '')
      );
    }
  }`;

const F_NEW = F_ANCHOR + `

  // PATCH BUG-F-G (F): exclude combos from non-Combo subcats — when customer is
  // browsing Collars/Bandanas/Leashes/Harnesses, don't mix combo SKUs into the list.
  if (
    rowId === WELCOME_ROW.ACCESSORIES &&
    ctx.cart?.woofparade?.accessorySubcat &&
    ctx.cart.woofparade.accessorySubcat !== 'subcat_combos'
  ) {
    const comboRe = ACCESSORY_SUBCATS.subcat_combos.match;
    products = products.filter(p =>
      !comboRe.test(p.handle || '') && !comboRe.test(p.title || '')
    );
  }`;

if (!src.includes(F_ANCHOR)) {
  console.error('FATAL Patch F: Bug A filter anchor not found — was Bug A applied?');
  process.exit(1);
}
src = src.replace(F_ANCHOR, F_NEW);
console.log('✓ Patch F: combos excluded from non-Combo subcats');

// ─── Patch 2 (Bug G): handleContinueSection preserves accessorySubcat ────
// Replace the entire function body with a smarter version.
const G_ANCHOR = `async function handleContinueSection(ctx) {
  const r = ctx.cart.woofparade || {};
  if (r.browseMode === 'category' && r.categoryRowId) {
    await sendCategoryResults(ctx, r.categoryRowId, r.page || 0);
    return;
  }
  await sendWelcome(ctx);
}`;

const G_NEW = `async function handleContinueSection(ctx) {
  // PATCH BUG-F-G (G): "Continue shopping" returns to the last subcat / category
  // so customer doesn't lose their browsing context after adding to shortlist.
  const r = ctx.cart.woofparade || {};

  // Preference order:
  // 1. If they were in an Accessories subcat (Collars, Bandanas, etc.) — go back there
  // 2. If they had a category context — return to that category
  // 3. Otherwise — fall back to welcome
  const lastCat = r.categoryRowId;
  const lastSubcat = r.accessorySubcat;

  if (lastCat === WELCOME_ROW.ACCESSORIES && lastSubcat && ACCESSORY_SUBCATS[lastSubcat]) {
    // accessorySubcat is still set on cart — sendCategoryResults will filter automatically
    await sendCategoryResults(ctx, lastCat, 0);
    return;
  }

  if (lastCat && CATEGORY_HANDLES[lastCat]) {
    await sendCategoryResults(ctx, lastCat, r.page || 0);
    return;
  }

  if (r.browseMode === 'category' && r.categoryRowId) {
    await sendCategoryResults(ctx, r.categoryRowId, r.page || 0);
    return;
  }
  await sendWelcome(ctx);
}`;

if (!src.includes(G_ANCHOR)) {
  console.error('FATAL Patch G: handleContinueSection anchor not found');
  process.exit(1);
}
src = src.replace(G_ANCHOR, G_NEW);
console.log('✓ Patch G: handleContinueSection now preserves accessorySubcat');

// ─── Patch 3: Also persist categoryRowId / accessorySubcat after handleSizePick / addToShortlist ──
// This is critical — Bug G depends on the cart state having categoryRowId set.
// The "Anything to pair with this" branch sets size_added but doesn't always
// preserve categoryRowId. Look at the upsertConversation call that sends
// PICKED_BTN.ACCESSORIES + PICKED_BTN.CONTINUE + PICKED_BTN.CHECKOUT (line ~2125).
// We need to ensure that upsert preserves categoryRowId & accessorySubcat.

// Find and update the upsertConversation right after `Added to your shortlist`
const PRESERVE_ANCHOR = `  ], { ...cart, woofparade: { ...r, items } });
}

async function handleCrossSell(ctx) {`;

const PRESERVE_NEW = `  ], { ...cart, woofparade: {
    ...r,
    items,
    // PATCH BUG-F-G (G): persist categoryRowId + accessorySubcat so "Continue shopping"
    // can route the customer back where they were.
    categoryRowId: r.categoryRowId || null,
    accessorySubcat: r.accessorySubcat || null,
  } });
}

async function handleCrossSell(ctx) {`;

if (src.includes('PATCH BUG-F-G (G): persist categoryRowId')) {
  console.log('• Patch 3 (preservation) already applied');
} else if (!src.includes(PRESERVE_ANCHOR)) {
  console.log('⚠ Patch 3: preservation anchor not found — non-fatal');
  console.log('⚠ categoryRowId/accessorySubcat may not survive checkout-handoff');
} else {
  src = src.replace(PRESERVE_ANCHOR, PRESERVE_NEW);
  console.log('✓ Patch 3: cart state preserves categoryRowId + accessorySubcat after add-to-cart');
}

fs.writeFileSync(HANDLER_PATH, src);
console.log('');
console.log('handlers/woofparade.js: ' + origLen + ' → ' + src.length + ' chars (delta ' + (src.length - origLen) + ')');
console.log('');
console.log('Next:');
console.log('  node -c handlers/woofparade.js && echo "SYNTAX OK"');
console.log('  grep -c "PATCH BUG-F-G" handlers/woofparade.js');
console.log('  git add handlers/woofparade.js apply-bug-f-g.js && git commit -m "Bug F+G: subcat strict filter + continue shopping returns to subcat" && git push');
console.log('');
console.log('Rollback:');
console.log('  cp handlers/woofparade.js.backup-bug-f-g handlers/woofparade.js');
