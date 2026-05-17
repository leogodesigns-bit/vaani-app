// handlers/woofparade.js
// Woof Parade × Vaani flow — implements Woof_Parade_Vaani_Flow_v1.4.pdf verbatim.
// Bot persona: Rio (golden retriever co-founder). Sub-persona: Biscuit (when customer's pup is also named Rio).
//
// Scenarios covered (all 37):
//   Section 1 (Entry):       S01 CTA, S02 Custom Order form arrival, S03 Returning customer (A/A.1/B/C), S04 random/hi
//   Section 2 (Browse):      S05 category browse, S06 product pick + size, S07 sizing help (3 outcomes + reminder + hooman)
//   Section 3 (Checkout):    S08 cross-sell, S09 checkout w/ discount stacking, S10 COD path, S11 Pay now path
//   Section 4 (Custom):      S12 custom order in WhatsApp (form vs chat branches)
//   Section 5 (Edge):        S13 OOS, S14 silence nudges + pup-named-Rio = Biscuit, S15 payment-link unpaid, S16 talk to human,
//                            S17 delivery/policy/sale Q&A, S18 refund SOS, S19 stop/unsubscribe, S20 international opt-in,
//                            S21 wholesale SOS, S22 press SOS, S23 multi-pup, S24 cat owner, S25 Hindi/Marathi,
//                            S26 discount pressure 3-strike, S27 random text, S28 abusive 2-strike block
//   Section 5.5 (Founder):   Kashmira commands: pause/extend/resume bot, stats today/week/month, show chat, last 5 chats,
//                            flag/unflag/priority, note, mark paid, test mode, broadcast
//   Section 6 (Post-purchase): S29 ₹10k+ alert, S30 pup profile (A/B/C), S31 photo permission
//   Section 6.3 (Order ops): S32 tracking (4 branches), S33 modification, S34 address change, S35 pincode serviceability,
//                            S36 paid elsewhere UPI, S37 rage-quit 3-strike

const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
const { getConversation, upsertConversation, saveOrder, getOrder, markOrderPaid } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const edge = require('./woofparade-edge');
const qa = require('./woofparade-qa');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { getCollectionProducts, getProductByHandle, formatPrice, stripHtml } = require('../shopify');
const { getTenantSettings } = require('../settings-cache');

// ─── BRAND CONSTANTS ──────────────────────────────────────────────────────

const BRAND_NAME = 'Woof Parade';
const DEFAULT_BOT_NAME = 'Rio';     // golden retriever co-founder
const ALT_BOT_NAME     = 'Biscuit'; // sub-persona when customer's pup is also named Rio
const ORDER_PREFIX = 'WOOF';        // WOOF-XXXXXX-XXX
const PAW = '🐾';

const GREETING_RE = edge.GREETING_RE;

// ─── WELCOME (S01, S04) ────────────────────────────────────────────────────

const WELCOME_BTN = {
  VIEW_CATEGORIES: 'View categories',
  CUSTOM_FIT:      'Custom Fit',
  ORDER_HELP:      'Order help',
};

const WELCOME_ROW = {
  CASUAL:      'cat_casual',
  FESTIVE:     'cat_festive',
  ACCESSORIES: 'cat_accessories',
  IPL:         'cat_ipl',
  CUSTOM:      'cat_custom',
  BESTSELLERS: 'cat_bestsellers',
};

// Shopify collection handles for the 5 catalogue categories.
// Founder review: confirm these match thewoofparade.com handles.
const CATEGORY_HANDLES = {
  [WELCOME_ROW.CASUAL]:      'pet-clothes',           // S05 PDF example
  [WELCOME_ROW.FESTIVE]:     'festive-fits',
  [WELCOME_ROW.ACCESSORIES]: 'toys-accessories',
  [WELCOME_ROW.IPL]:         'jerseys-for-dogs-and-cats',
  [WELCOME_ROW.BESTSELLERS]: 'bestsellers',
  // CUSTOM is handled inline (S12 flow), not a Shopify collection.
};

const CATEGORY_LABEL = {
  [WELCOME_ROW.CASUAL]:      'Casual Wear',
  [WELCOME_ROW.FESTIVE]:     'Festive Wear',
  [WELCOME_ROW.ACCESSORIES]: 'Accessories',
  [WELCOME_ROW.IPL]:         'IPL Jerseys',
  [WELCOME_ROW.CUSTOM]:      'Custom Fit',
  [WELCOME_ROW.BESTSELLERS]: 'Bestsellers',
};

// ─── PRODUCT CARD / DETAIL BUTTONS ────────────────────────────────────────

const PRODUCT_BTN = {
  SHOW_3_MORE:    'Show 3 more',
  BACK_TO_MENU:   'Back to menu',
  BACK:           'Back',
  ADD_S:    'XS', ADD_S2: 'S', ADD_M: 'M',
  ADD_L:    'L',  ADD_XL: 'XL', ADD_2XL: '2XL',
  HELP_SIZING:    'Need help sizing',
};

// Jersey sizes per memory: XS, S, M, L, XL, 2XL.
const ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

const PICKED_BTN = {
  ACCESSORIES:    'Our accessories',
  CONTINUE:       'Continue this section',
  CHECKOUT:       'Checkout',
};

// ─── SIZING (S07) ──────────────────────────────────────────────────────────

const SIZE_BTN = {
  YES_HAVE:     'Yes, I have them',
  REMIND:       'No, remind me later',
  HOOMAN:       'Talk to my hooman',
  // Outcome 1 (clean match) — built dynamically
  // Outcome 2 (borderline) — built dynamically
  YES_CUSTOM:   'Yes, custom-make',
  TALK_DESIGNER:'Talk to designer first',
  IN_2_HOURS:   'In 2 hours',
  TOMORROW:     'Tomorrow morning',
  PICK_TIME:    'Pick a time',
  HERE_THEY_ARE:'Yes, here they are',
  STILL_NEED:   'Still need time',
  SKIP_BROWSE:  'Skip, browse instead',
};

// Reasonable defaults for the size chart — used in S07 if no founder data set.
// Founder review: confirm against actual Woof Parade size chart.
const SIZE_CHART = [
  // size, back_min, back_max, chest_min, chest_max, neck_min, neck_max
  { size: 'XS',  back: [8,  11], chest: [12, 14], neck: [8,  10] },
  { size: 'S',   back: [11, 14], chest: [14, 17], neck: [10, 12] },
  { size: 'M',   back: [14, 18], chest: [17, 20], neck: [12, 14] },
  { size: 'L',   back: [18, 22], chest: [20, 24], neck: [14, 17] },
  { size: 'XL',  back: [22, 26], chest: [24, 28], neck: [17, 20] },
  { size: '2XL', back: [26, 30], chest: [28, 32], neck: [20, 23] },
];

// ─── CHECKOUT (S10, S11) ───────────────────────────────────────────────────

const CHECKOUT_BTN = {
  PAY_NOW:        'Pay now',
  EDIT_CART:      'Edit shortlist',
  COD:            'Cash on delivery',
  CONFIRM:        'Confirm order',
  CANCEL:         'Cancel checkout',
  EDIT_ADDR:      'Edit address',
};

const CHECKOUT_STEP = {
  COLLECT:   'collect',   // one-shot collection of all 5 fields
  REVIEW:    'review',
  CONFIRMED: 'confirmed',
};

const ADDRESS_PROMPT =
  // S10 PDF v1.4: "Sure! I'll need a delivery address..."
  `Sure! I'll need a delivery address.\n\n` +
  `Could you share:\n` +
  `1. Full name\n` +
  `2. Address (house/flat, street, area)\n` +
  `3. City + State\n` +
  `4. PIN code\n` +
  `5. Alternate phone (different from WhatsApp, optional)`;

// Shipping (PDF S17: free on ₹899+).
const SHIPPING_FREE_THRESHOLD = 899;
const SHIPPING_FEE = 99;

// Discount stacking (PDF S09).
const WOOF15_PERCENT = 15;       // secret code
const FESTIVAL_B1_PERCENT = 15;  // Buy 1 Get 15%
const FESTIVAL_B2_PERCENT = 20;  // Buy 2+ Get 20%
// Set to false in env (FESTIVAL_SALE_ON=0) to disable festival sale globally.
const FESTIVAL_SALE_ON = process.env.FESTIVAL_SALE_ON !== '0';

// PDF S29 high-value threshold.
const HIGH_VALUE_THRESHOLD = 10000;

// ─── POST-PURCHASE (S30, S31) ──────────────────────────────────────────────

const POSTPURCHASE_BTN = {
  TRACK:        'Track order',
  BROWSE_MORE:  'Browse more',
  YES_MOCHI:    "Yes, it's for them",   // S30 branch B (text dynamically subbed)
  NEW_ADDITION: 'New addition 🐾',
  SKIP:         'Skip',
  YES_FEATURE:  'Yes, please feature',
  JUST_REVIEW:  'Just for the review',
  MAYBE_LATER:  'Maybe later',
  ADD_NOW:      'Add now',
  SHARE_PHOTO:  'Share photo',
  LEAVE_REVIEW: 'Leave review',
};

// ─── ORDER OPS (S32–S37) ───────────────────────────────────────────────────

const ORDER_OPS_BTN = {
  YES_TALK_APURV: 'Yes, talk to Apurv',
  NO_WAIT:        "No, I'll wait",
  YES_NEW_PIN:    "Yes, that's right",
  FIX_THIS:       'Wait, fix this',
  YES_PAYMENT:    'Yes, send payment link',
  CANCEL_ORDER:   'Cancel order',
  YES_WHATSAPP:   'Yes, WhatsApp me',
  NO_THANKS:      'No thanks',
  NOTIFY_BACK:    'Notify me when back',
};

// ─── DISCOUNT NUDGES & EDGE COPY (S14, S15) ────────────────────────────────

const NUDGE_BTN = {
  SHOW_GOODS:   'Show me the goods',
  CART_BACK:    'Bring my cart back',
  CHECKOUT_NOW: 'Checkout now',
};

// ─── TEAM ROUTING (env-driven) ─────────────────────────────────────────────
// All placeholders until Kashmira confirms numbers. When unset, alerts go to console only.
const APURV_PHONE     = process.env.APURV_PHONE     || null; // ops, sizing, COD, refunds, tracking, mods, address, paid-elsewhere, frustration, discount-x3
const ANOUTTAMA_PHONE = process.env.ANOUTTAMA_PHONE || null; // custom design lead (S02, S12)
const KASHMIRA_PHONE  = process.env.KASHMIRA_PHONE  || null; // founder line + SOS escalation + founder commands

// Press email (S22) — TBC per PDF Section 7.
const PRESS_EMAIL = process.env.WOOFPARADE_PRESS_EMAIL || 'hello@thewoofparade.com';

// Pagination.
const PAGE_SIZE = 3;
const MAX_PRODUCTS_PER_CAT = 12;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────

