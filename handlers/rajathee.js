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
const { getConversation, upsertConversation, saveOrder, getOrder, markOrderPaid, saveShopifyDraftRef, scheduleNudge, cancelNudges } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const edge = require('./rajathee-edge');
const qa = require('./rajathee-qa');
const sareeSearch = require('./rajathee-product-search');
const budgetParser = require('./rajathee-budget');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { getCollectionProducts, getProductByHandle, formatPrice, stripHtml, createCheckoutDraftOrder } = require('../shopify');
const { getTenantSettings } = require('../settings-cache');
const { sendTemplateOrFreeform } = require('../templates');

// ─── CONSTANTS ────────────────────────────────────────────────────────────

const WELCOME_BODY =
  'Welcome to Rajathee.\n' +
  'Effortless and Elegant Sarees for Women on the Move.\n' +
  'How would you like to browse today?';

const GREETING_RE = edge.GREETING_RE;

const WELCOME_ROW = {
  BROWSE_FABRIC:      'welcome_browse_fabric',
  BROWSE_COLOUR:      'welcome_browse_colour',
  MORE:               'welcome_more',
  // sub-rows under "More options"
  BROWSE_BESTSELLERS: 'welcome_browse_bestsellers',
  BROWSE_COLLECTION:  'welcome_browse_collection',  // retained so older list-replies still route; see dispatcher
  STYLING:            'welcome_styling_help',
};

