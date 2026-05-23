// handlers/woofparade-variants.js
// PATCH 52b — Two-step Color → Size variant picker.
//
// Triggers ONLY for products with:
//   - 2+ Shopify options (not single-option)
//   - One option is size-like (name contains "size") with values from XS/S/M/L/XL/2XL
//   - Another option is non-size (color, design, style, etc.)
//   - ≥4 in-stock variants (smaller catalogs use P51 single-list which is fine)
//
// State machine (stored on cart.woofparade):
//   awaitingColorPick:        { handle, colors: ['Flash', 'Superman'] }
//   awaitingSizeAfterColor:   { handle, color: 'Flash', sizes: ['S','M','L'] }
//
// Falls back to existing P51 picker if needsTwoStepPicker returns false.
//
// Critical invariant: this module never re-fetches the Shopify product —
// the caller always passes in `fetched` (already loaded). This avoids
// double-fetches and lets the caller decide cache policy.

const SIZE_VALUES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
const SIZE_OPT_NAME_HINTS = /\b(size)\b/i;  // matches "Size", "Shirt size", "Accessory size", etc.
const PAW = '🐾';

/**
 * Returns true if a Shopify product should use the two-step picker.
 * Expects `fetched.options` (array of {name, position, values}) and
 * `fetched.variants` (array of {option1, option2, option3, inventory_quantity, available}).
 */
function needsTwoStepPicker(fetched) {
  if (!fetched || !Array.isArray(fetched.options) || !Array.isArray(fetched.variants)) return false;
  if (fetched.options.length < 2) return false;

  // Find which option is size-like and which is color-like
  const sizeOption = fetched.options.find(o => SIZE_OPT_NAME_HINTS.test(o.name || ''));
  const colorOption = fetched.options.find(o => o !== sizeOption);
  if (!sizeOption || !colorOption) return false;

  // Need ≥2 colors and ≥2 sizes (otherwise P51 is fine)
  if ((colorOption.values || []).length < 2) return false;
  if ((sizeOption.values || []).length < 2) return false;

  // ≥4 in-stock variants — below this P51 single-list is cleaner
  const inStock = fetched.variants.filter(v => isInStock(v));
  return inStock.length >= 4;
}

function isInStock(variant) {
  // Shopify's variant.available is true when inventory_quantity > 0 AND tracking allows sale.
  // When inventory_management is null (untracked), available defaults to true.
  // We treat null/undefined inventory_quantity as in-stock IF available is not explicitly false.
  if (variant.available === false) return false;
  if (typeof variant.inventory_quantity === 'number') {
    return variant.inventory_quantity > 0;
  }
  return true;
}

/**
 * Returns which option position holds size ('1' | '2' | '3') and which holds color.
 * Used to map a variant's option1/option2/option3 to size/color correctly.
 */
function getOptionPositions(fetched) {
  const sizeOpt = fetched.options.find(o => SIZE_OPT_NAME_HINTS.test(o.name || ''));
  const colorOpt = fetched.options.find(o => o !== sizeOpt);
  return {
    sizePos: sizeOpt?.position || null,
    colorPos: colorOpt?.position || null,
    sizeName: sizeOpt?.name || 'Size',
    colorName: colorOpt?.name || 'Style',
  };
}

function getVariantOptValue(variant, position) {
  if (position === 1) return variant.option1;
  if (position === 2) return variant.option2;
  if (position === 3) return variant.option3;
  return null;
}

/**
 * Returns list of in-stock colors for a product (preserving Shopify's option order).
 */
function extractColors(fetched) {
  const { colorPos } = getOptionPositions(fetched);
  if (!colorPos) return [];

  const seen = new Set();
  const out = [];
  for (const v of fetched.variants) {
    if (!isInStock(v)) continue;
    const c = getVariantOptValue(v, colorPos);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Returns list of in-stock sizes for a given color, in canonical XS→2XL order.
 */
function getSizesForColor(fetched, color) {
  const { sizePos, colorPos } = getOptionPositions(fetched);
  if (!sizePos || !colorPos) return [];

  const sizesInStock = new Set();
  for (const v of fetched.variants) {
    if (!isInStock(v)) continue;
    if (getVariantOptValue(v, colorPos) !== color) continue;
    const s = getVariantOptValue(v, sizePos);
    if (s) sizesInStock.add(s);
  }
  // Return in canonical size order, then any non-standard sizes alphabetically after
  const standard = SIZE_VALUES.filter(s => sizesInStock.has(s));
  const nonStandard = [...sizesInStock].filter(s => !SIZE_VALUES.includes(s)).sort();
  return [...standard, ...nonStandard];
}

/**
 * Find a specific variant by (color, size). Returns variant or null.
 */
function findVariant(fetched, color, size) {
  const { sizePos, colorPos } = getOptionPositions(fetched);
  return fetched.variants.find(v =>
    isInStock(v) &&
    getVariantOptValue(v, colorPos) === color &&
    getVariantOptValue(v, sizePos) === size
  ) || null;
}

// ─── SEND HELPERS ──────────────────────────────────────────────────────────

/**
 * Step 1: send color picker.
 * Called from "Add to cart" branch when needsTwoStepPicker(fetched) is true.
 * Caller is responsible for upsertConversation with the new cart state AFTER calling this.
 */
async function sendColorPicker(ctx, fetched, deps) {
  const { sendButtons, sendList } = deps;
  const colors = extractColors(fetched);
  const { colorName } = getOptionPositions(fetched);

  // Truncate label per WhatsApp 24-char cap
  const labels = colors.map(c => String(c).slice(0, 24));
  const prompt = `Pick a ${colorName.toLowerCase()} for your pup ${PAW}`;

  if (labels.length <= 3) {
    await sendButtons(ctx.from, prompt, labels, ctx.waToken, ctx.phoneNumberId);
  } else {
    const sections = [{ title: colorName.slice(0, 24), rows: labels.map(l => ({ id: 'color_' + l, title: l })) }];
    await sendList(ctx.from, prompt, sections, ctx.waToken, ctx.phoneNumberId, 'Choose');
  }
  return colors;
}

/**
 * Step 2: send size picker for the chosen color.
 * Called from handleColorPick. Caller persists cart state after.
 */
async function sendSizePickerForColor(ctx, fetched, color, deps) {
  const { sendButtons, sendList, sendMessage } = deps;
  const sizes = getSizesForColor(fetched, color);
  const { sizeName } = getOptionPositions(fetched);

  if (sizes.length === 0) {
    // Edge case: color clicked is out of stock in all sizes (shouldn't happen since
    // extractColors filtered in-stock — but variants change between picks)
    await sendMessage(ctx.from,
      `Aw — looks like ${color} just sold out in every size ${PAW}\n\nWant to pick another?`,
      ctx.waToken, ctx.phoneNumberId);
    return [];
  }

  const labels = sizes.map(s => String(s).slice(0, 24));
  const prompt = `Got it — *${color}* ${PAW}\nWhich ${sizeName.toLowerCase()}?`;

  if (labels.length <= 3) {
    await sendButtons(ctx.from, prompt, labels, ctx.waToken, ctx.phoneNumberId);
  } else {
    const sections = [{ title: sizeName.slice(0, 24), rows: labels.map(l => ({ id: 'sizeac_' + l, title: l })) }];
    await sendList(ctx.from, prompt, sections, ctx.waToken, ctx.phoneNumberId, 'Choose');
  }
  return sizes;
}

module.exports = {
  needsTwoStepPicker,
  extractColors,
  getSizesForColor,
  findVariant,
  getOptionPositions,
  isInStock,
  sendColorPicker,
  sendSizePickerForColor,
};
