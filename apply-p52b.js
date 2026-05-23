#!/usr/bin/env node
// apply-p52b.js — applies P52b surgery to handlers/woofparade.js
// Run from ~/vaani-app:  node apply-p52b.js
// Idempotent: re-running after success is a no-op.

const fs = require('fs');
const path = require('path');

const HANDLER_PATH = path.resolve('handlers/woofparade.js');
const BACKUP_PATH  = path.resolve('handlers/woofparade.js.backup-p52b');

if (!fs.existsSync(HANDLER_PATH)) {
  console.error('FATAL: handlers/woofparade.js not found. Run from ~/vaani-app');
  process.exit(1);
}

let src = fs.readFileSync(HANDLER_PATH, 'utf8');
const origLen = src.length;

// Backup if not already
if (!fs.existsSync(BACKUP_PATH)) {
  fs.writeFileSync(BACKUP_PATH, src);
  console.log('✓ Backup created:', BACKUP_PATH);
} else {
  console.log('• Backup exists, skipping:', BACKUP_PATH);
}

// ─── Patch 1: Add the require line after woofparade-qa ────────────────────
const REQUIRE_OLD  = "const qa = require('./woofparade-qa');";
const REQUIRE_NEW  = "const qa = require('./woofparade-qa');\nconst variantsModule = require('./woofparade-variants');";

if (src.includes("require('./woofparade-variants')")) {
  console.log('• Patch 1 (require) already applied');
} else if (!src.includes(REQUIRE_OLD)) {
  console.error('FATAL Patch 1: anchor not found:', REQUIRE_OLD);
  process.exit(1);
} else {
  src = src.replace(REQUIRE_OLD, REQUIRE_NEW);
  console.log('✓ Patch 1: added variantsModule require');
}

// ─── Patch 2: Insert router blocks BEFORE the PATCH 50 picker ────────────
const ROUTER_ANCHOR = '// PATCH 50 (fixed): tap on a variant title while picker is active.';
const ROUTER_BLOCK = [
  '  // PATCH 52b: two-step color → size picker — step 1 (color tap)',
  '  if (ctx.cart?.woofparade?.awaitingColorPick) {',
  '    const pickState = ctx.cart.woofparade.awaitingColorPick;',
  '    const trimmedLocal = String(ctx.text || \'\').trim();',
  '    const pickedColor = (pickState.colors || []).find(c =>',
  '      c === trimmedLocal || (\'color_\' + c) === listReplyId',
  '    );',
  '    if (pickedColor) {',
  '      try {',
  '        const fetched = await getProductByHandle(ctx.tenant, pickState.handle);',
  '        const sizes = await variantsModule.sendSizePickerForColor(',
  '          ctx, fetched, pickedColor,',
  '          { sendMessage, sendButtons, sendList }',
  '        );',
  '        await upsertConversation(ctx.tenant.id, ctx.from, [',
  '          ...(ctx.history || []),',
  '          { role: \'user\', content: ctx.text || \'\' },',
  '          { role: \'assistant\', content: \'[woofparade p52b color_picked=\' + pickedColor + \' sizes=\' + sizes.length + \']\' },',
  '        ], {',
  '          ...(ctx.cart || {}),',
  '          woofparade: {',
  '            ...(ctx.cart.woofparade || {}),',
  '            awaitingColorPick: null,',
  '            awaitingSizeAfterColor: { handle: pickState.handle, color: pickedColor, sizes },',
  '          },',
  '        });',
  '      } catch (e) {',
  '        console.error(\'[woofparade P52b] color pick failed:\', e.message);',
  '        await sendMessage(ctx.from,',
  '          `Hmm — something went sideways picking that ${PAW} Try again or tap Back to menu.`,',
  '          ctx.waToken, ctx.phoneNumberId);',
  '      }',
  '      return;',
  '    }',
  '  }',
  '',
  '  // PATCH 52b: two-step picker — step 2 (size tap after color)',
  '  if (ctx.cart?.woofparade?.awaitingSizeAfterColor) {',
  '    const pickState = ctx.cart.woofparade.awaitingSizeAfterColor;',
  '    const trimmedLocal = String(ctx.text || \'\').trim();',
  '    const pickedSize = (pickState.sizes || []).find(sz =>',
  '      sz === trimmedLocal || (\'sizeac_\' + sz) === listReplyId',
  '    );',
  '    if (pickedSize) {',
  '      try {',
  '        const fetched = await getProductByHandle(ctx.tenant, pickState.handle);',
  '        const variant = variantsModule.findVariant(fetched, pickState.color, pickedSize);',
  '        if (!variant) {',
  '          await sendMessage(ctx.from,',
  '            `Aw — ${pickState.color} in ${pickedSize} just sold out ${PAW} Tap another size or pick a different color.`,',
  '            ctx.waToken, ctx.phoneNumberId);',
  '          return;',
  '        }',
  '        ctx.cart.woofparade.preselectedVariantId = String(variant.id);',
  '        ctx.cart.woofparade.preselectedVariantTitle = pickState.color + \' / \' + pickedSize;',
  '        ctx.cart.woofparade.awaitingSizeAfterColor = null;',
  '        await upsertConversation(ctx.tenant.id, ctx.from, ctx.history || [], { ...(ctx.cart || {}) });',
  '        await handleSizePick(ctx, pickedSize);',
  '      } catch (e) {',
  '        console.error(\'[woofparade P52b] size-after-color pick failed:\', e.message);',
  '        await sendMessage(ctx.from,',
  '          `Hmm — couldnt add that ${PAW} Try again or tap Back to menu.`,',
  '          ctx.waToken, ctx.phoneNumberId);',
  '      }',
  '      return;',
  '    }',
  '  }',
  '',
  '  ',
].join('\n');

