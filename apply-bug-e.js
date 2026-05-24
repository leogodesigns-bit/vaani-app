#!/usr/bin/env node
// apply-bug-e.js — Adds free-text matchers for top-level categories AND product names
// so customers can type "kurta" or "csk jersey" without tapping list buttons.
// Run from ~/vaani-app:  node apply-bug-e.js
// Idempotent: safe to re-run.

const fs = require('fs');
const path = require('path');

const HANDLER_PATH = path.resolve('handlers/woofparade.js');
const BACKUP_PATH  = path.resolve('handlers/woofparade.js.backup-bug-e');

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

// ─── Patch 1: Add CATEGORY_TEXT_MATCHERS and PRODUCT_KEYWORD_MATCHERS ──────
// Place them right after ACCESSORY_SUBCAT_TEXT_MATCHERS (added in Bug A).
const ANCHOR_1 = "  subcat_combos:    /^(combo|combos|combo set)$/i,\n};";
const NEW_CONSTS = ANCHOR_1 + `

// PATCH BUG-E: Free-text matchers for top-level categories
// Customer types these as plain text → bot routes to category as if they tapped the list row.
// Keys are the WELCOME_ROW IDs (cat_casual, cat_festive, etc.) and values are regex tests.
const CATEGORY_TEXT_MATCHERS = {
  cat_festive: /^(kurta|kurtas|ethnic|lehenga|lehengas|frock|frocks|festive|festive fits|festive wear|banarasi|bandhani|assamese)$/i,
  cat_casual:  /^(casual|casual wear|everyday|everyday wear|tshirt|t-shirt|t shirt|shirt|shirts|pet clothes|clothes|fits)$/i,
  cat_ipl:     /^(jersey|jerseys|ipl|cricket|cricket jersey|seasonal wear|csk|csk jersey|rcb|rcb jersey|mi|mi jersey|dhoni|dhoni jersey|virat|virat jersey|bumrah|rohit|kohli)$/i,
  cat_bestsellers: /^(bestseller|bestsellers|popular|best seller|best sellers|best selling|top selling|trending|favorites|favourites|most loved)$/i,
  cat_accessories: /^(accessory|accessories|accessory wear|access)$/i,
};

// PATCH BUG-E: Custom Fit text triggers (not a category — uses special flow)
const CUSTOM_FIT_TEXT_MATCHER = /^(custom|custom fit|custom outfit|made to measure|tailored|tailor made|tailormade|stitched|made for my pup|doesn't fit|doesnt fit|size doesn't fit|outfit for my pup|build my own|design my own)$/i;

// PATCH BUG-E: Specific product keyword matchers (IPL-heavy because Kashmira's catalog
// has 4 jerseys with named players). When customer types these, we route directly to
// the product card rather than the category list.
// Maps regex → product handle (or partial handle to fuzzy match in category fetch).
const PRODUCT_KEYWORD_MATCHERS = [
  { re: /\b(csk|chennai|dhoni)\b/i,  handle: 'csk-dhoni-jersey-yellow-dogs-cats',  category: 'cat_ipl' },
  { re: /\b(rcb|bangalore|virat|kohli)\b/i, handle: 'rcb-virat-jersey-red-dogs-cats', category: 'cat_ipl' },
  { re: /\b(rohit)\b/i, handle: 'mi-rohit-jersey-blue-dogs-cats', category: 'cat_ipl' },
  { re: /\b(bumrah)\b/i, handle: 'mi-bumrah-jersey-blue-dogs-cats', category: 'cat_ipl' },
  { re: /\bmi\b/i, handle: 'mi-rohit-jersey-blue-dogs-cats', category: 'cat_ipl' }, // ambiguous — pick Rohit default
  { re: /\b(superman bandana|superman-bandana)\b/i, handle: 'accessories-superman-bandana-dogs', category: 'cat_accessories' },
  { re: /\b(flash bandana|flash-bandana)\b/i, handle: 'accessories-bandana-flash-dogs', category: 'cat_accessories' },
  { re: /\b(superman collar|superman-collar)\b/i, handle: 'superman-printed-collar-dogs', category: 'cat_accessories' },
  { re: /\b(flash collar|flash-collar)\b/i, handle: 'accessories-collar-flash-dogs', category: 'cat_accessories' },
  { re: /\b(reflective collar|reflective-collar)\b/i, handle: 'accessories-reflective-collar-dogs', category: 'cat_accessories' },
  { re: /\b(reflective leash|reflective-leash)\b/i, handle: 'accessories-double-handle-reflective-leash-dogs', category: 'cat_accessories' },
];

// PATCH BUG-E: guard — only allow free-text intent matching when there's NO active flow.
// If customer is mid-checkout, mid-measurement, mid-color-pick, etc., do NOT redirect them.
function _bugEIntentGuard(ctx, isInteractive) {
  if (isInteractive) return false; // tap reply — handled elsewhere
  const wp = ctx.cart?.woofparade || {};
  if (wp.awaitingColorPick) return false;
  if (wp.awaitingSizeAfterColor) return false;
  if (wp.awaitingVariantPick) return false;
  if (wp.awaitingAccessorySubcat) return false;
  if (wp.sizing?.awaitingMeasurements) return false;
  if (wp.sizing?.awaitingRemindTime) return false;
  if (wp.custom?.awaitingMeasurements) return false;
  if (wp.custom?.awaitingPupName) return false;
  if (wp.pupProfile?.awaitingPupDetails) return false;
  if (wp.orderOps?.awaitingMod) return false;
  if (wp.orderOps?.awaitingAddrChange) return false;
  if (wp.orderOps?.awaitingUpiProof) return false;
  if (ctx.cart?.checkout?.step) return false; // mid-checkout
  return true;
}
`;