// Button labels for the 3-button welcome.
const WELCOME_BTN = {
  FABRIC: 'Browse by fabric',
  COLOUR: 'Browse by colour',
  MORE:   'More options',
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
  SHOW_MORE:     'Show more products',
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
  SHOW_MORE:     'Show more products',
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

// ─── PDF Section 6 — Add-ons (Fall & Pico, Ready to Wear) ─────────────────

// Rajathee variant IDs — locked from PDF Section 6.
// Founder review: when onboarding a second sarees brand, move to tenant config.
const ADDON_VARIANT = {
  FALL_PICO:     '47195287748791',
  READY_TO_WEAR: '47195287781559',
};
const ADDON_PRICE = {
  FALL_PICO:     180,
  READY_TO_WEAR: 1100,
};
const ADDON_ROW = {
  FP:   'addon_fp',
  RTW:  'addon_rtw',
  BOTH: 'addon_both',
  NONE: 'addon_none',
};
const CART_BTN = {
  APPLY_COUPON: 'Apply coupon',
  BROWSE_MORE: 'Browse more sarees',
  VIEW_CART:   'View cart',
  CHECKOUT:    'Checkout',
};

// ─── PDF Section 8 — Checkout (WhatsApp-managed v1, pre-Shopify-approval) ──
// Customer's address is collected one field at a time, validated, then
// confirmed. Order is recorded in the conversation cart and an alert is
// sent to the owner WhatsApp (or logged if OWNER_ALERT_PHONE not set).
// Post-approval migration: switch to authenticated Shopify draft orders.

const CHECKOUT_STEP = {
  NAME:     'name',
  ADDRESS1: 'address1',
  CITY:     'city',
  STATE:    'state',
  PIN:      'pin',
  REVIEW:   'review',
  PAYMENT:  'payment_method',
  CONFIRMED:'confirmed',
};

const CHECKOUT_BTN = {
  CONFIRM:    'Confirm order',
  EDIT_NAME:  'Edit name',
  EDIT_ADDR:  'Edit address',
  EDIT_CITY:  'Edit city',
  EDIT_STATE: 'Edit state',
  EDIT_PIN:   'Edit PIN',
  CANCEL:     'Cancel checkout',
};

// ─── Payment-mode buttons (Card / UPI / COD) ──────────────────────────────
const PAYMENT_BTN = {
  CARD: 'Pay by Card',
  UPI:  'Pay by UPI',
  COD:  'Cash on Delivery',
};

const VAANI_PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'https://vaani-app-production-6407.up.railway.app';

const COD_ADVANCE = 100;
const COD_SWITCH_BTN = {
  FULL_UPI:  'Pay full by UPI',
  FULL_CARD: 'Pay full by Card',
};

// ─── PDF Section 9 — Post-purchase ────────────────────────────────────────
const POSTPURCHASE_BTN = {
  TRACK:       'Track order',
  BROWSE_MORE: 'Browse more',
};

const CHECKOUT_PROMPT = {
  [CHECKOUT_STEP.NAME]:     'Lovely. To wrap this up, please share in ONE message:\n\n*Full Name*\n*Full Address* (house/flat, street, area, city, state)\n*6-digit Pincode*',
  [CHECKOUT_STEP.ADDRESS1]: 'Got it. House/flat number and street?',
  [CHECKOUT_STEP.CITY]:     'And which city?',
  [CHECKOUT_STEP.STATE]:    'State?',
  [CHECKOUT_STEP.PIN]:      'Last one — 6-digit PIN code?',
};

const SHIPPING_FREE_THRESHOLD = 999;
const SHIPPING_FEE = 80;

// Set to a real phone number in Railway env to enable real owner alerts.
// Leave null/empty for v1 — alerts will be logged to console only.
const OWNER_ALERT_PHONE = process.env.OWNER_ALERT_PHONE || null;
const STYLIST_PHONE     = process.env.STYLIST_PHONE     || null;

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

  // ── Owner confirmation command (PDF Section 9) ──
  // Format: "confirmed RAJ-XXXXXX-XXX" sent from OWNER_ALERT_PHONE.
  // Marks the order as paid and sends thank-you to the customer.
  if (OWNER_ALERT_PHONE && from === OWNER_ALERT_PHONE) {
    const m = (text || '').trim().match(/^confirmed\s+(RAJ-\d{6}-[A-Z0-9]{3})\s*$/i);
    if (m) {
      await handleOwnerConfirmCommand(ctx, m[1].toUpperCase());
      return;
    }
  }

  const listReplyId   = message.interactive?.list_reply?.id || null;
  const buttonReplyId = message.interactive?.button_reply?.id || null;

  const trimmed = (text || '').trim();
  const isGreeting = GREETING_RE.test(trimmed);

  // ── PDF Section 12 — non-text messages ──
  if (edge.isNonTextMessage(message)) {
    await edge.sendNonTextAck(ctx);
    await sendWelcome(ctx);
    return;
  }

  // ── Human takeover — bot stays silent when agent has taken over ──
  if (ctx.cart?.rajathee?.human_takeover === true) {
    console.log(`[rajathee] human takeover active for ${ctx.from} - bot silent`);
    return;
  }

  // ── PDF Section 13 — mute state (set after repeated off-topic) ──
  // Mute is cleared by: any interactive tap, OR any saree-related keyword.
  const isMuted = ctx.cart?.rajathee?.muted === true;
  const isInteractive = !!(listReplyId || buttonReplyId);
  if (isMuted) {
    if (isInteractive || qa.isSareeRelated(trimmed)) {
      // Unmute and continue normal flow.
      ctx.cart = ctx.cart || {};
      ctx.cart.rajathee = ctx.cart.rajathee || {};
      delete ctx.cart.rajathee.muted;
      delete ctx.cart.rajathee.offTopicCount;
      console.log(`[rajathee] unmuted ${ctx.from}`);
    } else {
      // Stay silent. Don't even acknowledge.
      console.log(`[rajathee] muted ${ctx.from} - ignoring: ${trimmed}`);
      return;
    }
  }

  // ── PDF Section 12 — stylist keyword passthrough ──
  if (edge.isStylistKeyword(trimmed)) {
    await handleStylistRequest(ctx);
    return;
  }

  // ── Checkout state machine: capture free-text inputs during address collection ──
  //    Must run BEFORE the coupon-capture block: if a stuck awaitingCoupon flag
  //    coincides with active address collection, address inputs (name, address,
  //    city...) would otherwise be silently consumed by the coupon handler.
  const checkoutState = ctx.cart?.rajathee?.checkout;
  const collectingSteps = [CHECKOUT_STEP.NAME, CHECKOUT_STEP.ADDRESS1, CHECKOUT_STEP.CITY, CHECKOUT_STEP.STATE, CHECKOUT_STEP.PIN];
  const inCollection = checkoutState && (collectingSteps.includes(checkoutState.step) || checkoutState.editingField);
  if (inCollection && !listReplyId && !buttonReplyId) {
    await handleCheckoutMessage(ctx);
    return;
  }

  // ── Coupon entry: capture free-text coupon code if customer was prompted ──
  if (ctx.cart?.rajathee?.awaitingCoupon && trimmed && trimmed.length > 0
      && !buttonReplyId && !listReplyId) {
    await handleCouponMessage(ctx, trimmed);
    return;
  }

  // ── Welcome buttons (3) + list-row taps ──
  if (trimmed === WELCOME_BTN.FABRIC || listReplyId === WELCOME_ROW.BROWSE_FABRIC) { await sendFabricPicker(ctx); return; }
  if (trimmed === WELCOME_BTN.COLOUR || listReplyId === WELCOME_ROW.BROWSE_COLOUR) { await sendColourPicker(ctx); return; }
  if (trimmed === WELCOME_BTN.MORE   || listReplyId === WELCOME_ROW.MORE)          { await sendMoreOptions(ctx); return; }
  if (listReplyId === WELCOME_ROW.BROWSE_BESTSELLERS || listReplyId === WELCOME_ROW.BROWSE_COLLECTION) {
    await sendCuratedCollection(ctx, 'best-sellers', 'Bestsellers',
      'Our most-loved pieces — the ones that keep coming back into stock');
    return;
  }
  if (listReplyId === WELCOME_ROW.STYLING)       { await handleStylistRequest(ctx); return; }
  if (trimmed === 'Talk to stylist')              { await handleStylistRequest(ctx); return; }

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

  // ── Free-text colour variant pick (typed instead of tapped) ──
  //    Catches "Yellow", "Blue", "Yellow ₹2,690" etc. when the customer is
  //    on a product-detail screen with colour variants offered. Without this,
  //    typed colour replies fall through to saree-search / off-topic / welcome.
  const availableColours = ctx.cart?.rajathee?.product?.availableColours || [];
  if (availableColours.length > 0 && trimmed.length > 0 && !listReplyId && !buttonReplyId) {
    const normalized = trimmed
      .replace(/[₹$].*$/, '')       // strip price suffix
      .replace(/\s*[—–-]\s*.*$/, '') // strip em-dash trailer
      .trim()
      .toLowerCase();
    const match = availableColours.find(c => c.name && c.name.trim().toLowerCase() === normalized);
    if (match) {
      console.log(`[rajathee] free-text variant pick: "${trimmed}" → ${match.name} (id=${match.id})`);
      await sendVariantDetail(ctx, match.id);
      return;
    }
  }

  // ── Add-on list-row taps (PDF Section 6) ──
  if (listReplyId === ADDON_ROW.FP)   { await handleAddon(ctx, 'fp');   return; }
  // New button-based add-on routing (3-button flow).
  if (trimmed === 'Ready to Wear') { await handleAddon(ctx, 'rtw'); return; }
  if (trimmed === 'Pico Fall')     { await handleAddon(ctx, 'fp');  return; }
  if (listReplyId === ADDON_ROW.RTW)  { await handleAddon(ctx, 'rtw');  return; }
  if (listReplyId === ADDON_ROW.BOTH) { await handleAddon(ctx, 'both'); return; }
  if (listReplyId === ADDON_ROW.NONE) { await handleAddon(ctx, 'none'); return; }

  // ── Cart-action buttons ──
  if (trimmed === CART_BTN.BROWSE_MORE) { await handleBrowseMore(ctx); return; }
  if (trimmed === CART_BTN.VIEW_CART)   { await handleViewCart(ctx);   return; }
  if (trimmed === CART_BTN.APPLY_COUPON) { await handleApplyCouponPrompt(ctx); return; }
  if (trimmed === CART_BTN.CHECKOUT)    { await handleCheckout(ctx);   return; }

  // ── Checkout flow buttons + edit list rows ──
  if (trimmed === CHECKOUT_BTN.CONFIRM)    { await handlePaymentMenu(ctx); return; }
  if (trimmed === PAYMENT_BTN.CARD)         { await handlePaymentCard(ctx);    return; }
  if (trimmed === PAYMENT_BTN.UPI)          { await handlePaymentUPI(ctx);     return; }
  if (trimmed === PAYMENT_BTN.COD)          { await handlePaymentCOD(ctx);     return; }
  if (trimmed === COD_SWITCH_BTN.FULL_UPI)  { await handleCodSwitchUPI(ctx);   return; }
  if (trimmed === COD_SWITCH_BTN.FULL_CARD) { await handleCodSwitchCard(ctx);  return; }
  if (trimmed === CHECKOUT_BTN.CANCEL)     { await handleCheckoutCancel(ctx);  return; }
  if (trimmed === CHECKOUT_BTN.EDIT_ADDR)  { await handleCheckoutEdit(ctx, CHECKOUT_STEP.ADDRESS1); return; }
  if (listReplyId === 'checkout_edit_name')  { await handleCheckoutEdit(ctx, CHECKOUT_STEP.NAME);     return; }
  if (listReplyId === 'checkout_edit_city')  { await handleCheckoutEdit(ctx, CHECKOUT_STEP.CITY);     return; }
  if (listReplyId === 'checkout_edit_state') { await handleCheckoutEdit(ctx, CHECKOUT_STEP.STATE);    return; }
  if (listReplyId === 'checkout_edit_pin')   { await handleCheckoutEdit(ctx, CHECKOUT_STEP.PIN);      return; }

  // ── Post-purchase buttons (PDF Section 9) ──
  if (trimmed === POSTPURCHASE_BTN.TRACK)       { await handleTrackOrder(ctx); return; }
  if (trimmed === POSTPURCHASE_BTN.BROWSE_MORE) { await handlePostBrowse(ctx); return; }

  // ── Product more-options list rows ──
  if (listReplyId === PRODUCT_LIST_ROW.STYLING_HELP) {
    await handleStylingHelp(ctx);
    return;
  }
  if (listReplyId === PRODUCT_LIST_ROW.BACK_TO_BROWSE) {
    await sendBackToBrowse(ctx);
    return;
  }

  // ── Saree-search pagination buttons (must come BEFORE FABRIC_BTN.SHOW_MORE to win when sareeSearch state exists) ──
  if (trimmed === 'Show more' && ctx.cart?.rajathee?.sareeSearch?.remainingHandles?.length > 0) {
    await handleSareeSearchShowMore(ctx);
    return;
  }

  // ── Saree-search: type a number (1-99) to pick from results ──
  if (ctx.cart?.rajathee?.sareeSearch?.allCandidates?.length > 0 && /^\s*\d{1,2}\s*$/.test(trimmed)) {
    const pick = parseInt(trimmed, 10);
    const all = ctx.cart.rajathee.sareeSearch.allCandidates;
    if (pick >= 1 && pick <= all.length) {
      const chosen = all[pick - 1];
      console.log(`[rajathee] saree-search digit pick: ${pick} → ${chosen.handle}`);
      await sendProductDetail(ctx, chosen.handle);
      return;
    }
  }
  if (trimmed === 'Browse menu') {
    // Clear saree-search state and return to welcome
    if (ctx.cart?.rajathee?.sareeSearch) delete ctx.cart.rajathee.sareeSearch;
    await sendWelcome(ctx);
    return;
  }

  // ── Pagination + control buttons ──
  if (trimmed === FABRIC_BTN.SHOW_MORE) { await handleShowMore(ctx); return; }
  if (trimmed === FABRIC_BTN.SWITCH_FABRIC) { await sendFabricPicker(ctx); return; }
  if (trimmed === COLOUR_BTN.SWITCH_COLOUR) { await sendColourPicker(ctx); return; }

  // ── In-stock filter (free text) ──
  if (/^(show\s+)?(only\s+)?in[\s-]*stock$/i.test(trimmed) || /^available\s+only$/i.test(trimmed)) {
    await handleInStockFilter(ctx);
    return;
  }

  // ── Product action buttons ──
  if (trimmed === 'Add to cart 🛒')           { await handleAddToCartPromptTap(ctx); return; }
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

  // ── Order inquiry detection — runs BEFORE saree-search to catch "#1002", "Order id- 1002", etc.
  const orderNum = detectOrderNumber(trimmed);
  if (orderNum) {
    console.log(`[rajathee] Order inquiry detected: #${orderNum} from ${ctx.from}`);
    await handleOrderInquiry(ctx, orderNum);
    return;
  }

  // ── Cart-edit intent — "edit cart", "Edit cart?", "change cart", "modify cart",
  //    "remove item". Routes to handleViewCart (cart summary + coupon/checkout
  //    buttons). Without this, the phrases fall through to off-topic warning,
  //    most painfully after the payment menu has been shown.
  if (/\b(edit|change|modify|remove)(\s+(my|an|the))?\s+(cart|carts|item|items)\b/i.test(trimmed)) {
    console.log(`[rajathee] Cart-edit intent detected in "${trimmed}"`);
    await handleViewCart(ctx);
    return;
  }

  // ── Payment intent detection — "checkout" (case-insensitive), "pay", "payment",
  //    "how to pay", "place order". Bare "Checkout" already matches via CART_BTN
  //    above; this catches the natural-language phrasings that previously fell
  //    through to off-topic or false-positive saree-search.
  if (/\b(checkout|payment|how (do i |to )pay|place\s+(my\s+)?order|pay)\b/i.test(trimmed)) {
    console.log(`[rajathee] Payment intent detected in "${trimmed}"`);
    await handlePaymentIntent(ctx);
    return;
  }

  // ── Budget detection — "under 1500", "1000 se kam", "silk under 2k" ──
  const budget = budgetParser.detectBudget(trimmed);
  if (budget) {
    console.log(`[rajathee] Budget detected: max=${budget.maxPrice} cleaned="${budget.cleanedText}"`);
    const remaining = budget.cleanedText.trim();
    if (remaining.length > 0) {
      try {
        const search = await sareeSearch.findSareeFromText(ctx.tenant, remaining);
        let candidates = [];
        if (search.mode === 'high') candidates = [search.best];
        else if (search.mode === 'low') candidates = search.candidates;
        const within = budgetParser.filterByBudget(filterInStock(candidates), budget.maxPrice);
        if (within.length > 0) {
          const header = within.length === 1
            ? `Here's what I found matching "${remaining}" under ${formatPrice(budget.maxPrice)} 💛`
            : `Here are ${within.length} sarees matching "${remaining}" under ${formatPrice(budget.maxPrice)} 💛`;
          await sendBudgetResults(ctx, within, budget.maxPrice, header, `q="${remaining}"`);
          return;
        }
        console.log(`[rajathee] budget+search "${remaining}" max=${budget.maxPrice} → 0 results, falling back to bare budget`);
      } catch (e) {
        console.error('[rajathee] budget+search error:', e.message);
      }
    }
    await handleBudgetBrowse(ctx, budget.maxPrice);
    return;
  }

  // ── Bestseller free-text trigger — "show me bestsellers", "popular sarees", "top sarees" ──
  if (/\b(best ?sellers?|most.?loved|popular sarees?|top sarees?|trending)\b/i.test(trimmed)) {
    console.log(`[rajathee] Bestseller keyword detected in "${trimmed}"`);
    await sendCuratedCollection(ctx, 'best-sellers', 'Bestsellers',
      'Our most-loved pieces — the ones that keep coming back into stock');
    return;
  }

  // ── Saree search FIRST — match free text to a specific product/collection ──
  // (Runs before FAQ so single-word fabric queries like "Silk" show sarees, not care info.)
  if (trimmed && trimmed.length > 0) {
    try {
      const search = await sareeSearch.findSareeFromText(ctx.tenant, trimmed);
      if (search.mode === 'high') {
        const card = sareeSearch.formatProductCard(search.best);
        console.log(`[rajathee] saree-search HIGH: "${search.best.title}"`);
        if (card.imageUrl) {
          await sendImage(ctx.from, card.imageUrl, card.caption, ctx.waToken, ctx.phoneNumberId);
        } else {
          await sendMessage(ctx.from, card.caption, ctx.waToken, ctx.phoneNumberId);
        }
        return;
      }
      if (search.mode === 'low') {
        console.log(`[rajathee] saree-search LOW: ${search.candidates.length} total candidates`);
        const total = search.candidates.length;
        const firstBatchSize = sareeSearch.batchSizeForPage(0);
        const firstBatch = search.candidates.slice(0, firstBatchSize);
        const remaining = search.candidates.slice(firstBatchSize);

        await sendMessage(ctx.from,
          `I found ${total} that might match. Which one were you thinking of? ✨`,
          ctx.waToken, ctx.phoneNumberId);
        for (let i = 0; i < firstBatch.length; i++) {
          const p = firstBatch[i];
          const card = sareeSearch.formatProductCard(p, i + 1);
          if (card.imageUrl) {
            await sendImage(ctx.from, card.imageUrl, card.caption, ctx.waToken, ctx.phoneNumberId);
          } else {
            await sendMessage(ctx.from, card.caption, ctx.waToken, ctx.phoneNumberId);
          }
        }

        // Build a full ordered array of ALL candidates (for digit-typed shortcut + list pickers)
        const allCandidates = search.candidates.map(p => ({
          handle: p.handle, title: p.title, price: p.variants?.[0]?.price, image: p.images?.[0]?.src,
        }));

        // Send a tappable picker for the SAME batch we just showed (max 10 rows per list)
        const pickerRows = firstBatch.slice(0, 10).map((p, i) => {
          const num = i + 1;
          const titleStr = `${num}. ${p.title}`;
          return {
            id: `product_${p.handle}`,
            title: titleStr.length > 24 ? titleStr.slice(0, 21) + '...' : titleStr,
            description: p.variants?.[0]?.price ? formatPrice(p.variants[0].price) : '',
          };
        });
        await sendList(ctx.from, 'Or tap below to pick a saree by number 👇',
          [{ title: 'Showing 1-' + firstBatch.length, rows: pickerRows }],
          ctx.waToken, ctx.phoneNumberId, 'Tap a saree');

        // Save state for Show more + digit-typed shortcut
        ctx.cart = ctx.cart || {};
        ctx.cart.rajathee = ctx.cart.rajathee || {};
        ctx.cart.rajathee.lastShown = buildLastShown(firstBatch);
        ctx.cart.rajathee.sareeSearch = {
          allCandidates,                          // full list, 1-based via i+1
          remainingHandles: remaining.map(p => ({ id: p.id, handle: p.handle, title: p.title, price: p.variants?.[0]?.price, image: p.images?.[0]?.src })),
          page: 0,
          shownCount: firstBatch.length,
          query: trimmed,
        };

        await sendAddToCartPrompt(ctx);

        await sendMessage(ctx.from,
          'Still deciding? See real women wearing these → https://rajathee.com/#draped',
          ctx.waToken, ctx.phoneNumberId);

        if (remaining.length > 0) {
          await sendButtons(ctx.from, `Want to see more? (${remaining.length} left)`,
            ['Show more', 'Browse menu'],
            ctx.waToken, ctx.phoneNumberId);
        }
        await upsertConversation(ctx.tenant.id, ctx.from, ctx.history || [], ctx.cart);
        return;
      }
    } catch (e) {
      console.error('[rajathee] saree-search error:', e.message);
    }

    // ── Smart Q&A — fallback if saree-search returns 'none' ──
    const matched = await qa.matchFaq(trimmed, ctx.tenant.id);
    console.log(`[rajathee] FAQ match: ${matched ? matched.q : 'none'} for "${trimmed}"`);
    if (matched) {
      await qa.sendFaqMatch(ctx, matched);
      return;
    }

    // Off-topic. Track count: 1st = warning, 2nd = mute.
    ctx.cart = ctx.cart || {};
    ctx.cart.rajathee = ctx.cart.rajathee || {};
    const count = (ctx.cart.rajathee.offTopicCount || 0) + 1;
    ctx.cart.rajathee.offTopicCount = count;

    if (count === 1) {
      await qa.sendOffTopicWarning(ctx);
    } else {
      // Second strike: send mute message and enter silent mode.
      ctx.cart.rajathee.muted = true;
      await qa.sendOffTopicMute(ctx);
      // Persist the mute state.
      await upsertConversation(ctx.tenant.id, ctx.from, [
        ...(ctx.history || []),
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '[rajathee muted after 2 off-topic]' },
      ], ctx.cart);
    }
    return;
  }
  await sendWelcome(ctx);
}

