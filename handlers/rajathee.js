// handlers/rajathee.js
// Rajathee × Vaani flow — implements Rajathee_Vaani_Flow_v1.pdf verbatim.
// v1 scope = PDF Sections 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13.
// Sections 7 (cross-sell) and 10 (returning customer) are v1.1, not built here.
//
// Sections 14 (fabric voice) and 15 (colour voice) are LOCKED string constants
// — never sent through the LLM, never templated, never rewritten on the fly.
//
// Phase progress:
//   C.1 — Section 1 Welcome flow                     ✅
//   C.2 — Section 2 Browse by fabric                 ✅
//   C.3 — Section 3 Browse by colour                 ✅
//   C.3.5 — Saree-picker list retrofit               ← THIS COMMIT
//   C.4 — Section 4 Product detail + variants        ← THIS COMMIT
//   C.5 — Section 6 Add-ons (Fall & Pico, RTW)       (next)
//   C.6 — Section 8 Checkout (WhatsApp-managed v1)
//   C.7 — Section 9 Post-purchase
//   C.8 — Section 5 Styling help
//   C.9 — Section 11 Smart-route Q&A
//   C.10 — Section 12 Stylist handoff
//   C.11 — Section 13 Edge cases

const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
const { getConversation, upsertConversation } = require('../db');
const { getCollectionProducts, getProductByHandle, formatPrice, stripHtml } = require('../shopify');

// ─── CONSTANTS ────────────────────────────────────────────────────────────

const WELCOME_BODY =
  'Welcome to Rajathee.\n' +
  'Effortless and Elegant Sarees for Women on the Move.\n' +
  'How would you like to browse today?';

const GREETING_RE = /^(hi+|hello+|hey+|helo+|namaste|namaskar|start|help)[!.?\s]*$/i;

const WELCOME_ROW = {
  BROWSE_FABRIC: 'welcome_browse_fabric',
  BROWSE_COLOUR: 'welcome_browse_colour',
  BESTSELLERS:   'welcome_bestsellers',
  AKSHAY:        'welcome_akshay_tritiya',
  STYLING:       'welcome_styling_help',
};

// ─── PDF Section 2 — Browse by fabric ─────────────────────────────────────

const FABRIC_ROW = {
  MUL_COTTON:     'fabric_mul_cotton',
  CREPE:          'fabric_crepe',
  SILK_EDIT:      'fabric_silk_edit',
  SILK_BLEND:     'fabric_silk_blend',
  MODAL_SATIN:    'fabric_modal_satin',
  CLASSIC_COTTON: 'fabric_classic_cotton',
};

const FABRIC_HANDLES = {
  [FABRIC_ROW.MUL_COTTON]:     'mul-cotton-edit',
  [FABRIC_ROW.CREPE]:          'crepe-edit',
  [FABRIC_ROW.SILK_EDIT]:      'the-silk-edit',
  [FABRIC_ROW.SILK_BLEND]:     'silk-blend-edit',
  [FABRIC_ROW.MODAL_SATIN]:    'modal-satin-edit',
  [FABRIC_ROW.CLASSIC_COTTON]: 'classic-cotton-edit',
};

const FABRIC_LABEL = {
  [FABRIC_ROW.MUL_COTTON]:     'Mul Cotton',
  [FABRIC_ROW.CREPE]:          'Crepe',
  [FABRIC_ROW.SILK_EDIT]:      'The Silk Edit',
  [FABRIC_ROW.SILK_BLEND]:     'Silk Blend',
  [FABRIC_ROW.MODAL_SATIN]:    'Modal Satin',
  [FABRIC_ROW.CLASSIC_COTTON]: 'Classic Cotton',
};

const FABRIC_VOICE = {
  [FABRIC_ROW.MUL_COTTON]:
    'Featherlight and breathable — the kind of saree that disappears into your day in the best way.',
  [FABRIC_ROW.CREPE]:
    'Light, fluid, the kind of drape you can wear all day without thinking about it.',
  [FABRIC_ROW.SILK_EDIT]:
    'For days when you want a little more shimmer without weighing yourself down.',
  [FABRIC_ROW.SILK_BLEND]:
    'The structure of silk, the ease of cotton — the best of both.',
  [FABRIC_ROW.CLASSIC_COTTON]:
    'Honest, breathable, beautifully built for everyday wear.',
  [FABRIC_ROW.MODAL_SATIN]:
    'A glossy fall and a modern hand — for when you want sleek and modern.',
};