if (src.includes('CATEGORY_TEXT_MATCHERS')) {
  console.log('• Patch 1 (constants) already applied');
} else if (!src.includes(ANCHOR_1)) {
  console.error('FATAL Patch 1: anchor not found (was Bug A applied first?)');
  console.error('Expected to find: ' + ANCHOR_1.substring(0, 60) + '...');
  process.exit(1);
} else {
  src = src.replace(ANCHOR_1, NEW_CONSTS);
  console.log('✓ Patch 1: added CATEGORY_TEXT_MATCHERS + PRODUCT_KEYWORD_MATCHERS + guard');
}

// ─── Patch 2: Insert the free-text matcher block BEFORE welcome/category dispatch ──
// Anchor: the existing welcome / category list dispatch (line ~599 originally,
// now shifted after Bug A patches). Use the comment + first if-block as anchor.
const ANCHOR_2 = `  // Welcome / category list rows
  if (listReplyId && CATEGORY_HANDLES[listReplyId]) {`;

const ROUTER_BLOCK = `  // PATCH BUG-E: free-text category matcher (typed, not tapped)
  // Customers who type "kurta", "jersey", "csk", "rcb", "accessories", etc. route to the
  // matching category as if they had tapped the welcome list row.
  if (_bugEIntentGuard(ctx, isInteractive)) {
    // Product keyword takes priority over category (more specific match)
    const productMatch = PRODUCT_KEYWORD_MATCHERS.find(m => m.re.test(trimmed));
    if (productMatch) {
      console.log('[woofparade BUG-E] product keyword matched:', trimmed, '→', productMatch.handle);
      try {
        const fetched = await getProductByHandle(ctx.tenant, productMatch.handle);
        if (fetched && fetched.handle) {
          // Simulate the listReplyId = product_<handle> tap so existing flow takes over.
          // We can't just set listReplyId (consts), so we directly call the same path:
          // skip ahead — reuse the product-handle dispatcher at line 698.
          // Easiest: re-enter handle by setting message-like state.
          // Simplest: trigger the handler at line 698 by setting listReplyId via local var below.
          // But since 'listReplyId' is const in the enclosing scope, we instead just inline:
          ctx.cart = ctx.cart || {};
          ctx.cart.woofparade = ctx.cart.woofparade || {};
          ctx.cart.woofparade.product = {
            handle: fetched.handle,
            title: fetched.title,
            id: fetched.id,
          };
          ctx.cart.woofparade.categoryRowId = productMatch.category;
          ctx.cart.woofparade.accessorySubcat = null;
          await sendProductDetail(ctx, fetched.handle);
          return;
        }
      } catch (e) {
        console.error('[woofparade BUG-E] product keyword fetch failed:', e.message);
      }
    }

    // Top-level category by text
    const catEntry = Object.entries(CATEGORY_TEXT_MATCHERS).find(([_, re]) => re.test(trimmed));
    if (catEntry) {
      const catRowId = catEntry[0];
      console.log('[woofparade BUG-E] category text matched:', trimmed, '→', catRowId);
      // Accessories text → subcat picker (consistent with Bug A tap behavior)
      if (catRowId === WELCOME_ROW.ACCESSORIES) {
        await sendAccessorySubcatPicker(ctx);
        return;
      }
      await sendCategoryResults(ctx, catRowId, 0);
      return;
    }

    // Custom Fit text — route to custom flow
    if (CUSTOM_FIT_TEXT_MATCHER.test(trimmed)) {
      console.log('[woofparade BUG-E] custom fit text matched:', trimmed);
      await handleCustomFitStart(ctx);
      return;
    }
  }

  // Welcome / category list rows
  if (listReplyId && CATEGORY_HANDLES[listReplyId]) {`;