async function handle(ctx) {
  const { tenant, message, from, text } = ctx;

  if (tenant.flow_template !== 'woofparade') {
    console.error(
      `❌ woofparade.handle called for wrong tenant: ${tenant.shop_domain} ` +
      `(flow_template=${tenant.flow_template})`
    );
    return;
  }

  console.log(`[woofparade] ${tenant.shop_domain} — from ${from}: ${text}`);

  const listReplyId   = message.interactive?.list_reply?.id || null;
  const buttonReplyId = message.interactive?.button_reply?.id || null;
  const trimmed = (text || '').trim();
  const isInteractive = !!(listReplyId || buttonReplyId);

  // ─── FOUNDER COMMANDS (Kashmira's number only, S5.5) ─────────────────────
  if (KASHMIRA_PHONE && from === KASHMIRA_PHONE) {
    const handled = await tryFounderCommand(ctx, trimmed);
    if (handled) return;
  }

  // ─── OWNER CONFIRM COMMAND (Apurv or Kashmira) — S36 mark paid ──────────
  // Format: "confirmed WOOF-XXXXXX-XXX" or "mark paid WOOF-XXXXXX-XXX"
  if ((APURV_PHONE && from === APURV_PHONE) || (KASHMIRA_PHONE && from === KASHMIRA_PHONE)) {
    const m = trimmed.match(/^(confirmed|mark paid)\s+(WOOF-\d{6}-[A-Z0-9]{3})\s*$/i);
    if (m) {
      await handleOwnerConfirmCommand(ctx, m[2].toUpperCase());
      return;
    }
  }

  // ─── TEST MODE (Kashmira only) — S5.5 ────────────────────────────────────
  // When test mode is on for Kashmira's number, she chats as a customer
  // but no team handoffs trigger and stats don't count.
  // Implemented as a tenant-wide flag in cart for her conversation only.
  // (Real customer chats are unaffected.)
  const inTestMode = ctx.cart?.woofparade?.testMode === true && KASHMIRA_PHONE && from === KASHMIRA_PHONE;
  ctx.testMode = inTestMode;

  // ─── PAUSE BOT (S5.5) — global flag, all customers silently ignored ─────
  // Pause state stored in tenant-scoped key in DB cart row keyed to Kashmira's phone.
  if (await isBotPaused(tenant.id)) {
    if (KASHMIRA_PHONE && from === KASHMIRA_PHONE) {
      // Still respond to Kashmira so she can run resume.
    } else {
      console.log(`[woofparade] bot paused — ignoring ${from}`);
      return;
    }
  }

  // ─── NON-TEXT MESSAGE ────────────────────────────────────────────────────
  if (edge.isNonTextMessage(message)) {
    // PDF S03 Branch A.1: image from a returning customer = potential review photo → S31 flow.
    if (message.type === 'image' && await hasPurchasedBefore(ctx)) {
      await handlePhotoFromCustomer(ctx);
      return;
    }
    await edge.sendNonTextAck(ctx);
    await sendWelcome(ctx);
    return;
  }

  // ─── ABUSIVE / SPAM (S28) ────────────────────────────────────────────────
  if (edge.isAbusiveMessage(trimmed)) {
    await handleAbusive(ctx);
    return;
  }

  // ─── BLOCKED FLAG (S28 second strike, persisted) ─────────────────────────
  if (ctx.cart?.woofparade?.blocked === true) {
    console.log(`[woofparade] blocked ${from} — ignoring: ${trimmed}`);
    return;
  }

  // ─── MUTE (S27 / S28 first strike) ───────────────────────────────────────
  const isMuted = ctx.cart?.woofparade?.muted === true;
  if (isMuted) {
    if (isInteractive || qa.isDogRelated(trimmed)) {
      ctx.cart = ctx.cart || {};
      ctx.cart.woofparade = ctx.cart.woofparade || {};
      delete ctx.cart.woofparade.muted;
      delete ctx.cart.woofparade.offTopicCount;
      console.log(`[woofparade] unmuted ${from}`);
    } else {
      console.log(`[woofparade] muted ${from} — ignoring: ${trimmed}`);
      return;
    }
  }

  // ─── STOP / UNSUBSCRIBE (S19) ────────────────────────────────────────────
  if (/^(stop|unsubscribe|stop all|don'?t message me)\s*[!.]?$/i.test(trimmed)) {
    await handleStopUnsubscribe(ctx);
    return;
  }

  // ─── RESUME AFTER STOP — any new interactive message wakes them up ──────
  if (ctx.cart?.woofparade?.unsubscribed === true) {
    ctx.cart = ctx.cart || {};
    ctx.cart.woofparade = ctx.cart.woofparade || {};
    delete ctx.cart.woofparade.unsubscribed;
    console.log(`[woofparade] re-engaged ${from} after unsubscribe`);
  }

  // ─── TALK TO HUMAN (S16) ─────────────────────────────────────────────────
  if (edge.isHumanKeyword(trimmed) || trimmed === 'Talk to Apurv' || trimmed === 'Talk to human') {
    await handleTalkToHuman(ctx);
    return;
  }

  // ─── FRUSTRATION TRACKING (S37) ──────────────────────────────────────────
  if (edge.isFrustrationMessage(trimmed)) {
    const f = (ctx.cart?.woofparade?.frustrationCount || 0) + 1;
    ctx.cart = ctx.cart || {}; ctx.cart.woofparade = ctx.cart.woofparade || {};
    ctx.cart.woofparade.frustrationCount = f;
    if (f >= 2) {
      await handleRageQuit(ctx);
      return;
    }
  }

  // ─── CHECKOUT FREE-TEXT INPUT (collecting address) ───────────────────────
  const checkoutState = ctx.cart?.woofparade?.checkout;
  if (checkoutState && checkoutState.step === CHECKOUT_STEP.COLLECT && !isInteractive) {
    await handleAddressMessage(ctx);
    return;
  }

  // ─── SIZING FREE-TEXT INPUT ──────────────────────────────────────────────
  if (ctx.cart?.woofparade?.sizing?.awaitingMeasurements && !isInteractive) {
    await handleMeasurementsMessage(ctx);
    return;
  }

  // ─── CUSTOM ORDER FREE-TEXT (S12 Branch B step 2) ────────────────────────
  if (ctx.cart?.woofparade?.custom?.awaitingMeasurements && !isInteractive) {
    await handleCustomMeasurementsMessage(ctx);
    return;
  }
  if (ctx.cart?.woofparade?.custom?.awaitingPupName && !isInteractive) {
    await handleCustomPupNameMessage(ctx);
    return;
  }

  // ─── POST-PURCHASE PUP PROFILE FREE-TEXT (S30) ───────────────────────────
  if (ctx.cart?.woofparade?.pupProfile?.awaitingPupDetails && !isInteractive) {
    await handlePupProfileMessage(ctx);
    return;
  }

  // ─── ORDER MODIFICATION / ADDRESS CHANGE / UPI-PAID FREE-TEXT ────────────
  if (ctx.cart?.woofparade?.orderOps?.awaitingMod && !isInteractive) {
    await handleOrderModMessage(ctx);
    return;
  }
  if (ctx.cart?.woofparade?.orderOps?.awaitingAddrChange && !isInteractive) {
    await handleAddressChangeMessage(ctx);
    return;
  }
  if (ctx.cart?.woofparade?.orderOps?.awaitingUpiProof && !isInteractive) {
    await handleUpiPaidMessage(ctx);
    return;
  }

  // ─── S01 CTA AUTO-MESSAGE — "Make my Pet look like a Showstopper!" ──────
  if (edge.SHOWSTOPPER_CTA_RE.test(trimmed)) {
    await sendShowstopperWelcome(ctx);
    return;
  }

  // ─── S02 CUSTOM ORDER FORM AUTO-MESSAGE detection ───────────────────────
  // Website prepends a distinctive marker. Look for "custom order" + measurements.
  if (/custom order/i.test(trimmed) && /(back|chest|neck)\s*[:=]/i.test(trimmed)) {
    await handleCustomOrderFromWebsite(ctx);
    return;
  }

  // ─── INTERACTIVE TAP DISPATCH ────────────────────────────────────────────

  // Welcome / category list rows
  if (listReplyId && CATEGORY_HANDLES[listReplyId]) {
    await sendCategoryResults(ctx, listReplyId, 0);
    return;
  }
  if (listReplyId === WELCOME_ROW.CUSTOM || trimmed === 'Custom Fit') {
    await handleCustomFitStart(ctx);
    return;
  }
  if (trimmed === 'Chat it through' || trimmed === 'Chat it through with me') {
    await handleCustomChatStart(ctx);
    return;
  }
  if (trimmed === 'Use website form' || trimmed === 'Fill the form') {
    await sendMessage(ctx.from,
      `Pawfect — here's the link ${PAW}\nhttps://thewoofparade.com/pages/custom-order\n\nOnce you submit, I'll pick it up here and Anouttama will reach out shortly.`,
      ctx.waToken, ctx.phoneNumberId);
    return;
  }
  // Custom fabric pick (S12 Branch B step 3)
  if (listReplyId && listReplyId.startsWith('fabric_')) {
    const fabric = listReplyId.replace('fabric_', '');
    await sendMessage(ctx.from,
      `Perfect ${PAW} *${fabric}* it is. Anouttama will share swatches and the final quote within a day.`,
      ctx.waToken, ctx.phoneNumberId);
    await pingTeam(ctx, 'designer',
      `🎨 Fabric chosen: *${fabric}* by +${from} for their custom order.`);
    return;
  }
  if (trimmed === WELCOME_BTN.VIEW_CATEGORIES || trimmed === 'View categories') {
    await sendWelcome(ctx);
    return;
  }
  if (trimmed === WELCOME_BTN.ORDER_HELP || trimmed === 'Order help') {
    await sendOrderHelpMenu(ctx);
    return;
  }
  if (trimmed === 'Just saying hi 🧡' || /^just saying hi/i.test(trimmed)) {
    await sendMessage(from, "Aww — hi back 🐾 If you want to peek around, tap below.", ctx.waToken, ctx.phoneNumberId);
    await sendWelcome(ctx);
    return;
  }
  if (trimmed === 'Continue where I left off' || listReplyId === 'continue_where_left_off') {
    await handleContinueWhereLeftOff(ctx);
    return;
  }
  if (trimmed === 'Browse fresh') {
    await sendWelcome(ctx);
    return;
  }

  // Product picker rows (numbered list under category carousel)
  if (listReplyId && listReplyId.startsWith('product_') && !listReplyId.startsWith('product_size_')) {
    const handle = listReplyId.replace(/^product_/, '');
    await sendProductDetail(ctx, handle);
    return;
  }

  // Size button taps after product detail
  if (ALL_SIZES.includes(trimmed)) {
    await handleSizePick(ctx, trimmed);
    return;
  }
  if (trimmed === PRODUCT_BTN.HELP_SIZING || trimmed === 'Help me sizing') {
    await handleSizingHelpStart(ctx);
    return;
  }
  if (trimmed === SIZE_BTN.YES_HAVE) {
    await handleSizingHaveMeasurements(ctx);
    return;
  }
  if (trimmed === SIZE_BTN.REMIND || trimmed === 'In 2 hours' || trimmed === 'Tomorrow morning' || trimmed === 'Pick a time') {
    await handleSizingRemind(ctx, trimmed);
    return;
  }
  if (trimmed === SIZE_BTN.HOOMAN) {
    await handleTalkToHuman(ctx, 'sizing');
    return;
  }
  if (trimmed === SIZE_BTN.YES_CUSTOM) {
    await handleCustomFitStart(ctx);
    return;
  }
  if (trimmed === SIZE_BTN.TALK_DESIGNER) {
    await handleTalkToDesigner(ctx);
    return;
  }
  if (/^Add (XS|S|M|L|XL|2XL)$/i.test(trimmed)) {
    const sz = trimmed.replace(/^Add\s+/i, '').toUpperCase();
    await handleSizePick(ctx, sz);
    return;
  }

  // Cross-sell
  if (trimmed === PICKED_BTN.ACCESSORIES) {
    await handleCrossSell(ctx);
    return;
  }
  if (trimmed === PICKED_BTN.CONTINUE) {
    await handleContinueSection(ctx);
    return;
  }
  if (trimmed === PICKED_BTN.CHECKOUT || trimmed === 'Checkout' || trimmed === 'Checkout now' || trimmed === CHECKOUT_BTN.PAY_NOW) {
    await handleCheckout(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.COD || trimmed === 'Cash on delivery') {
    await handleCheckoutCOD(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.EDIT_CART || trimmed === 'Edit shortlist') {
    await handleEditShortlist(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.CONFIRM) {
    await handleCheckoutConfirm(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.CANCEL) {
    await handleCheckoutCancel(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.EDIT_ADDR) {
    await handleCheckoutEditAddr(ctx);
    return;
  }

  // Show 3 more / pagination
  if (trimmed === PRODUCT_BTN.SHOW_3_MORE || trimmed === 'Show 3 more') {
    await handleShow3More(ctx);
    return;
  }
  if (trimmed === PRODUCT_BTN.BACK_TO_MENU || trimmed === 'Back to menu' || trimmed === 'Back') {
    await sendWelcome(ctx);
    return;
  }

  // Order help submenu
  if (trimmed === 'Track order' || trimmed === POSTPURCHASE_BTN.TRACK || /^where('?s| is) my order/i.test(trimmed) || /^tracking/i.test(trimmed)) {
    await handleTrackOrder(ctx);
    return;
  }
  if (trimmed === 'Modify order' || /\b(change|modify|swap|remove|add).*(order|item|size)\b/i.test(trimmed) || /^wrong size/i.test(trimmed)) {
    await handleModifyOrderStart(ctx);
    return;
  }
  if (trimmed === 'Change address' || /\b(change|update|wrong).*address/i.test(trimmed) || /\b(gave|sent).*(wrong|incorrect).*(address|pin)\b/i.test(trimmed)) {
    await handleAddressChangeStart(ctx);
    return;
  }
  if (/^i paid/i.test(trimmed) || /\b(paid via upi|sent the money|direct transfer|paid you)\b/i.test(trimmed) || trimmed === 'I paid via UPI') {
    await handleUpiPaidStart(ctx);
    return;
  }

  // S35 — direct pincode question
  if (/^(do you )?deliver to \d{6}\??$/i.test(trimmed) || /^\d{6}$/.test(trimmed) && ctx.cart?.woofparade?.awaitingPincode) {
    await handlePincodeCheck(ctx, trimmed.match(/\d{6}/)[0]);
    return;
  }

  // S13 — Notify when back in stock
  if (trimmed === ORDER_OPS_BTN.NOTIFY_BACK || trimmed === 'Notify me when back') {
    await handleNotifyMeBack(ctx);
    return;
  }

  // S20 — international opt-in
  if (/\b(ship|deliver|order|send).*(uk|usa|america|uae|canada|australia|singapore|international|overseas|abroad)\b/i.test(trimmed)) {
    await handleInternationalRequest(ctx);
    return;
  }
  if (trimmed === ORDER_OPS_BTN.YES_WHATSAPP) {
    await handleInternationalOptIn(ctx);
    return;
  }
  if (trimmed === ORDER_OPS_BTN.NO_THANKS) {
    await sendMessage(ctx.from, "All good 🐾 If you change your mind, just message me.", ctx.waToken, ctx.phoneNumberId);
    return;
  }

  // S21 — wholesale / bulk
  if (/\b(bulk|wholesale|pet store|retail|reseller|distributor|quantity discount|how many.*minimum)\b/i.test(trimmed)) {
    await handleBulkInquiry(ctx);
    return;
  }

  // S22 — press / collab
  if (/\b(journalist|press|collab|collaboration|influencer|brand partnership|feature.*magazine|interview)\b/i.test(trimmed)) {
    await handlePressInquiry(ctx);
    return;
  }

  // S18 — refund / complaint
  if (/\b(refund|complain|complaint|not happy|disappointed|wrong (item|product|size)|defective|damaged|torn|doesn'?t fit|too (tight|loose|small|big))\b/i.test(trimmed)) {
    await handleRefundComplaint(ctx);
    return;
  }

  // S26 — discount pressure
  if (/\b(discount|cheaper|cheap|reduce.*price|price down|any (more )?offer|coupon|promo)\b/i.test(trimmed) ||
      /\b\d{2}%\s*(off|discount)\b/i.test(trimmed)) {
    await handleDiscountPressure(ctx);
    return;
  }

  // S29 / S31 — order help buttons
  if (trimmed === POSTPURCHASE_BTN.YES_FEATURE) { await handlePhotoPermission(ctx, 'granted'); return; }
  if (trimmed === POSTPURCHASE_BTN.JUST_REVIEW) { await handlePhotoPermission(ctx, 'declined'); return; }
  if (trimmed === POSTPURCHASE_BTN.MAYBE_LATER) { await handlePhotoPermission(ctx, 'pending'); return; }
  if (trimmed === POSTPURCHASE_BTN.NEW_ADDITION) { await handleNewPupAdd(ctx); return; }
  if (trimmed === POSTPURCHASE_BTN.SKIP) { await handlePupProfileSkip(ctx); return; }
  if (trimmed === POSTPURCHASE_BTN.ADD_NOW) { await handlePupProfileAddNow(ctx); return; }
  if (trimmed === POSTPURCHASE_BTN.SHARE_PHOTO) {
    await sendMessage(ctx.from, "Send the photo right here whenever you're ready 🐾", ctx.waToken, ctx.phoneNumberId);
    return;
  }
  if (trimmed === POSTPURCHASE_BTN.LEAVE_REVIEW) {
    await sendMessage(ctx.from, "You can drop a review here: https://thewoofparade.com/ 🐾", ctx.waToken, ctx.phoneNumberId);
    return;
  }
  if (trimmed === POSTPURCHASE_BTN.BROWSE_MORE) { await sendWelcome(ctx); return; }

  // S33/S34 order ops buttons
  if (trimmed === ORDER_OPS_BTN.YES_TALK_APURV) { await handleTalkToHuman(ctx, 'order-issue'); return; }
  if (trimmed === ORDER_OPS_BTN.NO_WAIT) {
    await sendMessage(ctx.from, "Got it — we'll wait 🐾 Message me anytime if you change your mind.", ctx.waToken, ctx.phoneNumberId);
    return;
  }

  // Pup-specific tags from S30 (e.g. "Mochi 🦮", "Bruno 🐶")
  if (listReplyId && listReplyId.startsWith('tag_pup_')) {
    const pupName = listReplyId.replace(/^tag_pup_/, '');
    await handleTagOrderToPup(ctx, pupName);
    return;
  }

  // ─── GREETING / FALLBACK ─────────────────────────────────────────────────
  if (GREETING_RE.test(trimmed)) {
    await sendWelcome(ctx);
    return;
  }

  // ─── BUILT-IN FAQ MATCH (S17 — delivery, exchange, sale, real person) ────
  const builtin = qa.matchBuiltinFaq(trimmed);
  if (builtin) {
    await sendMessage(from, builtin.a, ctx.waToken, ctx.phoneNumberId);
    if (builtin.q === 'realperson') {
      await sendButtons(from, 'Anything else?',
        ['Yes, talk to a human', "No, you're fine 🧡"],
        ctx.waToken, ctx.phoneNumberId);
    } else {
      await sendWelcome(ctx);
    }
    return;
  }
  if (trimmed === 'Yes, talk to a human') { await handleTalkToHuman(ctx); return; }
  if (trimmed === "No, you're fine 🧡" || trimmed === "No, you're fine") {
    await sendMessage(from, "Tail wags 🐾 Tap below to keep going.", ctx.waToken, ctx.phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  // ─── DASHBOARD FAQ MATCH ─────────────────────────────────────────────────
  console.log(`[woofparade] no handler for: ${trimmed} (listId=${listReplyId}, btnId=${buttonReplyId})`);
  if (trimmed && trimmed.length > 0) {
    const matched = await qa.matchFaq(trimmed, ctx.tenant.id);
    if (matched) {
      await qa.sendFaqMatch(ctx, matched);
      await sendWelcome(ctx);
      return;
    }

    // S27 random/off-topic — track. 1st = warning, 2nd = mute, 3rd = rage-quit handoff.
    ctx.cart = ctx.cart || {};
    ctx.cart.woofparade = ctx.cart.woofparade || {};
    const count = (ctx.cart.woofparade.offTopicCount || 0) + 1;
    ctx.cart.woofparade.offTopicCount = count;

    if (count === 1) {
      await qa.sendOffTopicWarning(ctx);
      await sendWelcome(ctx);
    } else if (count === 2) {
      ctx.cart.woofparade.muted = true;
      await qa.sendOffTopicMute(ctx);
      await upsertConversation(ctx.tenant.id, ctx.from, [
        ...(ctx.history || []),
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '[woofparade muted after 2 off-topic]' },
      ], ctx.cart);
    } else {
      // 3 strikes — S37 rage-quit to Apurv
      await handleRageQuit(ctx);
    }
    return;
  }

  await sendWelcome(ctx);
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — WELCOME, BROWSE, SIZING, CHECKOUT
// ════════════════════════════════════════════════════════════════════════════

async function sendShowstopperWelcome(ctx) {
  // S01 PDF v1.4: when customer taps "Make my pet a showstopper" CTA on website.
  // "Hey there! I'm Rio, the woofy face of Woof Parade 🐾 Showstopper mode activated — where shall we start?"
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const body =
    `Hey there! I'm ${getBotName(ctx)}, the woofy face of ${BRAND_NAME} ${PAW}\n` +
    `Showstopper mode activated — where shall we start?`;
  await sendList(from, body, [{
    title: 'View categories',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Daily outfits & kurtas' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Wear',    description: 'Sherwanis, lehengas, more' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, bowties' },
      { id: WELCOME_ROW.IPL,         title: 'IPL Jerseys',     description: 'Match-day fits for pups' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade S01 showstopper-cta welcome]' },
  ], cart);
}

async function sendReturningWelcome(ctx) {
  // S03 PDF v1.4 — three branches:
  //   A: purchased + pup name on file: "Welcome back, Mochi's parent! 🐾 How's Mochi doing in the Banarasi Lavender Kurta? ..."
  //   B: purchased + no pup name on file: "Welcome back 🐾 Hope your pup is doing well in the Banarasi Lavender Kurta!..."
  //   C: chatted but never purchased: "Welcome back 🐾 Last time you were checking out the X. Want to: [Continue where I left off]..."
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const last = await getLastOrderSummary(ctx);
  const pups = await getCustomerPupProfiles(ctx);
  const pupName = pups[0]?.pup_name || last?.pupName || null;
  const lastProduct = last?.productTitle || null;

  let body;
  if (pupName && lastProduct) {
    // Branch A
    body =
      `Welcome back, ${pupName}'s parent! ${PAW}\n` +
      `How's ${pupName} doing in the ${lastProduct}?\n\n` +
      `Looking for something new today, or need a hand with your last order?`;
  } else if (lastProduct) {
    // Branch B (purchased, no pup name)
    body =
      `Welcome back ${PAW}\n` +
      `Hope your pup is doing well in the ${lastProduct}!\n\n` +
      `Looking for something new today?`;
  } else {
    // Fallback when we know they purchased but can't pull product details
    body =
      `Welcome back ${PAW}\n` +
      `Looking for something new today, or need a hand with your last order?`;
  }

  await sendButtons(from, body,
    ['Browse fresh', 'Order help', 'Just saying hi 🧡'],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade S03 returning-welcome pup=${pupName||'-'} last=${lastProduct||'-'}]` },
  ], cart);
}

async function sendWelcome(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const purchased = await hasPurchasedBefore(ctx);

  let baseBody;
  try {
    const s = await getTenantSettings(tenant.id);
    if (s && s.welcome_message && s.welcome_message.trim()) {
      baseBody = s.welcome_message.trim();
    }
  } catch (e) {
    console.error('[woofparade sendWelcome] settings fetch failed:', e.message);
  }

  if (!baseBody) {
    if (purchased) {
      // S03: returning customer — branch on whether pup name is on file
      await sendReturningWelcome(ctx);
      return;
    } else {
      // S04 PDF v1.4: "Hey there! I'm Rio, Woof Parade's golden-furred greeter 🐾 What's your pup looking for today?"
      baseBody =
        `Hey there! I'm ${getBotName(ctx)}, ${BRAND_NAME}'s golden-furred greeter ${PAW}\n` +
        `What's your pup looking for today?`;
    }
  }

  await sendList(from, baseBody, [{
    title: 'Browse',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Daily outfits & kurtas' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Wear',    description: 'Sherwanis, lehengas, more' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, bowties' },
      { id: WELCOME_ROW.IPL,         title: 'IPL Jerseys',     description: 'Match-day fits for pups' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId);

  await sendButtons(from, 'Or:',
    [WELCOME_BTN.ORDER_HELP, 'Just saying hi 🧡'],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade welcome shown — returning=' + purchased + ']' },
  ], cart);
}

async function sendOrderHelpMenu(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendList(from, `What's up with your order? ${PAW}`, [{
    title: 'Order help',
    rows: [
      { id: 'orderhelp_track',  title: 'Track order',     description: 'Where is my order' },
      { id: 'orderhelp_modify', title: 'Modify order',    description: 'Change size, swap item' },
      { id: 'orderhelp_addr',   title: 'Change address',  description: 'Wrong/old address' },
      { id: 'orderhelp_paid',   title: 'I paid via UPI',  description: 'Direct payment confirmation' },
      { id: 'orderhelp_human',  title: 'Talk to Apurv',   description: 'Speak to our human team' },
    ],
  }], waToken, phoneNumberId);
}

async function sendCategoryResults(ctx, rowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const handle = CATEGORY_HANDLES[rowId];
  const label  = CATEGORY_LABEL[rowId];
  if (!handle) { await sendWelcome(ctx); return; }

  let productsRaw = [];
  try { productsRaw = await getCollectionProducts(tenant, handle); }
  catch (e) { console.error('[woofparade] collection fetch failed:', e.message); }
  const products = filterInStock(productsRaw);

  if (!products.length) {
    await sendMessage(from,
      `Hmm, our ${label} edit looks empty right now ${PAW} Try another category from the menu, or tap *Custom Fit* and we'll get something made.`,
      waToken, phoneNumberId);
    return;
  }

  const totalAvailable = Math.min(products.length, MAX_PRODUCTS_PER_CAT);
  const start = page * PAGE_SIZE;
  const slice = products.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    await sendMessage(from,
      `That's all I've got for ${label} ${PAW} Want to peek at another category?`,
      waToken, phoneNumberId);
    return;
  }

  for (const p of slice) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const caption = `${p.title}\n${price}`;
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from,
    `That's our top ${slice.length} in ${label} ${PAW}\nReply with the number to pick, or tap any link to view.`,
    waToken, phoneNumberId);

  await sendProductPickerList(ctx, slice);

  const totalShownAfter = Math.min((page + 1) * PAGE_SIZE, totalAvailable);
  const moreAvailable = totalShownAfter < totalAvailable;
  const buttons = moreAvailable
    ? [PRODUCT_BTN.SHOW_3_MORE, PRODUCT_BTN.BACK_TO_MENU]
    : [PRODUCT_BTN.BACK_TO_MENU];
  await sendButtons(from, 'Or:', buttons, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade cat=${rowId} page=${page} shown=${slice.length}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      browseMode: 'category',
      categoryRowId: rowId,
      page: page,
      totalShown: totalShownAfter,
      productHandles: products.slice(0, totalShownAfter).map(p => p.handle),
    },
  });
}

async function sendProductPickerList(ctx, products) {
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
  await sendList(from, `Tap any to see details ${PAW}`,
    [{ title: 'Pick a product', rows }],
    waToken, phoneNumberId);
}

async function handleShow3More(ctx) {
  const r = ctx.cart.woofparade || {};
  if (r.browseMode === 'category' && r.categoryRowId) {
    await sendCategoryResults(ctx, r.categoryRowId, (r.page || 0) + 1);
    return;
  }
  await sendWelcome(ctx);
}

async function sendProductDetail(ctx, productHandle) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  let product = null;
  try { product = await getProductByHandle(tenant, productHandle); }
  catch (e) { console.error('[woofparade] product fetch failed:', e.message); }

  if (!product) {
    await sendMessage(from, "Hmm, I couldn't find that one. Let me show you what we have.", waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  const images = (product.images || []).slice(0, 2);
  for (const img of images) {
    await sendImage(from, img.src, '', waToken, phoneNumberId);
  }

  const v0 = product.variants?.[0];
  const price = formatPrice(v0?.price);
  const desc = stripHtml(product.body_html || '').slice(0, 200).trim();
  const ellipsis = stripHtml(product.body_html || '').length > 200 ? '...' : '';
  await sendMessage(from,
    `*${product.title}* — ${price}\n\n${desc}${ellipsis}`,
    waToken, phoneNumberId);

  const sizesInStock = detectInStockSizes(product);

  if (sizesInStock.length === 0) {
    // S13 — fully OOS
    await sendMessage(from,
      `This one's sold out across all sizes right now ${PAW} ` +
      `Want me to notify you when it's back, or shall we look at something similar?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'What next?',
      [ORDER_OPS_BTN.NOTIFY_BACK, PRODUCT_BTN.BACK_TO_MENU, SIZE_BTN.YES_CUSTOM],
      waToken, phoneNumberId);
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[woofparade product_oos handle=${productHandle}]` },
    ], {
      ...cart,
      woofparade: { ...(cart.woofparade || {}), product: { handle: productHandle, oos: true } },
    });
    return;
  }

  const firstThree = sizesInStock.slice(0, 3);
  await sendButtons(from,
    `Available sizes: ${sizesInStock.join(', ')}\nTap a size to add to your shortlist:`,
    firstThree, waToken, phoneNumberId);

  if (sizesInStock.length > 3) {
    const nextThree = sizesInStock.slice(3, 6);
    await sendButtons(from, 'More sizes:', nextThree, waToken, phoneNumberId);
  }

  await sendButtons(from, 'Not sure of the size?',
    [PRODUCT_BTN.HELP_SIZING, PRODUCT_BTN.BACK],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade product_detail handle=${productHandle} sizes=${sizesInStock.join(',')}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      browseMode: 'product_detail',
      product: {
        handle: productHandle,
        title: product.title,
        price: parseFloat(v0?.price || 0),
        sizesInStock,
      },
    },
  });
}

function detectInStockSizes(product) {
  const variants = product.variants || [];
  const found = [];
  for (const sz of ALL_SIZES) {
    const match = variants.find(v => {
      if (v.available === false) return false;
      const opt = String(v.option1 || v.title || '').toUpperCase().trim();
      return opt === sz;
    });
    if (match) found.push(sz);
  }
  return found;
}

function filterInStock(products) {
  return (products || []).filter(p =>
    (p.variants || []).some(v => v.available !== false)
  );
}

async function handleSizePick(ctx, size) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.woofparade || {};
  const product = r.product;

  if (!product || !product.handle) {
    await sendMessage(from, `Pick a product first and then tap a size ${PAW}`, waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  let variantId = null;
  let variantPrice = product.price;
  try {
    const fetched = await getProductByHandle(tenant, product.handle);
    if (fetched) {
      const v = (fetched.variants || []).find(v => {
        const opt = String(v.option1 || v.title || '').toUpperCase().trim();
        return v.available !== false && opt === size;
      });
      if (v) { variantId = String(v.id); variantPrice = parseFloat(v.price) || product.price; }
    }
  } catch (e) { console.error('[woofparade] variant resolve failed:', e.message); }

  if (!variantId) {
    await sendMessage(from,
      `That size just went out of stock ${PAW} Pick another, or tap *Need help sizing*.`,
      waToken, phoneNumberId);
    return;
  }

  const items = Array.isArray(r.items) ? [...r.items] : [];
  items.push({
    kind: 'product',
    productHandle: product.handle,
    productTitle: product.title,
    variantId, size, price: variantPrice,
  });

  await sendMessage(from,
    `✅ Added *${product.title}* (${size}) to your shortlist ${PAW}`,
    waToken, phoneNumberId);

  await sendButtons(from, "Want to add some accessories or keep browsing?",
    [PICKED_BTN.ACCESSORIES, PICKED_BTN.CONTINUE, PICKED_BTN.CHECKOUT],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade size_added=${size} variant=${variantId}]` },
  ], { ...cart, woofparade: { ...r, items } });
}

async function handleCrossSell(ctx) {
  const { tenant, from, phoneNumberId, waToken } = ctx;
  let products = [];
  try { products = await getCollectionProducts(tenant, CATEGORY_HANDLES[WELCOME_ROW.ACCESSORIES]); }
  catch (e) { console.error('[woofparade] cross-sell fetch failed:', e.message); }
  const inStock = filterInStock(products).slice(0, 3);

  if (!inStock.length) {
    await sendMessage(from, `No accessories handy right now ${PAW} Let's checkout?`, waToken, phoneNumberId);
    await sendButtons(from, 'Or:',
      [PICKED_BTN.CHECKOUT, PICKED_BTN.CONTINUE, PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);
    return;
  }

  for (const p of inStock) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const caption = `${p.title}\n${price}`;
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from,
    `These pair nicely with what you've picked ${PAW} Tap any to see details.`,
    waToken, phoneNumberId);
  await sendProductPickerList(ctx, inStock);
  await sendButtons(from, 'Or:',
    [PICKED_BTN.CHECKOUT, PRODUCT_BTN.BACK_TO_MENU],
    waToken, phoneNumberId);
}

async function handleContinueSection(ctx) {
  const r = ctx.cart.woofparade || {};
  if (r.browseMode === 'category' && r.categoryRowId) {
    await sendCategoryResults(ctx, r.categoryRowId, r.page || 0);
    return;
  }
  await sendWelcome(ctx);
}

async function handleSizingHelpStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  // S07 PDF v1.4: "No stress — we'll get the fit just right 🐾 Do you have your pup's measurements handy?"
  await sendButtons(from,
    `No stress — we'll get the fit just right ${PAW}\nDo you have your pup's measurements handy?`,
    [SIZE_BTN.YES_HAVE, SIZE_BTN.REMIND, SIZE_BTN.HOOMAN],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade sizing_help_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), sizing: { step: 'asked_if_have', awaitingMeasurements: false } },
  });
}