// ─── PDF SECTION 1 — WELCOME ──────────────────────────────────────────────

async function sendWelcome(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  // Pull tenant-managed welcome from dashboard (cached 60s); fallback to hardcoded.
  let welcomeBody = WELCOME_BODY;
  try {
    const s = await getTenantSettings(tenant.id);
    if (s && s.welcome_message && s.welcome_message.trim()) {
      welcomeBody = s.welcome_message.trim();
    }
  } catch (e) {
    console.error('[sendWelcome] settings fetch failed (using fallback):', e.message);
  }

  await sendButtons(from, welcomeBody,
    [WELCOME_BTN.FABRIC, WELCOME_BTN.COLOUR, WELCOME_BTN.MORE],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee welcome shown: Browse by fabric, Browse by colour, More options]' },
  ], cart);
}

// "More options" submenu — opens curated collections + styling help.
async function sendMoreOptions(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  await sendList(from, 'What else can I help with?', [{
    title: 'More options',
    rows: [
      { id: WELCOME_ROW.BROWSE_BESTSELLERS, title: 'Browse by bestseller', description: 'Our most-loved sarees' },
      { id: WELCOME_ROW.STYLING,            title: "I'd like styling help", description: 'Talk to us' },
    ],
  }], waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee more options shown]' },
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

  const productsRaw = await getCollectionProducts(tenant, handle);
  const products = filterInStock(productsRaw);

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

  // Send 3 product cards. (C.5 — enriched captions w/ link + variants)
  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const caption = buildProductCaption(p);
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  // Voice line.
  const introPrefix = `From the ${label === 'The Silk Edit' ? 'Silk Edit' : label + ' Edit'}. `;
  await sendMessage(from, introPrefix + voice, waToken, phoneNumberId);

  await sendAddToCartPrompt(ctx);

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
      lastShown: buildLastShown(slice),
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
  // C.5b (23 May): also check product title + tags for single-variant products
  // where the colour lives in the name (e.g. "Blush Beauty | Baby Pink Cotton-Tissue Saree")
  return products.filter(p => {
    const variants = p.variants || [];
    if (variants.some(v => variantMatchesColour(v.option1 || v.title, colourId))) return true;
    // Fallback 1: product title
    if (variantMatchesColour(p.title, colourId)) return true;
    // Fallback 2: product tags (Shopify tags array, comma-joined for substring match)
    const tagsStr = Array.isArray(p.tags) ? p.tags.join(' ') : (p.tags || '');
    if (variantMatchesColour(tagsStr, colourId)) return true;
    return false;
  });
}

// PDF Section 13 stock rule (Shweta 14 May, tightened C.6 23 May):
// Hide a saree from carousels if ANY of these are true:
//   - product status is not 'active' (drops draft / unlisted / archived)
//   - published_at is null (drops unpublished even if status='active')
//   - all variants have inventory_quantity <= 0
// Admin API returns v.available = null, so the old check was a no-op.
// inventory_quantity is the only reliable signal on Admin API responses.
function isVisibleProduct(p) {
  if (!p) return false;
  if (p.status && p.status !== 'active') return false;
  if (p.published_at === null || p.published_at === undefined) return false;
  return true;
}

function hasStockOnSomeVariant(p) {
  const variants = p.variants || [];
  if (!variants.length) return false;
  return variants.some(v => {
    // Defensive: if inventory_quantity is missing/null, fall back to v.available
    // (Storefront API path includes 'available'; Admin API includes 'inventory_quantity')
    if (typeof v.inventory_quantity === 'number') return v.inventory_quantity > 0;
    return v.available !== false;
  });
}

function filterInStock(products) {
  return (products || []).filter(p => isVisibleProduct(p) && hasStockOnSomeVariant(p));
}

async function sendColourResults(ctx, colourRowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const label = COLOUR_LABEL[colourRowId];
  const voice = COLOUR_VOICE[colourRowId];

  const allProducts = filterInStock(await getCollectionProducts(tenant, 'all-sarees'));
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
    const caption = buildProductCaption(p, matchingVariant);

    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from, voice, waToken, phoneNumberId);
  await sendAddToCartPrompt(ctx);

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
      lastShown: buildLastShown(slice),
    },
  });
}

// ─── PRODUCT CARD CAPTION BUILDER (Patch C.5 — Nikita feedback 23 May) ────
// Enriches product captions with: PDP link + colour variant list.
// Behaviour:
//   - 1 variant (no colour option): title + price + PDP link only
//   - 2+ variants with distinct option1 values: title + price + colours line + PDP link
function buildProductCaption(p, variantOverride) {
  const v0 = variantOverride || p.variants?.[0];
  const price = formatPrice(v0?.price);
  const lines = [p.title, price];

  // Variant summary — only meaningful when there's an option named Color/Colour
  // OR when there are 2+ variants with distinct option1 strings.
  const variants = p.variants || [];
  const hasColourOption = (p.options || []).some(
    o => /colou?r/i.test(typeof o === 'string' ? o : (o?.name || ''))
  );

  if (variants.length >= 2) {
    const opts = [...new Set(
      variants.map(v => (v.option1 || '').trim()).filter(Boolean)
    )];

    if (opts.length >= 2) {
      const label = hasColourOption ? 'colours' : 'options';
      // Cap at 4 names to keep the caption tight; rest implied by "+N more"
      const shown = opts.slice(0, 4).join(', ');
      const extra = opts.length > 4 ? ` +${opts.length - 4} more` : '';
      lines.push(`🎨 ${opts.length} ${label}: ${shown}${extra}`);
    }
  }

  if (p.handle) {
    lines.push(`🔗 https://rajathee.com/products/${p.handle}`);
  }

  return lines.join('\n');
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
  await sendList(from, 'Pick a saree to add 🛒', sections, waToken, phoneNumberId);
}

// ─── ADD-TO-CART CTA (shown after each batch of product cards) ───────────
// Button label uses a trailing emoji so it does NOT collide with the existing
// exact-match PRODUCT_BTN.ADD_TO_CART handler (which expects to act on a
// product the user is viewing in detail).
//
// Tap behaviour reads cart.rajathee.lastShown:
//   - empty → welcome menu
//   - single → open that saree's detail directly
//   - multiple → re-send the picker so the user can choose

async function sendAddToCartPrompt(ctx) {
  await sendButtons(ctx.from,
    'Ready to order? Tap to add a saree to your cart',
    ['Add to cart 🛒'],
    ctx.waToken, ctx.phoneNumberId);
}

// Used by every batch-sending function to record the LAST batch shown, so
// the smart Add-to-cart tap can act on it.
function buildLastShown(products) {
  return (products || []).map(p => ({
    handle: p.handle,
    title:  p.title,
    price:  p.variants?.[0]?.price,
  }));
}

async function handleAddToCartPromptTap(ctx) {
  const ls = ctx.cart?.rajathee?.lastShown || [];
  if (ls.length === 0) {
    await sendWelcome(ctx);
    return;
  }
  if (ls.length === 1) {
    await sendProductDetail(ctx, ls[0].handle);
    return;
  }
  // Re-show picker built from the recorded handles/titles/prices.
  await sendSareePickerList(ctx, ls.map(p => ({
    handle: p.handle,
    title: p.title,
    variants: [{ price: p.price }],
  })));
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
  scheduleBrowseNudges(tenant.id, from, product.title).catch(e => console.error('[rajathee] scheduleBrowseNudges ERROR:', e.message, e.stack));

  // Identify real colour variants (excludes Shopify default-title dummy).
  // `realVariants` = all colour variants regardless of stock — used to decide
  // single vs multi-variant branch and to show "X of Y" counts.
  // `availableVariants` = in-stock subset — used to build the picker rows.
  const realVariants = (product.variants || []).filter(
    v => v.option1 && v.option1.toLowerCase() !== 'default title'
  );
  const availableVariants = realVariants.filter(v => v.available !== false);

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

  // Multi-variant but ALL sold out — graceful fallback (no empty picker).
  if (availableVariants.length === 0) {
    await sendMessage(from,
      `This one's sold out in all ${realVariants.length} colours right now. Would you like to see something similar?`,
      waToken, phoneNumberId);
    await sendButtons(from,
      'What would you like to do?',
      [PRODUCT_BTN.SEE_MORE_PICS, PRODUCT_BTN.MORE_OPTIONS,
       { id: 'back_to_browse', title: 'Browse other sarees' }],
      waToken, phoneNumberId);

    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[rajathee product_detail handle=${productHandle} variants=0/${realVariants.length} all_sold_out]` },
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
    return;
  }

  // Multi-variant branch below — show only in-stock colours in the picker.
  const colourRows = availableVariants.slice(0, 10).map(v => ({
    id: `product_variant_${v.id}`,
    title: v.option1.length > 24 ? v.option1.slice(0, 21) + '...' : v.option1,
    description: formatPrice(v.price),
  }));

  // Header reflects "X of Y" when some are sold out, else just "X colours".
  const headerText = availableVariants.length < realVariants.length
    ? `Available in ${availableVariants.length} of ${realVariants.length} colours:`
    : `Available in ${availableVariants.length} ${availableVariants.length === 1 ? 'colour' : 'colours'}:`;

  await sendList(from,
    headerText,
    [{ title: 'Choose a colour', rows: colourRows }],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee product_detail handle=${productHandle} variants=${availableVariants.length}/${realVariants.length}]` },
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
        availableColours: availableVariants.map(v => ({
          id: String(v.id), name: v.option1, price: v.price,
        })),
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
  // Try all-sarees first (reliable .available), fall back to direct-handle
  // fetch — same fallback as handleAddToCart, since bestseller-only products
  // aren't in the all-sarees collection.
  const allProducts = await getCollectionProducts(tenant, 'all-sarees').catch(() => []);
  let product = allProducts.find(p => p.handle === productHandle);
  if (!product) {
    product = await getProductByHandle(tenant, productHandle).catch(() => null);
  }
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
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const productHandle = r.product?.handle;
  const variantId = r.product?.currentVariantId;

  if (!productHandle) {
    await sendWelcome(ctx);
    return;
  }

  // Resolve product + variant. Try all-sarees first (gives reliable .available
  // on variants) then fall back to direct-handle fetch for products that live
  // only in other collections (e.g. best-sellers-only items). Without the
  // fallback, those items hit "Couldn't find that one" even though
  // sendProductDetail loaded them fine via the same direct path.
  const allProducts = await getCollectionProducts(tenant, 'all-sarees').catch(() => []);
  let product = allProducts.find(p => p.handle === productHandle);
  if (!product) {
    product = await getProductByHandle(tenant, productHandle).catch(() => null);
  }
  if (!product) {
    await sendMessage(from, "Couldn't find that one. Let me bring you back to browse.", waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // Single-variant product: use first variant.
  const variant = variantId
    ? (product.variants || []).find(v => String(v.id) === String(variantId))
    : product.variants?.[0];

  if (!variant) {
    await sendMessage(from, "That colour isn't available right now.", waToken, phoneNumberId);
    return;
  }

  // Add saree line item to in-conversation cart.
  const items = Array.isArray(r.items) ? [...r.items] : [];
  items.push({
    kind: 'saree',
    productHandle: product.handle,
    productTitle: product.title,
    variantId: String(variant.id),
    colour: variant.option1 || null,
    price: parseFloat(variant.price) || 0,
  });

  const colourPart = variant.option1 && variant.option1.toLowerCase() !== 'default title'
    ? ' in ' + variant.option1
    : '';
  await sendMessage(from,
    'Added — ' + product.title + colourPart + ' in your cart.\n\n' +
    'Would you like us to take care of the finishing?\n' +
    '• Ready to Wear — pre-stitched +' + formatPrice(ADDON_PRICE.READY_TO_WEAR) + '\n' +
    '• Pico Fall — neat hemmed edges +' + formatPrice(ADDON_PRICE.FALL_PICO),
    waToken, phoneNumberId);

  // 2 buttons per PDF v1.1: RTW + Pico Fall only. No Skip.
  await sendButtons(from, 'Choose:',
    ['Ready to Wear', 'Pico Fall'],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee added_to_cart variantId=' + variant.id + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items,
      pendingSareeVariantId: String(variant.id),
    },
  });
}