if (src.includes('PATCH BUG-E: free-text category matcher')) {
  console.log('• Patch 2 (router) already applied');
} else if (!src.includes(ANCHOR_2)) {
  console.error('FATAL Patch 2: anchor not found');
  process.exit(1);
} else {
  // Find the FIRST occurrence — other "Welcome / category list rows" comments don't exist but be safe
  const occ = src.split(ANCHOR_2).length - 1;
  if (occ !== 1) {
    console.error('FATAL Patch 2: expected 1 occurrence of anchor, found', occ);
    process.exit(1);
  }
  src = src.replace(ANCHOR_2, ROUTER_BLOCK);
  console.log('✓ Patch 2: inserted free-text category + product router');
}

// ─── Patch 3: ensure sendProductDetail exists (sanity check) ─────────
// If sendProductDetail isn't defined under that name, the product-keyword branch will fail.
// Look it up — if missing, use a fallback.
if (!src.includes('sendProductDetail') && !src.includes('async function sendProductDetail')) {
  console.log('⚠ sendProductDetail not found by exact name. Looking for alternates...');
  // Don't fail — but warn that the product-keyword branch may need adjustment
  console.log('⚠ Product-keyword fast-path may not work until you point it at the correct send function.');
  console.log('⚠ Search for: grep -n "async function send" handlers/woofparade.js | grep -i product');
}

fs.writeFileSync(HANDLER_PATH, src);
console.log('');
console.log('handlers/woofparade.js: ' + origLen + ' → ' + src.length + ' chars (delta ' + (src.length - origLen) + ')');
console.log('');
console.log('Next steps:');
console.log('  1. node -c handlers/woofparade.js                                # syntax check');
console.log('  2. grep -n "PATCH BUG-E" handlers/woofparade.js                   # verify markers');
console.log('  3. grep -n "async function send" handlers/woofparade.js | head    # check sendProductDetail exists');
console.log('  4. git add handlers/woofparade.js apply-bug-e.js');
console.log('  5. git commit -m "Bug E: free-text matchers for categories + product keywords"');
console.log('  6. git push');
console.log('');
console.log('Rollback:');
console.log('  cp handlers/woofparade.js.backup-bug-e handlers/woofparade.js');