async function handleSizingHaveMeasurements(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  // S07 PDF v1.4: ask for back/chest/neck only (armhole is custom-only — see S12)
  await sendMessage(from,
    `Here's our size chart ${PAW}\nTap to zoom in — measurements you'll need below.\n\n` +
    `Pop them in here:\n` +
    `• Back length (neck base to tail base)\n` +
    `• Chest (widest part behind front legs)\n` +
    `• Neck (around the base)\n\n` +
    `In inches please. Like:\n*Back 14, Chest 18, Neck 12*`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade sizing_awaiting_measurements]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), sizing: { step: 'awaiting', awaitingMeasurements: true } },
  });
}

async function handleSizingRemind(ctx, when) {
  const { from, phoneNumberId, waToken } = ctx;
  const note =
    when === 'In 2 hours' ? "Got it — I'll nudge you in 2 hours." :
    when === 'Tomorrow morning' ? "Got it — catch you tomorrow morning." :
    when === 'Pick a time' ? "Send me a time (e.g. 'tomorrow 6pm') and I'll remind you." :
    "Got it — I'll remind you later.";
  await sendMessage(from, `${note} ${PAW}`, waToken, phoneNumberId);
  await sendButtons(from, 'Meanwhile:',
    [SIZE_BTN.SKIP_BROWSE, SIZE_BTN.HERE_THEY_ARE, SIZE_BTN.HOOMAN],
    waToken, phoneNumberId);
}

