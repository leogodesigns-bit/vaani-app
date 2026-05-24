#!/usr/bin/env node
// apply-bug-e-fix1.js — Make Bug E + Bug A matchers tolerant of trailing punctuation.
// "Bandanas?" should match the same way "bandanas" does.
// Run from ~/vaani-app:  node apply-bug-e-fix1.js
// Idempotent.

const fs = require('fs');
const path = require('path');

const HANDLER_PATH = path.resolve('handlers/woofparade.js');
const BACKUP_PATH  = path.resolve('handlers/woofparade.js.backup-bug-e-fix1');

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

if (src.includes('_bugEMatchText')) {
  console.log('• Already applied — exiting');
  process.exit(0);
}

// ─── Patch 1: Add a helper that normalizes text before regex testing ─────
const HELPER_ANCHOR = `function _bugEIntentGuard(ctx, isInteractive) {`;
const HELPER_NEW = `// PATCH BUG-E-FIX1: normalize text before matching — strips trailing punctuation
// and common pleasantries so "Bandanas?" / "bandanas please" / "show me bandanas"
// all reach the same matcher.
function _bugEMatchText(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // Strip leading politeness phrases
  s = s.replace(/^(please|pls|plz|hey|hi|hello|yo|can i see|can you show|show me|i want|i need|give me|i'd like|i would like|looking for)\\s+/i, '');
  // Strip trailing politeness / pleas
  s = s.replace(/\\s+(please|pls|plz|thanks|thank you|tnx)\\s*[?.!,]*\\s*$/i, '');
  // Strip remaining trailing punctuation (?, ., !, ,)
  s = s.replace(/[?.!,]+\\s*$/g, '');
  return s.trim();
}

${HELPER_ANCHOR}`;

if (!src.includes(HELPER_ANCHOR)) {
  console.error('FATAL: Bug E guard function not found — was Bug E deployed?');
  process.exit(1);
}
src = src.replace(HELPER_ANCHOR, HELPER_NEW);
console.log('✓ Patch 1: added _bugEMatchText normalizer');

// ─── Patch 2: Update the Bug E router to use _bugEMatchText instead of trimmed ─
// We need to replace the inner regex tests inside the BUG-E router.
// Find the block that has `m.re.test(trimmed)` and `re.test(trimmed)` AND `CUSTOM_FIT_TEXT_MATCHER.test(trimmed)`
// All inside the `if (_bugEIntentGuard(...))` block.

const ROUTER_OLD_BLOCK = `  if (_bugEIntentGuard(ctx, isInteractive)) {
    // Product keyword takes priority over category (more specific match)
    const productMatch = PRODUCT_KEYWORD_MATCHERS.find(m => m.re.test(trimmed));`;

const ROUTER_NEW_BLOCK = `  if (_bugEIntentGuard(ctx, isInteractive)) {
    // PATCH BUG-E-FIX1: normalize before matching (strips ?, .!,, common politeness)
    const _normText = _bugEMatchText(trimmed);
    // Product keyword takes priority over category (more specific match)
    const productMatch = PRODUCT_KEYWORD_MATCHERS.find(m => m.re.test(_normText));`;

if (!src.includes(ROUTER_OLD_BLOCK)) {
  console.error('FATAL Patch 2: router block anchor not found');
  process.exit(1);
}
src = src.replace(ROUTER_OLD_BLOCK, ROUTER_NEW_BLOCK);
console.log('✓ Patch 2: product matcher now uses normalized text');

// ─── Patch 3: Update the category matcher to use _normText too ─────────
const CAT_OLD = `    // Top-level category by text
    const catEntry = Object.entries(CATEGORY_TEXT_MATCHERS).find(([_, re]) => re.test(trimmed));`;
const CAT_NEW = `    // Top-level category by text (uses normalized form)
    const catEntry = Object.entries(CATEGORY_TEXT_MATCHERS).find(([_, re]) => re.test(_normText));`;

if (!src.includes(CAT_OLD)) {
  console.error('FATAL Patch 3: category matcher anchor not found');
  process.exit(1);
}
src = src.replace(CAT_OLD, CAT_NEW);
console.log('✓ Patch 3: category matcher now uses normalized text');

// ─── Patch 4: Update CUSTOM_FIT_TEXT_MATCHER to use _normText ─────────
const CUSTOM_OLD = `    // Custom Fit text — route to custom flow
    if (CUSTOM_FIT_TEXT_MATCHER.test(trimmed)) {`;
const CUSTOM_NEW = `    // Custom Fit text — route to custom flow (uses normalized form)
    if (CUSTOM_FIT_TEXT_MATCHER.test(_normText)) {`;

if (src.includes(CUSTOM_OLD)) {
  src = src.replace(CUSTOM_OLD, CUSTOM_NEW);
  console.log('✓ Patch 4: custom-fit matcher now uses normalized text');
} else {
  console.log('• Patch 4 (custom matcher): anchor not found — skipping (non-fatal)');
}

// ─── Patch 5: Update the Bug A accessory subcat free-text matcher to use _normText ─
const SUBCAT_OLD = `    const subcatIdFromText = Object.entries(ACCESSORY_SUBCAT_TEXT_MATCHERS)
      .find(([_, re]) => re.test(trimmed));`;
const SUBCAT_NEW = `    // PATCH BUG-E-FIX1: normalize for accessory subcat matching too
    const _subcatNormText = _bugEMatchText(trimmed);
    const subcatIdFromText = Object.entries(ACCESSORY_SUBCAT_TEXT_MATCHERS)
      .find(([_, re]) => re.test(_subcatNormText));`;

if (src.includes(SUBCAT_OLD)) {
  src = src.replace(SUBCAT_OLD, SUBCAT_NEW);
  console.log('✓ Patch 5: Bug A accessory subcat matcher now uses normalized text');
} else {
  console.log('• Patch 5 (subcat matcher): anchor not found — skipping (non-fatal)');
}

fs.writeFileSync(HANDLER_PATH, src);
console.log('');
console.log('handlers/woofparade.js: ' + origLen + ' → ' + src.length + ' chars (delta ' + (src.length - origLen) + ')');
console.log('');
console.log('Next:');
console.log('  node -c handlers/woofparade.js && echo "SYNTAX OK"');
console.log('  grep -c "PATCH BUG-E-FIX1" handlers/woofparade.js');
console.log('  git add handlers/woofparade.js apply-bug-e-fix1.js && git commit -m "Bug E fix 1: punctuation tolerance" && git push');
console.log('');
console.log('Rollback:');
console.log('  cp handlers/woofparade.js.backup-bug-e-fix1 handlers/woofparade.js');