async function handleAddon(ctx, choice) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const items = Array.isArray(r.items) ? [...r.items] : [];
  const linkedSareeId = r.pendingSareeVariantId || null;

  // Ready to Wear (₹1,100) bundles Pico Fall — the stitching includes hemming.
  // So 'rtw' must NOT also push a fall_pico line item (that would double-charge
  // the ₹180 Pico Fall on top of the ₹1,100 RTW price).
  if (choice === 'fp' || choice === 'both') {
    items.push({
      kind: 'fall_pico',
      variantId: ADDON_VARIANT.FALL_PICO,
      price: ADDON_PRICE.FALL_PICO,
      linkedToSaree: linkedSareeId,
    });
  }
  if (choice === 'rtw' || choice === 'both') {
    items.push({
      kind: 'ready_to_wear',
      variantId: ADDON_VARIANT.READY_TO_WEAR,
      price: ADDON_PRICE.READY_TO_WEAR,
      linkedToSaree: linkedSareeId,
    });
  }
  // 'none' adds nothing extra.

  const summary = formatCartSummary(items);
  const confirmation = choice === 'none'
    ? 'No problem — just the saree it is.'
    : (choice === 'both' ? 'Both added.' : (choice === 'fp' ? 'Pico Fall added.' : "Ready to Wear includes Pico Fall — we'll take care of both."));

  await sendMessage(from,
    confirmation + '\n\n*Your cart*\n' + summary,
    waToken, phoneNumberId);

  await sendButtons(from, "Anything else you'd like to add to this drape?",
    [CART_BTN.BROWSE_MORE, CART_BTN.VIEW_CART, CART_BTN.CHECKOUT],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee addon=' + choice + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items,
      pendingSareeVariantId: null,
    },
  });
}

async function handleViewCart(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const items = cart.rajathee?.items || [];
  if (!items.length) {
    await sendMessage(from, "Your cart is empty. Shall we find you something?", waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }
  await sendMessage(from, '*Your cart*\n' + formatCartSummary(items), waToken, phoneNumberId);
  const couponLine = cart.rajathee?.discountCode
    ? `\n_Coupon applied: ${cart.rajathee.discountCode}_`
    : '';
  if (couponLine) {
    await sendMessage(from, couponLine.trim(), waToken, phoneNumberId);
  }
  await sendButtons(from, 'Have a coupon code? Tap below to apply, or continue to checkout.',
    [CART_BTN.APPLY_COUPON, CART_BTN.CHECKOUT],
    waToken, phoneNumberId);
}

async function handleBrowseMore(ctx) {
  await sendBackToBrowse(ctx);
}

// Free-text payment-intent router. Empty cart → browse nudge. Items in cart
// without complete address → quick ack then drop into handleCheckout. Items
// in cart WITH complete address → skip address re-collection and jump
// straight to handlePaymentMenu.
async function handlePaymentIntent(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const r = cart?.rajathee || {};
  const items = r.items || [];
  const co = r.checkout || {};

  if (!items.length) {
    await sendMessage(from, 'Your cart is empty — let me find you a saree first 🌸', waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  const addressComplete = co.name && co.address1 && co.city && co.state && co.pin;
  if (addressComplete) {
    await handlePaymentMenu(ctx);
    return;
  }

  await sendMessage(from, 'Got it — just need your delivery details first ✨', waToken, phoneNumberId);
  await handleCheckout(ctx);
}

async function handleCheckout(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const items = cart.rajathee?.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your cart is empty. Shall we find you a saree first?', waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // If address is already on file (returning customer or post-edit re-tap),
  // skip re-collection and jump straight to payment.
  const co = cart.rajathee?.checkout || {};
  if (co.name && co.address1 && co.city && co.state && co.pin) {
    await handlePaymentMenu(ctx);
    return;
  }

  // Begin name collection.
  await sendMessage(from, CHECKOUT_PROMPT[CHECKOUT_STEP.NAME], waToken, phoneNumberId);

  // Defensively clear awaitingCoupon — if the customer tapped "Apply coupon"
  // earlier and never typed a code, the stuck flag would otherwise intercept
  // their address inputs in the coupon handler. (Dispatcher priority swap
  // already prevents this; clearing here is belt-and-braces.)
  const nextRajathee = { ...(cart.rajathee || {}) };
  delete nextRajathee.awaitingCoupon;

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee checkout_started]' },
  ], {
    ...cart,
    rajathee: {
      ...nextRajathee,
      checkout: {
        step: CHECKOUT_STEP.NAME,
        name: null, address1: null, city: null, state: null, pin: null,
        phone: from,
        editingField: null,
        orderId: null,
      },
    },
  });
}

// ─── Validation ──────────────────────────────────────────────────────────

function validateCheckoutField(field, raw) {
  const v = (raw || '').trim();
  if (field === CHECKOUT_STEP.NAME) {
    if (v.length < 2) return { valid: false, error: 'Could you share your full name? Even just first and last is fine.' };
    if (/\d/.test(v))  return { valid: false, error: 'Names usually don\'t have numbers — could you share again?' };
    return { valid: true, value: v };
  }
  if (field === CHECKOUT_STEP.ADDRESS1) {
    if (v.length < 10) return { valid: false, error: 'Could you share the full address? House/flat number and street.' };
    return { valid: true, value: v };
  }
  if (field === CHECKOUT_STEP.CITY) {
    if (v.length < 2) return { valid: false, error: 'Which city is this for?' };
    if (/\d/.test(v)) return { valid: false, error: 'City names usually don\'t have numbers — could you share again?' };
    return { valid: true, value: v };
  }
  if (field === CHECKOUT_STEP.STATE) {
    if (v.length < 2) return { valid: false, error: 'Could you share the state?' };
    return { valid: true, value: v };
  }
  if (field === CHECKOUT_STEP.PIN) {
    if (!/^\d{6}$/.test(v)) return { valid: false, error: 'PIN should be exactly 6 digits.' };
    return { valid: true, value: v };
  }
  return { valid: false, error: 'Could you share that again?' };
}

// ─── Step machine — handles free-text inputs during address collection ──

async function handleCheckoutMessage(ctx) {
  // ── Try to parse combined customer details if we're at the NAME step ──
  // Customer may have sent all info (name, address, city, state, pin) in one message.
  const _bulkTry = await tryParseBulkDetails(ctx);
  if (_bulkTry === 'PARSED') return;

  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const editingField = co.editingField;
  const currentStep = editingField || co.step;

  const result = validateCheckoutField(currentStep, text);
  if (!result.valid) {
    await sendMessage(from, result.error, waToken, phoneNumberId);
    return;
  }

  // Save the field.
  const updatedCheckout = { ...co, [currentStep]: result.value };

  if (editingField) {
    // After editing, jump straight back to review.
    updatedCheckout.editingField = null;
    updatedCheckout.step = CHECKOUT_STEP.REVIEW;
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee checkout_edited=' + currentStep + ']' },
    ], {
      ...cart,
      rajathee: { ...r, checkout: updatedCheckout },
    });
    await sendCheckoutReview({ ...ctx, cart: { ...cart, rajathee: { ...r, checkout: updatedCheckout } } });
    return;
  }

  // Advance to next step.
  const stepOrder = [CHECKOUT_STEP.NAME, CHECKOUT_STEP.ADDRESS1, CHECKOUT_STEP.CITY, CHECKOUT_STEP.STATE, CHECKOUT_STEP.PIN];
  const idx = stepOrder.indexOf(currentStep);
  const nextStep = idx >= 0 && idx < stepOrder.length - 1 ? stepOrder[idx + 1] : CHECKOUT_STEP.REVIEW;
  updatedCheckout.step = nextStep;

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee checkout_step=' + currentStep + '→' + nextStep + ']' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: updatedCheckout },
  });

  if (nextStep === CHECKOUT_STEP.REVIEW) {
    await sendCheckoutReview({ ...ctx, cart: { ...cart, rajathee: { ...r, checkout: updatedCheckout } } });
  } else {
    await sendMessage(from, CHECKOUT_PROMPT[nextStep], waToken, phoneNumberId);
  }
}

// ─── Review screen ───────────────────────────────────────────────────────

function calcShipping(subtotal) {
  return subtotal >= SHIPPING_FREE_THRESHOLD ? 0 : SHIPPING_FEE;
}

function formatOrderSummary(items, checkout) {
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand = subtotal + shipping;

  let out = '*Order summary*\n\n';
  out += formatCartSummary(items) + '\n';
  out += 'Shipping: ' + (shipping === 0 ? 'Free' : formatPrice(shipping)) + '\n';
  out += '*Grand total: ' + formatPrice(grand) + '*\n\n';
  out += '*Delivery to*\n';
  out += checkout.name + '\n';
  out += checkout.address1 + '\n';
  out += checkout.city + ', ' + checkout.state + ' — ' + checkout.pin + '\n';
  out += 'Phone: +' + checkout.phone;
  return out;
}

async function sendCheckoutReview(ctx) {
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const items = cart.rajathee?.items || [];
  const co = cart.rajathee?.checkout || {};

  const summary = formatOrderSummary(items, co);
  await sendMessage(from, summary, waToken, phoneNumberId);

  // Primary action buttons (3 max).
  await sendButtons(from, 'Ready to place the order?',
    [CHECKOUT_BTN.CONFIRM, CHECKOUT_BTN.EDIT_ADDR, CHECKOUT_BTN.CANCEL],
    waToken, phoneNumberId);

  // Secondary edit options as a list.
  await sendList(from, 'Need to change something?', [{
    title: 'Edit details',
    rows: [
      { id: 'checkout_edit_name',  title: CHECKOUT_BTN.EDIT_NAME,  description: co.name || '—' },
      { id: 'checkout_edit_city',  title: CHECKOUT_BTN.EDIT_CITY,  description: co.city || '—' },
      { id: 'checkout_edit_state', title: CHECKOUT_BTN.EDIT_STATE, description: co.state || '—' },
      { id: 'checkout_edit_pin',   title: CHECKOUT_BTN.EDIT_PIN,   description: co.pin || '—' },
    ],
  }], waToken, phoneNumberId);
}

// ─── Edit + confirm + cancel ─────────────────────────────────────────────

async function handleCheckoutEdit(ctx, field) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const updatedCheckout = { ...(r.checkout || {}), editingField: field };

  await sendMessage(from, CHECKOUT_PROMPT[field], waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee checkout_editing=' + field + ']' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: updatedCheckout },
  });
}

function generateOrderId(phone) {
  const last6 = (phone || '').slice(-6).padStart(6, '0');
  const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  return 'RAJ-' + last6 + '-' + rand;
}