async function handleMeasurementsMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const parsed = parseMeasurements(text);

  if (!parsed) {
    await sendMessage(from,
      `Couldn't read those measurements ${PAW} Try this format:\n\n*Back 18, Chest 22, Neck 14*`,
      waToken, phoneNumberId);
    return;
  }

  const match = matchSizeFromChart(parsed);
  const r = cart.woofparade || {};
  const updatedCart = {
    ...cart,
    woofparade: {
      ...r,
      sizing: { step: 'done', awaitingMeasurements: false, measurements: parsed, lastMatch: match.outcome },
    },
  };

  if (match.outcome === 'clean') {
    // S07 PDF v1.4 clean match: "That's a Size M for your pup 🐾 Want to go ahead?"
    await sendButtons(from,
      `That's a Size *${match.size}* for your pup ${PAW}\nWant to go ahead?`,
      [`Add ${match.size} to shortlist`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  } else if (match.outcome === 'borderline') {
    // S07 PDF v1.4 borderline: snugger vs roomier, "Which feels right?"
    await sendMessage(from,
      `Looks like a Size *${match.size}* for your pup ${PAW}\n\n` +
      `Quick note — they're slightly over the ${match.size}. Could go either way:\n\n` +
      `• *${match.size}* = snugger fit\n` +
      `• *${match.otherSize}* = roomier fit\n\n` +
      `Which feels right?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [`Add ${match.size}`, `Add ${match.otherSize}`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  } else {
    // S07 PDF v1.4 no match: route to custom
    await sendMessage(from,
      `Hmm — your pup's measurements are outside our standard sizes ${PAW}\n\n` +
      `But Anouttama can custom-make something pawfect for them.\n\n` +
      `Want me to set that up?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [SIZE_BTN.YES_CUSTOM, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  }

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade sizing_result=${match.outcome} size=${match.size}]` },
  ], updatedCart);
}

function parseMeasurements(text) {
  const t = (text || '').toLowerCase();
  const back = t.match(/back\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const chest = t.match(/chest\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const neck = t.match(/neck\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  if (!back || !chest || !neck) return null;
  return {
    back: parseFloat(back[1]),
    chest: parseFloat(chest[1]),
    neck: parseFloat(neck[1]),
  };
}

function matchSizeFromChart(m) {
  for (const row of SIZE_CHART) {
    const inBack = m.back >= row.back[0] && m.back <= row.back[1];
    const inChest = m.chest >= row.chest[0] && m.chest <= row.chest[1];
    const inNeck = m.neck >= row.neck[0] && m.neck <= row.neck[1];
    if (inBack && inChest && inNeck) {
      return { outcome: 'clean', size: row.size };
    }
  }
  for (let i = 0; i < SIZE_CHART.length; i++) {
    const row = SIZE_CHART[i];
    const next = SIZE_CHART[i + 1];
    if (!next) continue;
    const hits = [
      m.back >= row.back[0] && m.back <= row.back[1],
      m.chest >= row.chest[0] && m.chest <= row.chest[1],
      m.neck >= row.neck[0] && m.neck <= row.neck[1],
    ].filter(Boolean).length;
    if (hits === 2) {
      return {
        outcome: 'borderline',
        size: row.size,
        otherSize: next.size,
        note: `If you'd rather room to grow, go with ${next.size}.`,
      };
    }
  }
  return { outcome: 'no_match', size: null };
}

async function handleTalkToDesigner(ctx) {
  const r = ctx.cart?.woofparade || {};
  const sizing = r.sizing?.measurements;
  const msg =
    `🎨 *Designer Talk Requested*\n` +
    `From: +${ctx.from}\n` +
    (sizing ? `Measurements: Back ${sizing.back}", Chest ${sizing.chest}", Neck ${sizing.neck}"\n` : '') +
    `Recent context: customer wants designer input before custom-making.`;
  await pingTeam(ctx, 'designer', msg);
  await sendMessage(ctx.from,
    `Our designer Anouttama will reach out shortly ${PAW} Meanwhile, feel free to keep browsing.`,
    ctx.waToken, ctx.phoneNumberId);
}

// ─── CHECKOUT (S09–S11) ───────────────────────────────────────────────────

async function handleCheckout(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const items = cart.woofparade?.items || [];

  if (!items.length) {
    await sendMessage(from, `Your shortlist is empty ${PAW} Let's find something first.`, waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }

  const subtotal = items.reduce((s, it) => s + (it.price || 0), 0);
  const itemCount = items.filter(it => it.kind === 'product').length;
  const discount = applyDiscount(subtotal, itemCount);
  const afterDiscount = subtotal - discount.amount;
  const shipping = calcShipping(afterDiscount);
  const grand = afterDiscount + shipping;

  let summary = `*Your shortlist ${PAW}*\n\n`;
  summary += formatCartSummary(items) + '\n';
  if (discount.amount > 0) {
    summary += `Discount (${discount.label}): -${formatPrice(discount.amount)}\n`;
  }
  summary += `Shipping: ${shipping === 0 ? 'Free' : formatPrice(shipping)}\n`;
  summary += `*Grand total: ${formatPrice(grand)}*\n\n`;
  if (discount.amount > 0) {
    summary += `_${discount.transparency}_\n`;
  }

  await sendMessage(from, summary, waToken, phoneNumberId);

  await sendButtons(from, "How would you like to pay?",
    [CHECKOUT_BTN.PAY_NOW, CHECKOUT_BTN.COD, CHECKOUT_BTN.EDIT_CART],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade checkout_summary subtotal=${subtotal} discount=${discount.amount} grand=${grand}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      checkout: { step: null, subtotal, discount: discount.amount, discountLabel: discount.label, shipping, grand, phone: from },
    },
  });
}

async function handleCheckoutCOD(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from, ADDRESS_PROMPT, waToken, phoneNumberId);
  const co = cart.woofparade?.checkout || {};
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade cod_started]' },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      checkout: { ...co, step: CHECKOUT_STEP.COLLECT, paymentMethod: 'cod' },
    },
  });
}