const FABRIC_BTN = {
  SHOW_MORE:     'Show 3 more',
  SWITCH_FABRIC: 'Switch fabric',
  HELP_CHOOSE:   'Help me choose',
};

// ─── PDF Section 3 — Browse by colour ─────────────────────────────────────

const COLOUR_ROW = {
  IVORY_WHITE:    'colour_ivory_white',
  PINK_ROSE:      'colour_pink_rose',
  BLUE_TEAL:      'colour_blue_teal',
  RED_MAROON:     'colour_red_maroon',
  PURPLE_PLUM:    'colour_purple_plum',
  BLACK_GREY:     'colour_black_grey',
  YELLOW_MUSTARD: 'colour_yellow_mustard',
  GREEN_OLIVE:    'colour_green_olive',
  BROWN_BEIGE:    'colour_brown_beige',
  PASTELS:        'colour_pastels',
};

const COLOUR_LABEL = {
  [COLOUR_ROW.IVORY_WHITE]:    'Ivory & White',
  [COLOUR_ROW.PINK_ROSE]:      'Pink & Rose',
  [COLOUR_ROW.BLUE_TEAL]:      'Blue & Teal',
  [COLOUR_ROW.RED_MAROON]:     'Red & Maroon',
  [COLOUR_ROW.PURPLE_PLUM]:    'Purple & Plum',
  [COLOUR_ROW.BLACK_GREY]:     'Black & Grey',
  [COLOUR_ROW.YELLOW_MUSTARD]: 'Yellow & Mustard',
  [COLOUR_ROW.GREEN_OLIVE]:    'Green & Olive',
  [COLOUR_ROW.BROWN_BEIGE]:    'Brown & Beige',
  [COLOUR_ROW.PASTELS]:        'Pastels',
};

// Founder review needed (PDF Section 17 Q2).
const COLOUR_KEYWORDS = {
  [COLOUR_ROW.IVORY_WHITE]:    ['ivory', 'white', 'cream', 'off white', 'pearl'],
  [COLOUR_ROW.PINK_ROSE]:      ['pink', 'rose', 'fuchsia'],
  [COLOUR_ROW.BLUE_TEAL]:      ['blue', 'teal', 'navy', 'cobalt', 'azure'],
  [COLOUR_ROW.RED_MAROON]:     ['red', 'maroon', 'crimson', 'scarlet', 'wine'],
  [COLOUR_ROW.PURPLE_PLUM]:    ['purple', 'plum', 'mauve', 'lavender', 'lavendar', 'magenta', 'violet'],
  [COLOUR_ROW.BLACK_GREY]:     ['black', 'grey', 'gray', 'charcoal'],
  [COLOUR_ROW.YELLOW_MUSTARD]: ['yellow', 'mustard', 'gold', 'ochre'],
  [COLOUR_ROW.GREEN_OLIVE]:    ['green', 'olive', 'sage', 'emerald', 'mint'],
  [COLOUR_ROW.BROWN_BEIGE]:    ['brown', 'beige', 'tan', 'taupe', 'camel'],
  [COLOUR_ROW.PASTELS]:        ['pastel', 'powder', 'baby pink', 'baby blue', 'mint'],
};

const COLOUR_VOICE = {
  [COLOUR_ROW.IVORY_WHITE]:
    'Quiet luminous neutrals — for days when you want the saree to whisper, not shout.',
  [COLOUR_ROW.PINK_ROSE]:
    'Pink and rose — soft, romantic, endlessly wearable.',
  [COLOUR_ROW.BLUE_TEAL]:
    'From cobalt to seafoam — blue is the colour of calm composure.',
  [COLOUR_ROW.RED_MAROON]:
    'The colour of celebration and ceremony — warm, rich, unmistakably striking.',
  [COLOUR_ROW.PURPLE_PLUM]:
    "Plum, magenta, mauve — the modern Indian woman's wardrobe quiet rebellion.",
  [COLOUR_ROW.BLACK_GREY]:
    'Sleek and grounded — for when you want sharp lines and modern presence.',
  [COLOUR_ROW.YELLOW_MUSTARD]:
    'Sunlit and golden — yellow lifts every other colour around it.',
  [COLOUR_ROW.GREEN_OLIVE]:
    'From sage to emerald — green pairs effortlessly with both gold and silver.',
  [COLOUR_ROW.BROWN_BEIGE]:
    'Earthy, warm, grounding — the colours of late afternoon light.',
  [COLOUR_ROW.PASTELS]:
    'Soft, breathable hues — for the days when subtle is the whole point.',
};