if (src.includes('PATCH 52b: two-step color')) {
  console.log('• Patch 2 (router) already applied');
} else if (!src.includes(ROUTER_ANCHOR)) {
  console.error('FATAL Patch 2: anchor not found:', ROUTER_ANCHOR);
  process.exit(1);
} else {
  src = src.replace(ROUTER_ANCHOR, ROUTER_BLOCK + ROUTER_ANCHOR);
  console.log('✓ Patch 2: inserted P52b router (color + size-after-color)');
}

// ─── Patch 3: Insert divert-to-two-step check in Add-to-cart branch ──────
const DIVERT_ANCHOR = 'const fetched = await getProductByHandle(ctx.tenant, product.handle);';
const DIVERT_BLOCK = [
  DIVERT_ANCHOR,
  '',
  '        // PATCH 52b: divert to two-step picker if eligible',
  '        if (variantsModule.needsTwoStepPicker(fetched)) {',
  '          const colors = await variantsModule.sendColorPicker(',
  '            ctx, fetched,',
  '            { sendButtons, sendList }',
  '          );',
  '          await upsertConversation(ctx.tenant.id, ctx.from, [',
  '            ...(ctx.history || []),',
  '            { role: \'user\', content: ctx.text || \'\' },',
  '            { role: \'assistant\', content: \'[woofparade p52b color_picker presented=\' + colors.length + \']\' },',
  '          ], {',
  '            ...(ctx.cart || {}),',
  '            woofparade: {',
  '              ...(ctx.cart.woofparade || {}),',
  '              awaitingColorPick: { handle: product.handle, colors },',
  '              awaitingVariantPick: false,',
  '              variantChoices: null,',
  '            },',
  '          });',
  '          return;',
  '        }',
].join('\n');

if (src.includes('PATCH 52b: divert to two-step picker')) {
  console.log('• Patch 3 (divert) already applied');
} else {
  // Only ONE occurrence expected
  const occurrences = (src.match(/const fetched = await getProductByHandle\(ctx\.tenant, product\.handle\);/g) || []).length;
  if (occurrences !== 1) {
    console.error('FATAL Patch 3: expected exactly 1 occurrence of the anchor, found', occurrences);
    process.exit(1);
  }
  src = src.replace(DIVERT_ANCHOR, DIVERT_BLOCK);
  console.log('✓ Patch 3: inserted divert check in Add-to-cart branch');
}

// Write back
fs.writeFileSync(HANDLER_PATH, src);
console.log('');
console.log('handlers/woofparade.js: ' + origLen + ' → ' + src.length + ' chars (delta ' + (src.length - origLen) + ')');
console.log('');
console.log('Next steps:');
console.log('  1. node -c handlers/woofparade.js   # syntax check');
console.log('  2. grep -n "PATCH 52b" handlers/woofparade.js   # verify markers');
console.log('  3. git diff --stat handlers/woofparade.js');
console.log('  4. git add handlers/ && git commit -m "P52b: two-step Color → Size picker" && git push');
console.log('');
console.log('Rollback if anything goes wrong:');
console.log('  cp handlers/woofparade.js.backup-p52b handlers/woofparade.js');