async function handleAddressMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const parsed = await bulkParseAddress(text);

  if (!parsed) {
    await sendMessage(from,
      `Couldn't quite read that ${PAW} Try again, all in one message:\n\n` +
      `1. Full name\n2. Address (house/flat, street, area)\n3. City + State\n4. 6-digit PIN`,
      waToken, phoneNumberId);
    return;
  }

  const serviceable = await isPincodeServiceable(parsed.pin);
  if (!serviceable) {
    await sendMessage(from,
      `We don't ship to *${parsed.pin}* yet ${PAW}\n\nWant me to notify you when we open up your area?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
      waToken, phoneNumberId);
    console.log(`[woofparade] non-serviceable PIN ${parsed.pin} for ${from}`);
    return;
  }

  const co = cart.woofparade?.checkout || {};
  const updatedCheckout = { ...co, ...parsed, step: CHECKOUT_STEP.REVIEW };

  let review = `*Order summary ${PAW}*\n\n`;
  review += formatCartSummary(cart.woofparade?.items || []) + '\n';
  if (co.discount > 0) review += `Discount (${co.discountLabel}): -${formatPrice(co.discount)}\n`;
  review += `Shipping: ${co.shipping === 0 ? 'Free' : formatPrice(co.shipping)}\n`;
  review += `*Grand total: ${formatPrice(co.grand)}*\n\n`;
  review += `*Delivery to*\n${parsed.name}\n${parsed.address1}\n${parsed.city}, ${parsed.state} — ${parsed.pin}\nPhone: +${from}`;

  await sendMessage(from, review, waToken, phoneNumberId);
  await sendButtons(from, 'Confirm?',
    [CHECKOUT_BTN.CONFIRM, CHECKOUT_BTN.EDIT_ADDR, CHECKOUT_BTN.CANCEL],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade address_parsed]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), checkout: updatedCheckout },
  });
}

async function handleCheckoutEditAddr(ctx) {
  const { from, phoneNumberId, waToken, tenant, history, text, cart } = ctx;
  await sendMessage(from, ADDRESS_PROMPT, waToken, phoneNumberId);
  const co = cart.woofparade?.checkout || {};
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade edit_addr]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), checkout: { ...co, step: CHECKOUT_STEP.COLLECT } },
  });
}

async function handleCheckoutConfirm(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.woofparade || {};
  const co = r.checkout || {};
  const items = r.items || [];

  if (!co.name || !co.address1 || !co.city || !co.state || !co.pin) {
    await sendMessage(from, `Some details are missing — let's go through them again ${PAW}`, waToken, phoneNumberId);
    return;
  }

  const orderId = generateOrderId(from);
  try {
    await saveOrder(orderId, tenant.id, from, items, co, co.subtotal || 0, co.shipping || 0, co.grand || 0);
  } catch (e) {
    console.error('[woofparade] saveOrder failed:', e.message);
  }

  // S10/S11 PDF v1.4: COD = "Order locked in for COD"; Paid = "Payment confirmed!"
  const isPaid = co.paymentMethod !== 'cod';
  if (isPaid) {
    await sendMessage(from,
      `Payment confirmed! 🎉\n` +
      `Order #${orderId} is on its way to being a showstopper.\n` +
      `Tracking link will land here once it ships (usually 1–2 days).`,
      waToken, phoneNumberId);
  } else {
    await sendMessage(from,
      `Thanks! Order locked in for COD ${PAW}\n` +
      `Our team will confirm and dispatch within 1–2 days.\n` +
      `You'll get a tracking link on WhatsApp once it ships.`,
      waToken, phoneNumberId);
  }

  if ((co.grand || 0) >= HIGH_VALUE_THRESHOLD) {
    await handleHighValueAlert(ctx, items, co, orderId);
  }
  await sendOwnerAlertWoof(ctx, items, co, orderId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade order_placed=${orderId}]` },
  ], {
    ...cart,
    woofparade: {
      ...r,
      items: [],
      checkout: { ...co, step: CHECKOUT_STEP.CONFIRMED, orderId },
      lastOrderId: orderId,
    },
  });

  // Pup profile (S30) — fire after a beat
  setTimeout(() => {
    handlePupProfileFlow(ctx).catch(e => console.error('[woofparade] pup profile flow failed:', e.message));
  }, 1500);
}

async function handleCheckoutCancel(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from, `No worries — your shortlist is still here ${PAW}`, waToken, phoneNumberId);
  await sendButtons(from, 'What next?',
    [PICKED_BTN.CHECKOUT, PRODUCT_BTN.BACK_TO_MENU, WELCOME_BTN.ORDER_HELP],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade checkout_cancelled]' },
  ], { ...cart, woofparade: { ...(cart.woofparade || {}), checkout: null } });
}

async function handleEditShortlist(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const items = cart.woofparade?.items || [];
  if (!items.length) {
    await sendMessage(from, `Shortlist is empty ${PAW}`, waToken, phoneNumberId);
    await sendWelcome(ctx);
    return;
  }
  await sendMessage(from, `*Current shortlist*\n${formatCartSummary(items)}`, waToken, phoneNumberId);
  await sendButtons(from, "Want to remove anything?",
    ['Remove last', PICKED_BTN.CHECKOUT, PRODUCT_BTN.BACK_TO_MENU],
    waToken, phoneNumberId);
}

async function handleNotifyMeBack(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const handle = cart.woofparade?.product?.handle || '(unknown)';
  await sendMessage(from,
    `Got it ${PAW} I'll WhatsApp you the moment *${handle}* is back in stock.`,
    waToken, phoneNumberId);
  console.log(`[woofparade] OOS notify-back: ${from} → ${handle}`);
  await sendButtons(from, 'Meanwhile:',
    [PRODUCT_BTN.BACK_TO_MENU, SIZE_BTN.YES_CUSTOM],
    waToken, phoneNumberId);
}

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — CUSTOM, EDGE CASES, POST-PURCHASE, ORDER OPS, FOUNDER, HELPERS
// ════════════════════════════════════════════════════════════════════════════

// ─── S12 CUSTOM FIT ────────────────────────────────────────────────────────

async function handleCustomFitStart(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  // S12 PDF v1.4 intro
  await sendButtons(from,
    `Custom designs starting from ₹300+ over base price ${PAW}\n` +
    `Two ways we can do this — pick what's easier:`,
    ['Fill the form', 'Chat it through with me', PRODUCT_BTN.BACK_TO_MENU],
    waToken, phoneNumberId);
}

async function handleCustomOrderFromWebsite(ctx) {
  // Customer arrived from website form with pre-filled measurements.
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Got your custom order details ${PAW} Anouttama will reach out shortly with fabric swatches and the final quote.\n\n` +
    `Meanwhile, anything to add — special detail, embroidery, pup's nickname for the tag?`,
    waToken, phoneNumberId);

  const alertBody =
    `🎨 *CUSTOM ORDER FROM WEBSITE*\n` +
    `From: +${from}\n\n` +
    `Auto-message content:\n${text.slice(0, 800)}`;
  await pingTeam(ctx, 'designer', alertBody);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade custom_from_website]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), custom: { source: 'website', stage: 'team_notified' } },
  });
}

// Branch when user taps "Chat it through" in handleCustomFitStart
async function handleCustomChatStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  // S12 PDF v1.4 Branch B step 1: ask pup name + fit together
  await sendMessage(from,
    `Pawfect ${PAW} Just two quick messages from me.\n\n` +
    `First up:\n` +
    `1. What's your pup's name?\n` +
    `2. What kind of fit are you after? (Kurta, Frock, Lehenga, Bandana, or "not sure yet")\n\n` +
    `Send both in one message — like: *Mochi, Kurta*`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade custom_chat_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), custom: { source: 'chat', awaitingPupName: true } },
  });
}

async function handleCustomPupNameMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const pupName = (text || '').trim().slice(0, 60);
  // S12 PDF v1.4 Branch B step 2: full intake in one message
  await sendMessage(from,
    `Lovely — *${pupName}*'s about to look like a showstopper ${PAW}\n\n` +
    `Now pop in everything in one message:\n` +
    `• Back length (neck base to tail base)\n` +
    `• Chest (widest part behind front legs)\n` +
    `• Neck (around the base)\n` +
    `• Armhole (around the front leg)\n` +
    `• Fabric / style preference (or 'not sure yet')\n` +
    `• Occasion or theme (optional)\n` +
    `• Weight in kg (optional)\n\n` +
    `Like: *Back 14, Chest 18, Neck 12, Armhole 6, Red Banarasi, Diwali, 8kg*`,
    waToken, phoneNumberId);

  const c = cart.woofparade?.custom || {};
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade custom_pup_name=${pupName}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      custom: { ...c, pupName, awaitingPupName: false, awaitingMeasurements: true },
    },
  });
}

async function handleCustomMeasurementsMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const m = parseMeasurements(text);
  const armholeMatch = (text || '').toLowerCase().match(/armhole\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const armhole = armholeMatch ? parseFloat(armholeMatch[1]) : null;

  if (!m) {
    await sendMessage(from,
      `Couldn't catch those ${PAW} Try: *Back 18, Chest 22, Neck 14, Armhole 8*`,
      waToken, phoneNumberId);
    return;
  }

  // Send fabric list.
  await sendList(from, `Pick a fabric for ${cart.woofparade?.custom?.pupName || "your pup"} ${PAW}`, [{
    title: 'Fabrics',
    rows: [
      { id: 'fabric_cotton',    title: 'Cotton',       description: 'Soft, breathable, daily wear' },
      { id: 'fabric_linen',     title: 'Linen',        description: 'Light, summer-ready' },
      { id: 'fabric_silk',      title: 'Silk',         description: 'Festive shimmer' },
      { id: 'fabric_velvet',    title: 'Velvet',       description: 'Winter, formal' },
      { id: 'fabric_brocade',   title: 'Brocade',      description: 'Heavy festive' },
      { id: 'fabric_denim',     title: 'Denim',        description: 'Casual, durable' },
      { id: 'fabric_print',     title: 'Printed',      description: 'Cotton with prints' },
      { id: 'fabric_surprise',  title: 'Surprise me',  description: 'Designer picks' },
    ],
  }], waToken, phoneNumberId);

  // Ping team with full intake.
  const c = cart.woofparade?.custom || {};
  const intake =
    `🎨 *CUSTOM ORDER — CHAT INTAKE*\n` +
    `From: +${from}\n` +
    `Pup: ${c.pupName || '(unknown)'}\n` +
    `Back: ${m.back}", Chest: ${m.chest}", Neck: ${m.neck}"` +
    (armhole !== null ? `, Armhole: ${armhole}"` : '') + `\n` +
    `Awaiting fabric pick.`;
  await pingTeam(ctx, 'designer', intake);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade custom_intake back=${m.back} chest=${m.chest} neck=${m.neck} armhole=${armhole}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      custom: { ...c, measurements: m, armhole, awaitingMeasurements: false, awaitingFabric: true },
    },
  });
}

// ─── S18 — REFUND / COMPLAINT (SOS to Apurv + Kashmira) ──────────────────

async function handleRefundComplaint(ctx) {
  const { from, phoneNumberId, waToken, history } = ctx;
  // S18 PDF v1.4: no outcome promise, just empathy + escalation
  await sendMessage(from,
    `I'm so sorry to hear that ${PAW} Let me get our team on it right away — they'll reach out to you shortly.`,
    waToken, phoneNumberId);

  const lastMsgs = formatRecentHistory(history);
  const body =
    `🆘 *REFUND / COMPLAINT*\n` +
    `From: +${from}\n\n` +
    `Recent chat:\n${lastMsgs}\n\n` +
    `Reply directly to customer's WhatsApp. No outcome promised yet.`;
  await pingTeam(ctx, 'apurv', body);
  await pingTeam(ctx, 'kashmira', body);
}