const COLOUR_BTN = {
  SHOW_MORE:     'Show 3 more',
  SWITCH_COLOUR: 'Switch colour',
  HELP_CHOOSE:   'Help me choose',
};

const NOT_A_COLOUR = ['ready to wear', 'fall and pico', 'fall & pico'];

// ─── PDF Section 4 — Product detail ───────────────────────────────────────

const PRODUCT_BTN = {
  ADD_TO_CART:      'Add to cart',
  SEE_MORE_PICS:    'See more pics',
  TRY_ANOTHER:      'Try another colour',
  STYLING_HELP:     'Styling help',
  BACK_TO_BROWSE:   'Back to browse',
  MORE_OPTIONS:     'More options',
  SEE_EVEN_MORE:    'See even more',
};

const PRODUCT_LIST_ROW = {
  STYLING_HELP:    'product_more_styling',
  BACK_TO_BROWSE:  'product_more_back',
};

const PAGE_SIZE = 3;
const MAX_SHOWN = 9;
const PIC_BATCH_SIZE = 3;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────

async function handle(ctx) {
  const { tenant, message, from, text } = ctx;

  if (tenant.flow_template !== 'rajathee') {
    console.error(
      `❌ rajathee.handle called for wrong tenant: ${tenant.shop_domain} ` +
      `(flow_template=${tenant.flow_template})`
    );
    return;
  }

  console.log(`[rajathee] ${tenant.shop_domain} — from ${from}: ${text}`);

  const listReplyId   = message.interactive?.list_reply?.id || null;
  const buttonReplyId = message.interactive?.button_reply?.id || null;

  const trimmed = (text || '').trim();
  const isGreeting = GREETING_RE.test(trimmed);

  // ── Welcome list-row taps ──
  if (listReplyId === WELCOME_ROW.BROWSE_FABRIC) { await sendFabricPicker(ctx); return; }
  if (listReplyId === WELCOME_ROW.BROWSE_COLOUR) { await sendColourPicker(ctx); return; }

  // ── Fabric list-row taps ──
  if (listReplyId && FABRIC_HANDLES[listReplyId]) {
    await sendFabricResults(ctx, listReplyId, 0);
    return;
  }

  // ── Colour list-row taps ──
  if (listReplyId && COLOUR_KEYWORDS[listReplyId]) {
    await sendColourResults(ctx, listReplyId, 0);
    return;
  }

  // ── Product detail entry: tap on saree row ──
  if (listReplyId && listReplyId.startsWith('product_') && !listReplyId.startsWith('product_more_') && !listReplyId.startsWith('product_variant_')) {
    const handle = listReplyId.replace(/^product_/, '');
    await sendProductDetail(ctx, handle);
    return;
  }

  // ── Variant tap inside product detail ──
  if (listReplyId && listReplyId.startsWith('product_variant_')) {
    const variantId = listReplyId.replace(/^product_variant_/, '');
    await sendVariantDetail(ctx, variantId);
    return;
  }

  // ── Product more-options list rows ──
  if (listReplyId === PRODUCT_LIST_ROW.STYLING_HELP) {
    // Deferred to C.8.
    await sendMessage(ctx.from,
      'Styling help is coming soon. May I bring our stylist in for a personal answer?',
      ctx.waToken, ctx.phoneNumberId
    );
    return;
  }
  if (listReplyId === PRODUCT_LIST_ROW.BACK_TO_BROWSE) {
    await sendBackToBrowse(ctx);
    return;
  }

  // ── Pagination + control buttons ──
  if (trimmed === FABRIC_BTN.SHOW_MORE) { await handleShowMore(ctx); return; }
  if (trimmed === FABRIC_BTN.SWITCH_FABRIC) { await sendFabricPicker(ctx); return; }
  if (trimmed === COLOUR_BTN.SWITCH_COLOUR) { await sendColourPicker(ctx); return; }

  // ── Product action buttons ──
  if (trimmed === PRODUCT_BTN.ADD_TO_CART)    { await handleAddToCart(ctx); return; }
  if (trimmed === PRODUCT_BTN.SEE_MORE_PICS)  { await sendMorePics(ctx); return; }
  if (trimmed === PRODUCT_BTN.SEE_EVEN_MORE)  { await sendMorePics(ctx); return; }
  if (trimmed === PRODUCT_BTN.TRY_ANOTHER)    { await retryColourPicker(ctx); return; }
  if (trimmed === PRODUCT_BTN.MORE_OPTIONS)   { await sendProductMoreOptions(ctx); return; }
  if (trimmed === PRODUCT_BTN.BACK_TO_BROWSE) { await sendBackToBrowse(ctx); return; }

  // ── Greetings / ambiguous ──
  if (isGreeting || isAmbiguous(message, trimmed)) {
    await sendWelcome(ctx);
    return;
  }

  console.log(`[rajathee] no handler yet for: ${trimmed} (listId=${listReplyId}, btnId=${buttonReplyId})`);
}