// ─── TEAM ALERT ROUTING (Patch C.7 — 23 May) ──────────────────────────────
// Final routing per Kashmira:
//   - role 'ops'  → Apurv + Nikita        (new orders, all operational alerts)
//   - role 'sos'  → Apurv + Nikita + Manisha  (escalations)
//   - role 'apurv' / 'nikita' / 'manisha' / 'kashmira' → single recipient
//
// Uses vaani_team_sos template (when meta.sosType present + tenant provisioned)
// so SOS messages deliver outside the 24h freeform window. Falls back to
// freeform when no meta or template not approved.
//
// OWNER_ALERT_PHONE remains as legacy single-recipient fallback if the new
// env vars are not set.

const RAJATHEE_APURV_PHONE   = process.env.RAJATHEE_APURV_PHONE   || null;
const RAJATHEE_NIKITA_PHONE  = process.env.RAJATHEE_NIKITA_PHONE  || null;
const RAJATHEE_MANISHA_PHONE = process.env.RAJATHEE_MANISHA_PHONE || null;
const RAJATHEE_KASHMIRA_PHONE = process.env.KASHMIRA_PHONE        || null;

function resolveRajatheeRole(role) {
  switch (role) {
    case 'apurv':    return RAJATHEE_APURV_PHONE ? [RAJATHEE_APURV_PHONE] : [];
    case 'nikita':   return RAJATHEE_NIKITA_PHONE ? [RAJATHEE_NIKITA_PHONE] : [];
    case 'manisha':  return RAJATHEE_MANISHA_PHONE ? [RAJATHEE_MANISHA_PHONE] : [];
    case 'kashmira': return RAJATHEE_KASHMIRA_PHONE ? [RAJATHEE_KASHMIRA_PHONE] : [];
    case 'ops':      return [RAJATHEE_APURV_PHONE, RAJATHEE_NIKITA_PHONE].filter(Boolean);
    case 'sos':      return [RAJATHEE_APURV_PHONE, RAJATHEE_NIKITA_PHONE, RAJATHEE_MANISHA_PHONE].filter(Boolean);
    default:         return [];
  }
}

async function pingTeam(ctx, role, body, meta) {
  if (ctx?.testMode) {
    console.log(`[rajathee testMode] would have pinged ${role}:\n${body}`);
    return;
  }

  let phones = resolveRajatheeRole(role);

  // Legacy fallback: if no per-person env vars set, route to OWNER_ALERT_PHONE.
  if (!phones.length && OWNER_ALERT_PHONE) {
    phones = [OWNER_ALERT_PHONE];
    console.log(`[rajathee] role=${role} resolved no phones — falling back to OWNER_ALERT_PHONE`);
  }

  if (!phones.length) {
    console.log(`[rajathee] role=${role} has no recipients — would have sent:\n${body}`);
    return;
  }

  for (const phone of phones) {
    if (meta && meta.sosType) {
      try {
        const result = await sendTemplateOrFreeform({
          to: phone,
          templateName: 'vaani_team_sos',
          params: {
            sosType: meta.sosType,
            customerPhone: '+' + (ctx.from || 'unknown'),
            summary: (meta.summary || body.split('\n').slice(0, 3).join(' ')).slice(0, 180),
          },
          tenant: ctx.tenant,
          waToken: ctx.waToken,
          phoneNumberId: ctx.phoneNumberId,
          freeformText: body,
          sendMessage,
          record: {
            tenantId: ctx.tenant?.id,
            role,
            sosType: meta.sosType,
            draftId: meta.draftId || null,
          },
        });
        console.log(`[rajathee] pinged ${role}→${phone} via=${result.via} ok=${result.ok}`);
      } catch (e) {
        console.error(`[rajathee] template/freeform ping ${role}→${phone} failed:`, e.message);
      }
    } else {
      try {
        await sendMessage(phone, body, ctx.waToken, ctx.phoneNumberId);
        console.log(`[rajathee] pinged ${role}→${phone} via=freeform-legacy`);
      } catch (e) {
        console.error(`[rajathee] freeform ping ${role}→${phone} failed:`, e.message);
      }
    }
  }
}

async function sendOwnerAlert(ctx, items, checkout, orderId) {
  // C.7c (23 May): switched from direct sendMessage(OWNER_ALERT_PHONE)
  // to pingTeam(ctx, 'ops', ...) which fans out to Apurv + Nikita.
  // Falls back to OWNER_ALERT_PHONE if RAJATHEE_*_PHONE env vars not set.
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand = subtotal + shipping;

  let alert = '🛒 *NEW RAJATHEE ORDER*\n\n';
  alert += '*Order ID*: ' + orderId + '\n';
  alert += '*Customer*: ' + checkout.name + '\n';
  alert += '*Phone*: +' + checkout.phone + '\n\n';
  alert += '*Items*\n';
  for (const it of items) {
    if (it.kind === 'saree') {
      const c = it.colour && it.colour.toLowerCase() !== 'default title' ? ' (' + it.colour + ')' : '';
      alert += '• ' + it.productTitle + c + ' — ' + formatPrice(it.price) + '\n';
    } else if (it.kind === 'fall_pico') {
      alert += '• Fall & Pico — ' + formatPrice(it.price) + '\n';
    } else if (it.kind === 'ready_to_wear') {
      alert += '• Ready to Wear — ' + formatPrice(it.price) + '\n';
    }
  }
  alert += '\nSubtotal: ' + formatPrice(subtotal) + '\n';
  alert += 'Shipping: ' + (shipping === 0 ? 'Free' : formatPrice(shipping)) + '\n';
  alert += '*Grand total: ' + formatPrice(grand) + '*\n\n';
  alert += '*Delivery*\n' + checkout.address1 + '\n';
  alert += checkout.city + ', ' + checkout.state + ' — ' + checkout.pin;

  await pingTeam(ctx, 'ops', alert, {
    sosType: 'NEW ORDER',
    summary: `New order ${orderId} — ${formatPrice(grand)}`,
  });
}

// ─── Payment-mode menu — shown after address is collected ─────────────────
async function handlePaymentMenu(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your bag is empty — tap *Browse Products* to add a saree first 🌸', waToken, phoneNumberId);
    return;
  }
  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand = subtotal + shipping;

  await sendButtons(from,
    '*How would you like to pay?*\n\n' +
    'Order total: ' + formatPrice(grand) +
    (shipping === 0 ? ' (free shipping)' : ' incl. ' + formatPrice(shipping) + ' shipping') + '\n\n' +
    '💳 *Card* — pay securely online\n' +
    '📲 *UPI* — scan & pay\n' +
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

// ─── Card branch — Shopify checkout link (auto-confirm comes via orders/paid webhook) ─
async function handlePaymentCard(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your bag is empty — tap *Browse Products* to add a saree first 🌸', waToken, phoneNumberId);
    return;
  }
  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const orderId  = generateOrderId(co.phone || from);
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;

  try {
    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);
  } catch (e) { console.error('[rajathee card] saveOrder failed:', e.message); }

  // Add shipping as a line item so the Shopify total matches Tara exactly.
  const draftItems = shipping > 0
    ? [...items, { kind: 'shipping', productTitle: 'Shipping', price: shipping, quantity: 1 }]
    : items;

  let linkSent = false;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const draft = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
        items: draftItems,
        customerPhone: from,
        customerName: co.name,
        address1: co.address1,
        city: co.city,
        state: co.state,
        pin: co.pin,
        subtotal,
        discountAmount: co.discount || 0,
        discountLabel: co.discountLabel || '',
        grandTotal: grand,
        internalOrderId: orderId,
        sourceTag: 'vaani-rajathee',
      });
      if (draft && draft.invoice_url) {
        try { await saveShopifyDraftRef(orderId, draft.shopify_draft_id); }
        catch (e) { console.error('[rajathee card] saveShopifyDraftRef failed:', e.message); }
        await sendMessage(from,
          '💳 *Pay securely here:*\n' + draft.invoice_url + '\n\n' +
          'The moment your payment is in, I\'ll confirm your order right here ✨\n' +
          'Estimated delivery after payment: 5–7 working days.',
          waToken, phoneNumberId);
        linkSent = true;
        console.log('[rajathee card] draft ' + draft.shopify_draft_id + ' invoice sent for ' + orderId);
      }
    } catch (e) { console.error('[rajathee card] draft creation failed:', e.message); }
  }

  if (!linkSent) {
    await sendMessage(from,
      'Got your order ✨ Our team will send you a payment link shortly — usually within an hour.',
      waToken, phoneNumberId);
    await pingTeam(ctx, 'ops',
      '⚠️ Vaani: Shopify card link FAILED for ' + orderId + '\n' +
      'Customer: ' + co.name + ' (+' + from + ')\nPlease send a manual payment link.',
      { sosType: 'NEW ORDER', summary: 'Card link failed for ' + orderId });
  }

  await sendOwnerAlert(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee card_order=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items: [],
      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId, paymentMethod: 'card' },
      lastOrderId: orderId,
    },
  });
}

// ─── UPI branch — dynamic QR; team confirms on dashboard / via 'confirmed RAJ-XXX' ─
async function handlePaymentUPI(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your bag is empty — tap *Browse Products* to add a saree first 🌸', waToken, phoneNumberId);
    return;
  }
  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const orderId  = generateOrderId(co.phone || from);
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;

  try {
    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);
  } catch (e) { console.error('[rajathee upi] saveOrder failed:', e.message); }

  // Record in Shopify as a draft (searchable by RAJ-xxx tag). UPI is paid via the QR, so no link is sent.
  const draftItems = shipping > 0
    ? [...items, { kind: 'shipping', productTitle: 'Shipping', price: shipping, quantity: 1 }]
    : items;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const d = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
        items: draftItems, customerPhone: from, customerName: co.name,
        address1: co.address1, city: co.city, state: co.state, pin: co.pin,
        subtotal, discountAmount: co.discount || 0, discountLabel: co.discountLabel || '',
        grandTotal: grand, internalOrderId: orderId, sourceTag: 'vaani-rajathee, UPI',
      });
      if (d && d.shopify_draft_id) await saveShopifyDraftRef(orderId, d.shopify_draft_id);
    } catch (e) { console.error('[rajathee upi] draft create failed:', e.message); }
  }

  const qrUrl = VAANI_PUBLIC_URL + '/qr/' + orderId + '.png';
  await sendImage(from, qrUrl, '📲 Scan to pay ' + formatPrice(grand) + ' via any UPI app', waToken, phoneNumberId);
  await sendMessage(from,
    'Order *' + orderId + '* — total *' + formatPrice(grand) + '*.\n\n' +
    'Once you have paid, reply here with your *UPI reference number* (the 12-digit ref in your payment app) or a screenshot. ' +
    'Our team will verify it and your confirmation will land right here ✨',
    waToken, phoneNumberId);

  await sendOwnerAlert(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee upi_order=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items: [],
      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId, paymentMethod: 'upi' },
      lastOrderId: orderId,
    },
  });
}