// ─── S19 — STOP / UNSUBSCRIBE ─────────────────────────────────────────────

async function handleStopUnsubscribe(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Okay... I'll stop. *walks away slowly* ${PAW}\nYou're unsubscribed.\n\nBut if you change your mind, I'll be here.`,
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade unsubscribed]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), unsubscribed: true },
  });
}

// ─── S16 — TALK TO HUMAN ──────────────────────────────────────────────────

async function handleTalkToHuman(ctx, reasonCode) {
  const { from, phoneNumberId, waToken, history } = ctx;
  // S16 PDF v1.4: "Of course! Apurv from our team will be with you shortly..."
  await sendMessage(from,
    `Of course! Apurv from our team will be with you shortly ${PAW}\n\n` +
    `What's the best time to reach out, and what should I tell them you'd like to chat about?`,
    waToken, phoneNumberId);

  const lastMsgs = formatRecentHistory(history);
  const tag = reasonCode ? ` (${reasonCode})` : '';
  const body =
    `👤 *HUMAN HELP REQUESTED${tag}*\n` +
    `From: +${from}\n\n` +
    `Recent chat:\n${lastMsgs}`;
  await pingTeam(ctx, 'apurv', body);
}

// ─── S20 — INTERNATIONAL ──────────────────────────────────────────────────

async function handleInternationalRequest(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  // S20 PDF v1.4: explicit opt-in language, scoped to international launch only
  await sendButtons(from,
    `Right now we ship pan-India only 🇮🇳\n\n` +
    `We'll let you know the moment international shipping launches! ` +
    `Want me to save your contact and WhatsApp you when international shipping goes live? ` +
    `(We'll only message you about that — nothing else.)`,
    [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
    waToken, phoneNumberId);
}

async function handleInternationalOptIn(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    `Lovely ${PAW} Apurv will WhatsApp you within 24 hours with international shipping options.`,
    waToken, phoneNumberId);

  const body =
    `🌍 *INTERNATIONAL INQUIRY*\n` +
    `From: +${from}\n` +
    `Customer opted in for international shipping options.`;
  await pingTeam(ctx, 'apurv', body);
  console.log(`[woofparade] international opt-in: ${from}`);
}

// ─── S21 — BULK / WHOLESALE ───────────────────────────────────────────────

async function handleBulkInquiry(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  // S21 PDF v1.4
  await sendMessage(from,
    `For bulk orders, we'll reach out within a day, personally.\n\n` +
    `Could you share your contact + a bit about your business? ${PAW}`,
    waToken, phoneNumberId);

  const body =
    `📦 *BULK / WHOLESALE INQUIRY*\n` +
    `From: +${from}\n\n` +
    `Recent chat: ${formatRecentHistory(ctx.history)}`;
  await pingTeam(ctx, 'apurv', body);
  await pingTeam(ctx, 'kashmira', body);
}

// ─── S22 — PRESS ──────────────────────────────────────────────────────────

async function handlePressInquiry(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  // S22 PDF v1.4 — TODO: KASHMIRA CONFIRM press email (default: hello@thewoofparade.com)
  await sendMessage(from,
    `Lovely to hear from you! ${PAW}\n\n` +
    `For press or collaborations, please email *${PRESS_EMAIL}* — our team will get right back to you.`,
    waToken, phoneNumberId);

  const body =
    `📰 *PRESS / COLLAB INQUIRY*\n` +
    `From: +${from}\n` +
    `Pointed customer to ${PRESS_EMAIL}.\n\n` +
    `Recent chat: ${formatRecentHistory(ctx.history)}`;
  await pingTeam(ctx, 'kashmira', body);
}

// ─── S26 — DISCOUNT PRESSURE (3-strike) ───────────────────────────────────

async function handleDiscountPressure(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.woofparade || {};
  const strikes = (r.discountStrikes || 0) + 1;

  if (strikes === 1) {
    let line = `Our current offer is *Buy 1 Get ${FESTIVAL_B1_PERCENT}%, Buy 2+ Get ${FESTIVAL_B2_PERCENT}%* — auto-applied at checkout ${PAW}`;
    if (!FESTIVAL_SALE_ON) {
      line = `No public sale running right now ${PAW} But you'll get our best price at checkout — promise.`;
    }
    await sendMessage(from, line, waToken, phoneNumberId);
  } else if (strikes === 2) {
    await sendMessage(from,
      `Wish I could budge more ${PAW} For special asks, Apurv has more flexibility than I do — want me to loop him in?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      ['Yes, talk to Apurv', "No, that's okay"],
      waToken, phoneNumberId);
  } else {
    // 3+ strikes — auto-route to Apurv
    await handleTalkToHuman(ctx, 'discount-pressure-x3');
  }

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade discount_pressure strike=${strikes}]` },
  ], { ...cart, woofparade: { ...r, discountStrikes: strikes } });
}

// ─── S28 — ABUSIVE (2-strike) ─────────────────────────────────────────────

async function handleAbusive(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const r = cart.woofparade || {};
  const strikes = (r.abuseStrikes || 0) + 1;

  if (strikes === 1) {
    // Silent flag — no warning, just an internal note. Per PDF, don't engage.
    console.log(`[woofparade] abusive strike 1 from ${from}: ${text}`);
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[woofparade abuse_strike_1]' },
    ], { ...cart, woofparade: { ...r, abuseStrikes: 1 } });
    return;
  }

  // 2nd strike — block.
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade abuse_strike_2 blocked]' },
  ], { ...cart, woofparade: { ...r, abuseStrikes: 2, blocked: true } });

  const body =
    `🚫 *ABUSIVE CUSTOMER BLOCKED*\n` +
    `From: +${from}\n\n` +
    `Bot will no longer respond. To unblock, run "unblock ${from}" in founder commands.`;
  await pingTeam(ctx, 'kashmira', body);
}

// ─── S37 — RAGE-QUIT ──────────────────────────────────────────────────────

async function handleRageQuit(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    `Looks like I'm not the best help right now ${PAW} I'm pulling in Apurv — he'll WhatsApp you shortly with the full picture of where we are.`,
    waToken, phoneNumberId);

  const body =
    `🔥 *RAGE-QUIT / FRUSTRATION HANDOFF*\n` +
    `From: +${from}\n\n` +
    `Recent chat:\n${formatRecentHistory(ctx.history)}\n\n` +
    `Customer is frustrated. Take over warmly.`;
  await pingTeam(ctx, 'apurv', body);
  console.log(`[woofparade] rage_quit handoff: ${from}`);
}

// ─── S35 — PINCODE SERVICEABILITY ─────────────────────────────────────────

async function handlePincodeCheck(ctx, pin) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const ok = await isPincodeServiceable(pin);
  if (ok) {
    await sendMessage(from,
      `Yes! We deliver to *${pin}* ${PAW} Usually 4–8 days.`,
      waToken, phoneNumberId);
  } else {
    await sendMessage(from,
      `We don't ship to *${pin}* yet ${PAW} Want me to notify you when we open up your area?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
      waToken, phoneNumberId);
  }
}

// Stub. Returns true unless a known non-serviceable prefix.
// TODO: wire to Shopify shipping zones + Shiprocket API after founder confirms (PDF Section 7).
async function isPincodeServiceable(pin) {
  if (!/^\d{6}$/.test(pin)) return false;
  // Hardcoded non-serviceable prefixes for v1 (PO box / Andaman remote / Lakshadweep).
  const blocked = ['744', '682']; // partial — review with founder
  return !blocked.some(prefix => pin.startsWith(prefix));
}

// ─── S29 — HIGH-VALUE ALERT ────────────────────────────────────────────────

async function handleHighValueAlert(ctx, items, checkout, orderId) {
  const body =
    `💎 *HIGH-VALUE ORDER (₹10k+)*\n` +
    `Order: ${orderId}\n` +
    `Customer: ${checkout.name} (+${ctx.from})\n` +
    `Total: ${formatPrice(checkout.grand)}\n` +
    `Items: ${items.length}\n\n` +
    `Consider a personal call from Kashmira within 24 hrs.`;
  await pingTeam(ctx, 'kashmira', body);
}

async function sendOwnerAlertWoof(ctx, items, checkout, orderId) {
  const body =
    `🛒 *NEW WOOF PARADE ORDER*\n\n` +
    `*Order*: ${orderId}\n` +
    `*Customer*: ${checkout.name} (+${ctx.from})\n` +
    `*Payment*: ${checkout.paymentMethod === 'cod' ? 'COD' : 'Pay now'}\n\n` +
    `*Items*\n${formatCartSummary(items)}\n\n` +
    `Subtotal: ${formatPrice(checkout.subtotal || 0)}\n` +
    (checkout.discount ? `Discount (${checkout.discountLabel}): -${formatPrice(checkout.discount)}\n` : '') +
    `Shipping: ${(checkout.shipping || 0) === 0 ? 'Free' : formatPrice(checkout.shipping)}\n` +
    `*Total: ${formatPrice(checkout.grand)}*\n\n` +
    `*Delivery*\n${checkout.address1}\n${checkout.city}, ${checkout.state} — ${checkout.pin}`;
  await pingTeam(ctx, 'apurv', body);
}

// ─── S30 — PUP PROFILE FLOW ───────────────────────────────────────────────

async function handlePupProfileFlow(ctx) {
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const pups = await getCustomerPupProfiles(ctx);

  if (pups.length === 0) {
    // Branch A — first-time, no pup on file.
    await sendMessage(from,
      `One quick thing ${PAW} What's your pup's name? ` +
      `Just so I can address them next time — like a regular at our shop.`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Or:',
      [POSTPURCHASE_BTN.SKIP],
      waToken, phoneNumberId);
    await upsertConversation(tenant.id, from, ctx.history || [], {
      ...cart,
      woofparade: { ...(cart.woofparade || {}), pupProfile: { awaitingPupDetails: true, branch: 'first_time' } },
    });
    return;
  }

  if (pups.length === 1) {
    const p = pups[0];
    // Branch B — 1 pup on file
    await sendMessage(from,
      `Is this order for *${p.pup_name}* ${PAW} or a new pup in the family?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [`Yes, ${p.pup_name}`, POSTPURCHASE_BTN.NEW_ADDITION, POSTPURCHASE_BTN.SKIP],
      waToken, phoneNumberId);
    return;
  }

  // Branch C — 2+ pups
  const rows = pups.slice(0, 8).map(p => ({
    id: `tag_pup_${p.pup_name}`,
    title: p.pup_name.slice(0, 24),
    description: p.breed || 'Tap to tag this order',
  }));
  rows.push({ id: 'tag_pup_new', title: 'New addition 🐾', description: 'A new pup in the family' });
  await sendList(from, `Which pup is this for ${PAW}`,
    [{ title: 'Your pups', rows }],
    waToken, phoneNumberId);
}

async function handlePupProfileMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const t = (text || '').trim();
  const pupName = t.split(/[,\n]/)[0].slice(0, 60);

  // Check sub-persona switch (S14 — customer's pup also named Rio → bot becomes Biscuit)
  const isRioPup = /^rio$/i.test(pupName);
  const finalBotName = isRioPup ? ALT_BOT_NAME : DEFAULT_BOT_NAME;

  try {
    await savePupProfile(tenant.id, from, pupName);
  } catch (e) {
    console.error('[woofparade] savePupProfile failed:', e.message);
  }

  const greeting = isRioPup
    ? `Ha! You have a Rio too ${PAW} I'll be *Biscuit* from now on, so we don't get confused. Welcome aboard, fellow Rio!`
    : `Lovely name ${PAW} *${pupName}* it is. I'll remember next time.`;

  await sendMessage(from, greeting, waToken, phoneNumberId);
  await sendButtons(from, "Would you like to share a photo of them in our outfit when it arrives?",
    [POSTPURCHASE_BTN.YES_FEATURE, POSTPURCHASE_BTN.JUST_REVIEW, POSTPURCHASE_BTN.MAYBE_LATER],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade pup_profile_set=${pupName} biscuit=${isRioPup}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      pupProfile: { awaitingPupDetails: false, pupName, botName: finalBotName },
    },
  });
}

async function handleNewPupAdd(ctx) {
  const { tenant, from, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from, `Tell me about the new pup ${PAW} What's their name?`, waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, history, {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), pupProfile: { awaitingPupDetails: true, branch: 'new_addition' } },
  });
}

async function handlePupProfileSkip(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from, `No problem ${PAW} Anything else I can help with?`, waToken, phoneNumberId);
  await sendButtons(from, 'Or:',
    [POSTPURCHASE_BTN.TRACK, POSTPURCHASE_BTN.BROWSE_MORE],
    waToken, phoneNumberId);
}