// ─── PDF SECTION 1 — WELCOME ──────────────────────────────────────────────

async function sendWelcome(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const sections = [{
    title: 'How would you like to browse',
    rows: [
      { id: WELCOME_ROW.BROWSE_FABRIC, title: 'Browse by fabric',     description: 'By feel and weave' },
      { id: WELCOME_ROW.BROWSE_COLOUR, title: 'Browse by colour',     description: 'By palette' },
      { id: WELCOME_ROW.BESTSELLERS,   title: 'Bestsellers',          description: 'Most loved drapes' },
      { id: WELCOME_ROW.AKSHAY,        title: 'Akshay Tritiya',       description: 'Festive edit' },
      { id: WELCOME_ROW.STYLING,       title: "I'd like styling help", description: 'Talk to us' },
    ],
  }];

  await sendList(from, WELCOME_BODY, sections, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee welcome shown]' },
  ], cart);
}

// ─── PDF SECTION 2 — BROWSE BY FABRIC ─────────────────────────────────────

async function sendFabricPicker(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const sections = [{
    title: 'Choose a fabric',
    rows: [
      { id: FABRIC_ROW.MUL_COTTON,     title: 'Mul Cotton',     description: 'Featherlight, breathable' },
      { id: FABRIC_ROW.CREPE,          title: 'Crepe',          description: 'Light, fluid drape' },
      { id: FABRIC_ROW.SILK_EDIT,      title: 'The Silk Edit',  description: 'A little more shimmer' },
      { id: FABRIC_ROW.SILK_BLEND,     title: 'Silk Blend',     description: 'Structure + ease' },
      { id: FABRIC_ROW.MODAL_SATIN,    title: 'Modal Satin',    description: 'Glossy, modern' },
      { id: FABRIC_ROW.CLASSIC_COTTON, title: 'Classic Cotton', description: 'Honest, everyday' },
    ],
  }];

  await sendList(from, 'What fabric speaks to you today?', sections, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee fabric picker shown]' },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'fabric',
      fabric: null,
      page: 0,
      totalShown: 0,
      productHandles: [],
    },
  });
}

async function sendFabricResults(ctx, fabricRowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const handle = FABRIC_HANDLES[fabricRowId];
  const label  = FABRIC_LABEL[fabricRowId];
  const voice  = FABRIC_VOICE[fabricRowId];

  const products = await getCollectionProducts(tenant, handle);

  if (!products.length) {
    await sendMessage(from, `Our ${label} edit is being refreshed. May I show you another fabric in the meantime?`, waToken, phoneNumberId);
    await sendFabricPicker(ctx);
    return;
  }

  const start = page * PAGE_SIZE;
  const slice = products.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    await sendMessage(from, `That's the full ${label} edit for now. Want to explore another fabric?`, waToken, phoneNumberId);
    await sendFabricPicker(ctx);
    return;
  }

  // Send 3 product cards.
  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const caption = `${p.title}\n${price}`;
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  // Voice line.
  const introPrefix = `From the ${label === 'The Silk Edit' ? 'Silk Edit' : label + ' Edit'}. `;
  await sendMessage(from, introPrefix + voice, waToken, phoneNumberId);

  // C.3.5: saree-picker list above the action buttons.
  await sendSareePickerList(ctx, slice);

  const totalShownAfter = Math.min((page + 1) * PAGE_SIZE, products.length);
  const moreAvailable = totalShownAfter < Math.min(products.length, MAX_SHOWN);

  const buttons = moreAvailable
    ? [FABRIC_BTN.SHOW_MORE, FABRIC_BTN.SWITCH_FABRIC, FABRIC_BTN.HELP_CHOOSE]
    : [FABRIC_BTN.SWITCH_FABRIC, FABRIC_BTN.HELP_CHOOSE];

  await sendButtons(from, 'Or:', buttons, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee fabric=${fabricRowId} page=${page} shown=${slice.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'fabric',
      fabric: fabricRowId,
      page: page,
      totalShown: totalShownAfter,
      productHandles: products.slice(0, totalShownAfter).map(p => p.handle),
    },
  });
}