// ─── COD branch — ₹100 advance via UPI QR; switch-to-full buttons ──────────
async function handlePaymentCOD(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your bag is empty — tap *Browse Products* to add a saree first 🌸', waToken, phoneNumberId);
    return;
  }
  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const orderId  = generateOrderId(co.phone || from);
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand    = subtotal + shipping;
  const balance  = grand - COD_ADVANCE;

  try {
    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);
  } catch (e) { console.error('[rajathee cod] saveOrder failed:', e.message); }

  // Record the COD order in Shopify as a draft (tagged COD + RAJ-xxx). Team confirms later.
  const draftItems = shipping > 0
    ? [...items, { kind: 'shipping', productTitle: 'Shipping', price: shipping, quantity: 1 }]
    : items;
  let codInvoiceUrl = null;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const d = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
        items: draftItems, customerPhone: from, customerName: co.name,
        address1: co.address1, city: co.city, state: co.state, pin: co.pin,
        subtotal, discountAmount: co.discount || 0, discountLabel: co.discountLabel || '',
        grandTotal: grand, internalOrderId: orderId, sourceTag: 'vaani-rajathee, COD',
      });
      if (d && d.shopify_draft_id) await saveShopifyDraftRef(orderId, d.shopify_draft_id);
      if (d && d.invoice_url) codInvoiceUrl = d.invoice_url;
    } catch (e) { console.error('[rajathee cod] draft create failed:', e.message); }
  }

  await sendMessage(from,
    '📦 *Cash on Delivery*\n\n' +
    'Order *' + orderId + '* — total *' + formatPrice(grand) + '*.\n' +
    'To confirm a COD order we take a small *₹100 advance* now. It is adjusted from your bill, so you pay *' + formatPrice(balance) + '* on delivery.',
    waToken, phoneNumberId);

  const qrUrl = VAANI_PUBLIC_URL + '/qr/' + orderId + '.png?amt=' + COD_ADVANCE;
  await sendImage(from, qrUrl, '📲 Scan to pay the ₹100 advance', waToken, phoneNumberId);
  await sendMessage(from,
    'After paying ₹100, reply with your *UPI reference number* (or a screenshot). ' +
    'Once we verify it, your COD order is locked in ✨',
    waToken, phoneNumberId);

  await sendButtons(from,
    'Or pay the *full amount* now instead:',
    [COD_SWITCH_BTN.FULL_UPI, COD_SWITCH_BTN.FULL_CARD],
    waToken, phoneNumberId);

  await sendOwnerAlert(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee cod_order=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items: [],
      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId, paymentMethod: 'cod', codBalance: balance, invoiceUrl: codInvoiceUrl },
      lastOrderId: orderId,
    },
  });
}

// Switch a pending COD order to full UPI payment (reuses the same order).
async function handleCodSwitchUPI(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const orderId = co.orderId || r.lastOrderId;
  if (!orderId) {
    await sendMessage(from, 'I lost track of that order — let me know if you would like to start again.', waToken, phoneNumberId);
    return;
  }
  const order = await getOrder(orderId).catch(() => null);
  const grand = order ? Number(order.grand_total) : 0;

  const qrUrl = VAANI_PUBLIC_URL + '/qr/' + orderId + '.png';
  await sendImage(from, qrUrl, '📲 Scan to pay ' + formatPrice(grand) + ' in full via UPI', waToken, phoneNumberId);
  await sendMessage(from,
    'Paying the full *' + formatPrice(grand) + '* for order *' + orderId + '*.\n\n' +
    'After paying, reply with your *UPI reference number* (or screenshot) and we will confirm here ✨',
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee cod_switch_upi=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: { ...co, paymentMethod: 'upi' } },
  });
}

// Switch a pending COD order to full Card payment (Shopify checkout link).
async function handleCodSwitchCard(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const orderId = co.orderId || r.lastOrderId;
  if (!orderId) {
    await sendMessage(from, 'I lost track of that order — let me know if you would like to start again.', waToken, phoneNumberId);
    return;
  }
  // Reuse the draft already created at COD time — avoids a duplicate Shopify draft.
  if (co.invoiceUrl) {
    await sendMessage(from,
      '💳 *Pay securely here:*\n' + co.invoiceUrl + '\n\n' +
      'The moment your payment is in, I will confirm your order right here ✨',
      waToken, phoneNumberId);
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee cod_switch_card=' + orderId + ']' },
    ], { ...cart, rajathee: { ...r, checkout: { ...co, paymentMethod: 'card' } } });
    return;
  }

  const order = await getOrder(orderId).catch(() => null);
  if (!order) {
    await sendMessage(from, 'I could not find that order — let me know if you would like to start again.', waToken, phoneNumberId);
    return;
  }

  let items = order.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (e) { items = []; } }
  if (!Array.isArray(items)) items = [];
  const shipping = Number(order.shipping || 0);
  const grand = Number(order.grand_total || 0);
  const draftItems = shipping > 0
    ? [...items, { kind: 'shipping', productTitle: 'Shipping', price: shipping, quantity: 1 }]
    : items;

  let linkSent = false;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const draft = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
        items: draftItems,
        customerPhone: from,
        customerName: co.name,
        address1: co.address1, city: co.city, state: co.state, pin: co.pin,
        subtotal: Number(order.subtotal || 0),
        discountAmount: 0, discountLabel: '',
        grandTotal: grand,
        internalOrderId: orderId,
        sourceTag: 'vaani-rajathee',
      });
      if (draft && draft.invoice_url) {
        try { await saveShopifyDraftRef(orderId, draft.shopify_draft_id); }
        catch (e) { console.error('[rajathee cod-switch-card] saveShopifyDraftRef failed:', e.message); }
        await sendMessage(from,
          '💳 *Pay securely here:*\n' + draft.invoice_url + '\n\n' +
          'The moment your payment is in, I will confirm your order right here ✨',
          waToken, phoneNumberId);
        linkSent = true;
      }
    } catch (e) { console.error('[rajathee cod-switch-card] draft failed:', e.message); }
  }
  if (!linkSent) {
    await sendMessage(from, 'Our team will send you a payment link shortly — sorry for the small delay!', waToken, phoneNumberId);
  }

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee cod_switch_card=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: { ...co, paymentMethod: 'card' } },
  });
}

async function handleCheckoutConfirm(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!items.length) {
    await sendMessage(from, 'Your bag is empty — tap *Browse Products* to add a saree first 🌸', waToken, phoneNumberId);
    return;
  }
  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, 'A few details are missing — let me walk through them again.', waToken, phoneNumberId);
    return;
  }

  const orderId = generateOrderId(co.phone || from);
  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const shipping = calcShipping(subtotal);
  const grand = subtotal + shipping;

  // Persist order to orders table for owner-side lookup.
  try {
    await saveOrder(orderId, tenant.id, from, items, co, subtotal, shipping, grand);
  } catch (e) {
    console.error('[rajathee] saveOrder failed:', e.message);
  }

  const updatedCheckout = { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId };

  // Stage 1: order placed (NOT thank-you yet; that comes after payment confirmed).
  await sendMessage(from,
    '✅ *Order placed*\n\n' +
    '*Order ID*: ' + orderId + '\n' +
    '*Total*: ' + formatPrice(grand) + '\n\n' +
    'Our team will reach out shortly to confirm payment.\n' +
    'Estimated delivery once payment confirmed: 5–7 working days.',
    waToken, phoneNumberId);

  await sendButtons(from, 'What next?',
    [POSTPURCHASE_BTN.TRACK, POSTPURCHASE_BTN.BROWSE_MORE],
    waToken, phoneNumberId);

  // Owner alert.
  await sendOwnerAlert(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee order_placed=' + orderId + ']' },
  ], {
    ...cart,
    rajathee: {
      ...r,
      items: [],
      checkout: updatedCheckout,
      lastOrderId: orderId,
    },
  });
}

// ─── Post-purchase handlers ──────────────────────────────────────────────

// ─── PDF Section 10 — Light styling tips ──────────────────────────────────

const STYLING_SYSTEM_PROMPT =
  'You are Tara, Rajathee\'s in-house stylist. Rajathee makes effortless, elegant sarees for women on the move — ' +
  'women who slip into a saree between meetings, dinners, school runs, and weekend trips. ' +
  'Your voice is calm, considered, and heritage-rooted. You speak like a thoughtful friend with taste, not a chirpy assistant. ' +
  'Given a saree (title, fabric, colour), reply with ONE styling suggestion in 2 short sentences. ' +
  'Name specific things: jewellery (jhumkas, oxidised silver, polki, kundan, pearls), hair (low bun, side-parted, mogra), ' +
  'footwear (kolhapuris, slim heels, embroidered juttis), bag, and an occasion if it fits naturally. ' +
  'Favour quiet elegance over festive maximalism. Vary your openings — never start with "Pair this with". ' +
  'No hashtags. No emojis. No exclamation marks. Lowercase "and" is fine. ' +
  'Indian styling vocabulary is welcome and encouraged.';

async function handleStylingHelp(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const r = cart.rajathee || {};
  const product = r.product || {};

  // If we don't know what they were viewing, gracefully redirect.
  if (!product.handle) {
    await sendMessage(from,
      'I\'d love to give you styling tips — please pick a saree first and tap "More options" again.',
      waToken, phoneNumberId);
    return;
  }

  // Build product context from the saree they're currently viewing.
  let productTitle = product.handle;
  let colourLine = '';
  try {
    const fetched = await getProductByHandle(ctx.tenant, product.handle);
    if (fetched) {
      productTitle = fetched.title;
      const variant = (fetched.variants || []).find(v => String(v.id) === String(product.currentVariantId));
      if (variant && variant.option1) {
        colourLine = ' (' + variant.option1 + ')';
      }
    }
  } catch (e) {
    console.error('[rajathee] styling: product fetch failed', e.message);
  }

  const userPrompt =
    'Saree: ' + productTitle + colourLine + '\n' +
    'Suggest one styling for this saree.';

  let stylingMsg;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: STYLING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    stylingMsg = resp.content?.[0]?.text?.trim();
  } catch (e) {
    console.error('[rajathee] styling Claude call failed:', e.message);
  }

  if (!stylingMsg) {
    // Fallback that still feels in-brand.
    stylingMsg = 'Try classic gold jhumkas, a low bun with a few mogra, and minimal kohl. Effortless on a busy day, elegant in the evening.';
  }

  await sendMessage(from, '✨ ' + stylingMsg, waToken, phoneNumberId);

  // Offer next steps.
  await sendButtons(from, 'Anything else?',
    ['Add to cart', 'Talk to stylist'],
    waToken, phoneNumberId);
}

async function handleStylistRequest(ctx) {
  const { tenant, from, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};

  // Customer-facing acknowledgement.
  await sendMessage(from,
    '✨ *Of course!*\n\n' +
    'Our stylist will reach out shortly to help you find the perfect drape.\n\n' +
    'In the meantime, feel free to keep browsing.',
    waToken, phoneNumberId);
  await sendHandoffFollowups(ctx);
  await sendButtons(from, 'While you wait:',
    ['Browse by fabric', 'Browse by colour'],
    waToken, phoneNumberId);

  // Build alert for stylist.
  const lastMsgs = (history || []).slice(-6).map(m => {
    const role = m.role === 'user' ? 'Customer' : 'Bot';
    const content = (m.content || '').slice(0, 200);
    return role + ': ' + content;
  }).join('\n');

  const cartSummary = (r.items && r.items.length)
    ? r.items.map(it => '• ' + (it.productTitle || 'item') + ' — ' + formatPrice(it.price || 0)).join('\n')
    : '(empty)';

  const lastViewed = r.product?.handle ? r.product.handle : '(none)';

  const alertBody =
    '👗 *RAJATHEE — Stylist help requested*\n\n' +
    '*Customer*: +' + from + '\n' +
    '*Last viewed*: ' + lastViewed + '\n\n' +
    '*Cart*\n' + cartSummary + '\n\n' +
    '*Recent messages*\n' + (lastMsgs || '(no history)') + '\n\n' +
    'Reply directly to the customer\'s number above.';

  if (STYLIST_PHONE) {
    try {
      await sendMessage(STYLIST_PHONE, alertBody, waToken, phoneNumberId);
      console.log('[rajathee] stylist alert sent to ' + STYLIST_PHONE);
    } catch (e) {
      console.error('[rajathee] stylist alert failed:', e.message);
    }
  } else {
    console.log('[rajathee] STYLIST_PHONE not set — would have sent:\n' + alertBody);
  }
}

async function handleTrackOrder(ctx) {
  const { from, waToken, phoneNumberId, cart } = ctx;
  const orderId = cart.rajathee?.lastOrderId || cart.rajathee?.checkout?.orderId;

  let msg = '*Tracking your order*\n\n';
  if (orderId) {
    const order = await getOrder(orderId).catch(() => null);
    msg += 'Order ID: ' + orderId + '\n';
    if (order) {
      const status = order.status === 'paid' ? '✅ Payment confirmed' : '⏳ Awaiting payment confirmation';
      msg += 'Status: ' + status + '\n\n';
    }
  }
  msg += 'Once your order ships, you\'ll receive tracking details from our team within 24-48 hours.\n\n';
  msg += 'For anything urgent, reply here and our team will help.';

  await sendMessage(from, msg, waToken, phoneNumberId);
  await sendButtons(from, 'Anything else?',
    [POSTPURCHASE_BTN.BROWSE_MORE],
    waToken, phoneNumberId);
}