async function handlePupProfileAddNow(ctx) {
  await handleNewPupAdd(ctx);
}

async function handleTagOrderToPup(ctx, pupName) {
  const { from, phoneNumberId, waToken } = ctx;
  if (pupName === 'new') {
    await handleNewPupAdd(ctx);
    return;
  }
  await sendMessage(from,
    `Tagged this order to *${pupName}* ${PAW}`,
    waToken, phoneNumberId);
  // TODO: write to orders table — tagged_pup column when added.
  console.log(`[woofparade] tagged order to ${pupName} for ${from}`);
}

// ─── S31 — PHOTO FROM CUSTOMER ────────────────────────────────────────────

async function handlePhotoFromCustomer(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    `What a lovely shot ${PAW} Mind if we feature *your pup* on our Instagram or website?\n\n` +
    `Tap below — totally fine if you'd rather not, just a tail-wag from us either way.`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Choose:',
    [POSTPURCHASE_BTN.YES_FEATURE, POSTPURCHASE_BTN.JUST_REVIEW, POSTPURCHASE_BTN.MAYBE_LATER],
    waToken, phoneNumberId);

  // Ping Kashmira with photo notice.
  const body =
    `📸 *PHOTO FROM CUSTOMER*\n` +
    `From: +${from}\n` +
    `Asked permission to feature. Awaiting reply.`;
  await pingTeam(ctx, 'kashmira', body);
}

async function handlePhotoPermission(ctx, status) {
  const { from, phoneNumberId, waToken } = ctx;
  const msg = {
    granted:  `Brilliant! ${PAW} We'll tag your pup when we feature them. Thank you!`,
    declined: `Totally understood ${PAW} Thanks for the lovely shot anyway.`,
    pending:  `No rush ${PAW} Just let us know whenever.`,
  }[status] || `Got it ${PAW}`;
  await sendMessage(from, msg, waToken, phoneNumberId);

  if (status === 'granted') {
    const body =
      `✅ *PHOTO PERMISSION GRANTED*\n` +
      `From: +${from}\n` +
      `Cleared to feature on Insta/website. Tag the pup if known.`;
    await pingTeam(ctx, 'kashmira', body);
  }
}

// ─── S32 — TRACK ORDER ────────────────────────────────────────────────────

async function handleTrackOrder(ctx) {
  const { from, phoneNumberId, waToken, cart } = ctx;
  const orderId = cart.woofparade?.lastOrderId || cart.woofparade?.checkout?.orderId;

  if (!orderId) {
    await sendMessage(from,
      `I don't have an order ID for you yet ${PAW}\n\n` +
      `Could you share the order number (looks like *WOOF-XXXXXX-XXX*) or the email/phone you used?`,
      waToken, phoneNumberId);
    return;
  }

  let order = null;
  try { order = await getOrder(orderId); }
  catch (e) { console.error('[woofparade] getOrder failed:', e.message); }

  if (!order) {
    await sendMessage(from,
      `Hmm, can't pull up *${orderId}* right now ${PAW} Let me get Apurv to check on this.`,
      waToken, phoneNumberId);
    await handleTalkToHuman(ctx, 'tracking-lookup-failed');
    return;
  }

  // Branch logic per PDF S32
  const status = order.status;
  const createdAt = new Date(order.created_at || Date.now());
  const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

  if (status === 'shipped') {
    await sendMessage(from,
      `📦 *${orderId}* has shipped ${PAW}\n\n` +
      `Tracking link will be sent to you within 24 hrs once we update.\n` +
      `Estimated delivery: 4–8 days from dispatch.`,
      waToken, phoneNumberId);
  } else if (status === 'paid' && ageInDays < 2) {
    await sendMessage(from,
      `*${orderId}* is being prepared ${PAW}\n` +
      `It'll ship within 1–2 days. You'll get tracking once it's on the way.`,
      waToken, phoneNumberId);
  } else if (status === 'paid' && ageInDays >= 2) {
    await sendMessage(from,
      `Let me check on *${orderId}* ${PAW} I'm pinging Apurv now — he'll WhatsApp you within an hour with an update.`,
      waToken, phoneNumberId);
    const body =
      `⚠️ *UNFULFILLED >2 DAYS*\n` +
      `Order: ${orderId}\nCustomer: +${from}\nAge: ${ageInDays.toFixed(1)} days\nStatus: paid, not shipped`;
    await pingTeam(ctx, 'apurv', body);
  } else {
    // awaiting_payment
    await sendMessage(from,
      `*${orderId}* is in our system but payment hasn't been confirmed yet ${PAW}\n` +
      `Once that's sorted, we'll start prep.`,
      waToken, phoneNumberId);
  }
}

// ─── S33 — MODIFY ORDER ───────────────────────────────────────────────────

async function handleModifyOrderStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Got it ${PAW} Tell me what you'd like to change — size, item swap, remove, add — in one message and I'll loop Apurv in to confirm.`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade modify_order_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingMod: true } },
  });
}

async function handleOrderModMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const orderId = cart.woofparade?.lastOrderId || '(unknown)';
  let order = null;
  try { if (orderId !== '(unknown)') order = await getOrder(orderId); } catch (e) {}

  await sendMessage(from,
    `Noted ${PAW} Apurv will WhatsApp you shortly to confirm the change.`,
    waToken, phoneNumberId);

  const shipped = order?.status === 'shipped';
  const tag = shipped ? 'POST-SHIP MODIFICATION (exchange window)' : 'PRE-SHIP MODIFICATION';
  const body =
    `✏️ *${tag}*\n` +
    `Order: ${orderId}\nCustomer: +${from}\n\nRequested change:\n${text.slice(0, 500)}`;
  await pingTeam(ctx, 'apurv', body);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade order_mod_request order=${orderId}]` },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingMod: false } },
  });
}

// ─── S34 — ADDRESS CHANGE ─────────────────────────────────────────────────

async function handleAddressChangeStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Send me the *correct* full address in one message ${PAW}\n\n` +
    `Name, house/flat & street, city, state, 6-digit PIN.`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade addr_change_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingAddrChange: true } },
  });
}

async function handleAddressChangeMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const orderId = cart.woofparade?.lastOrderId || '(unknown)';
  let order = null;
  try { if (orderId !== '(unknown)') order = await getOrder(orderId); } catch (e) {}

  await sendMessage(from,
    `Got it ${PAW} Apurv is on it — he'll confirm with you on WhatsApp shortly.`,
    waToken, phoneNumberId);

  const shipped = order?.status === 'shipped';
  const tag = shipped ? '🚨 *URGENT — IN-TRANSIT ADDRESS CHANGE*' : '✏️ *PRE-SHIP ADDRESS CHANGE*';
  const oldAddr = order?.checkout
    ? `${order.checkout.address1}, ${order.checkout.city}, ${order.checkout.state} — ${order.checkout.pin}`
    : '(unknown)';
  const body =
    `${tag}\n` +
    `Order: ${orderId}\nCustomer: +${from}\n\n` +
    `OLD: ${oldAddr}\nNEW:\n${text.slice(0, 500)}`;
  await pingTeam(ctx, 'apurv', body);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade addr_change order=${orderId} shipped=${shipped}]` },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingAddrChange: false } },
  });
}

// ─── S36 — UPI PAID ───────────────────────────────────────────────────────

async function handleUpiPaidStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Got it ${PAW} Send me:\n\n` +
    `1. Screenshot of the payment\n` +
    `2. UTR / transaction number\n` +
    `3. Order ID (WOOF-XXXXXX-XXX)\n\n` +
    `Apurv will verify within an hour and mark your order paid.`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade upi_paid_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingUpiProof: true } },
  });
}

async function handleUpiPaidMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Thanks ${PAW} Apurv is reviewing — you'll hear back within an hour.`,
    waToken, phoneNumberId);

  const body =
    `💸 *UPI PAYMENT CLAIMED*\n` +
    `Customer: +${from}\n\nProof:\n${text.slice(0, 600)}\n\n` +
    `To confirm: reply "mark paid WOOF-XXXXXX-XXX" once you've verified.`;
  await pingTeam(ctx, 'apurv', body);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade upi_paid_proof_received]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), orderOps: { awaitingUpiProof: false } },
  });
}

// ─── OWNER CONFIRM COMMAND (S36 → "mark paid" / "confirmed") ──────────────

async function handleOwnerConfirmCommand(ctx, orderId) {
  const { tenant, from, phoneNumberId, waToken } = ctx;
  let order;
  try { order = await getOrder(orderId); }
  catch (e) { console.error('[woofparade] getOrder failed:', e.message); }

  if (!order) {
    await sendMessage(from, `No order found with ID ${orderId}`, waToken, phoneNumberId);
    return;
  }
  if (order.status === 'paid') {
    await sendMessage(from, `Order ${orderId} was already marked paid.`, waToken, phoneNumberId);
    return;
  }

  const updated = await markOrderPaid(orderId).catch(() => null);
  if (!updated) {
    await sendMessage(from, `Could not update order ${orderId}`, waToken, phoneNumberId);
    return;
  }

  await sendMessage(from,
    `✅ Order ${orderId} marked as paid. Customer notified.`,
    waToken, phoneNumberId);

  await sendMessage(order.customer_phone,
    `🎉 *Payment confirmed!* ${PAW}\n\n` +
    `Your order *${orderId}* is now in our queue. ` +
    `You'll get tracking once it ships (4–8 days estimate).`,
    waToken, phoneNumberId);
}

// ─── S03 BRANCH C — CONTINUE WHERE LEFT OFF ───────────────────────────────

async function handleContinueWhereLeftOff(ctx) {
  const r = ctx.cart.woofparade || {};
  if (r.browseMode === 'category' && r.categoryRowId) {
    await sendCategoryResults(ctx, r.categoryRowId, r.page || 0);
    return;
  }
  if (r.browseMode === 'product_detail' && r.product?.handle) {
    await sendProductDetail(ctx, r.product.handle);
    return;
  }
  await sendWelcome(ctx);
}

// ─── S5.5 FOUNDER COMMANDS (Kashmira only) ────────────────────────────────