// ─── PDF SECTION 3 — BROWSE BY COLOUR ─────────────────────────────────────

async function sendColourPicker(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const sections = [{
    title: 'Choose a palette',
    rows: [
      { id: COLOUR_ROW.IVORY_WHITE,    title: 'Ivory & White',    description: 'Quiet luminous neutrals' },
      { id: COLOUR_ROW.PINK_ROSE,      title: 'Pink & Rose',      description: 'Soft and romantic' },
      { id: COLOUR_ROW.BLUE_TEAL,      title: 'Blue & Teal',      description: 'Calm composure' },
      { id: COLOUR_ROW.RED_MAROON,     title: 'Red & Maroon',     description: 'Celebration tones' },
      { id: COLOUR_ROW.PURPLE_PLUM,    title: 'Purple & Plum',    description: 'A quiet rebellion' },
      { id: COLOUR_ROW.BLACK_GREY,     title: 'Black & Grey',     description: 'Sleek and grounded' },
      { id: COLOUR_ROW.YELLOW_MUSTARD, title: 'Yellow & Mustard', description: 'Sunlit and golden' },
      { id: COLOUR_ROW.GREEN_OLIVE,    title: 'Green & Olive',    description: 'Sage to emerald' },
      { id: COLOUR_ROW.BROWN_BEIGE,    title: 'Brown & Beige',    description: 'Earthy and warm' },
      { id: COLOUR_ROW.PASTELS,        title: 'Pastels',          description: 'Soft, breathable hues' },
    ],
  }];

  await sendList(from, 'Which palette draws you in?', sections, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee colour picker shown]' },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'colour',
      colour: null,
      page: 0,
      totalShown: 0,
      productHandles: [],
    },
  });
}

function variantMatchesColour(variantTitle, colourId) {
  if (!variantTitle) return false;
  const v = variantTitle.toLowerCase().trim();
  if (NOT_A_COLOUR.some(n => v.includes(n))) return false;
  const keywords = COLOUR_KEYWORDS[colourId] || [];
  return keywords.some(k => v.includes(k));
}

function filterProductsByColour(products, colourId) {
  return products.filter(p => {
    const variants = p.variants || [];
    return variants.some(v => variantMatchesColour(v.option1 || v.title, colourId));
  });
}

async function sendColourResults(ctx, colourRowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const label = COLOUR_LABEL[colourRowId];
  const voice = COLOUR_VOICE[colourRowId];

  const allProducts = await getCollectionProducts(tenant, 'all-sarees');
  const matched = filterProductsByColour(allProducts, colourRowId);

  if (!matched.length) {
    if (colourRowId === COLOUR_ROW.PASTELS) {
      await sendMessage(from,
        'Pastels are coming soon to Rajathee. May I show you another palette in the meantime?',
        waToken, phoneNumberId);
    } else {
      await sendMessage(from,
        `Our ${label} edit is being refreshed. May I show you another palette in the meantime?`,
        waToken, phoneNumberId);
    }
    await sendColourPicker(ctx);
    return;
  }

  const start = page * PAGE_SIZE;
  const slice = matched.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    await sendMessage(from, `That's the full ${label} edit for now. Want to explore another palette?`, waToken, phoneNumberId);
    await sendColourPicker(ctx);
    return;
  }

  for (const p of slice) {
    const matchingVariant = (p.variants || []).find(
      v => variantMatchesColour(v.option1 || v.title, colourRowId)
    ) || p.variants?.[0];

    const img = matchingVariant?.featured_image?.src || p.images?.[0]?.src;
    const price = formatPrice(matchingVariant?.price || p.variants?.[0]?.price);
    const caption = `${p.title}\n${price}`;

    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from, voice, waToken, phoneNumberId);

  // C.3.5 retrofit: saree-picker list.
  await sendSareePickerList(ctx, slice);

  const totalShownAfter = Math.min((page + 1) * PAGE_SIZE, matched.length);
  const moreAvailable = totalShownAfter < Math.min(matched.length, MAX_SHOWN);

  const buttons = moreAvailable
    ? [COLOUR_BTN.SHOW_MORE, COLOUR_BTN.SWITCH_COLOUR, COLOUR_BTN.HELP_CHOOSE]
    : [COLOUR_BTN.SWITCH_COLOUR, COLOUR_BTN.HELP_CHOOSE];

  await sendButtons(from, 'Or:', buttons, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee colour=${colourRowId} page=${page} shown=${slice.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'colour',
      colour: colourRowId,
      page: page,
      totalShown: totalShownAfter,
      productHandles: matched.slice(0, totalShownAfter).map(p => p.handle),
    },
  });
}