async function handlePostBrowse(ctx) {
  await sendWelcome(ctx);
}

// ─── Owner confirmation command ──────────────────────────────────────────
// Owner sends "confirmed RAJ-XXXXXX-XXX" from OWNER_ALERT_PHONE → we mark
// the order paid AND send the customer the thank-you + tracking info.

async function handleOwnerConfirmCommand(ctx, orderId) {
  const { tenant, from, phoneNumberId, waToken } = ctx;

  const order = await getOrder(orderId).catch(() => null);
  if (!order) {
    await sendMessage(from, 'No order found with ID ' + orderId, waToken, phoneNumberId);
    return;
  }
  if (order.status === 'paid') {
    await sendMessage(from, 'Order ' + orderId + ' was already marked paid.', waToken, phoneNumberId);
    return;
  }

  const updated = await markOrderPaid(orderId).catch(() => null);
  if (!updated) {
    await sendMessage(from, 'Could not update order ' + orderId, waToken, phoneNumberId);
    return;
  }

  // Acknowledge to owner.
  await sendMessage(from,
    '✅ Order ' + orderId + ' marked as paid.\nCustomer is being notified now.',
    waToken, phoneNumberId);

  // Send thank-you to customer.
  const customerPhone = order.customer_phone;
  await sendMessage(customerPhone,
    '🌸 *Payment confirmed — thank you for choosing Rajathee!*\n\n' +
    'Your order ' + orderId + ' is now in our queue.\n' +
    'You\'ll receive tracking details once it ships.\n\n' +
    'For anything else, just message us here.',
    waToken, phoneNumberId);
}

async function handleCheckoutCancel(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};

  await sendMessage(from, 'Checkout cancelled — your cart is still here.', waToken, phoneNumberId);
  await sendButtons(from, 'What next?',
    [CART_BTN.BROWSE_MORE, CART_BTN.VIEW_CART, CART_BTN.CHECKOUT],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee checkout_cancelled]' },
  ], {
    ...cart,
    rajathee: { ...r, checkout: null },
  });
}

function formatCartSummary(items) {
  if (!items.length) return '_Empty_';
  let total = 0;
  const lines = items.map(it => {
    total += it.price || 0;
    if (it.kind === 'saree') {
      const colourPart = it.colour && it.colour.toLowerCase() !== 'default title'
        ? ' (' + it.colour + ')'
        : '';
      return '• ' + it.productTitle + colourPart + ' — ' + formatPrice(it.price);
    }
    if (it.kind === 'fall_pico') return '• Fall & Pico — ' + formatPrice(it.price);
    if (it.kind === 'ready_to_wear') return '• Ready to Wear — ' + formatPrice(it.price);
    return '• ' + (it.title || 'Item') + ' — ' + formatPrice(it.price);
  });
  lines.push('');
  lines.push('*Subtotal*: ' + formatPrice(total));
  return lines.join('\n');
}

// ─── PAGINATION DISPATCH ──────────────────────────────────────────────────

async function handleShowMore(ctx) {
  const { cart } = ctx;
  const r = cart.rajathee || {};
  if (r.totalShown >= MAX_SHOWN) {
    if (r.browseMode === 'colour') await sendColourPicker(ctx);
    else if (r.browseMode === 'curated' && r.curatedHandle) {
      await sendCuratedCollection(ctx, r.curatedHandle, r.curatedLabel || 'edit', '', (r.page || 0) + 1);
    }
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
  if (r.browseMode === 'curated' && r.curatedHandle) {
    await sendCuratedCollection(ctx, r.curatedHandle, r.curatedLabel || 'edit', '', (r.page || 0) + 1);
    return;
  }
  await sendWelcome(ctx);
}

// ─── HANDOFF FOLLOW-UPS ───────────────────────────────────────────────────
// Sent to customer after a human handoff confirmation: wait-time line, top-3
// bestsellers, then 3 more sarees not already shown this session.

async function sendHandoffFollowups(ctx) {
  const { tenant, from, waToken, phoneNumberId, cart } = ctx;

  await sendMessage(from,
    "We'll reach out shortly. Typically 20-30 mins during working hours 🕐",
    waToken, phoneNumberId);

  await sendMessage(from,
    'While you wait — see how real customers are draping them: https://rajathee.com/#draped',
    waToken, phoneNumberId);

  // 1) Fetch bestsellers and collect their handles UPFRONT so the dedup for
  //    the "more sarees" set doesn't depend on loop ordering.
  const bestRaw = await getCollectionProducts(tenant, 'best-sellers').catch(e => {
    console.error('[rajathee] bestsellers fetch failed:', e.message);
    return [];
  });
  const bestsellers = filterInStock(bestRaw).slice(0, 3);
  const bestsellerHandles = new Set(bestsellers.map(p => p.handle));

  // Strict exclusion set: anything already shown to this session + every
  // bestseller we're about to render.
  const priorHandles = new Set(cart?.rajathee?.productHandles || []);
  const blocked = new Set([...priorHandles, ...bestsellerHandles]);

  for (const p of bestsellers) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const caption = buildProductCaption(p);
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }
  if (bestsellers.length) await sendAddToCartPrompt(ctx);

  // 2) "More sarees" set — strict exclusion of both prior session + bestsellers
  const moreRaw = await getCollectionProducts(tenant, 'all-sarees').catch(e => {
    console.error('[rajathee] all-sarees fetch for handoff followup failed:', e.message);
    return [];
  });
  const more = filterInStock(moreRaw)
    .filter(p => !blocked.has(p.handle))
    .slice(0, 3);

  if (more.length) {
    await sendMessage(from, 'More sarees you might love 🌸', waToken, phoneNumberId);
    for (const p of more) {
      const v0 = p.variants?.[0];
      const img = p.images?.[0]?.src || v0?.featured_image?.src;
      const caption = buildProductCaption(p);
      if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
      else await sendMessage(from, caption, waToken, phoneNumberId);
    }
    await sendAddToCartPrompt(ctx);
  }

  // Record the last batch shown for the smart Add-to-cart tap. Prefer "more"
  // since it's chronologically last; fall back to bestsellers if "more" empty.
  const lastBatch = more.length ? more : bestsellers;
  if (lastBatch.length) {
    await upsertConversation(ctx.tenant.id, from, ctx.history || [], {
      ...(ctx.cart || {}),
      rajathee: {
        ...(ctx.cart?.rajathee || {}),
        lastShown: buildLastShown(lastBatch),
      },
    });
  }
}

// ─── CURATED COLLECTIONS (Bestsellers, Akshay Tritiya) ────────────────────

async function sendCuratedCollection(ctx, handle, label, voice, page = 0) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  const productsRaw = await getCollectionProducts(tenant, handle).catch(e => {
    console.error(`[rajathee] curated ${handle} fetch failed:`, e.message);
    return [];
  });
  const products = filterInStock(productsRaw);

  if (!products.length) {
    await sendMessage(from,
      `Our ${label} edit is being refreshed. May I show you another way to browse?`,
      waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  const start = page * PAGE_SIZE;
  const slice = products.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    await sendMessage(from, `That's all the ${label.toLowerCase()} for now. Want to explore another way?`, waToken, phoneNumberId);
    await sendButtons(from, 'Or:',
      ['Browse by fabric', 'Browse by colour', FABRIC_BTN.HELP_CHOOSE],
      waToken, phoneNumberId);
    return;
  }

  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const caption = buildProductCaption(p);
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  // Voice line only on first page — repetitive otherwise.
  if (page === 0 && voice) {
    await sendMessage(from, `${label}. ${voice}.`, waToken, phoneNumberId);
  }
  await sendAddToCartPrompt(ctx);

  const totalShownAfter = Math.min((page + 1) * PAGE_SIZE, products.length);
  const moreAvailable = totalShownAfter < Math.min(products.length, MAX_SHOWN);

  const buttons = moreAvailable
    ? [FABRIC_BTN.SHOW_MORE, 'Browse by fabric', 'Browse by colour']
    : ['Browse by fabric', 'Browse by colour', FABRIC_BTN.HELP_CHOOSE];

  await sendButtons(from, 'Or:', buttons, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee curated=${handle} page=${page} shown=${slice.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'curated',
      curatedHandle: handle,
      curatedLabel: label,
      page,
      totalShown: totalShownAfter,
      productHandles: products.slice(0, totalShownAfter).map(p => p.handle),
      lastShown: buildLastShown(slice),
    },
  });
}

// ─── IN-STOCK FILTER ──────────────────────────────────────────────────────

// ─── BUDGET BROWSE ────────────────────────────────────────────────────────
// Entry point when the user types a bare budget phrase ("under 1500",
// "1000 se kam"). Also used as the fallback when a refined query like
// "silk under 1500" returns no products within the cap.

async function sendBudgetResults(ctx, within, maxPrice, header, logTag) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const slice = within.slice(0, PAGE_SIZE);

  await sendMessage(from, header, waToken, phoneNumberId);

  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const caption = buildProductCaption(p);
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendAddToCartPrompt(ctx);
  await sendButtons(from, 'Or:',
    ['Browse by fabric', 'Browse by colour', FABRIC_BTN.HELP_CHOOSE],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee budget=${maxPrice} ${logTag} shown=${slice.length}/${within.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      browseMode: 'budget',
      budgetCap: maxPrice,
      page: 0,
      totalShown: slice.length,
      productHandles: slice.map(p => p.handle),
      lastShown: buildLastShown(slice),
    },
  });
}

