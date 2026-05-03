// handlers/rajathee.js
// Rajathee × Vaani flow — implements Rajathee_Vaani_Flow_v1.pdf verbatim,
// with brand tagline supplied by founder ("Effortless and Elegant...").
// v1 scope = PDF Sections 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13.
// Sections 7 (cross-sell) and 10 (returning customer) are v1.1, not built here.
//
// This handler shares NOTHING with Jhilmil's flow. It only uses low-level
// transport helpers (sendMessage/sendButtons/sendList/sendImage), Shopify
// reads (mode-aware via tenant.shopify_mode), and conversation persistence.
//
// Sections 14 (fabric voice) and 15 (colour voice) are LOCKED string constants
// — never sent through the LLM, never templated, never rewritten on the fly.
//
// Phase progress:
//   C.1 — Section 1 Welcome flow                     ✅
//   C.2 — Section 2 Browse by fabric                 ← THIS COMMIT
//   C.3 — Section 3 Browse by colour                 (next)
//   C.4 — Section 4 Product detail + variants
//   C.5 — Section 6 Add-ons (Fall & Pico, RTW)
//   C.6 — Section 8 Checkout
//   C.7 — Section 9 Post-purchase
//   C.8 — Section 5 Styling help
//   C.9 — Section 11 Smart-route Q&A
//   C.10 — Section 12 Stylist handoff
//   C.11 — Section 13 Edge cases

const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
const { getConversation, upsertConversation } = require('../db');
const { getCollectionProducts, formatPrice } = require('../shopify');

// ─── CONSTANTS ────────────────────────────────────────────────────────────

// PDF Section 1 — Welcome body.
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

// PDF Section 14 — LOCKED fabric voice library. Verbatim. Never rewrite.
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

// Tappable button text (used as IDs back from WhatsApp).
const FABRIC_BTN = {
  SHOW_MORE:     'Show 3 more',
  SWITCH_FABRIC: 'Switch fabric',
  HELP_CHOOSE:   'Help me choose',
};

const PAGE_SIZE = 3;
const MAX_SHOWN = 9;

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

  // Extract interactive IDs (preferred over text title for stable dispatch).
  const listReplyId  = message.interactive?.list_reply?.id || null;
  const buttonReplyId = message.interactive?.button_reply?.id || null;

  const trimmed = (text || '').trim();
  const isGreeting = GREETING_RE.test(trimmed);

  // ── Dispatch in priority order ──

  // 1. Welcome list-row taps.
  if (listReplyId === WELCOME_ROW.BROWSE_FABRIC) {
    await sendFabricPicker(ctx);
    return;
  }

  // 2. Fabric list-row taps.
  if (listReplyId && FABRIC_HANDLES[listReplyId]) {
    await sendFabricResults(ctx, listReplyId, 0);
    return;
  }

  // 3. Pagination + fabric controls (button replies — text matches button title).
  if (trimmed === FABRIC_BTN.SHOW_MORE) {
    await handleShowMore(ctx);
    return;
  }
  if (trimmed === FABRIC_BTN.SWITCH_FABRIC) {
    await sendFabricPicker(ctx);
    return;
  }
  // FABRIC_BTN.HELP_CHOOSE handled in C.8 (styling). For now, fall through
  // to Welcome so the customer doesn't get stuck.

  // 4. Greetings or ambiguous → Welcome.
  if (isGreeting || isAmbiguous(message, trimmed)) {
    await sendWelcome(ctx);
    return;
  }

  // 5. Anything else — log and stay quiet (handlers land in C.3+).
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

  await upsertConversation(
    tenant.id,
    from,
    [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee welcome shown]' },
    ],
    cart
  );
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

  await upsertConversation(
    tenant.id,
    from,
    [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee fabric picker shown]' },
    ],
    {
      ...cart,
      rajathee: {
        ...(cart.rajathee || {}),
        browseMode: 'fabric',
        fabric: null,
        page: 0,
        totalShown: 0,
        productHandles: [],
      },
    }
  );
}

async function sendFabricResults(ctx, fabricRowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const handle = FABRIC_HANDLES[fabricRowId];
  const label  = FABRIC_LABEL[fabricRowId];
  const voice  = FABRIC_VOICE[fabricRowId];

  // Fetch up to MAX_SHOWN products from this fabric collection.
  const products = await getCollectionProducts(tenant, handle);

  if (!products.length) {
    await sendMessage(
      from,
      `Our ${label} edit is being refreshed. May I show you another fabric in the meantime?`,
      waToken, phoneNumberId
    );
    await sendFabricPicker(ctx);
    return;
  }

  const start = page * PAGE_SIZE;
  const slice = products.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    // Past last page — gracefully bounce back to fabric picker.
    await sendMessage(
      from,
      `That's the full ${label} edit for now. Want to explore another fabric?`,
      waToken, phoneNumberId
    );
    await sendFabricPicker(ctx);
    return;
  }

  // 1) Send 3 product cards (image + caption).
  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const caption = `${p.title}\n${price}`;
    if (img) {
      await sendImage(from, img, caption, waToken, phoneNumberId);
    } else {
      await sendMessage(from, caption, waToken, phoneNumberId);
    }
  }

  // 2) Send the locked fabric voice line, prefixed per PDF.
  const introPrefix = `From the ${label === 'The Silk Edit' ? 'Silk Edit' : label + ' Edit'}. `;
  await sendMessage(from, introPrefix + voice, waToken, phoneNumberId);

  // 3) Action row. WhatsApp buttons cap at 3.
  const totalShownAfter = Math.min((page + 1) * PAGE_SIZE, products.length);
  const moreAvailable = totalShownAfter < Math.min(products.length, MAX_SHOWN);

  const buttons = moreAvailable
    ? [FABRIC_BTN.SHOW_MORE, FABRIC_BTN.SWITCH_FABRIC, FABRIC_BTN.HELP_CHOOSE]
    : [FABRIC_BTN.SWITCH_FABRIC, FABRIC_BTN.HELP_CHOOSE];

  await sendButtons(from, 'Anything catch your eye?', buttons, waToken, phoneNumberId);

  // 4) Persist state for pagination + future product-detail dispatch.
  await upsertConversation(
    tenant.id,
    from,
    [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[rajathee fabric=${fabricRowId} page=${page} shown=${slice.length}]` },
    ],
    {
      ...cart,
      rajathee: {
        ...(cart.rajathee || {}),
        browseMode: 'fabric',
        fabric: fabricRowId,
        page: page,
        totalShown: totalShownAfter,
        productHandles: products.slice(0, totalShownAfter).map(p => p.handle),
      },
    }
  );
}

async function handleShowMore(ctx) {
  const { cart } = ctx;
  const r = cart.rajathee || {};
  if (r.browseMode !== 'fabric' || !r.fabric) {
    // No active fabric browse — fall back to picker.
    await sendFabricPicker(ctx);
    return;
  }
  if (r.totalShown >= MAX_SHOWN) {
    await sendFabricPicker(ctx);
    return;
  }
  await sendFabricResults(ctx, r.fabric, (r.page || 0) + 1);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function isAmbiguous(message, trimmed) {
  if (!trimmed) return true;
  return false;
}

module.exports = {
  handle,
  // Exported for tests.
  WELCOME_BODY,
  WELCOME_ROW,
  GREETING_RE,
  FABRIC_ROW,
  FABRIC_HANDLES,
  FABRIC_LABEL,
  FABRIC_VOICE,
  FABRIC_BTN,
};