// ─── C.3.5 SAREE PICKER LIST ──────────────────────────────────────────────

async function sendSareePickerList(ctx, products) {
  const { from, phoneNumberId, waToken } = ctx;

  const rows = products.slice(0, 10).map(p => {
    const v0 = p.variants?.[0];
    const price = formatPrice(v0?.price);
    return {
      id: `product_${p.handle}`,
      title: p.title.length > 24 ? p.title.slice(0, 21) + '...' : p.title,
      description: price,
    };
  });

  const sections = [{ title: 'Tap to see details', rows }];
  await sendList(from, 'Which one would you like to explore?', sections, waToken, phoneNumberId);
}

// ─── PDF SECTION 4 — PRODUCT DETAIL ───────────────────────────────────────

async function sendProductDetail(ctx, productHandle) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const product = await getProductByHandle(tenant, productHandle);
  if (!product) {
    await sendMessage(from,
      "I couldn't find that one. Let me show you what we have.",
      waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // Send 2 default images.
  const images = product.images || [];
  const imgsToSend = images.slice(0, 2);
  for (const img of imgsToSend) {
    await sendImage(from, img.src, '', waToken, phoneNumberId);
  }

  // Send name + price + fabric + short description.
  const v0 = product.variants?.[0];
  const price = formatPrice(v0?.price);
  const desc = stripHtml(product.body_html).slice(0, 220).trim();
  const ellipsis = stripHtml(product.body_html).length > 220 ? '...' : '';
  const detailText =
    `*${product.title}* — ${price}\n\n` +
    desc + ellipsis;

  await sendMessage(from, detailText, waToken, phoneNumberId);

  // Single-variant product: skip colour picker.
  const realVariants = (product.variants || []).filter(
    v => v.option1 && v.option1.toLowerCase() !== 'default title'
  );

  if (realVariants.length === 0) {
    // No real variants — just ask Add to cart.
    await sendButtons(from,
      'Would you like to add this to your cart?',
      [PRODUCT_BTN.ADD_TO_CART, PRODUCT_BTN.SEE_MORE_PICS, PRODUCT_BTN.MORE_OPTIONS],
      waToken, phoneNumberId);

    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[rajathee product_detail handle=${productHandle} variants=0]` },
    ], {
      ...cart,
      rajathee: {
        ...(cart.rajathee || {}),
        browseMode: 'product_detail',
        priorBrowseMode: (cart.rajathee?.browseMode === 'fabric' || cart.rajathee?.browseMode === 'colour') ? cart.rajathee.browseMode : (cart.rajathee?.priorBrowseMode || null),
        priorFabric: cart.rajathee?.fabric || cart.rajathee?.priorFabric || null,
        priorColour: cart.rajathee?.colour || cart.rajathee?.priorColour || null,
        product: {
          handle: productHandle,
          id: product.id,
          currentVariantId: v0?.id || null,
          picsShownCount: 2,
        },
      },
    });
    return;
  }

  // Multi-variant branch below.
  const colourRows = realVariants.slice(0, 10).map(v => ({
    id: `product_variant_${v.id}`,
    title: v.option1.length > 24 ? v.option1.slice(0, 21) + '...' : v.option1,
    description: v.available ? formatPrice(v.price) : 'Sold out',
  }));

  await sendList(from,
    `Available in ${realVariants.length} ${realVariants.length === 1 ? 'colour' : 'colours'}:`,
    [{ title: 'Choose a colour', rows: colourRows }],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee product_detail handle=${productHandle} variants=${realVariants.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'product_detail',
      priorBrowseMode: (cart.rajathee?.browseMode === 'fabric' || cart.rajathee?.browseMode === 'colour') ? cart.rajathee.browseMode : (cart.rajathee?.priorBrowseMode || null),
      priorFabric: cart.rajathee?.fabric || cart.rajathee?.priorFabric || null,
      priorColour: cart.rajathee?.colour || cart.rajathee?.priorColour || null,
      product: {
        handle: productHandle,
        id: product.id,
        currentVariantId: null,
        picsShownCount: 2,
      },
    },
  });
}

async function sendVariantDetail(ctx, variantId) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const r = cart.rajathee || {};
  const productHandle = r.product?.handle;
  if (!productHandle) {
    await sendMessage(from, "Let me bring you back to browse.", waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // Fetch via collection endpoint — products.json reliably returns 'available'.
  // /products/{handle}.json omits availability, which broke sold-out detection.
  const allProducts = await getCollectionProducts(tenant, 'all-sarees');
  const product = allProducts.find(p => p.handle === productHandle);
  if (!product) {
    await sendWelcome(ctx);
    return;
  }

  const variant = (product.variants || []).find(v => String(v.id) === String(variantId));
  if (!variant) {
    await sendMessage(from, "That colour isn't available — let me show you what is.", waToken, phoneNumberId);
    await sendProductDetail(ctx, productHandle);
    return;
  }

  // Sold out check (PDF Section 4).
  if (variant.available === false) {
    await sendMessage(from,
      `${variant.option1} is currently sold out. Would you like to be notified when it's back, or try another colour?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'What would you like to do?',
      [PRODUCT_BTN.TRY_ANOTHER, PRODUCT_BTN.BACK_TO_BROWSE, PRODUCT_BTN.MORE_OPTIONS],
      waToken, phoneNumberId);
    return;
  }

  // Send 2 images of THIS variant.
  const variantImg = variant.featured_image?.src;
  const imagesToSend = [variantImg].filter(Boolean);
  // Backfill from product gallery if only one image is variant-specific.
  if (imagesToSend.length < 2 && product.images?.length) {
    for (const img of product.images) {
      if (imagesToSend.length >= 2) break;
      if (!imagesToSend.includes(img.src)) imagesToSend.push(img.src);
    }
  }
  for (const img of imagesToSend) {
    await sendImage(from, img, '', waToken, phoneNumberId);
  }

  // Send "Variant — price" + Add to cart prompt.
  const price = formatPrice(variant.price);
  await sendMessage(from,
    `${product.title} in ${variant.option1} — ${price}\nWould you like to add this to your cart?`,
    waToken, phoneNumberId);

  // 3 primary buttons.
  await sendButtons(from, 'Choose:',
    [PRODUCT_BTN.ADD_TO_CART, PRODUCT_BTN.SEE_MORE_PICS, PRODUCT_BTN.TRY_ANOTHER],
    waToken, phoneNumberId);

  // Secondary list (More options).
  await sendList(from, 'More options:', [{
    title: 'Other actions',
    rows: [
      { id: PRODUCT_LIST_ROW.STYLING_HELP,   title: 'Styling help',   description: 'Talk to our stylist' },
      { id: PRODUCT_LIST_ROW.BACK_TO_BROWSE, title: 'Back to browse', description: 'Return to picker' },
    ],
  }], waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee variant_selected variantId=${variantId}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'product_detail',
      product: {
        ...(cart.rajathee?.product || {}),
        handle: productHandle,
        currentVariantId: variant.id,
        picsShownCount: imagesToSend.length,
      },
    },
  });
}