async function handleBudgetBrowse(ctx, maxPrice) {
  const { tenant, from, phoneNumberId, waToken } = ctx;

  const all = filterInStock(await getCollectionProducts(tenant, 'all-sarees').catch(() => []));
  const within = budgetParser.filterByBudget(all, maxPrice);

  if (!within.length) {
    const min = all.reduce((m, p) => Math.min(m, budgetParser.variantMinPrice(p)), Infinity);
    const hint = isFinite(min)
      ? ` Our edit starts from ${formatPrice(min)} — want to see a few near that?`
      : '';
    await sendMessage(from,
      `I couldn't find any sarees under ${formatPrice(maxPrice)} right now.${hint}`,
      waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  await sendBudgetResults(ctx, within, maxPrice,
    `Here's what we have under ${formatPrice(maxPrice)} 💛`,
    'q=bare');
}

async function handleInStockFilter(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.rajathee || {};

  let products = [];
  let label = '';

  if (r.browseMode === 'fabric' && r.fabric) {
    const handle = FABRIC_HANDLES[r.fabric];
    label = FABRIC_LABEL[r.fabric];
    products = await getCollectionProducts(tenant, handle).catch(() => []);
  } else if (r.browseMode === 'colour' && r.colour) {
    label = COLOUR_LABEL[r.colour];
    const all = await getCollectionProducts(tenant, 'all-sarees').catch(() => []);
    products = filterProductsByColour(all, r.colour);
  } else if (r.browseMode === 'curated' && r.curatedHandle) {
    label = r.curatedLabel || 'edit';
    products = await getCollectionProducts(tenant, r.curatedHandle).catch(() => []);
  } else {
    await sendMessage(from,
      "Pick a fabric or palette first, then I'll show you only what's in stock.",
      waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // C.6: use shared filterInStock so this matches carousel behaviour
  const inStock = filterInStock(products);

  if (!inStock.length) {
    await sendMessage(from,
      `Everything in our ${label} edit is currently sold out — let me show you another option.`,
      waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  const slice = inStock.slice(0, PAGE_SIZE);

  for (const p of slice) {
    const v0 = (p.variants || []).find(v => (typeof v.inventory_quantity === 'number' ? v.inventory_quantity > 0 : v.available !== false)) || p.variants?.[0];
    const img = v0?.featured_image?.src || p.images?.[0]?.src;
    const caption = buildProductCaption(p, v0);
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from,
    `Showing only in-stock pieces from the ${label} edit.`,
    waToken, phoneNumberId);
  await sendAddToCartPrompt(ctx);

  await sendButtons(from, 'Or:',
    ['Switch fabric', 'Switch colour', FABRIC_BTN.HELP_CHOOSE],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[rajathee in_stock_filter mode=${r.browseMode} shown=${slice.length}]` },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      lastShown: buildLastShown(slice),
    },
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function isAmbiguous(message, trimmed) {
  if (!trimmed) return true;
  return false;
}

// ─── Saree-search "Show more" pagination handler ──────────────────────────
async function handleSareeSearchShowMore(ctx) {
  const state = ctx.cart?.rajathee?.sareeSearch;
  if (!state || !state.remainingHandles || state.remainingHandles.length === 0) {
    console.log('[rajathee] sareeSearch show-more called but no state');
    await sendWelcome(ctx);
    return;
  }

  const nextPage = (state.page || 0) + 1;
  const batchSize = sareeSearch.batchSizeForPage(nextPage);
  const batch = state.remainingHandles.slice(0, batchSize);
  const stillRemaining = state.remainingHandles.slice(batchSize);

  console.log(`[rajathee] sareeSearch show-more: page=${nextPage} batchSize=${batchSize} stillRemaining=${stillRemaining.length}`);

  const startNum = (state.shownCount || 0) + 1;
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    const num = startNum + i;
    const card = {
      imageUrl: p.image || null,
      caption: `*${num}. ${p.title}*${p.price ? '\n' + formatPrice(p.price) : ''}\n\nhttps://rajathee.com/products/${p.handle || ''}`,
    };
    if (card.imageUrl) {
      await sendImage(ctx.from, card.imageUrl, card.caption, ctx.waToken, ctx.phoneNumberId);
    } else {
      await sendMessage(ctx.from, card.caption, ctx.waToken, ctx.phoneNumberId);
    }
  }

  // Send a tappable picker for THIS batch
  const pickerRows = batch.slice(0, 10).map((p, i) => {
    const num = startNum + i;
    const titleStr = `${num}. ${p.title}`;
    return {
      id: `product_${p.handle}`,
      title: titleStr.length > 24 ? titleStr.slice(0, 21) + '...' : titleStr,
      description: p.price ? formatPrice(p.price) : '',
    };
  });
  await sendList(ctx.from, 'Or tap below to pick a saree by number 👇',
    [{ title: `Showing ${startNum}-${startNum + batch.length - 1}`, rows: pickerRows }],
    ctx.waToken, ctx.phoneNumberId, 'Tap a saree');
  await sendAddToCartPrompt(ctx);

  // Update state
  ctx.cart.rajathee.sareeSearch = {
    ...state,
    page: nextPage,
    remainingHandles: stillRemaining,
    shownCount: (state.shownCount || 0) + batch.length,
  };
  ctx.cart.rajathee.lastShown = buildLastShown(batch);

  if (stillRemaining.length > 0) {
    await sendButtons(ctx.from, `Want to see more? (${stillRemaining.length} left)`,
      ['Show more', 'Browse menu'],
      ctx.waToken, ctx.phoneNumberId);
  } else {
    delete ctx.cart.rajathee.sareeSearch;
    await sendButtons(ctx.from, `That's all I found! Want to keep browsing?`,
      ['Browse by fabric', 'Browse by colour'],
      ctx.waToken, ctx.phoneNumberId);
  }
  await upsertConversation(ctx.tenant.id, ctx.from, ctx.history || [], ctx.cart);
}

module.exports = {
  handle,
  WELCOME_BODY,
  WELCOME_ROW, WELCOME_BTN,
  GREETING_RE,
  FABRIC_ROW, FABRIC_HANDLES, FABRIC_LABEL, FABRIC_VOICE, FABRIC_BTN,
  COLOUR_ROW, COLOUR_LABEL, COLOUR_KEYWORDS, COLOUR_VOICE, COLOUR_BTN,
  PRODUCT_BTN, PRODUCT_LIST_ROW,
  ADDON_VARIANT, ADDON_PRICE, ADDON_ROW, CART_BTN,
  CHECKOUT_STEP, CHECKOUT_BTN, CHECKOUT_PROMPT,
  POSTPURCHASE_BTN,
  handleStylistRequest,
  handleStylingHelp,
  STYLING_SYSTEM_PROMPT,
  SHIPPING_FREE_THRESHOLD, SHIPPING_FEE,
  formatCartSummary, formatOrderSummary, calcShipping,
  validateCheckoutField, generateOrderId,
  variantMatchesColour, filterProductsByColour,
};


// ─── Coupon entry helpers (added by 6-item batch) ──────────────────────────

async function handleApplyCouponPrompt(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    "Type your coupon code below, or tap *Continue to checkout* to proceed without one.",
    waToken, phoneNumberId);
  await sendButtons(from, 'Or:', ['Continue to checkout'], waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee coupon_prompt]' },
  ], {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      awaitingCoupon: true,
    },
  });
}

async function handleCouponMessage(ctx, code) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const trimmedCode = String(code || '').trim();

  // Skip path — matches 'Skip' (legacy) or 'Continue to checkout' (PDF v1.1 button)
  if (/^skip$/i.test(trimmedCode) || /^continue to checkout$/i.test(trimmedCode)) {
    await sendMessage(from, "No problem — continuing without a coupon.", waToken, phoneNumberId);
    const updatedCart = { ...cart, rajathee: { ...(cart.rajathee || {}) } };
    delete updatedCart.rajathee.awaitingCoupon;
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee coupon_skipped]' },
    ], updatedCart);
    await handleViewCart({ ...ctx, cart: updatedCart });
    return;
  }

  // Shape validation — reject loudly instead of silently sanitising. Without
  // this, an address pasted by mistake (e.g. "Poorva Konde Deshmukh, ...")
  // would be stripped to "POORVAKONDEDESHMUKH..." and stored as a "valid"
  // discount code. The reported live-order bug.
  if (trimmedCode.length > 20) {
    await sendMessage(from,
      "Coupon codes are usually short — please type just the code, or tap *Continue to checkout* to skip.",
      waToken, phoneNumberId);
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmedCode)) {
    await sendMessage(from,
      "That doesn't look like a coupon code (no spaces or punctuation). Try again or tap *Continue to checkout*.",
      waToken, phoneNumberId);
    return;
  }

  // Already shape-validated — uppercase is now safe.
  const cleanCode = trimmedCode.toUpperCase();

  const updatedCart = {
    ...cart,
    rajathee: {
      ...(cart.rajathee || {}),
      discountCode: cleanCode,
    },
  };
  delete updatedCart.rajathee.awaitingCoupon;

  await sendMessage(from,
    `Coupon *${cleanCode}* noted. We'll apply it at checkout — if it's not valid, we'll let you know.`,
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[rajathee coupon_set=' + cleanCode + ']' },
  ], updatedCart);

  await handleViewCart({ ...ctx, cart: updatedCart });
}


// ─── Bulk customer details parser (Claude-based, added by 6-item batch) ────

async function tryParseBulkDetails(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const checkout = cart.rajathee?.checkout;
  if (!checkout || checkout.step !== CHECKOUT_STEP.NAME) return 'CONTINUE';

  const msg = (text || '').trim();
  // Only attempt bulk parse if message looks substantial (likely contains address)
  // Heuristic: must have at least 20 chars and contain a 6-digit number (pincode)
  if (msg.length < 20 || !/\d{6}/.test(msg)) return 'CONTINUE';

  if (!process.env.ANTHROPIC_API_KEY) return 'CONTINUE';

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const sys =
      "Extract the customer's shipping details from their message. " +
      "Reply with ONLY a JSON object, no other text, in this exact format: " +
      '{"name":"...","address1":"...","city":"...","state":"...","pin":"......"}. ' +
      "If any field is missing or unclear, set it to null. " +
      "name = full name; address1 = house/flat/street/area (not city); " +
      "city = city name only; state = Indian state name; pin = 6-digit pincode as string.";

    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: sys,
      messages: [{ role: 'user', content: msg }],
    });
    const raw = (r.content[0]?.text || '').trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return 'CONTINUE'; }

    const { name, address1, city, state, pin } = parsed || {};
    // All five must be present for bulk-fill to succeed
    if (!name || !address1 || !city || !state || !pin) {
      console.log('[rajathee bulk-parse] incomplete:', parsed);
      return 'CONTINUE';
    }
    const pinClean = String(pin).replace(/\D/g, '');
    if (pinClean.length !== 6) return 'CONTINUE';
    if (String(name).trim().length < 2) return 'CONTINUE';

    // Write all fields, advance to confirm step.
    const updatedCart = {
      ...cart,
      rajathee: {
        ...(cart.rajathee || {}),
        checkout: {
          ...checkout,
          name: String(name).trim(),
          address1: String(address1).trim(),
          city: String(city).trim(),
          state: String(state).trim(),
          pin: pinClean,
          step: CHECKOUT_STEP.REVIEW,
        },
      },
    };

    await sendMessage(from,
      `Got it — confirming:\n\n*${name}*\n${address1}\n${city}, ${state} - ${pinClean}`,
      waToken, phoneNumberId);

    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee bulk_details_parsed]' },
    ], updatedCart);

    // Show order summary + confirm/cancel.
    await sendCheckoutReview({ ...ctx, cart: updatedCart });
    return 'PARSED';
  } catch (e) {
    console.error('[rajathee bulk-parse] error:', e.message);
    return 'CONTINUE';
  }
}


// ─── ORDER NUMBER DETECTION (Exchange/Track handoff) ───────────────────────
// Catches customer-typed order numbers like "#1002", "order 1002", "order number #1002".
// Hands off to Nikita + Apurv via pingTeam; bot does not attempt exchange logic itself.

const ORDER_NUMBER_RE = /(?:^|\s)(?:order\s*(?:number|num|id|no\.?|#)?\s*[-:#]*\s*|#)(\d{3,7})\b/i;

function detectOrderNumber(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(ORDER_NUMBER_RE);
  return m ? m[1] : null;
}

async function handleOrderInquiry(ctx, orderNumber) {
  const { from, phoneNumberId, waToken } = ctx;

  // 1. Acknowledge to customer.
  await sendMessage(from,
    `Got it! I've shared your order *#${orderNumber}* with our team 💛\n\n` +
    `Nikita will reach out within a few hours to help you with exchange or any other request.\n\n` +
    `In the meantime, feel free to ask me anything else.`,
    waToken, phoneNumberId);

  // 2. Alert Nikita + Apurv.
  const alert =
    '🔄 *RAJATHEE — ORDER INQUIRY*\n\n' +
    '*Order*: #' + orderNumber + '\n' +
    '*Customer Phone*: +' + from + '\n\n' +
    'Customer messaged about this order on WhatsApp. Likely exchange/return/track request.\n' +
    'Please look up the order in Shopify and reach out to the customer.';

  await pingTeam(ctx, 'ops', alert, {
    sosType: 'ORDER INQUIRY',
    summary: `Order inquiry #${orderNumber} from +${from}`,
  });
}

// ─── C.12 BROWSE NUDGES — schedule 15m + 30m follow-ups on product view ───
// Called every time sendProductDetail renders a product. Idempotent — db
// cancels the prior pending nudge of the same kind before inserting a new one.
async function scheduleBrowseNudges(tenantId, customerPhone, productTitle) {
  const now = new Date();
  const at15 = new Date(now.getTime() + 15 * 60 * 1000);
  const at30 = new Date(now.getTime() + 30 * 60 * 1000);
  const payload = { productTitle };
  await scheduleNudge(tenantId, customerPhone, 'rajathee_browse_15m', at15, payload);
  await scheduleNudge(tenantId, customerPhone, 'rajathee_browse_30m', at30, payload);
}
// browse nudge deploy Fri Jun 12 10:15:09 IST 2026