async function tryFounderCommand(ctx, text) {
  const { from, phoneNumberId, waToken, tenant } = ctx;
  const t = (text || '').trim();
  const lc = t.toLowerCase();

  // pause bot [N hours|N days]
  let m = lc.match(/^pause bot(?:\s+(\d+)\s*(hour|hr|day)s?)?$/);
  if (m) {
    const n = parseInt(m[1] || '2', 10);
    const unit = m[2] || 'hour';
    const ms = (unit.startsWith('day') ? n * 24 * 60 * 60 : n * 60 * 60) * 1000;
    const until = new Date(Date.now() + ms);
    await setBotPause(tenant.id, until);
    await sendMessage(from, `🤫 Bot paused until ${until.toISOString().replace('T', ' ').slice(0, 16)} IST.`, waToken, phoneNumberId);
    return true;
  }
  if (lc === 'resume bot' || lc === 'unpause bot') {
    await setBotPause(tenant.id, null);
    await sendMessage(from, `▶️ Bot resumed.`, waToken, phoneNumberId);
    return true;
  }
  m = lc.match(/^extend\s+(\d+)\s*(hour|hr|day)s?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const cur = await getBotPauseUntil(tenant.id);
    const base = cur && cur > new Date() ? cur : new Date();
    const ms = (unit.startsWith('day') ? n * 24 * 60 * 60 : n * 60 * 60) * 1000;
    const until = new Date(base.getTime() + ms);
    await setBotPause(tenant.id, until);
    await sendMessage(from, `⏰ Pause extended until ${until.toISOString().replace('T', ' ').slice(0, 16)} IST.`, waToken, phoneNumberId);
    return true;
  }

  // stats today / week / month
  m = lc.match(/^stats\s+(today|week|month)$/);
  if (m) {
    const stats = await getStats(tenant.id, m[1]);
    await sendMessage(from,
      `📊 *Stats ${m[1]}*\n` +
      `Conversations: ${stats.conversations}\nOrders: ${stats.orders}\nRevenue: ${formatPrice(stats.revenue)}`,
      waToken, phoneNumberId);
    return true;
  }

  // show chat [number]
  m = t.match(/^show chat\s+\+?(\d+)$/i);
  if (m) {
    const phone = m[1];
    const conv = await getConversation(tenant.id, phone).catch(() => null);
    if (!conv) {
      await sendMessage(from, `No chat history for +${phone}`, waToken, phoneNumberId);
      return true;
    }
    const recent = (conv.messages || []).slice(-10).map(msg => {
      const role = msg.role === 'user' ? 'C' : 'B';
      return `${role}: ${(msg.content || '').slice(0, 120)}`;
    }).join('\n');
    await sendMessage(from, `*Last 10 msgs with +${phone}:*\n\n${recent || '(empty)'}`, waToken, phoneNumberId);
    return true;
  }

  // last 5 chats
  if (lc === 'last 5 chats') {
    const recent = await getRecentChats(tenant.id, 5);
    const lines = recent.map(c =>
      `+${c.customer_phone} — ${new Date(c.last_active).toISOString().slice(5, 16).replace('T', ' ')}`
    ).join('\n');
    await sendMessage(from, `*Last 5 chats:*\n${lines || '(none)'}`, waToken, phoneNumberId);
    return true;
  }

  // flag / unflag / priority [number]
  m = t.match(/^(flag|unflag|priority)\s+\+?(\d+)$/i);
  if (m) {
    const action = m[1].toLowerCase();
    const phone = m[2];
    // Persist a per-customer admin tag on their cart row.
    const conv = await getConversation(tenant.id, phone).catch(() => null);
    if (!conv) {
      await sendMessage(from, `No chat for +${phone} yet.`, waToken, phoneNumberId);
      return true;
    }
    const newCart = { ...(conv.cart || {}) };
    newCart.woofparade = newCart.woofparade || {};
    if (action === 'flag') newCart.woofparade.flagged = true;
    if (action === 'unflag') delete newCart.woofparade.flagged;
    if (action === 'priority') newCart.woofparade.priority = true;
    await upsertConversation(tenant.id, phone, conv.messages || [], newCart);
    await sendMessage(from, `✅ ${action} applied to +${phone}.`, waToken, phoneNumberId);
    return true;
  }

  // note [pup] [text]
  m = t.match(/^note\s+(\S+)\s+(.+)$/i);
  if (m) {
    const pup = m[1];
    const note = m[2];
    console.log(`[woofparade founder] note on ${pup}: ${note}`);
    await sendMessage(from, `📝 Noted on *${pup}*: ${note}`, waToken, phoneNumberId);
    return true;
  }

  // test mode on / off (Kashmira only)
  if (lc === 'test mode on') {
    const conv = await getConversation(tenant.id, from).catch(() => null);
    const cart = conv?.cart || {};
    cart.woofparade = cart.woofparade || {};
    cart.woofparade.testMode = true;
    await upsertConversation(tenant.id, from, conv?.messages || [], cart);
    await sendMessage(from, `🧪 Test mode ON. Handoffs and stats are suppressed for your chats.`, waToken, phoneNumberId);
    return true;
  }
  if (lc === 'test mode off') {
    const conv = await getConversation(tenant.id, from).catch(() => null);
    const cart = conv?.cart || {};
    cart.woofparade = cart.woofparade || {};
    delete cart.woofparade.testMode;
    await upsertConversation(tenant.id, from, conv?.messages || [], cart);
    await sendMessage(from, `✅ Test mode OFF.`, waToken, phoneNumberId);
    return true;
  }

  // unblock [number]
  m = t.match(/^unblock\s+\+?(\d+)$/i);
  if (m) {
    const phone = m[1];
    const conv = await getConversation(tenant.id, phone).catch(() => null);
    if (!conv) {
      await sendMessage(from, `No record for +${phone}.`, waToken, phoneNumberId);
      return true;
    }
    const newCart = { ...(conv.cart || {}) };
    newCart.woofparade = newCart.woofparade || {};
    delete newCart.woofparade.blocked;
    delete newCart.woofparade.abuseStrikes;
    await upsertConversation(tenant.id, phone, conv.messages || [], newCart);
    await sendMessage(from, `✅ Unblocked +${phone}.`, waToken, phoneNumberId);
    return true;
  }

  // broadcast [msg]  — placeholder, logs only for safety
  m = t.match(/^broadcast\s+(.+)$/i);
  if (m) {
    await sendMessage(from,
      `⚠️ Broadcast is not enabled in v1. Logged your message — Shweta will run this manually.\n\nMessage:\n${m[1].slice(0, 500)}`,
      waToken, phoneNumberId);
    console.log(`[woofparade founder broadcast]: ${m[1]}`);
    return true;
  }

  return false; // not a founder command — let normal flow proceed
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function getBotName(ctx) {
  return ctx.cart?.woofparade?.pupProfile?.botName || DEFAULT_BOT_NAME;
}

function generateOrderId(phone) {
  const last6 = (phone || '').slice(-6).padStart(6, '0');
  const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  return `${ORDER_PREFIX}-${last6}-${rand}`;
}

function calcShipping(subtotal) {
  return subtotal >= SHIPPING_FREE_THRESHOLD ? 0 : SHIPPING_FEE;
}

function applyDiscount(subtotal, itemCount) {
  // Pick the BIGGER of WOOF15 vs festival sale per PDF.
  const woof15Amt = subtotal * (WOOF15_PERCENT / 100);
  let festAmt = 0;
  let festLabel = '';
  if (FESTIVAL_SALE_ON) {
    if (itemCount >= 2) {
      festAmt = subtotal * (FESTIVAL_B2_PERCENT / 100);
      festLabel = `Buy 2+ ${FESTIVAL_B2_PERCENT}%`;
    } else if (itemCount === 1) {
      festAmt = subtotal * (FESTIVAL_B1_PERCENT / 100);
      festLabel = `Buy 1 ${FESTIVAL_B1_PERCENT}%`;
    }
  }
  if (woof15Amt >= festAmt && woof15Amt > 0) {
    return {
      amount: Math.round(woof15Amt),
      label: `WOOF15 ${WOOF15_PERCENT}%`,
      transparency: `Using my secret WOOF15 — it beat today's festival offer 🎉`,
    };
  }
  if (festAmt > 0) {
    return {
      amount: Math.round(festAmt),
      label: festLabel,
      transparency: `There's a live sale running, already auto-applied for you (better than my secret WOOF15, so I've put the bigger one on) 🎉`,
    };
  }
  return { amount: 0, label: '', transparency: '' };
}

function formatCartSummary(items) {
  if (!items || !items.length) return '_Empty_';
  let total = 0;
  const lines = items.map(it => {
    total += it.price || 0;
    if (it.kind === 'product') {
      const sz = it.size ? ` (${it.size})` : '';
      return `• ${it.productTitle}${sz} — ${formatPrice(it.price)}`;
    }
    return `• ${it.title || 'Item'} — ${formatPrice(it.price)}`;
  });
  lines.push('');
  lines.push(`*Subtotal*: ${formatPrice(total)}`);
  return lines.join('\n');
}

function formatRecentHistory(history) {
  return (history || []).slice(-6).map(m => {
    const role = m.role === 'user' ? 'Customer' : 'Bot';
    return `${role}: ${(m.content || '').slice(0, 200)}`;
  }).join('\n') || '(no history)';
}

async function pingTeam(ctx, role, body) {
  // role: 'apurv' | 'designer' (anouttama) | 'kashmira'
  // Suppresses send when in test mode.
  if (ctx?.testMode) {
    console.log(`[woofparade testMode] would have pinged ${role}:\n${body}`);
    return;
  }
  const phone = role === 'apurv' ? APURV_PHONE
              : role === 'designer' ? ANOUTTAMA_PHONE
              : role === 'kashmira' ? KASHMIRA_PHONE
              : null;
  if (!phone) {
    console.log(`[woofparade] ${role.toUpperCase()}_PHONE not set — would have sent:\n${body}`);
    return;
  }
  try {
    await sendMessage(phone, body, ctx.waToken, ctx.phoneNumberId);
    console.log(`[woofparade] pinged ${role} (${phone})`);
  } catch (e) {
    console.error(`[woofparade] ping ${role} failed:`, e.message);
  }
}

// ─── Claude-powered bulk address parser ────────────────────────────────────

async function bulkParseAddress(text) {
  const msg = (text || '').trim();
  if (msg.length < 15 || !/\d{6}/.test(msg)) return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const sys =
      "Extract the customer's shipping details from their message. " +
      "Reply with ONLY a JSON object: " +
      '{"name":"...","address1":"...","city":"...","state":"...","pin":"......"}. ' +
      "If any field is missing, set it to null. " +
      "name = full name; address1 = house/flat/street/area; city = city only; " +
      "state = Indian state; pin = 6-digit pincode as string.";

    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: sys,
      messages: [{ role: 'user', content: msg }],
    });
    const raw = (r.content[0]?.text || '').trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return null; }

    const { name, address1, city, state, pin } = parsed || {};
    if (!name || !address1 || !city || !state || !pin) return null;
    const pinClean = String(pin).replace(/\D/g, '');
    if (pinClean.length !== 6) return null;
    if (String(name).trim().length < 2) return null;

    return {
      name: String(name).trim(),
      address1: String(address1).trim(),
      city: String(city).trim(),
      state: String(state).trim(),
      pin: pinClean,
    };
  } catch (e) {
    console.error('[woofparade bulkParseAddress] error:', e.message);
    return null;
  }
}

// ─── DB HELPERS (purchase history, pup profiles, pause state, stats) ──────

const { pool } = require('../db');

function hasPurchasedBefore(ctx) {
  // Sync-ish guard — returns a Promise that the caller awaits.
  return (async () => {
    try {
      const r = await pool.query(
        `SELECT 1 FROM orders WHERE tenant_id = $1 AND customer_phone = $2 AND status = 'paid' LIMIT 1`,
        [ctx.tenant.id, ctx.from]
      );
      return r.rows.length > 0;
    } catch (e) {
      console.error('[woofparade hasPurchasedBefore] error:', e.message);
      return false;
    }
  })();
}

async function getCustomerPupProfiles(ctx) {
  try {
    const r = await pool.query(
      `SELECT pup_name, breed, dob FROM pup_profiles WHERE tenant_id = $1 AND customer_phone = $2 ORDER BY created_at`,
      [ctx.tenant.id, ctx.from]
    );
    return r.rows;
  } catch (e) {
    // Table may not exist yet
    console.error('[woofparade getCustomerPupProfiles] error:', e.message);
    return [];
  }
}


async function getLastOrderSummary(ctx) {
  // S03 Branch A: returns { pupName, productTitle } from most recent paid order, or null.
  try {
    const r = await pool.query(
      `SELECT pup_name, items_json, created_at
         FROM orders
        WHERE tenant_id = $1 AND customer_phone = $2 AND status = 'paid'
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.tenant.id, ctx.from]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let firstItem = null;
    try {
      const items = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json;
      if (Array.isArray(items) && items.length > 0) firstItem = items[0]?.title || items[0]?.name || null;
    } catch (_) {}
    return { pupName: row.pup_name || null, productTitle: firstItem };
  } catch (e) {
    console.error('[woofparade getLastOrderSummary] error:', e.message);
    return null;
  }
}

async function savePupProfile(tenantId, customerPhone, pupName, breed = null, dob = null) {
  await pool.query(
    `INSERT INTO pup_profiles (tenant_id, customer_phone, pup_name, breed, dob)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, customerPhone, pupName, breed, dob]
  );
}

async function isBotPaused(tenantId) {
  try {
    const r = await pool.query(
      `SELECT paused_until FROM woofparade_bot_state WHERE tenant_id = $1`,
      [tenantId]
    );
    const until = r.rows[0]?.paused_until;
    if (!until) return false;
    return new Date(until) > new Date();
  } catch (e) {
    // table may not exist
    return false;
  }
}

async function getBotPauseUntil(tenantId) {
  try {
    const r = await pool.query(
      `SELECT paused_until FROM woofparade_bot_state WHERE tenant_id = $1`,
      [tenantId]
    );
    return r.rows[0]?.paused_until ? new Date(r.rows[0].paused_until) : null;
  } catch (e) {
    return null;
  }
}

async function setBotPause(tenantId, until) {
  try {
    await pool.query(
      `INSERT INTO woofparade_bot_state (tenant_id, paused_until)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET paused_until = $2`,
      [tenantId, until]
    );
  } catch (e) {
    console.error('[woofparade setBotPause] error:', e.message);
  }
}

async function getStats(tenantId, period) {
  // period: 'today' | 'week' | 'month'
  const interval = period === 'today' ? '1 day' : period === 'week' ? '7 days' : '30 days';
  try {
    const orders = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS rev
       FROM orders WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '${interval}'`,
      [tenantId]
    );
    const convs = await pool.query(
      `SELECT COUNT(*) AS n FROM conversations
       WHERE tenant_id = $1 AND last_active > NOW() - INTERVAL '${interval}'`,
      [tenantId]
    );
    return {
      conversations: parseInt(convs.rows[0]?.n || 0, 10),
      orders: parseInt(orders.rows[0]?.n || 0, 10),
      revenue: parseFloat(orders.rows[0]?.rev || 0),
    };
  } catch (e) {
    console.error('[woofparade getStats] error:', e.message);
    return { conversations: 0, orders: 0, revenue: 0 };
  }
}

async function getRecentChats(tenantId, n) {
  try {
    const r = await pool.query(
      `SELECT customer_phone, last_active FROM conversations
       WHERE tenant_id = $1 ORDER BY last_active DESC LIMIT $2`,
      [tenantId, n]
    );
    return r.rows;
  } catch (e) {
    return [];
  }
}

module.exports = { handle };