async function sendMorePics(ctx) {
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const r = cart.rajathee || {};
  const productHandle = r.product?.handle;
  if (!productHandle) {
    await sendWelcome(ctx);
    return;
  }

  const product = await getProductByHandle(tenant, productHandle);
  if (!product) { await sendWelcome(ctx); return; }

  const allImages = product.images || [];
  const alreadyShown = r.product?.picsShownCount || 0;
  const nextBatch = allImages.slice(alreadyShown, alreadyShown + PIC_BATCH_SIZE);

  if (!nextBatch.length) {
    await sendMessage(from, "That's all the photos we have for this one. Anything else?", waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [PRODUCT_BTN.ADD_TO_CART, PRODUCT_BTN.TRY_ANOTHER, PRODUCT_BTN.BACK_TO_BROWSE],
      waToken, phoneNumberId);
    return;
  }

  for (const img of nextBatch) {
    await sendImage(from, img.src, '', waToken, phoneNumberId);
  }

  const newCount = alreadyShown + nextBatch.length;
  const moreLeft = newCount < allImages.length;

  if (moreLeft) {
    await sendButtons(from, 'Want to see more?',
      [PRODUCT_BTN.SEE_EVEN_MORE, PRODUCT_BTN.ADD_TO_CART, PRODUCT_BTN.BACK_TO_BROWSE],
      waToken, phoneNumberId);
  } else {
    await sendButtons(from, "That's the last of them.",
      [PRODUCT_BTN.ADD_TO_CART, PRODUCT_BTN.TRY_ANOTHER, PRODUCT_BTN.BACK_TO_BROWSE],
      waToken, phoneNumberId);
  }

  await upsertConversation(tenant.id, from, ctx.history, {
    ...cart,
    rajathee: {
      ...r,
      product: {
        ...(r.product || {}),
        picsShownCount: newCount,
      },
    },
  });
}

async function retryColourPicker(ctx) {
  const { cart } = ctx;
  const r = cart.rajathee || {};
  const productHandle = r.product?.handle;
  if (!productHandle) {
    await sendWelcome(ctx);
    return;
  }
  await sendProductDetail(ctx, productHandle);
}

async function sendProductMoreOptions(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendList(from, 'More options:', [{
    title: 'Other actions',
    rows: [
      { id: PRODUCT_LIST_ROW.STYLING_HELP,   title: 'Styling help',   description: 'Talk to our stylist' },
      { id: PRODUCT_LIST_ROW.BACK_TO_BROWSE, title: 'Back to browse', description: 'Return to picker' },
    ],
  }], waToken, phoneNumberId);
}

async function sendBackToBrowse(ctx) {
  const { cart } = ctx;
  const r = cart.rajathee || {};
  const prior = r.priorBrowseMode;

  if (prior === 'colour' && r.priorColour) {
    await sendColourResults({ ...ctx, cart: { ...cart, rajathee: { ...r, browseMode: 'colour', colour: r.priorColour, page: 0 } } }, r.priorColour, 0);
    return;
  }
  if (prior === 'fabric' && r.priorFabric) {
    await sendFabricResults({ ...ctx, cart: { ...cart, rajathee: { ...r, browseMode: 'fabric', fabric: r.priorFabric, page: 0 } } }, r.priorFabric, 0);
    return;
  }
  // No prior context — go to welcome.
  await sendWelcome(ctx);
}

async function handleAddToCart(ctx) {
  // Deferred to C.5 — add-ons + cart.
  const { from, waToken, phoneNumberId } = ctx;
  await sendMessage(from,
    'Add to cart is coming soon. The full checkout flow will be ready before launch.',
    waToken, phoneNumberId);
}

// ─── PAGINATION DISPATCH ──────────────────────────────────────────────────

async function handleShowMore(ctx) {
  const { cart } = ctx;
  const r = cart.rajathee || {};
  if (r.totalShown >= MAX_SHOWN) {
    if (r.browseMode === 'colour') await sendColourPicker(ctx);
    else await sendFabricPicker(ctx);
    return;
  }
  if (r.browseMode === 'colour' && r.colour) {
    await sendColourResults(ctx, r.colour, (r.page || 0) + 1);
    return;
  }
  if (r.browseMode === 'fabric' && r.fabric) {
    await sendFabricResults(ctx, r.fabric, (r.page || 0) + 1);
    return;
  }
  await sendWelcome(ctx);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function isAmbiguous(message, trimmed) {
  if (!trimmed) return true;
  return false;
}

module.exports = {
  handle,
  WELCOME_BODY,
  WELCOME_ROW,
  GREETING_RE,
  FABRIC_ROW, FABRIC_HANDLES, FABRIC_LABEL, FABRIC_VOICE, FABRIC_BTN,
  COLOUR_ROW, COLOUR_LABEL, COLOUR_KEYWORDS, COLOUR_VOICE, COLOUR_BTN,
  PRODUCT_BTN, PRODUCT_LIST_ROW,
  variantMatchesColour, filterProductsByColour,
};
