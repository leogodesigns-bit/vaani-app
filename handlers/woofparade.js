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
const { sendTemplateOrFreeform } = require('../templates');
const { getConversation, upsertConversation, saveOrder,
  saveShopifyDraftRef, getOrder, markOrderPaid, saveNotifyRequest,
  scheduleNudge, cancelNudges,
  saveOptIn, tagOrderToPup, savePupNote } = require('../db');
const { detectLanguage } = require('../ai');
const Anthropic = require('@anthropic-ai/sdk');
const edge = require('./woofparade-edge');
const qa = require('./woofparade-qa');
const variantsModule = require('./woofparade-variants');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { getCollectionProducts, getProductByHandle, getProducts, formatPrice, stripHtml , createCheckoutDraftOrder, createCustomOrderDraft, updateDraftOrderPrice} = require('../shopify');

// ─── S12 PDF v1.4: Custom Order fabrics ────────────────────────────────────
// 8 fabrics in PDF order. photoUrl=null = text-only fallback (HEIC files not
// accepted by WhatsApp Media API even with &format=jpg; or "Something Different"
// which is a custom request by design). Swap URLs here if Shopify reorganizes.
const WOOFPARADE_FABRICS = [
  { id: 'fabric_red_banarasi',         name: 'Red Banarasi',         photoUrl: 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/swatch-red-banarasi_jpg.jpg?v=1773464065',                    description: 'Soft fabric with traditional gold weave — perfect for weddings and festive evenings.' },
  { id: 'fabric_lavender_grace',       name: 'Lavender Grace',       photoUrl: 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/swatch-lavender-grace.jpg?v=1773464068',                       description: 'Delicate lavender Banarasi with gold accents — soft, regal, occasion-ready.' },
  { id: 'fabric_black_assamese',       name: 'Black Assamese',       photoUrl: 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/swatch-black-assamese.jpg?v=1773464067',                       description: 'Classic Assamese weave in deep black with woven motifs — bold and festive.' },
  { id: 'fabric_blue_leheriya',        name: 'Blue Leheriya',        photoUrl: null,                                                                                                                  description: 'Traditional Rajasthani leheriya in blue — playful wave pattern, light and festive. (Photo coming soon — Kashmira to re-upload as JPG.)' },
  { id: 'fabric_multicolour_bandhani', name: 'Multicolour Bandhani', photoUrl: null,                                                                                                                  description: 'Vibrant bandhani tie-dye in multicolour — joyful, festive, eye-catching. (Photo coming soon — Kashmira to re-upload as JPG.)' },
  { id: 'fabric_dazzling_yellow',      name: 'Dazzling Yellow',      photoUrl: 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/WhatsApp_Image_2026-03-30_at_14.56.58.jpg?v=1774864048',       description: 'Bright golden yellow weave — celebratory, perfect for haldi and festive shoots.' },
  { id: 'fabric_pink_bandhani',        name: 'Pink Bandhani',        photoUrl: 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/pink_bandhani.jpg?v=1774860713',                                description: 'Classic pink bandhani — feminine, traditional, photographs beautifully.' },
  { id: 'fabric_something_different',  name: 'Something Different',  photoUrl: null,                                                                                                                  description: "Want something not on this list? Tell Anouttama what you're imagining and they'll bring it to life." },
];
const FABRIC_BY_ID = Object.fromEntries(WOOFPARADE_FABRICS.map(f => [f.id, f]));

const { getTenantSettings } = require('../settings-cache');

// ─── BRAND CONSTANTS ──────────────────────────────────────────────────────

const BRAND_NAME = 'The Woof Parade';
const DEFAULT_BOT_NAME = 'Rio';     // golden retriever co-founder
const ALT_BOT_NAME     = 'Biscuit'; // sub-persona when customer's pup is also named Rio
const ORDER_PREFIX = 'WOOF';        // WOOF-XXXXXX-XXX
const PAW = '🐾';

const GREETING_RE = edge.GREETING_RE;

// S03 Branch A.1 — detect positive response from returning customer
const POSITIVE_RESPONSE_RE = /\b(love(d|s|ly)?|loves it|great fit|fits great|fits well|fits perfectly|perfect fit|looks (great|amazing|cute|beautiful|stunning|fab|fabulous|gorgeous)|adore|obsessed|happy|thrilled|delighted|amazing|wonderful|fantastic|brilliant|so cute|sooo cute|too cute|awesome|fab)\b/i;

// S03 Branch A.1 — detect neutral/negative response (DO NOT ask for review)
const NEGATIVE_RESPONSE_RE = /\b(not great|didn't fit|doesn'?t fit|too (tight|loose|small|big)|return|refund|disappointed|unhappy|wrong|bad|terrible|awful|hate|defective|damaged|torn)\b/i;

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
  [WELCOME_ROW.FESTIVE]:     'Festive Fits',
  [WELCOME_ROW.ACCESSORIES]: 'Accessories',
  [WELCOME_ROW.IPL]:         'Seasonal Wear',
  [WELCOME_ROW.CUSTOM]:      'Custom Fit',
  [WELCOME_ROW.BESTSELLERS]: 'Bestsellers',
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
};

// ─── PRODUCT CARD / DETAIL BUTTONS ────────────────────────────────────────

const PRODUCT_BTN = {
  SHOW_3_MORE:    'Show more',
  BACK_TO_MENU:   'Back to menu',
  BACK:           'Back',
  ADD_S:    'XS', ADD_S2: 'S', ADD_M: 'M',
  ADD_L:    'L',  ADD_XL: 'XL', ADD_2XL: '2XL',
  HELP_SIZING:    'Need help sizing',
};

// Jersey sizes per memory: XS, S, M, L, XL, 2XL.
const ALL_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

const PICKED_BTN = {
  ACCESSORIES:    'Accessories',
  CONTINUE:       'Continue shopping',
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

// PATCH 24 — Per-category size charts. Mirrors the Interactive Size Finder
// widget on woofparade.com (assets/twp-size-guide.liquid) EXACTLY. Source of
// truth is the widget; if the widget changes, update these together.
//
// Categories (priority order, first hit wins):
//   harness → bandana → jersey → posh (SHIRT but not jersey) → ethnic (default)
//   leash/collar → no size guide (caller handles)
//
// Single-row format for clothes: { key, name, length, chest, neck } — target
// sizes the garment is cut to. Match: chest <= row.chest AND neck <= row.neck+1.
// Harness uses ranges: { key, name, cMin, cMax, nMin, nMax }.
// Bandana uses neck range only.
const SIZE_CHARTS_BY_CATEGORY = {
  ethnic: [
    { key: 'XS',  name: 'Extra Small (XS)', length: 13, chest: 22, neck: 14 },
    { key: 'S',   name: 'Small (S)',         length: 16, chest: 24, neck: 15 },
    { key: 'M',   name: 'Medium (M)',        length: 20, chest: 27, neck: 19 },
    { key: 'L',   name: 'Large (L)',         length: 24, chest: 30, neck: 22 },
    { key: 'XL',  name: 'Extra Large (XL)',  length: 26, chest: 36, neck: 25 },
    { key: '2XL', name: 'Double XL (2XL)',   length: 28, chest: 38, neck: 28 },
  ],
  posh: [
    { key: 'S',   name: 'Small (S)',         length: 16, chest: 24, neck: 15 },
    { key: 'M',   name: 'Medium (M)',        length: 20, chest: 28, neck: 20 },
    { key: 'L',   name: 'Large (L)',         length: 24, chest: 30, neck: 22 },
    { key: 'XL',  name: 'Extra Large (XL)',  length: 26, chest: 37, neck: 25 },
    { key: '2XL', name: 'Double XL (2XL)',   length: 28, chest: 41, neck: 30 },
  ],
  jersey: [
    { key: 'XS',  name: 'Extra Small (XS)', length: 16, chest: 25, neck: 16 },
    { key: 'S',   name: 'Small (S)',         length: 18, chest: 27, neck: 18 },
    { key: 'M',   name: 'Medium (M)',        length: 20, chest: 31, neck: 21 },
    { key: 'L',   name: 'Large (L)',         length: 22, chest: 34, neck: 24 },
    { key: 'XL',  name: 'Extra Large (XL)',  length: 24, chest: 38, neck: 26 },
    { key: '2XL', name: 'Double XL (2XL)',   length: 26, chest: 40, neck: 28 },
  ],
  harness: [
    { key: 'S',  name: 'Small (S)',         cMin: 13, cMax: 25, nMin: 12, nMax: 18 },
    { key: 'M',  name: 'Medium (M)',        cMin: 17, cMax: 29, nMin: 14, nMax: 21 },
    { key: 'L',  name: 'Large (L)',         cMin: 19, cMax: 34, nMin: 16, nMax: 25 },
    { key: 'XL', name: 'Extra Large (XL)',  cMin: 21, cMax: 40, nMin: 19, nMax: 28 },
  ],
  bandana: [
    { key: 'M',  name: 'Medium (M)', nMin: 14, nMax: 20 },
    { key: 'L',  name: 'Large (L)',  nMin: 20, nMax: 24 },
  ],
};

// PATCH 24 — Size guide image (Shopify CDN, same one the website widget uses).
// Sent at S07 start AND when customer asks "how do I measure".
const MEASURE_IMG_URL = 'https://cdn.shopify.com/s/files/1/1000/6475/6006/files/Gemini_Generated_Image_ua6e2vua6e2vua6e.png?v=1779443190';
const MEASURE_IMG_CAPTION = 'How to measure your pup — neck, chest, length & arm hole';

// PATCH 24 — Detect product category from title. Mirrors the Liquid logic in
// the widget (assets/twp-size-guide.liquid):
//   - HARNESS  → harness
//   - BANDANA  → bandana
//   - JERSEY   → jersey
//   - SHIRT (not JERSEY) → posh
//   - LEASH or COLLAR → no_size_guide
//   - everything else (KURTA etc.) → ethnic
function categorizeProduct(productTitle) {
  const t = String(productTitle || '').toUpperCase();
  if (!t) return 'ethnic';  // safe default when no product context
  if (t.includes('HARNESS')) return 'harness';
  if (t.includes('BANDANA')) return 'bandana';
  if (t.includes('JERSEY'))  return 'jersey';
  if (t.includes('SHIRT'))   return 'posh';  // SHIRT-but-not-JERSEY (already returned above)
  if (t.includes('LEASH') || t.includes('COLLAR')) return 'no_size_guide';
  return 'ethnic';
}

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
  // S10 PDF v1.4 verbatim: "Sure! I'll need a delivery address.\nCould you share:..."
  `Sure! I'll need a delivery address.\n` +
  `Could you share:\n` +
  `1. Full name\n` +
  `2. Address\n` +
  `3. City + State\n` +
  `4. PIN code\n` +
  `5. Phone (different from WhatsApp, if any)`;

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
// Apurv +91 73871 66499; Kashmira +91 88888 16399. Set in Railway env.
// If unset, alerts go to console only (handy for local dev).
const APURV_PHONE     = process.env.APURV_PHONE     || null; // ops + custom design + everything except founder commands
const KASHMIRA_PHONE  = process.env.KASHMIRA_PHONE  || null; // founder line + SOS escalation + founder commands

// Press email (S22) — TBC per PDF Section 7.
const PRESS_EMAIL = process.env.WOOFPARADE_PRESS_EMAIL || 'hello@thewoofparade.com';

// Pagination.
const PAGE_SIZE = 3;
const MAX_PRODUCTS_PER_CAT = 12;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────

async function handle(ctx) {
  const { tenant, message, from, text } = ctx;

  // S14 — user is active again, kill any pending IN-WINDOW silence-nudges
  // (Branch A and Branch B) for them. Do NOT cancel day-14 — per PDF that
  // fires 14 days after first contact regardless of intervening activity.
  // Fire-and-forget; failures shouldn't block the message flow.
  cancelNudges(tenant.id, from, 's14_branch_a_pre_shortlist', 'user_active')
    .catch(e => console.error('[woofparade S14] cancel branch_a failed:', e.message));
  cancelNudges(tenant.id, from, 's14_branch_b_post_shortlist', 'user_active')
    .catch(e => console.error('[woofparade S14] cancel branch_b failed:', e.message));

  // S16 mute window: if a team member is currently dealing with this customer,
  // stay quiet so Vaani doesn't talk over them. Window is 30min from when
  // handleTalkToHuman was last called.
  const handoffUntil = ctx.cart?.woofparade?.humanHandoffUntil;
  if (handoffUntil && Date.now() < handoffUntil) {
    console.log(`[woofparade S16] human handoff active until ${new Date(handoffUntil).toISOString()} — suppressing auto-reply for ${from}`);
    return;
  }

  if (tenant.flow_template !== 'woofparade') {
    console.error(
      `❌ woofparade.handle called for wrong tenant: ${tenant.shop_domain} ` +
      `(flow_template=${tenant.flow_template})`
    );
    return;
  }

  console.log(`[woofparade] ${tenant.shop_domain} — from ${from}: ${text}`);

  // PATCH 22 — S25 language detection. Used by built-in FAQ path below for
  // a short same-language lead-in. Full Hindi/Marathi support = v1.5.
  ctx.detectedLang = detectLanguage(text || '');
  if (ctx.detectedLang !== 'english') {
    console.log(`[woofparade S25] detected lang=${ctx.detectedLang} for ${from}`);
  }

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

  // ─── PATCH 31: OWNER APPROVE COMMAND (Apurv or Kashmira) — S02 draft approval ───
  // Formats:
  //   approved                  — approve latest pending draft for this tenant, send invoice as-is
  //   approved 3500             — same + set Custom Order price to ₹3500 first
  //   approve <draft_id>        — explicit draft, send invoice as-is
  //   approve <draft_id> 3500   — explicit draft + set price first
  if ((APURV_PHONE && from === APURV_PHONE) || (KASHMIRA_PHONE && from === KASHMIRA_PHONE)) {
    const lc = trimmed.toLowerCase();
    let am;
    // approve <id> [price]
    am = lc.match(/^approve\s+(\d{6,})(?:\s+(\d+(?:\.\d+)?))?\s*$/);
    if (am) {
      await handleApproveDraft(ctx, { draftId: am[1], newPrice: am[2] ? Number(am[2]) : null });
      return;
    }
    // approved [price]
    am = lc.match(/^approved(?:\s+(\d+(?:\.\d+)?))?\s*$/);
    if (am) {
      await handleApproveDraft(ctx, { draftId: null, newPrice: am[1] ? Number(am[1]) : null });
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
    // PATCH 19: 24hr auto-expire — stale mute clears unconditionally
    const MUTE_TTL_MS = 24 * 60 * 60 * 1000;
    const mutedAt = ctx.cart?.woofparade?.mutedAt || 0;
    if (mutedAt > 0 && (Date.now() - mutedAt) >= MUTE_TTL_MS) {
      ctx.cart = ctx.cart || {};
      ctx.cart.woofparade = ctx.cart.woofparade || {};
      delete ctx.cart.woofparade.muted;
      delete ctx.cart.woofparade.mutedAt;
      delete ctx.cart.woofparade.offTopicCount;
      console.log(`[woofparade] mute auto-expired (24h) for ${from}`);
    } else if (isInteractive || qa.isDogRelated(trimmed)) {
      ctx.cart = ctx.cart || {};
      ctx.cart.woofparade = ctx.cart.woofparade || {};
      delete ctx.cart.woofparade.muted;
      delete ctx.cart.woofparade.mutedAt;
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

  // ─── S03 BRANCH A.1 — positive response after returning customer welcome ─
  // If customer just received returning-welcome (Branch A) and their reply is positive,
  // Rio asks for a photo/review. Negative → silent route to Apurv (no review push).
  if (ctx.cart?.woofparade?.lastBranchA && !isInteractive && trimmed.length > 0) {
    if (NEGATIVE_RESPONSE_RE.test(trimmed)) {
      ctx.cart = ctx.cart || {}; ctx.cart.woofparade = ctx.cart.woofparade || {};
      delete ctx.cart.woofparade.lastBranchA;
      await sendMessage(from,
        `Oh — I'm sorry to hear that ${PAW} Apurv from our team will reach out shortly to make this right.`,
        ctx.waToken, ctx.phoneNumberId);
      const body = `⚠️ *RETURNING CUSTOMER ISSUE*\nFrom: +${from}\nLast product feedback was negative.\n\nRecent chat:\n${formatRecentHistory(ctx.history)}`;
      await pingTeam(ctx, 'apurv', body, { sosType: 'RETURNING CUSTOMER ISSUE', summary: 'Negative feedback after returning-welcome' });
      await upsertConversation(ctx.tenant.id, from, [
        ...ctx.history,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '[woofparade S03A.1 negative — routed to Apurv]' },
      ], ctx.cart);
      return;
    }
    if (POSITIVE_RESPONSE_RE.test(trimmed)) {
      ctx.cart = ctx.cart || {}; ctx.cart.woofparade = ctx.cart.woofparade || {};
      const pupName = ctx.cart.woofparade.lastBranchAPupName || 'them';
      delete ctx.cart.woofparade.lastBranchA;
      await sendMessage(from,
        `That just made my tail wag ${PAW}\n` +
        `Would you mind sharing a quick photo or a review?\n` +
        `It helps other pup parents — and we'd love to feature ${pupName} on our page (with your permission, of course).`,
        ctx.waToken, ctx.phoneNumberId);
      await sendButtons(from, 'Choose:',
        [POSTPURCHASE_BTN.SHARE_PHOTO, POSTPURCHASE_BTN.LEAVE_REVIEW, POSTPURCHASE_BTN.MAYBE_LATER],
        ctx.waToken, ctx.phoneNumberId);
      await upsertConversation(ctx.tenant.id, from, [
        ...ctx.history,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '[woofparade S03A.1 positive — asked for photo/review]' },
      ], ctx.cart);
      return;
    }
    // Neither positive nor negative — clear the flag, fall through to normal dispatch
    delete ctx.cart.woofparade.lastBranchA;
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

  // PATCH 26 — "Pick a time" free-text reply for sizing reminder
  if (ctx.cart?.woofparade?.sizing?.awaitingRemindTime && !isInteractive) {
    await handleSizingRemindTimeMessage(ctx);
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
  }
  if (listReplyId === WELCOME_ROW.CUSTOM || /^custom\s*fit\b/i.test(trimmed) || /^custom\b/i.test(trimmed)) {
    await handleCustomFitStart(ctx);
    return;
  }
  if (/^(chat\s+(it\s+through|with\s+me|through\s+with)|chat\s+through)/i.test(trimmed)) {
    await handleCustomChatStart(ctx);
    return;
  }
  if (trimmed === 'Use website form' || trimmed === 'Fill the form') {
    await sendMessage(ctx.from,
      `Pawfect — here's the link ${PAW}\nhttps://thewoofparade.com/pages/custom-order\n\nOnce you submit, I'll pick it up here and Anouttama will reach out shortly.`,
      ctx.waToken, ctx.phoneNumberId);
    return;
  }
  // S12 PDF v1.4 Branch B step 3: fabric pick → send photo (if available)
  // + description, then "All set" PDF-verbatim message + Anouttama notification.
  if (listReplyId && FABRIC_BY_ID[listReplyId]) {
    const fabric = FABRIC_BY_ID[listReplyId];
    const r = ctx.cart?.woofparade || {};
    const custom = r.custom || {};
    const pupName = custom.pupName || 'your pup';

    // Send fabric photo if available, else just description.
    if (fabric.photoUrl) {
      try {
        await sendImage(ctx.from, fabric.photoUrl, `${fabric.name} ${PAW}\n${fabric.description}`, ctx.waToken, ctx.phoneNumberId);
      } catch (e) {
        console.error('[woofparade S12] sendImage failed for', fabric.name, e.message);
        await sendMessage(ctx.from, `*${fabric.name}* ${PAW}\n${fabric.description}`, ctx.waToken, ctx.phoneNumberId);
      }
    } else {
      await sendMessage(ctx.from, `*${fabric.name}* ${PAW}\n${fabric.description}`, ctx.waToken, ctx.phoneNumberId);
    }

    // PDF S12 verbatim closer
    await sendMessage(ctx.from,
      `All set ${PAW}\nAnouttama will sniff this out shortly and get back to you to take this forward ✨`,
      ctx.waToken, ctx.phoneNumberId);

    // Anouttama notification with full measurements (incl. armhole per PDF S12)
    const m2 = custom.measurements || {};
    const measLine = [
      m2.back && `Back: ${m2.back}"`,
      m2.chest && `Chest: ${m2.chest}"`,
      m2.neck && `Neck: ${m2.neck}"`,
      m2.armhole && `Armhole: ${m2.armhole}"`,
      m2.weight && `Weight: ${m2.weight}kg`,
    ].filter(Boolean).join(', ') || '(not provided)';

    await pingTeam(ctx, 'designer',
      `🎨 *Custom order — Woof Parade* (S12 via WhatsApp)\n\n` +
      `Customer: +${from}\n` +
      `Pup: ${pupName}\n` +
      `Style: ${custom.style || '(not specified)'}\n` +
      `Fabric: ${fabric.name}\n` +
      `Measurements: ${measLine}\n` +
      `Occasion: ${custom.occasion || '(not specified)'}\n\n` +
      `Chat: https://wa.me/${from}`,
      { sosType: 'CUSTOM ORDER', summary: 'Custom order intake from S12 chat flow' });
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
  if (trimmed === 'Continue' || trimmed === 'Continue where I left off' || trimmed === 'Continue where I lef' || listReplyId === 'continue_where_left_off') {
    await handleContinueWhereLeftOff(ctx);
    return;
  }
  if (trimmed === 'Browse fresh') {
    // Patch 40: bypass sendWelcome (which would fire S03 returning-welcome again
    // and create a loop). Show category picker directly.
    const { from, phoneNumberId, waToken } = ctx;
    await sendList(from, `Have a peek ${PAW} what's your pup after?`, [{
      title: 'Browse',
      rows: [
        { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Fits for everyday' },
        { id: WELCOME_ROW.FESTIVE,     title: 'Festive Fits',    description: 'Kurtas, frocks, lehengas' },
        { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, leashes' },
        { id: WELCOME_ROW.CUSTOM,      title: 'Custom outfit',   description: 'Made to measure' },
      ],
    }], waToken, phoneNumberId);
    return;
  }

  // Product picker rows (numbered list under category carousel)
  if (listReplyId && listReplyId.startsWith('product_') && !listReplyId.startsWith('product_size_')) {
    const handle = listReplyId.replace(/^product_/, '');
    await sendProductDetail(ctx, handle);
    return;
  }

    // PATCH 52b: two-step color → size picker — step 1 (color tap)
  if (ctx.cart?.woofparade?.awaitingColorPick) {
    const pickState = ctx.cart.woofparade.awaitingColorPick;
    const trimmedLocal = String(ctx.text || '').trim();
    const pickedColor = (pickState.colors || []).find(c =>
      c === trimmedLocal || ('color_' + c) === listReplyId
    );
    if (pickedColor) {
      try {
        const fetched = await getProductByHandle(ctx.tenant, pickState.handle);
        const sizes = await variantsModule.sendSizePickerForColor(
          ctx, fetched, pickedColor,
          { sendMessage, sendButtons, sendList }
        );
        await upsertConversation(ctx.tenant.id, ctx.from, [
          ...(ctx.history || []),
          { role: 'user', content: ctx.text || '' },
          { role: 'assistant', content: '[woofparade p52b color_picked=' + pickedColor + ' sizes=' + sizes.length + ']' },
        ], {
          ...(ctx.cart || {}),
          woofparade: {
            ...(ctx.cart.woofparade || {}),
            awaitingColorPick: null,
            awaitingSizeAfterColor: { handle: pickState.handle, color: pickedColor, sizes },
          },
        });
      } catch (e) {
        console.error('[woofparade P52b] color pick failed:', e.message);
        await sendMessage(ctx.from,
          `Hmm — something went sideways picking that ${PAW} Try again or tap Back to menu.`,
          ctx.waToken, ctx.phoneNumberId);
      }
      return;
    }
  }

  // PATCH 52b: two-step picker — step 2 (size tap after color)
  if (ctx.cart?.woofparade?.awaitingSizeAfterColor) {
    const pickState = ctx.cart.woofparade.awaitingSizeAfterColor;
    const trimmedLocal = String(ctx.text || '').trim();
    const pickedSize = (pickState.sizes || []).find(sz =>
      sz === trimmedLocal || ('sizeac_' + sz) === listReplyId
    );
    if (pickedSize) {
      try {
        const fetched = await getProductByHandle(ctx.tenant, pickState.handle);
        const variant = variantsModule.findVariant(fetched, pickState.color, pickedSize);
        if (!variant) {
          await sendMessage(ctx.from,
            `Aw — ${pickState.color} in ${pickedSize} just sold out ${PAW} Tap another size or pick a different color.`,
            ctx.waToken, ctx.phoneNumberId);
          return;
        }
        ctx.cart.woofparade.preselectedVariantId = String(variant.id);
        ctx.cart.woofparade.preselectedVariantTitle = pickState.color + ' / ' + pickedSize;
        ctx.cart.woofparade.awaitingSizeAfterColor = null;
        await upsertConversation(ctx.tenant.id, ctx.from, ctx.history || [], { ...(ctx.cart || {}) });
        await handleSizePick(ctx, pickedSize);
      } catch (e) {
        console.error('[woofparade P52b] size-after-color pick failed:', e.message);
        await sendMessage(ctx.from,
          `Hmm — couldnt add that ${PAW} Try again or tap Back to menu.`,
          ctx.waToken, ctx.phoneNumberId);
      }
      return;
    }
  }

  // PATCH 50 (fixed): tap on a variant title while picker is active.
  // NOTE: uses ctx.cart, not bare cart — main handle() does not destructure cart at top.
  if (ctx.cart?.woofparade?.awaitingVariantPick && ctx.cart?.woofparade?.variantChoices) {
    const choice = (ctx.cart.woofparade.variantChoices || []).find(c =>
      c.title === trimmed || c.id === buttonReplyId || c.id === listReplyId
    );
    if (choice) {
      ctx.cart.woofparade.preselectedVariantId = choice.variantId;
      ctx.cart.woofparade.preselectedVariantTitle = choice.title;
      ctx.cart.woofparade.awaitingVariantPick = false;
      ctx.cart.woofparade.variantChoices = null;
      await handleSizePick(ctx, '__NO_SIZE__');
      return;
    }
  }

  // PATCH 42 + PATCH 50 (fixed in 50.2): 'Add to cart' for sizeless products.
  // Uses ctx.* throughout — handle() does not destructure cart/history/text/tenant at top.
  if (trimmed === 'Add to cart') {
    const r = ctx.cart?.woofparade || {};
    const product = r.product;
    if (product && product.handle) {
      try {
        const fetched = await getProductByHandle(ctx.tenant, product.handle);

        // PATCH 52b: divert to two-step picker if eligible
        if (variantsModule.needsTwoStepPicker(fetched)) {
          const colors = await variantsModule.sendColorPicker(
            ctx, fetched,
            { sendButtons, sendList }
          );
          await upsertConversation(ctx.tenant.id, ctx.from, [
            ...(ctx.history || []),
            { role: 'user', content: ctx.text || '' },
            { role: 'assistant', content: '[woofparade p52b color_picker presented=' + colors.length + ']' },
          ], {
            ...(ctx.cart || {}),
            woofparade: {
              ...(ctx.cart.woofparade || {}),
              awaitingColorPick: { handle: product.handle, colors },
              awaitingVariantPick: false,
              variantChoices: null,
            },
          });
          return;
        }
        const available = ((fetched && fetched.variants) || []).filter(v => v.available !== false);
        // Skip Size-based variants — those have their own flow.
        const nonSizeAvail = available.filter(v => {
          const opt = String(v.option1 || v.title || '').toUpperCase().trim();
          return !ALL_SIZES.includes(opt);
        });
        if (nonSizeAvail.length >= 2) {
          // PATCH 51: Build choice list with disambiguated labels.
          // For multi-option products (e.g. bandana with Color + Accessory size),
          // v.title is auto-joined as "Flash / M" — perfect. For single-option
          // products (Color only), v.title is just "Flash" — also fine.
          // But Shopify also returns v.title === v.option1 when there's only one
          // option, and when there are 2+ options the title joins them with " / ".
          // We prefer the joined title, fall back to option1, then 'Option'.
          //
          // Dedup by label: if multiple variants share the same final label
          // (data-quality issue in catalog), keep only the first — otherwise
          // customer sees identical buttons and can't choose.
          const rawChoices = nonSizeAvail.slice(0, 10).map(v => {
            const opts = [v.option1, v.option2, v.option3].filter(Boolean);
            const label = (v.title && v.title !== 'Default Title' && v.title !== v.option1)
              ? v.title
              : (opts.join(' / ') || v.option1 || 'Option');
            return {
              id: 'variant_' + v.id,
              title: String(label).slice(0, 24),
              variantId: String(v.id),
            };
          });
          const seen = new Set();
          const choices = rawChoices.filter(c => {
            if (seen.has(c.title)) return false;
            seen.add(c.title);
            return true;
          });
          if (choices.length < rawChoices.length) {
            console.log('[woofparade PATCH 51] deduped variant labels:',
              rawChoices.length, '->', choices.length, 'for', product.handle);
          }

          // Persist choices on cart so the tap-handler above can resolve them.
          // PATCH 50.2: use ctx.history / ctx.text / ctx.waToken / ctx.phoneNumberId / ctx.from / ctx.tenant
          //             — none of these are destructured at top of handle()
          await upsertConversation(ctx.tenant.id, ctx.from, [
            ...(ctx.history || []),
            { role: 'user', content: ctx.text || '' },
            { role: 'assistant', content: '[woofparade variant_picker presented=' + choices.length + ']' },
          ], {
            ...(ctx.cart || {}),
            woofparade: {
              ...r,
              awaitingVariantPick: true,
              variantChoices: choices,
            },
          });

          if (choices.length <= 3) {
            await sendButtons(ctx.from,
              `Which one for your pup? ${PAW}`,
              choices.map(c => c.title),
              ctx.waToken, ctx.phoneNumberId);
          } else {
            await sendList(ctx.from,
              `Which one for your pup? ${PAW}`,
              [{ title: 'Options', rows: choices.map(c => ({ id: c.id, title: c.title })) }],
              ctx.waToken, ctx.phoneNumberId, 'Pick one');
          }
          return;
        }
      } catch (e) {
        console.error('[woofparade PATCH 50] variant picker fetch failed:', e.message);
        // Fall through to auto-pick on error
      }
    }
    await handleSizePick(ctx, '__NO_SIZE__');
    return;
  }

  // Size button taps after product detail
  if (ALL_SIZES.includes(trimmed)) {
    await handleSizePick(ctx, trimmed);
    return;
  }
  // PATCH 25 — broadened sizing-intent detection.
  // Matches:
  //   • Exact button tap (PRODUCT_BTN.HELP_SIZING)
  //   • "I need sizing" / "need help sizing" / "need help with sizing" / "sizing help"
  //   • "Hi, I need help with sizing for <product>" (CTA from product page)
  //   • "can you help me with size" / "size help please" / "what size for my pup"
  // For CTA messages with a product hint, we extract the product name and
  // look it up in the Shopify catalog so per-category sizing (Patch 24)
  // picks the right table.
  if (trimmed === PRODUCT_BTN.HELP_SIZING ||
      /\b(siz(ing|e)\s+help|help\s+(me\s+)?(with\s+)?(siz(ing|e)|fit(ting)?)|need\s+(help\s+)?(with\s+)?(siz(ing|e)|fit)|what\s+siz(e|ing)|which\s+siz(e|ing)|fit\s+(help|guide))\b/i.test(trimmed)) {
    const productHint = extractProductHintFromSizingMsg(trimmed);
    if (productHint) {
      await handleSizingHelpFromCTA(ctx, productHint);
    } else {
      await handleSizingHelpStart(ctx);
    }
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
  if (trimmed === PICKED_BTN.ACCESSORIES || trimmed === 'Our accessories') {
    await handleCrossSell(ctx);
    return;
  }
  if (trimmed === PICKED_BTN.CONTINUE) {
    await handleContinueSection(ctx);
    return;
  }
  if (trimmed === PICKED_BTN.CHECKOUT || trimmed === 'Checkout' || trimmed === 'Checkout now') {
    await handleCheckout(ctx);
    return;
  }
  if (trimmed === CHECKOUT_BTN.PAY_NOW || trimmed === 'Pay now') {
    await handleCheckoutPayNow(ctx);
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

  // PDF v1.4 Bug #2 (Kashmira): customer types a number to pick a product from the cumulative list.
  // Numbers are global across all browsed pages within the session (resets on checkout).
  // e.g. customer browsed Jerseys 1-3 then Clothes 4-6, types "5" → pick handle at index 4.
  if (/^[1-9]\d*$/.test(trimmed)) {
    const handles = ctx.cart?.woofparade?.productHandles || [];
    const idx = parseInt(trimmed, 10) - 1;
    if (idx >= 0 && idx < handles.length) {
      await sendProductDetail(ctx, handles[idx]);
      return;
    }
    // Number was a digit but out of range — fall through to normal handling
    // (could be a size measurement, weight, address pincode, etc.)
  }

  // Show 3 more / pagination
  if (trimmed === PRODUCT_BTN.SHOW_3_MORE || trimmed === 'Show more' || trimmed === 'Show 3 more') {
    await handleShow3More(ctx);
    return;
  }
  if (trimmed === PRODUCT_BTN.BACK_TO_MENU || trimmed === 'Back to menu' || trimmed === 'Back') {
    await sendWelcome(ctx);
    return;
  }
  if (trimmed === 'Browse another category') {
    await sendWelcome(ctx);
    return;
  }
  // Patch 29 — Lehenga request (festive category trailing button)
  if (trimmed === 'Looking for a Lehenga?' || trimmed === 'View Lehengas') {
    await handleLehengaRequest(ctx);
    return;
  }
  // Patch 29 — Raincoats waitlist (seasonal category trailing button)
  if (trimmed === 'Notify me — Raincoats' || trimmed === 'Notify me — Raincoat') {
    await handleNotifyRaincoats(ctx);
    return;
  }
  if (trimmed === 'Talk to designer') {
    await handleTalkToDesigner(ctx);
    return;
  }
  if (trimmed === 'See full on website') {
    const r = ctx.cart?.woofparade || {};
    const lastHandle = r.categoryRowId ? CATEGORY_HANDLES[r.categoryRowId] : null;
    const url = lastHandle
      ? `https://${ctx.tenant.shop_domain || 'thewoofparade.com'}/collections/${lastHandle}`
      : `https://${ctx.tenant.shop_domain || 'thewoofparade.com'}/collections/all`;
    await sendMessage(ctx.from, `Tap to browse the full collection on our site ${PAW}\n${url}`, ctx.waToken, ctx.phoneNumberId);
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

  // PATCH 23 — bare WOOF-XXXXXX-XXX order ID typed by customer → S32 Branch 4.
  // The customer asked "where's my order?", got the prompt for an order number,
  // and just pasted the ID. Look it up and route to track-order flow.
  const _orderIdMatch = trimmed.match(/\b(WOOF-\d{6}-[A-Z0-9]{3})\b/i);
  if (_orderIdMatch) {
    ctx.cart = ctx.cart || {};
    ctx.cart.woofparade = ctx.cart.woofparade || {};
    ctx.cart.woofparade.lastOrderId = _orderIdMatch[1].toUpperCase();
    await handleTrackOrder(ctx);
    return;
  }

  // S35 — direct pincode question
  if (/\b\d{6}\b/.test(trimmed) && /(deliver|ship|cod|pincode|pin code)/i.test(trimmed)) {
    await handlePincodeCheck(ctx, trimmed.match(/\d{6}/)[0]);
    return;
  }

  // S13 — Notify when back in stock
  if (trimmed === ORDER_OPS_BTN.NOTIFY_BACK || trimmed === 'Notify me when back') {
    await handleNotifyMeBack(ctx);
    return;
  }

  // S23 — multi-pup intent ("I have 2 dogs, can I order for both?")
  if (/\b(\d+|two|three|both|multiple|several)\s+(dogs|pups|puppies|pets)\b/i.test(trimmed) ||
      /\bfor (both|all) (my |our )?(pups|dogs|pets)\b/i.test(trimmed)) {
    await handleMultiPup(ctx);
    return;
  }

  // S24 — cat owner ("I have a cat, will these fit?")
  if (/\b(have|own|got)\s+(a |my )?(cat|kitty|kitten)\b/i.test(trimmed) ||
      /\b(cat|kitty|kitten)s?\b.*\b(fit|wear|size|order)\b/i.test(trimmed) ||
      /\bfor (my )?(cat|kitty|kitten)\b/i.test(trimmed)) {
    await handleCatOwner(ctx);
    return;
  }

  // S20 — international opt-in
  if (/\b(ship|deliver|order|send).*(uk|usa|america|uae|canada|australia|singapore|international|overseas|abroad)\b/i.test(trimmed)) {
    await handleInternationalRequest(ctx);
    return;
  }
  if (trimmed === ORDER_OPS_BTN.YES_WHATSAPP) {
    // Route by the most-recent opt-in context flag set by either S20 or S35.
    const optKind = ctx.cart?.woofparade?.pendingOptInKind;
    if (optKind === 'pin_nonserviceable') {
      await handlePinNonserviceableOptIn(ctx);
    } else {
      await handleInternationalOptIn(ctx);
    }
    return;
  }
  if (trimmed === ORDER_OPS_BTN.NO_THANKS) {
    if (ctx.cart?.woofparade) delete ctx.cart.woofparade.pendingOptInKind;
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
  // Patch 49: "refund policy/process/timeline" are FAQ queries, not complaints.
  // Strategy: split into two branches —
  //   (a) clear complaint signals → always SOS regardless of "refund"/"return" mention
  //   (b) "refund" / "return"-as-action → SOS only if NOT framed as a policy question
  // FAQ-style "refund policy / return policy / refund process / how do refunds work"
  // fall through to qa.matchBuiltinFaq below.
  const isPolicyQuery = /\b(policy|policies|process|procedure|timeline|window|period|rule|rules|how (do|does|long)|what is|whats|tell me about)\b/i.test(trimmed);
  const hardComplaint = /\b(complain|complaint|not happy|disappointed|defective|damaged|torn|doesn'?t fit|too (tight|loose|small|big)|wrong (item|product|size)|broken|missing|never (got|received|came)|wrong order)\b/i.test(trimmed);
  const refundAction = /\b(refund|return|exchange)\b/i.test(trimmed) && !isPolicyQuery;
  if (hardComplaint || refundAction) {
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
    // PATCH 22 — S25 short same-language lead-in if customer wrote in Hindi/Hinglish/Marathi.
    if (ctx.detectedLang === 'hinglish' || ctx.detectedLang === 'hindi') {
      await sendMessage(from, `Bilkul batata hoon ${PAW}`, ctx.waToken, ctx.phoneNumberId);
    } else if (ctx.detectedLang === 'marathi') {
      await sendMessage(from, `Nakkich sangto ${PAW}`, ctx.waToken, ctx.phoneNumberId);
    }
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
      ctx.cart.woofparade.mutedAt = Date.now();
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
  // "Hey there! I'm Rio, co-founder of The Woof Parade 🐾 Showstopper mode activated — where shall we start?"
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const body =
    `Hey there! I'm ${getBotName(ctx)}, co-founder of ${BRAND_NAME} ${PAW}\n` +
    `Showstopper mode activated — where shall we start?`;
  await sendList(from, body, [{
    title: 'View categories',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Fits for everyday' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Fits',    description: 'Kurtas, frocks, lehengas' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, leashes' },
      { id: WELCOME_ROW.IPL,         title: 'Seasonal Wear',   description: 'Jerseys and Raincoats' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId, 'Browse Categories');
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
    // Branch A — flag so we can detect positive/negative follow-up (S03 Branch A.1)
    cart.woofparade = cart.woofparade || {};
    cart.woofparade.lastBranchA = true;
    cart.woofparade.lastBranchAPupName = pupName;
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

// S03 Branch C: chatted but never purchased — has product context
async function sendBranchCWelcome(ctx, lastProduct) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const body =
    `Welcome back ${PAW}\n` +
    `Last time you were checking out the ${lastProduct}. Want to:`;
  await sendButtons(from, body,
    ['Continue', 'Browse fresh', 'Order help'],
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade S03C welcome lastProduct=${lastProduct}]` },
  ], cart);
}

// S03 Branch C variant: chatted but never purchased — no product context yet
async function sendBranchCWelcomeNoProduct(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const body =
    `Welcome back ${PAW}\n` +
    `Good to see you again. What's your pup after today?`;
  await sendList(from, body, [{
    title: 'Browse',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Fits for everyday' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Fits',    description: 'Kurtas, frocks, lehengas' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, leashes' },
      { id: WELCOME_ROW.IPL,         title: 'Seasonal Wear',   description: 'Jerseys and Raincoats' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId, 'Browse Categories');
  await sendButtons(from, 'Or:',
    [WELCOME_BTN.ORDER_HELP, 'Just saying hi 🧡'],
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade S03C welcome no-product]' },
  ], cart);
}

async function sendWelcome(ctx) {
  // PATCH BUG-A: clear any sticky accessory subcat when returning to welcome
  if (ctx.cart?.woofparade) {
    ctx.cart.woofparade.accessorySubcat = null;
    ctx.cart.woofparade.awaitingAccessorySubcat = false;
  }
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const purchased = await hasPurchasedBefore(ctx);

  // S14 — schedule Branch A pre-shortlist nudge 30min out. Cancelled if user
  // shortlists (handleSizePick) or sends any message (top of handle()).
  // Fire-and-forget; cancelNudges inside scheduleNudge handles the supersede.
  const _r14 = cart?.woofparade || {};
  const _hasShortlist = Array.isArray(_r14.items) && _r14.items.length > 0;
  if (!_hasShortlist) {
    const _fireAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();  // +30min
    const _pupName = _r14.lastBranchAPupName || _r14.custom?.pupName || null;
    scheduleNudge(tenant.id, from, 's14_branch_a_pre_shortlist', _fireAt, { pupName: _pupName })
      .catch(e => console.error('[woofparade S14] schedule branch_a failed:', e.message));
  }

  // PATCH 23 — S14 day-14 final nudge. Fires 14 days after first contact
  // regardless of intervening activity (cart auto-clears day 15 per PDF page 15-16).
  // Cancelled on purchase, unsubscribe, or refreshed when shortlist is added.
  // scheduleNudge dedupes by (tenant, phone, kind) so re-running on every message
  // is safe — it'll either insert once or refresh fire_at.
  const _day14FireAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const _day14Pup = _r14.lastBranchAPupName || _r14.custom?.pupName || null;
  scheduleNudge(tenant.id, from, 's14_day14_final', _day14FireAt, { pupName: _day14Pup })
    .catch(e => console.error('[woofparade S14] schedule day14 failed:', e.message));


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
      // S03 Branch A/B: returning customer who purchased
      await sendReturningWelcome(ctx);
      return;
    }

    // S03 Branch C: chatted before but never purchased — look at conversation history
    const hasChatHistory = Array.isArray(history) && history.length > 2;
    const lastProduct = cart?.woofparade?.product?.title || null;
    if (hasChatHistory && lastProduct) {
      await sendBranchCWelcome(ctx, lastProduct);
      return;
    }
    if (hasChatHistory && !lastProduct) {
      // Chatted but no product context — softer welcome
      await sendBranchCWelcomeNoProduct(ctx);
      return;
    }

    // S04: first-time customer — random hi/hello
    baseBody =
      `Hey there! I'm ${getBotName(ctx)}, co-founder of ${BRAND_NAME} ${PAW}\n` +
      `What's your pup looking for today?`;
  }

  await sendList(from, baseBody, [{
    title: 'Browse',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Fits for everyday' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Fits',    description: 'Kurtas, frocks, lehengas' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, leashes' },
      { id: WELCOME_ROW.IPL,         title: 'Seasonal Wear',   description: 'Jerseys and Raincoats' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId, 'Browse Categories');

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

// PATCH BUG-A: subcategory picker (sent BEFORE sendCategoryResults for accessories)
async function sendAccessorySubcatPicker(ctx) {
  const { from, waToken, phoneNumberId, history, text, tenant, cart } = ctx;
  const rows = Object.entries(ACCESSORY_SUBCATS).map(([id, def]) => ({
    id,
    title: def.label,
    description: '',
  }));
  await sendList(from,
    `What kind of accessory? ${PAW}`,
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

async function sendCategoryResults(ctx, rowId, page) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const handle = CATEGORY_HANDLES[rowId];
  const label  = CATEGORY_LABEL[rowId];
  if (!handle) { await sendWelcome(ctx); return; }

  let productsRaw = [];
  try { productsRaw = await getCollectionProducts(tenant, handle); }
  catch (e) { console.error('[woofparade] collection fetch failed:', e.message); }
  let products = filterInStock(productsRaw);

  // PATCH BUG-A: when viewing Accessories and a subcat is set, filter products
  if (rowId === WELCOME_ROW.ACCESSORIES && ctx.cart?.woofparade?.accessorySubcat) {
    const sub = ACCESSORY_SUBCATS[ctx.cart.woofparade.accessorySubcat];
    if (sub) {
      products = products.filter(p =>
        sub.match.test(p.handle || '') || sub.match.test(p.title || '')
      );
    }
  }

  // PATCH 43 bug #1: Shopify has festive kurtas double-tagged into pet-clothes.
  // For Casual category, exclude items whose title screams festive (kurta, lehenga, banarasi, etc.)
  if (rowId === WELCOME_ROW.CASUAL) {
    const FESTIVE_KEYWORDS = /\b(kurta|lehenga|lehariya|banarasi|bandhani|assamese|festive|frock|ethnic)\b/i;
    products = products.filter(p => !FESTIVE_KEYWORDS.test(p.title || ''));
  }

  if (!products.length) {
    await sendMessage(from,
      `Hmm, our ${label} edit looks empty right now ${PAW} Try another category from the menu, or tap *Custom Fit* and we'll get something made.`,
      waToken, phoneNumberId);
    return;
  }

  // Bug #10 (Kashmira): Jerseys = 4 products total, show all in one batch.
  // Per-category page size: defaults to PAGE_SIZE (3), but IPL/Jerseys gets 4
  // so the customer sees CSK + RCB + MI x 2 without needing 'Show more'.
  const pageSize = (rowId === WELCOME_ROW.IPL) ? 4 : PAGE_SIZE;

  // PATCH 41 + 44: rotate products per customer so the customer sees a different
  // first 3 than the next customer. Rotation MUST apply on every page so
  // 'Show more' continues from the rotated order — not the original Shopify order.
  const phoneSeed = String(from || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rotated = [...products];
  if (rotated.length > pageSize) {
    const offset = phoneSeed % rotated.length;
    rotated.unshift(...rotated.splice(offset));
  }
  const totalAvailable = Math.min(rotated.length, MAX_PRODUCTS_PER_CAT);
  const start = page * pageSize;
  const slice = rotated.slice(start, start + pageSize);

  if (!slice.length) {
    // S05 PDF v1.4 end-of-12 fallback — show 4 specific options
    await sendMessage(from,
      `That's our full lineup in ${label} for now ${PAW}\n` +
      `Want to see more? Here's what we can do:`,
      waToken, phoneNumberId);
    const fullCollectionUrl = `https://${tenant.shop_domain || 'thewoofparade.com'}/collections/${handle}`;
    await sendButtons(from, 'Choose:',
      [`See full on website`, 'Browse another category', 'Custom Fit'],
      waToken, phoneNumberId);
    await sendButtons(from, 'Or:',
      ['Talk to designer', PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);
    // Send the link as a separate message so customers can tap it
    await sendMessage(from,
      `Browse the full ${label} collection on our site:\n${fullCollectionUrl}`,
      waToken, phoneNumberId);
    return;
  }

  // S05 PDF v1.4 — each product card has:
  //   numbered badge (1️⃣/2️⃣/3️⃣), title
  //   price + Sale tag (if compare_at_price > price) + In Stock ✅
  //   ⚡ Only N left! (if total inventory ≤ 3)
  //   product URL
  // PDF v1.4 Bug #2: cumulative global numbering across pages so customer can type '4', '7' etc.
  const NUMBER_BADGES = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  for (let i = 0; i < slice.length; i++) {
    const p = slice[i];
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const compareAt = v0?.compare_at_price ? parseFloat(v0.compare_at_price) : null;
    const currentPrice = v0?.price ? parseFloat(v0.price) : null;
    const onSale = compareAt && currentPrice && compareAt > currentPrice;
    const totalInventory = (p.variants || []).reduce((sum, v) => {
      const qty = (v.inventory_quantity !== undefined && v.inventory_quantity !== null)
        ? parseInt(v.inventory_quantity, 10) : null;
      return sum + (qty !== null && !isNaN(qty) ? qty : 0);
    }, 0);
    const lowStock = totalInventory > 0 && totalInventory <= 3;
    const url = `https://${tenant.shop_domain || 'thewoofparade.com'}/products/${p.handle}`;

    const globalIdx = start + i;  // PDF v1.4 Bug #2: cumulative across pages
    const badge = NUMBER_BADGES[globalIdx] || `${globalIdx + 1}.`;
    let caption = `${badge} ${p.title}\n`;
    caption += `${price}`;
    if (onSale) caption += ` 🏷 Sale`;
    caption += ` • In Stock ✅\n`;
    if (lowStock) caption += `⚡ Only ${totalInventory} left!\n`;
    caption += url;

    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

  await sendMessage(from,
    `That's our top ${slice.length} in ${label} ${PAW}\nReply with the number to pick, or tap any link to view.`,
    waToken, phoneNumberId);

  // PATCH 43 bug #2: picker list shows ALL products seen so far, not just current page.
  // So tapping "Pick a product" after 3+3+3 = 9 products gives all 9 in the list.
  const accumulated = rotated.slice(0, start + pageSize);
  await sendProductPickerList(ctx, accumulated);

  const totalShownAfter = Math.min((page + 1) * pageSize, totalAvailable);
  const moreAvailable = totalShownAfter < totalAvailable;
  const buttons = moreAvailable
    ? [PRODUCT_BTN.SHOW_3_MORE, PRODUCT_BTN.BACK_TO_MENU]
    : [PRODUCT_BTN.BACK_TO_MENU];
  await sendButtons(from, 'Or:', buttons, waToken, phoneNumberId);

  // Patch 29 — category-specific trailing buttons
  if (rowId === WELCOME_ROW.FESTIVE) {
    await sendButtons(from, 'Looking for something extra special?',
      ['View Lehengas'], waToken, phoneNumberId);
  } else if (rowId === WELCOME_ROW.IPL) {
    await sendButtons(from, 'Raincoats are on the way 🍃',
      ['Notify me — Raincoat'], waToken, phoneNumberId);
  }

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
    waToken, phoneNumberId, 'Pick a product');
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
  const compareAt = v0?.compare_at_price ? parseFloat(v0.compare_at_price) : null;
  const currentPrice = v0?.price ? parseFloat(v0.price) : null;
  const onSale = compareAt && currentPrice && compareAt > currentPrice;
  const desc = stripHtml(product.body_html || '').slice(0, 200).trim();
  const ellipsis = stripHtml(product.body_html || '').length > 200 ? '...' : '';

  // S06 PDF v1.4 format:
  //   "${product.title} ✨\n${price} (was ${compareAt})\n\n${desc}\n\nWhich size for your pup?"
  let detailMsg = `${product.title} ✨\n${price}`;
  if (onSale) detailMsg += ` (was ${formatPrice(compareAt)})`;
  detailMsg += `\n\n${desc}${ellipsis}`;
  const sizesInStock = detectInStockSizes(product);
  const isNoSizeProduct = sizesInStock.length === 1 && sizesInStock[0] === '__NO_SIZE__';

  // PATCH 41: skip "Which size?" for sizeless products (accessories — leash, bandana, etc.)
  if (!isNoSizeProduct) {
    detailMsg += `\n\nWhich size for your pup?`;
  }
  await sendMessage(from, detailMsg, waToken, phoneNumberId);

  if (sizesInStock.length === 0) {
    // S13 — fully OOS
    await sendMessage(from,
      `This one's sold out across all sizes right now ${PAW} ` +
      `Want me to notify you when it's back, or shall we look at something similar?`,
      waToken, phoneNumberId);
    // PATCH 41: for accessories (sizeless), don't offer custom-make (clothing only)
    const oosBtns = isNoSizeProduct
      ? [ORDER_OPS_BTN.NOTIFY_BACK, PRODUCT_BTN.BACK_TO_MENU]
      : [ORDER_OPS_BTN.NOTIFY_BACK, PRODUCT_BTN.BACK_TO_MENU, SIZE_BTN.YES_CUSTOM];
    await sendButtons(from, 'What next?', oosBtns, waToken, phoneNumberId);
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

  // PATCH 41: sizeless products (accessories) → "Add to cart" directly, no size prompt
  if (isNoSizeProduct) {
    await sendButtons(from, 'Like it?',
      ['Add to cart', PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);
  } else {
    // S06 PDF v1.4: just send size buttons split into two rows + helper button row
    const firstThree = sizesInStock.slice(0, 3);
    await sendButtons(from, 'Pick a size:', firstThree, waToken, phoneNumberId);

    if (sizesInStock.length > 3) {
      const nextThree = sizesInStock.slice(3, 6);
      await sendButtons(from, 'Or:', nextThree, waToken, phoneNumberId);
    }

    await sendButtons(from, 'Not sure of the size?',
      [PRODUCT_BTN.HELP_SIZING, PRODUCT_BTN.BACK],
      waToken, phoneNumberId);
  }

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
  // PATCH 41: detect if this product even uses S/M/L sizing
  const hasAnySizeVariant = variants.some(v => {
    const opt = String(v.option1 || v.title || '').toUpperCase().trim();
    return ALL_SIZES.includes(opt);
  });

  // Sizeless product (accessory with Color/Material variants, or single variant)
  // Return special marker so the caller can skip the size prompt and go straight
  // to add-to-cart. ANY available variant means the product is in stock.
  if (!hasAnySizeVariant) {
    const anyAvailable = variants.some(v => v.available !== false);
    return anyAvailable ? ['__NO_SIZE__'] : [];
  }

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
  return (products || []).filter(p => {
    // PATCH 41: exclude drafts and archived (admin API returns `status`)
    if (p.status && p.status !== 'active') return false;
    // PATCH 41: exclude unpublished (no published_at means not on Online Store)
    if (p.published_at === null) return false;
    // Need at least one in-stock variant
    return (p.variants || []).some(v => v.available !== false);
  });
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
  const isNoSize = size === '__NO_SIZE__';
  try {
    const fetched = await getProductByHandle(tenant, product.handle);
    if (fetched) {
      let v;
      if (isNoSize) {
        // PATCH 50: if a variant was preselected via the picker, honour it.
        const preselId = r.preselectedVariantId;
        if (preselId) {
          v = (fetched.variants || []).find(v => String(v.id) === String(preselId) && v.available !== false);
        }
        // PATCH 42 fallback: sizeless products — first available variant wins
        if (!v) v = (fetched.variants || []).find(v => v.available !== false);
      } else {
        v = (fetched.variants || []).find(v => {
          const opt = String(v.option1 || v.title || '').toUpperCase().trim();
          return v.available !== false && opt === size;
        });
      }
      if (v) { variantId = String(v.id); variantPrice = parseFloat(v.price) || product.price; }
    }
  } catch (e) { console.error('[woofparade] variant resolve failed:', e.message); }

  if (!variantId) {
    // S13 PDF v1.4 — per-size OOS: show 2-3 similar products in customer's size, then offer notify-me
    await sendMessage(from,
      `Aw — this one's currently sold out in ${size} 😔\n` +
      `But here are similar products available in your size ${PAW}`,
      waToken, phoneNumberId);

    // Find similar products in the same category that have `size` in stock
    let similarShown = 0;
    try {
      const categoryRowId = r.categoryRowId;
      const categoryHandle = categoryRowId ? CATEGORY_HANDLES[categoryRowId] : null;
      if (categoryHandle) {
        const candidatesRaw = await getCollectionProducts(tenant, categoryHandle);
        const candidates = (candidatesRaw || [])
          .filter(p => p.handle !== product.handle)
          .filter(p => {
            // Has the requested size in stock?
            return (p.variants || []).some(v => {
              const opt = String(v.option1 || v.title || '').toUpperCase().trim();
              return v.available !== false && opt === size;
            });
          })
          .slice(0, 3);

        for (let i = 0; i < candidates.length; i++) {
          const p = candidates[i];
          const v0 = p.variants?.[0];
          const img = p.images?.[0]?.src || v0?.featured_image?.src;
          const price = formatPrice(v0?.price);
          const productUrl = `https://${tenant.shop_domain || 'thewoofparade.com'}/products/${p.handle}`;
          const caption =
            `${i + 1}. ${p.title}\n` +
            `${price}  •  In Stock ✅ (${size})\n` +
            `${productUrl}`;
          if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
          else await sendMessage(from, caption, waToken, phoneNumberId);
          await new Promise(rs => setTimeout(rs, 500));
        }
        similarShown = candidates.length;
      }
    } catch (e) {
      console.error('[woofparade S13] similar-products fetch failed:', e.message);
    }

    // Always offer notify-me + back to menu (PDF S13 exact buttons)
    await sendMessage(from,
      `Or I can ping you when this one's back in stock.`,
      waToken, phoneNumberId);
    await sendButtons(from, 'What next?',
      [ORDER_OPS_BTN.NOTIFY_BACK, PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);

    // Remember which product+size to notify for, so the button handler can persist it
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[woofparade S13 size_oos handle=${product.handle} size=${size} similar=${similarShown}]` },
    ], {
      ...cart,
      woofparade: {
        ...(cart.woofparade || {}),
        pendingNotify: { handle: product.handle, title: product.title, size },
      },
    });
    return;
  }

  const items = Array.isArray(r.items) ? [...r.items] : [];
  items.push({
    kind: 'product',
    productHandle: product.handle,
    productTitle: product.title,
    variantId, size, price: variantPrice,
  });

  // S14 — Branch A is moot once they've shortlisted; schedule Branch B 2hr instead.
  // Both calls are fire-and-forget; failures shouldn't block checkout.
  cancelNudges(tenant.id, from, 's14_branch_a_pre_shortlist', 'shortlisted')
    .catch(e => console.error('[woofparade S14] cancel branch_a failed:', e.message));
  const branchBFireAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();  // +2h
  const pupName = r.lastBranchAPupName || r.custom?.pupName || null;
  scheduleNudge(tenant.id, from, 's14_branch_b_post_shortlist', branchBFireAt, {
    productTitle: product.title, size, pupName,
  }).catch(e => console.error('[woofparade S14] schedule branch_b failed:', e.message));

  // PATCH 23 — Refresh day-14 nudge with product context now that we have one.
  const _d14At = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  scheduleNudge(tenant.id, from, 's14_day14_final', _d14At, {
    pupName, productTitle: product.title,
  }).catch(e => console.error('[woofparade S14] refresh day14 failed:', e.message));

  // S06 PDF v1.4: "Added Size S to your shortlist 🛒\nAnything you'd like to pair with this?"
  await sendMessage(from,
    size === '__NO_SIZE__'
      ? `Added to your shortlist 🛒`
      : `Added Size ${size} to your shortlist 🛒`,
    waToken, phoneNumberId);

  await sendButtons(from, `Anything you'd like to pair with this?`,
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

  // S08 PDF v1.4: "This kurta looks gorgeous with these 🐾"
  // Reference the most recent shortlisted product type if known.
  const lastProductTitle = ctx.cart?.woofparade?.product?.title || null;
  // Bug fix #3 (Kashmira): titles like "Bone Bandana for dogs & cats" used to grab
  // the last word ("cats") as the noun. Match against known product types instead.
  const PRODUCT_NOUNS = ['bandana', 'kurta', 'frock', 'lehenga', 'jersey', 'harness', 'bowtie', 'collar', 'leash', 'raincoat', 'shirt', 'hoodie', 'tee', 'tshirt', 'tutu'];
  let productNoun = 'one';
  if (lastProductTitle) {
    const titleLower = lastProductTitle.toLowerCase();
    const matched = PRODUCT_NOUNS.find(n => titleLower.includes(n));
    if (matched) productNoun = matched;
  }
  const intro = lastProductTitle
    ? `This ${productNoun} looks gorgeous with these ${PAW}`
    : `This looks gorgeous with these ${PAW}`;
  await sendMessage(from, intro, waToken, phoneNumberId);

  for (const p of inStock) {
    const v0 = p.variants?.[0];
    const img = p.images?.[0]?.src || v0?.featured_image?.src;
    const price = formatPrice(v0?.price);
    const caption = `${p.title}\n${price}`;
    if (img) await sendImage(from, img, caption, waToken, phoneNumberId);
    else await sendMessage(from, caption, waToken, phoneNumberId);
  }

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

// PATCH 25 — Extract product name from a sizing-help message.
// Examples:
//   "Hi, I need help with sizing for Banarasi Lavender Kurta 🐾"
//      → "Banarasi Lavender Kurta"
//   "sizing help for the CSK Jersey please"
//      → "CSK Jersey"
//   "need sizing"  →  null  (no product hint, use S07 generic flow)
// Returns trimmed string or null.
function extractProductHintFromSizingMsg(text) {
  if (!text) return null;
  // Look for "for <X>" / "of <X>" / "with <X>" pattern (after sizing keyword)
  // Capture everything up to end of message, trailing emoji/punctuation stripped.
  const m = text.match(/\b(?:siz(?:ing|e)|fit(?:ting)?)\b[^.!?]*?\b(?:for|of|with)\s+(?:the\s+|a\s+|an\s+|my\s+)?([^.!?\n]+)/i);
  if (!m || !m[1]) return null;
  let hint = m[1].trim();
  // Strip trailing emojis / paw-prints / punctuation / common filler
  hint = hint.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu, '').trim();
  hint = hint.replace(/\s+(please|pls|thanks|thx|ty)\s*$/i, '').trim();
  hint = hint.replace(/[\s,.\-!?]+$/g, '').trim();
  // Strip "for dogs & cats" / "for my pup" trailing audience phrases
  hint = hint.replace(/\s+for\s+(dogs?|cats?|pets?|pups?|my\s+(dog|cat|pet|pup))(\s+(&|and)\s+\w+)?\s*$/i, '').trim();
  if (hint.length < 3) return null;       // too short to be a real product
  if (hint.length > 80) hint = hint.slice(0, 80);  // safety cap
  return hint;
}

// PATCH 25 — Fuzzy-match a product hint against the Shopify catalog.
// Scores word overlap (case-insensitive). Returns best product if score
// is >= 50% of the hint's words, else null.
function findProductByTitleFuzzy(hint, products) {
  if (!hint || !Array.isArray(products) || products.length === 0) return null;
  const hintWords = hint.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);  // skip 'a', 'of', 'the', etc.
  if (hintWords.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const titleLow = (p.title || '').toLowerCase();
    let score = 0;
    for (const w of hintWords) {
      if (titleLow.includes(w)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // Require at least half the hint words to overlap
  if (bestScore >= Math.ceil(hintWords.length / 2)) return best;
  return null;
}

// PATCH 25 — Handle the size-help CTA from product page.
// 1) Fuzzy-find product by name in Shopify catalog
// 2) Set ctx.cart.woofparade.product so per-category sizing (Patch 24) kicks in
// 3) Send a brief acknowledgement that names the product
// 4) Fire handleSizingHelpStart (which sends measure image + asks for measurements)
async function handleSizingHelpFromCTA(ctx, productHint) {
  const { tenant, from, phoneNumberId, waToken } = ctx;
  let product = null;
  try {
    const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
    product = findProductByTitleFuzzy(productHint, products);
  } catch (e) {
    console.error('[woofparade S07 CTA] product fuzzy lookup failed:', e.message);
  }

  // Acknowledge before launching size flow — even if product wasn't found,
  // we use the customer's own words.
  const productLabel = product ? product.title : productHint;
  await sendMessage(from,
    `On it ${PAW} — let's get a perfect fit for *${productLabel}*.`,
    waToken, phoneNumberId);

  // Stash product context so handleSizingHaveMeasurements picks the right
  // category chart (kurta→ethnic, jersey→jersey, harness→harness, etc.)
  ctx.cart = ctx.cart || {};
  ctx.cart.woofparade = ctx.cart.woofparade || {};
  if (product) {
    ctx.cart.woofparade.product = {
      handle: product.handle,
      title: product.title,
      id: product.id,
    };
  } else {
    // Fall back to hint string as title so categorizeProduct() can still
    // do its job (it operates on the title string, not the handle).
    ctx.cart.woofparade.product = { handle: null, title: productHint, id: null };
  }

  // Now fire the normal S07 entry — image + "have measurements?" prompt.
  await handleSizingHelpStart(ctx);
}

async function handleSizingHelpStart(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  // PATCH 24 — Send the measure image first so customer knows how to measure.
  try {
    await sendImage(from, MEASURE_IMG_URL, MEASURE_IMG_CAPTION, waToken, phoneNumberId);
  } catch (e) {
    console.error('[woofparade S07] sendImage failed:', e.message);
  }
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

  // PATCH 24 — Determine category from current product context (if any).
  // No product context yet → default to ethnic which uses all 3 measurements.
  const productTitle = cart?.woofparade?.product?.title || '';
  const category = categorizeProduct(productTitle);

  // Send the measure-image once with the prompt so customer sees what to measure.
  try {
    await sendImage(from, MEASURE_IMG_URL, MEASURE_IMG_CAPTION, waToken, phoneNumberId);
  } catch (e) {
    console.error('[woofparade S07] sendImage failed:', e.message);
  }

  // PATCH 24 — Category-aware measurement prompt mirroring the widget's inputs.
  let prompt;
  if (category === 'bandana') {
    prompt =
      `Pop your pup's *neck* measurement in here ${PAW}\n\n` +
      `Just the neck (around the base) — in inches.\n\n` +
      `Like: *Neck 16*`;
  } else if (category === 'harness') {
    prompt =
      `Pop your pup's measurements in here ${PAW}\n\n` +
      `• Chest (widest part behind front legs)\n` +
      `• Neck (around the base)\n\n` +
      `In inches please. Like: *Chest 22, Neck 14*`;
  } else {
    // ethnic / posh / jersey — same 3 measurements
    prompt =
      `Pop your pup's measurements in here ${PAW}\n\n` +
      `• Back length (neck base to tail base)\n` +
      `• Chest (widest part behind front legs)\n` +
      `• Neck (around the base)\n\n` +
      `In inches please. Like:\n*Back 14, Chest 18, Neck 12*`;
  }
  await sendMessage(from, prompt, waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade sizing_awaiting_measurements category=${category}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      sizing: { step: 'awaiting', awaitingMeasurements: true, category },
    },
  });
}

async function handleSizingRemind(ctx, when) {
  const { tenant, from, phoneNumberId, waToken, history, cart } = ctx;

  // S07 PDF v1.4 Branch B: first tap = "All good! When should I nudge you? 🐾"
  // then [In 2 hours] [Tomorrow morning] [Pick a time]
  if (when === SIZE_BTN.REMIND || when === 'No, remind me later') {
    await sendButtons(from,
      `All good! When should I nudge you? ${PAW}`,
      [SIZE_BTN.IN_2_HOURS, SIZE_BTN.TOMORROW, SIZE_BTN.PICK_TIME],
      waToken, phoneNumberId);
    return;
  }

  // PATCH 26 — Actually schedule a reminder.
  // Compute fireAt based on which button they tapped.
  let fireAt = null;
  let note = null;
  const now = new Date();

  if (when === 'In 2 hours') {
    fireAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    note = "Got it — I'll nudge you in 2 hours.";
  } else if (when === 'Tomorrow morning') {
    // Tomorrow at 9:00 AM IST (in customer's local context; we just store UTC).
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    fireAt = tomorrow;
    note = "Got it — catch you tomorrow morning.";
  } else if (when === 'Pick a time') {
    // Flag conversation so the next free-text message is parsed as a time.
    ctx.cart = ctx.cart || {};
    ctx.cart.woofparade = ctx.cart.woofparade || {};
    ctx.cart.woofparade.sizing = {
      ...(ctx.cart.woofparade.sizing || {}),
      awaitingRemindTime: true,
    };
    await upsertConversation(tenant.id, from, [
      ...(history || []),
      { role: 'assistant', content: '[woofparade sizing_awaiting_remind_time]' },
    ], ctx.cart);
    await sendMessage(from,
      `Send me a time (e.g. "tomorrow 6pm" or "in 4 hours") and I'll remind you. ${PAW}`,
      waToken, phoneNumberId);
    return;
  }

  if (fireAt) {
    // Cancel any prior sizing reminder for this customer (supersede)
    try { await cancelNudges(tenant.id, from, 's07_sizing_remind'); } catch (e) {}
    // Stash the product context so the reminder copy can mention it
    const productTitle = cart?.woofparade?.product?.title || null;
    try {
      await scheduleNudge(tenant.id, from, 's07_sizing_remind', fireAt, {
        productTitle,
        pupName: cart?.woofparade?.pupName || null,
      });
      console.log(`[woofparade S07] scheduled sizing remind for ${from} at ${fireAt.toISOString()}`);
    } catch (e) {
      console.error('[woofparade S07] scheduleNudge failed:', e.message);
    }
  }

  await sendMessage(from, `${note || "Got it — I'll remind you later."} ${PAW}`, waToken, phoneNumberId);
  await sendButtons(from, 'Meanwhile:',
    [SIZE_BTN.SKIP_BROWSE, SIZE_BTN.HERE_THEY_ARE, SIZE_BTN.HOOMAN],
    waToken, phoneNumberId);
}

// PATCH 28 — Parse free-text time string from 'Pick a time' branch.
// Server runs in UTC; customer messages are IST. We compute target moments in
// IST math then convert to UTC Date for storage.
//
// Accepts forms:
//   "in 2 hours" / "in 30 minutes" / "in 4h" / "in 90 min"
//   "tomorrow 6pm" / "tomorrow at 9am" / "tomorrow morning/afternoon/evening/night"
//   "today 6pm" / "today 3:30 pm"
//   "6pm" / "9:30am" / "18:00"  (interpreted as today IST; tomorrow if past)
// Returns Date (UTC) or null.
//
// Returns null only if no time-like content found. Caller shows a friendly
// hint and reprompts.
function parseRemindTime(text) {
  if (!text) return null;
  let t = String(text).toLowerCase().trim();
  if (!t) return null;

  // Strip pleasantries and connectors that don't carry meaning
  t = t.replace(/\b(at|please|pls|by|around|around about)\b/g, ' ').replace(/\s+/g, ' ').trim();

  // "in N hours" / "in N minutes" — simple offset, server-TZ-agnostic
  let m = t.match(/in\s+(\d+)\s*(hour|hr|h|minute|min|m)s?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 0 || n > 168) return null;  // sanity cap: max 1 week
    const unit = m[2];
    const ms = (unit.startsWith('h') ? n * 60 * 60 : n * 60) * 1000;
    return new Date(Date.now() + ms);
  }

  // Determine day offset: today/tomorrow (default = today)
  let dayOffset = 0;
  if (/\btomorrow\b/.test(t)) {
    dayOffset = 1;
    t = t.replace(/\btomorrow\b/, ' ').replace(/\s+/g, ' ').trim();
  } else if (/\btoday\b/.test(t)) {
    dayOffset = 0;
    t = t.replace(/\btoday\b/, ' ').replace(/\s+/g, ' ').trim();
  }

  // Time-of-day keyword (morning/afternoon/evening/night/tonight) — default times in IST
  let hourIST = null, minuteIST = 0;
  if (/\bmorning\b/.test(t))           { hourIST = 9;  }
  else if (/\b(afternoon|noon)\b/.test(t)) { hourIST = 14; }
  else if (/\b(evening)\b/.test(t))     { hourIST = 18; }
  else if (/\b(night|tonight)\b/.test(t)) { hourIST = 20; if (/\btonight\b/.test(t)) dayOffset = 0; }
  // Bare "tomorrow" with no time → default 9am
  else if (dayOffset === 1 && !/\d/.test(t)) { hourIST = 9; }

  // Explicit HH[:MM][am|pm] anywhere in remaining string
  m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mi = m[2] ? parseInt(m[2], 10) : 0;
    const apRaw = m[3] ? m[3].replace(/\./g, '') : null;
    const ap = apRaw === 'am' || apRaw === 'pm' ? apRaw : null;

    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;

    // Validate
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    // Bare "3:30" without am/pm and h <= 12 is ambiguous — only accept if
    // it looks like 24h (>= 13) or has explicit colon (e.g. "03:30" looks
    // intentional). Otherwise reject so caller can reprompt.
    if (!ap && h < 8 && !m[2]) return null;  // "6" alone → ambiguous, ask again

    hourIST = h;
    minuteIST = mi;
  }

  if (hourIST === null) return null;

  // Compute target moment in IST → convert to UTC Date.
  // IST = UTC+5:30. Strategy: compute today's date in IST, set H:M IST,
  // then subtract 5:30 to get UTC.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowUTC = new Date();
  const nowIST = new Date(nowUTC.getTime() + IST_OFFSET_MS);

  // Build target in IST as if it were UTC, then subtract offset to get true UTC
  const targetIST = new Date(Date.UTC(
    nowIST.getUTCFullYear(),
    nowIST.getUTCMonth(),
    nowIST.getUTCDate() + dayOffset,
    hourIST,
    minuteIST,
    0
  ));
  const targetUTC = new Date(targetIST.getTime() - IST_OFFSET_MS);

  // If user said "6pm" without today/tomorrow and 6pm IST already passed
  // today → roll forward to tomorrow.
  if (dayOffset === 0 && !/\btoday\b/.test(text.toLowerCase()) && targetUTC.getTime() <= nowUTC.getTime()) {
    return new Date(targetUTC.getTime() + 24 * 60 * 60 * 1000);
  }

  // If "today X" was explicit but X has passed → return null so user is told
  // it's already past (less surprising than silently scheduling tomorrow).
  if (dayOffset === 0 && /\btoday\b/.test(text.toLowerCase()) && targetUTC.getTime() <= nowUTC.getTime()) {
    return null;
  }

  return targetUTC;
}

// PATCH 26 — Handle the free-text reply after 'Pick a time'.
// Reads the parsed time, schedules the reminder, confirms.
async function handleSizingRemindTimeMessage(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const fireAt = parseRemindTime(text);

  if (!fireAt || fireAt.getTime() <= Date.now()) {
    await sendMessage(from,
      `Couldn't catch that time ${PAW}\n\n` +
      `Try one of these formats:\n` +
      `• *in 2 hours* / *in 30 min*\n` +
      `• *today 6pm* / *today 3:30 pm*\n` +
      `• *tomorrow morning* / *tomorrow 6pm*`,
      waToken, phoneNumberId);
    return;
  }

  try { await cancelNudges(tenant.id, from, 's07_sizing_remind'); } catch (e) {}
  try {
    await scheduleNudge(tenant.id, from, 's07_sizing_remind', fireAt, {
      productTitle: cart?.woofparade?.product?.title || null,
      pupName: cart?.woofparade?.pupName || null,
    });
  } catch (e) {
    console.error('[woofparade S07] scheduleNudge failed:', e.message);
  }

  // Clear the awaiting flag
  const updatedCart = { ...cart, woofparade: { ...(cart.woofparade || {}) } };
  if (updatedCart.woofparade.sizing) {
    updatedCart.woofparade.sizing = { ...updatedCart.woofparade.sizing, awaitingRemindTime: false };
  }
  await upsertConversation(tenant.id, from, [
    ...(history || []),
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade s07_remind_scheduled at=${fireAt.toISOString()}]` },
  ], updatedCart);

  const when = fireAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  await sendMessage(from, `Done — I'll nudge you on *${when}* ${PAW}`, waToken, phoneNumberId);
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

  // PATCH 26 — Customer is actively answering. Cancel any pending sizing reminder.
  try { await cancelNudges(tenant.id, from, 's07_sizing_remind'); } catch (e) {}


  // PATCH 24 — Read category set during handleSizingHaveMeasurements (or
  // re-derive from current product). Used to pick the right chart.
  const sizingCart = cart?.woofparade?.sizing || {};
  const productTitle = cart?.woofparade?.product?.title || '';
  const category = sizingCart.category || categorizeProduct(productTitle);

  const match = matchSizeFromChart(parsed, category);
  const r = cart.woofparade || {};
  const updatedCart = {
    ...cart,
    woofparade: {
      ...r,
      sizing: {
        step: 'done',
        awaitingMeasurements: false,
        measurements: parsed,
        category,
        lastMatch: match.outcome,
      },
    },
  };

  if (match.outcome === 'clean') {
    // S07 PDF v1.4 clean match: "That's a Size M for your pup 🐾 Want to go ahead?"
    await sendButtons(from,
      `That's a Size *${match.size}* for your pup ${PAW}\nWant to go ahead?`,
      [`Add ${match.size} to shortlist`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  } else if (match.outcome === 'borderline') {
    // S07 PDF v1.4 borderline: quote specific over-measurement
    let overLine = `Quick note — they're slightly over the ${match.size}. Could go either way:`;
    if (match.overLabel && match.overValue !== null && match.overMax !== null) {
      overLine = `Quick note — their ${match.overLabel} (${match.overValue} in) is slightly over the ${match.size} (${match.overMax} in). Could go either way:`;
    }
    await sendMessage(from,
      `Looks like a Size *${match.size}* for your pup ${PAW}\n\n` +
      `${overLine}\n\n` +
      `• *${match.size}* = snugger fit\n` +
      `• *${match.otherSize}* = roomier fit\n\n` +
      `Which feels right?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [`Add ${match.size}`, `Add ${match.otherSize}`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  } else if (match.outcome === 'harness_multi') {
    // PATCH 24 — Harness multi-match (mirrors widget). Up to 3 fitting sizes.
    // WhatsApp Cloud API reply-button cap = 3. We send a single message with
    // the matches enumerated and 2-3 "Add <size>" buttons. If there are 4 we
    // truncate to the largest 3 (consistent w/ harness 'size-up' guidance).
    const list = match.matches.slice(0, 3);
    const lines = list.map(s => `• *${s.key}* — chest ${s.cMin}–${s.cMax}", neck ${s.nMin}–${s.nMax}"`).join('\n');
    await sendMessage(from,
      `Your pup may fit either of these sizes ${PAW}\n` +
      `Check both ranges and pick what works best:\n\n` +
      `${lines}\n\n` +
      `💡 Between two sizes? Go up — a slightly looser harness is safer.`,
      waToken, phoneNumberId);
    const btns = list.map(s => `Add ${s.key}`);
    await sendButtons(from, 'Choose a size:', btns, waToken, phoneNumberId);
  } else {
    // S07 PDF v1.4 no match: route to custom
    await sendMessage(from,
      `Hmm — your pup's measurements are outside our standard sizes ${PAW}\n\n` +
      `But Apurv can sort a custom-make for them.\n\n` +
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

// PATCH 24 — Accept partial measurement input.
// Categories needing different inputs:
//   bandana → neck only
//   harness → chest + neck (length not used)
//   clothes → length + chest + neck ideal, but bot still matches with what's given
// Returns null only if NOTHING parseable was found.
function parseMeasurements(text) {
  const t = (text || '').toLowerCase();
  const back  = t.match(/(?:back|length)\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const chest = t.match(/chest\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  const neck  = t.match(/neck\s*[:=]?\s*(\d+(?:\.\d+)?)/);
  if (!back && !chest && !neck) return null;
  return {
    back:  back  ? parseFloat(back[1])  : 0,
    chest: chest ? parseFloat(chest[1]) : 0,
    neck:  neck  ? parseFloat(neck[1])  : 0,
  };
}

// PATCH 24 — Per-category size match, mirrors the widget's twpFind() exactly.
// m: { back, chest, neck } — any can be 0 (missing). Returns:
//   { outcome: 'clean',      category, size, name, sizeUpTo? }   single match
//   { outcome: 'borderline', category, size, otherSize, overLabel, overValue, overMax }
//   { outcome: 'harness_multi', category, matches: [{key,name,cMin,cMax,nMin,nMax}, ...] }
//   { outcome: 'no_match',   category }
function matchSizeFromChart(m, category) {
  category = category || 'ethnic';
  const table = SIZE_CHARTS_BY_CATEGORY[category];
  if (!table) return { outcome: 'no_match', category };

  const C = Number(m.chest) || 0;
  const N = Number(m.neck) || 0;
  const L = Number(m.back) || 0;  // 'back' is widget's 'length'

  // ─── Bandana: neck only
  if (category === 'bandana') {
    if (!N) return { outcome: 'no_match', category };
    const hit = table.find(s => N >= s.nMin && N <= s.nMax);
    if (hit) return { outcome: 'clean', category, size: hit.key, name: hit.name, range: { nMin: hit.nMin, nMax: hit.nMax } };
    return { outcome: 'no_match', category };
  }

  // ─── Harness: collect all overlapping matches
  if (category === 'harness') {
    if (!C && !N) return { outcome: 'no_match', category };
    const matches = table.filter(s => {
      const cOk = !C || (C >= s.cMin && C <= s.cMax);
      const nOk = !N || (N >= s.nMin && N <= s.nMax);
      return cOk && nOk;
    });
    if (matches.length === 0) return { outcome: 'no_match', category };
    if (matches.length === 1) return { outcome: 'clean', category, size: matches[0].key, name: matches[0].name, range: matches[0] };
    return { outcome: 'harness_multi', category, matches };
  }

  // ─── Clothes (ethnic/posh/jersey) — chest-first, neck within +1, length is tip-only
  let chestMatch = null, neckMatch = null, bothMatch = null;
  for (let i = 0; i < table.length; i++) {
    const cs = table[i];
    const ccf = !C || C <= cs.chest;
    const cnf = !N || N <= cs.neck + 1;
    if (ccf && !chestMatch) chestMatch = cs;
    if (cnf && !neckMatch)  neckMatch  = cs;
    if (ccf && cnf && !bothMatch) { bothMatch = cs; break; }
  }

  if (!bothMatch) {
    // Borderline: chest and neck land on different sizes — return the bigger
    if (chestMatch && neckMatch && chestMatch.key !== neckMatch.key) {
      const cIdx = table.indexOf(chestMatch);
      const nIdx = table.indexOf(neckMatch);
      const bigger  = cIdx > nIdx ? chestMatch : neckMatch;
      const smaller = cIdx > nIdx ? neckMatch  : chestMatch;
      // Which measurement is the one driving the upsize?
      let overLabel, overValue, overMax;
      if (cIdx > nIdx) { overLabel = 'chest'; overValue = C; overMax = smaller.chest; }
      else             { overLabel = 'neck';  overValue = N; overMax = smaller.neck; }
      return {
        outcome: 'borderline', category,
        size: smaller.key, otherSize: bigger.key,
        overLabel, overValue, overMax,
      };
    }
    return { outcome: 'no_match', category };
  }

  // Both fit. Check for length-over tip (size up suggestion).
  const longPup = L && L > bothMatch.length;
  const next = table[table.indexOf(bothMatch) + 1] || null;
  if (longPup && next) {
    return {
      outcome: 'borderline', category,
      size: bothMatch.key, otherSize: next.key,
      overLabel: 'length', overValue: L, overMax: bothMatch.length,
    };
  }

  return { outcome: 'clean', category, size: bothMatch.key, name: bothMatch.name };
}

async function handleTalkToDesigner(ctx) {
  const r = ctx.cart?.woofparade || {};
  const sizing = r.sizing?.measurements;
  const msg =
    `🎨 *Designer Talk Requested*\n` +
    `From: +${ctx.from}\n` +
    (sizing ? `Measurements: Back ${sizing.back}", Chest ${sizing.chest}", Neck ${sizing.neck}"\n` : '') +
    `Recent context: customer wants designer input before custom-making.`;
  await pingTeam(ctx, 'designer', msg, { sosType: 'DESIGNER REQUEST', summary: 'Customer wants designer input before custom-making' });
  await sendMessage(ctx.from,
    `Our designer Anouttama will reach out shortly ${PAW} Meanwhile, feel free to keep browsing.`,
    ctx.waToken, ctx.phoneNumberId);
}

// Patch 29 — Lehenga request: pings Anouttama for festive Lehenga design.
async function handleLehengaRequest(ctx) {
  const msg =
    `👘 *Lehenga Design Request*\n` +
    `From: +${ctx.from}\n` +
    `Customer is interested in a custom Lehenga from the Festive collection.`;
  await pingTeam(ctx, 'designer', msg, { sosType: 'LEHENGA REQUEST', summary: 'Customer wants a Lehenga from Festive collection' });
  await sendMessage(ctx.from,
    `Lovely choice ${PAW} Lehengas are one of our designer specials — Anouttama will reach out shortly to take this forward ✨`,
    ctx.waToken, ctx.phoneNumberId);
  await sendButtons(ctx.from, 'Meanwhile:',
    [PRODUCT_BTN.BACK_TO_MENU], ctx.waToken, ctx.phoneNumberId);
}

// Patch 29 — Raincoats waitlist: saves a notify_requests row keyed to a virtual handle.
async function handleNotifyRaincoats(ctx) {
  const { tenant, from, phoneNumberId, waToken } = ctx;
  try {
    await saveNotifyRequest(tenant.id, from, 'raincoats-launch', 'Raincoats (launch)', null);
    console.log(`[woofparade P29] raincoats-launch notify saved: tenant=${tenant.id} phone=${from}`);
  } catch (e) {
    console.error('[woofparade P29] saveNotifyRequest (raincoats) failed:', e.message);
  }
  await sendMessage(from,
    `Got it ${PAW} I'll WhatsApp you the moment our *Raincoats* drop 🍃`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Meanwhile:',
    [PRODUCT_BTN.BACK_TO_MENU], waToken, phoneNumberId);
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

  // S09 PDF v1.4 format:
  // "Here's your order 🐾
  //  • Item1 (size) — ₹X
  //  • Item2 — ₹Y
  //  Subtotal: ₹X+Y
  //
  //  [transparency line about discount]
  //
  //  Discount: -₹X
  //  Total: ₹Z"
  let summary = `Here's your order ${PAW}\n`;
  for (const it of items) {
    if (it.kind === 'product') {
      const sz = (it.size && it.size !== '__NO_SIZE__') ? ` (${it.size})` : '';
      summary += `• ${it.productTitle}${sz} — ${formatPrice(it.price)}\n`;
    } else {
      summary += `• ${it.title || 'Item'} — ${formatPrice(it.price)}\n`;
    }
  }
  summary += `Subtotal: ${formatPrice(subtotal)}\n`;
  if (discount.amount > 0 && discount.transparency) {
    summary += `\n${discount.transparency}\n\n`;
    summary += `Discount: -${formatPrice(discount.amount)}\n`;
  }
  if (shipping > 0) {
    summary += `Shipping: ${formatPrice(shipping)}\n`;
  } else if (afterDiscount >= SHIPPING_FREE_THRESHOLD) {
    summary += `Shipping: Free 🚚\n`;
  }
  summary += `Total: ${formatPrice(grand)}`;

  await sendMessage(from, summary, waToken, phoneNumberId);

  // PDF: [Pay now] [Edit shortlist] [Cash on delivery]
  await sendButtons(from, "How would you like to go ahead?",
    [CHECKOUT_BTN.PAY_NOW, CHECKOUT_BTN.EDIT_CART, CHECKOUT_BTN.COD],
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

async function handleCheckoutPayNow(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from, ADDRESS_PROMPT, waToken, phoneNumberId);
  const co = cart.woofparade?.checkout || {};
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade paynow_started]' },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      checkout: { ...co, step: CHECKOUT_STEP.COLLECT, paymentMethod: 'paynow' },
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
      `Couldn't quite read that ${PAW} Try again with name, address, city, state and 6-digit PIN`,
      waToken, phoneNumberId);
    return;
  }

  // Merge previously-captured fields from checkout state with new parse
  const co = cart.woofparade?.checkout || {};
  const fields = ['name', 'address1', 'city', 'state', 'pin'];
  const merged = {};
  fields.forEach(k => {
    // Prefer new value, fall back to previous
    if (parsed[k]) merged[k] = parsed[k];
    else if (co[k]) merged[k] = co[k];
  });

  // Re-infer state from PIN if still missing
  if (!merged.state && merged.pin) {
    const inferredState = stateFromPin(merged.pin);
    if (inferredState) merged.state = inferredState;
  }

  // Recompute what's missing AFTER merge
  const stillMissing = [];
  if (!merged.name || merged.name.length < 2) stillMissing.push('name');
  if (!merged.address1 || merged.address1.length < 3) stillMissing.push('address1');
  if (!merged.city) stillMissing.push('city');
  if (!merged.state) stillMissing.push('state');
  if (!merged.pin) stillMissing.push('pin');

  if (stillMissing.length > 0) {
    const labels = {
      name: 'full name',
      address1: 'house/flat + street/area',
      city: 'city',
      state: 'state',
      pin: '6-digit PIN',
    };
    const missingHuman = stillMissing.map(k => labels[k] || k);
    await sendMessage(from,
      `Got most of it ${PAW} Just need: ${missingHuman.join(', ')}`,
      waToken, phoneNumberId);
    await upsertConversation(tenant.id, from, [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: `[woofparade address_partial missing=${stillMissing.join(',')}]` },
    ], {
      ...cart,
      woofparade: {
        ...(cart.woofparade || {}),
        checkout: { ...co, ...merged, step: CHECKOUT_STEP.COLLECT },
      },
    });
    return;
  }

  // All fields present — overwrite `parsed` with merged so downstream uses complete data
  Object.assign(parsed, merged);
  delete parsed._missing;

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

  // S10/S11 PDF v1.4: COD = locked in immediately; Pay now = real Shopify checkout link, wait for webhook
  const isPayNow = co.paymentMethod !== 'cod';

  if (isPayNow) {
    // PAY NOW PATH (S11) — generate real Shopify draft order, send invoice_url, wait for webhook
    let checkoutLinkSent = false;

    if (tenant.shopify_token && tenant.shop_domain) {
      try {
        // Mark order as awaiting payment (default status from saveOrder is 'awaiting_payment'-friendly)
        // Then create the Shopify draft order
        const draftResult = await createCheckoutDraftOrder(tenant.shop_domain, tenant.shopify_token, {
          items: items,
          customerPhone: from,
          customerName: co.name,
          address1: co.address1,
          city: co.city,
          state: co.state,
          pin: co.pin,
          altPhone: co.altPhone,
          subtotal: co.subtotal || 0,
          discountAmount: co.discountAmount || 0,
          discountLabel: co.discountLabel || '',
          grandTotal: co.grand || 0,
          internalOrderId: orderId,
          sourceTag: 'vaani-woofparade',
        });

        if (draftResult && draftResult.invoice_url) {
          // Link our internal order to Shopify draft for webhook matching
          try {
            await saveShopifyDraftRef(orderId, draftResult.shopify_draft_id);
          } catch (e) {
            console.error('[woofparade S11] saveShopifyDraftRef failed:', e.message);
          }

          // PDF S11 verbatim: secure payment link + confirmation wait message
          await sendMessage(from,
            `Here's your secure payment link:\n${draftResult.invoice_url}\n\n` +
            `Once payment is in, I'll send confirmation here ${PAW}`,
            waToken, phoneNumberId);
          checkoutLinkSent = true;
          console.log(`[woofparade S11] Shopify draft created: ${draftResult.shopify_draft_id}, invoice_url sent for order ${orderId}`);

          // S15 — 24-hr unpaid checkout nudge. Cancelled by orders/paid webhook
          // when payment lands (see routes/shopify-webhook.js + cancelNudges in
          // markOrderPaidByDraft path — wired in Patch 15).
          const unpaidFireAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();  // +24h
          scheduleNudge(tenant.id, from, 's15_unpaid_checkout', unpaidFireAt, {
            orderId,
            invoiceUrl: draftResult.invoice_url,
            shopifyDraftId: draftResult.shopify_draft_id,
            productTitle: items[0]?.productTitle || 'your order',
          }).catch(e => console.error('[woofparade S15] schedule unpaid failed:', e.message));
        } else {
          console.error('[woofparade S11] createCheckoutDraftOrder returned null/no invoice_url for order', orderId);
        }
      } catch (e) {
        console.error('[woofparade S11] Shopify checkout creation failed:', e.message);
      }
    } else {
      console.error('[woofparade S11] No Shopify token/domain for tenant', tenant.id, '- falling back to manual');
    }

    if (!checkoutLinkSent) {
      // Fallback: Shopify call failed. Don't pretend payment is confirmed.
      // Tell customer team will reach out + alert Apurv to handle manually.
      await sendMessage(from,
        `Got your order ${PAW}\n` +
        `Apurv from our team will send you a payment link shortly — usually within an hour.\n` +
        `Sorry for the small delay!`,
        waToken, phoneNumberId);
      try {
        await pingTeam(ctx, 'ops',
          `⚠️ Vaani: Shopify draft order creation FAILED for order ${orderId}\n` +
          `Customer: ${co.name} (+${from})\n` +
          `Address: ${co.address1}, ${co.city}, ${co.state} ${co.pin}\n` +
          `Items: ${items.length}, Total: ${formatPrice(co.grand || 0)}\n` +
          `Please send manual payment link.`,
          { sosType: 'SHOPIFY DRAFT FAILED', summary: `Order ${orderId} — draft creation failed, manual payment link needed` });
      } catch (e) {
        console.error('[woofparade S11] ops alert failed:', e.message);
      }
    }
  } else {
    // COD PATH (S10) — confirm immediately, no payment wait
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
  // S13 PDF v1.4 — persist notify request to DB so a future stock-check job can fire it.
  // Prefers `pendingNotify` (set by per-size OOS path in handleSizePick) with handle+title+size;
  // falls back to `product` (set by fully-OOS path in sendProductDetail) with handle+title only.
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const r = cart.woofparade || {};
  const pending = r.pendingNotify || null;
  const product = r.product || null;

  const handle = pending?.handle || product?.handle || null;
  const title  = pending?.title  || product?.title  || null;
  const size   = pending?.size   || null;

  if (!handle) {
    await sendMessage(from,
      `I'll need a product first ${PAW} Pick something and I'll watch its stock for you.`,
      waToken, phoneNumberId);
    return;
  }

  try {
    await saveNotifyRequest(tenant.id, from, handle, title, size);
    console.log(`[woofparade S13] notify-back saved: tenant=${tenant.id} phone=${from} handle=${handle} size=${size || '-'}`);
  } catch (e) {
    console.error('[woofparade S13] saveNotifyRequest failed:', e.message);
  }

  // PDF-verbatim confirmation, naming product (title preferred) + size if known.
  const productLabel = title || handle;
  const sizeLabel = size ? ` in ${size}` : '';
  await sendMessage(from,
    `Got it ${PAW} I'll WhatsApp you the moment *${productLabel}* is back${sizeLabel}.`,
    waToken, phoneNumberId);

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
    ['Fill the form', 'Chat with me 💬', PRODUCT_BTN.BACK_TO_MENU],
    waToken, phoneNumberId);
}

async function handleCustomOrderFromWebsite(ctx) {
  // S02 PDF v1.4: read back pup name + measurements + design choice,
  // CREATE Shopify draft order (placeholder ₹0), persist to pending_drafts,
  // notify Apurv with draft details + approval instructions.
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  // Try to extract pup name, fabric/style, occasion, and measurements from the auto-typed message.
  const t = text || '';

  // Helper: extract value for a labelled field. Stops at newline so we never
  // bleed into the next field (e.g. "Red Banarasi" not "Red Banarasi\nItem").
  const extract = (labelRe) => {
    const m = t.match(new RegExp('(?:^|\\n)\\s*(?:' + labelRe + ')\\s*[:=]\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : null;
  };
  const extractNum = (labelRe) => {
    const m = t.match(new RegExp('(?:^|\\n)\\s*(?:' + labelRe + ')\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)', 'i'));
    return m ? m[1] : null;
  };

  const pupName  = (extract("pup'?s?\\s+name|pup|dog name|pet'?s?\\s+name") || '').split(/\s+/)[0] || null;
  const item     = extract('item|product|garment|outfit');
  const fabric   = extract('design|fabric|pattern|print');
  const style    = extract('style|cut');
  const occasion = extract('occasion|theme');
  const breed    = extract('breed');
  const weight   = extract('weight');
  const back     = extractNum('back\\s*length|back');
  const chest    = extractNum('chest');
  const neck     = extractNum('neck');
  // Back-compat shims so the rest of this function and the Shopify draft still work
  const backMatch  = back  ? [null, back]  : null;
  const chestMatch = chest ? [null, chest] : null;
  const neckMatch  = neck  ? [null, neck]  : null;

  // Build readback message per PDF S02 (customer-facing)
  let msg = pupName
    ? `Hi! Got ${pupName}'s custom order details ${PAW}\n`
    : `Hi! Got your custom order details ${PAW}\n`;
  if (fabric) msg += `Gorgeous choice with the ${fabric} \u2728\n`;
  msg += `\nHere's what we have:\n`;
  if (item)     msg += `\u2022 Item: ${item}\n`;
  if (breed)    msg += `\u2022 Breed: ${breed}\n`;
  if (back)     msg += `\u2022 Back: ${back}"\n`;
  if (chest)    msg += `\u2022 Chest: ${chest}"\n`;
  if (neck)     msg += `\u2022 Neck: ${neck}"\n`;
  if (weight)   msg += `\u2022 Weight: ${weight}\n`;
  if (style)    msg += `\u2022 Style: ${style}\n`;
  if (occasion) msg += `\u2022 Occasion: ${occasion}\n`;
  msg += `\nOur designer will sniff this out shortly and get back to you \u2728`;
  await sendMessage(from, msg, waToken, phoneNumberId);

  // ─── Patch 31: create Shopify draft order ──────────────────────────────
  let draft = null;
  if (tenant.shopify_token && tenant.shop_domain) {
    try {
      const summaryForShopify = [
        pupName  ? `Pup: ${pupName}` : null,
        fabric   ? `Design: ${fabric}` : null,
        style    ? `Style: ${style}` : null,
        occasion ? `Occasion: ${occasion}` : null,
        backMatch  ? `Back: ${backMatch[1]}"` : null,
        chestMatch ? `Chest: ${chestMatch[1]}"` : null,
        neckMatch  ? `Neck: ${neckMatch[1]}"` : null,
        `Customer WA: +${from}`,
      ].filter(Boolean).join('\n');

      draft = await createCustomOrderDraft(tenant.shopify_admin_domain || tenant.shop_domain, tenant.shopify_token, {
        customerPhone: from,
        pupName,
        designName: fabric,
        summary: summaryForShopify,
      });

      if (draft) {
        await pool.query(
          `INSERT INTO pending_drafts (
            tenant_id, draft_id, draft_name, invoice_url,
            customer_phone, pup_name, design_name, summary, status, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())`,
          [tenant.id, draft.id, draft.name, draft.invoice_url,
           from, pupName, fabric, summaryForShopify]
        );
        console.log(`[woofparade S02] draft created: ${draft.name} (id=${draft.id}) for +${from}`);
      } else {
        console.error(`[woofparade S02] createCustomOrderDraft returned null for +${from}`);
      }
    } catch (e) {
      console.error('[woofparade S02] draft creation failed:', e.message);
    }
  } else {
    console.warn('[woofparade S02] missing tenant.shopify_token/shop_domain \u2014 skipping draft creation');
  }

  // ─── Apurv SOS with draft details + approval instructions ──────────────
  const alertLines = [
    `\uD83C\uDFA8 *CUSTOM ORDER FROM WEBSITE*`,
    `From: +${from}`,
  ];
  if (pupName)  alertLines.push(`Pup: ${pupName}`);
  if (fabric)   alertLines.push(`Fabric: ${fabric}`);
  if (style)    alertLines.push(`Style: ${style}`);
  if (occasion) alertLines.push(`Occasion: ${occasion}`);
  if (backMatch)  alertLines.push(`Back: ${backMatch[1]}"`);
  if (chestMatch) alertLines.push(`Chest: ${chestMatch[1]}"`);
  if (neckMatch)  alertLines.push(`Neck: ${neckMatch[1]}"`);

  if (draft) {
    alertLines.push('');
    alertLines.push(`\uD83D\uDCCB *Draft Order:* ${draft.name}`);
    alertLines.push(`Admin: ${draft.admin_url}`);
    alertLines.push('');
    alertLines.push(`*To approve and send payment link to customer:*`);
    alertLines.push(`Reply with one of:`);
    alertLines.push(`  \u2022 *approved* \u2014 send link as-is`);
    alertLines.push(`  \u2022 *approve ${draft.id} 3500* \u2014 set price to \u20B93500 first`);
    alertLines.push(`  \u2022 *approved 3500* \u2014 set price + approve latest pending`);
  } else {
    alertLines.push('');
    alertLines.push(`\u26A0\uFE0F Shopify draft creation failed \u2014 please create manually in Admin.`);
  }
  alertLines.push('');
  alertLines.push(`Auto-message content:`);
  alertLines.push(text.slice(0, 600));

  const alertBody = alertLines.join('\n');
  await pingTeam(ctx, 'designer', alertBody, { sosType: 'CUSTOM ORDER', summary: pupName ? `Custom order from ${pupName}'s parent` : 'Custom order intake', draftId: draft?.id || null });

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade S02 custom_from_website pup=${pupName||'-'} draft=${draft?.name||'-'}]` },
  ], {
    ...cart,
    woofparade: {
      ...(cart.woofparade || {}),
      custom: { source: 'website', stage: 'team_notified', pupName, fabric, style, occasion },
      lastCustomDraftId: draft?.id || null,
    },
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

  // S12 PDF v1.4: 8 fabrics in PDF order from WOOFPARADE_FABRICS config.
  await sendList(from, `Pick a fabric for ${cart.woofparade?.custom?.pupName || "your pup"} ${PAW}`, [{
    title: 'View fabrics',
    rows: WOOFPARADE_FABRICS.map(f => ({
      id: f.id,
      title: f.name.slice(0, 24),
      description: (f.description || '').slice(0, 72),
    })),
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
  await pingTeam(ctx, 'designer', intake, { sosType: 'CUSTOM ORDER', summary: 'Custom order intake awaiting fabric pick' });

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
  await pingTeam(ctx, 'apurv', body, { sosType: 'REFUND COMPLAINT', summary: 'Customer reports problem with product/delivery' });
  await pingTeam(ctx, 'kashmira', body, { sosType: 'REFUND COMPLAINT', summary: 'Customer reports problem with product/delivery' });
}

// ─── S19 — STOP / UNSUBSCRIBE ─────────────────────────────────────────────

async function handleStopUnsubscribe(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  // Bug #18 (Kashmira): if already unsubscribed, don't re-send the goodbye.
  // Guards against double-fires (network retries, customer typing 'stop' twice, etc).
  if (cart?.woofparade?.unsubscribed === true) {
    console.log(`[woofparade S19] ${from} already unsubscribed — skipping duplicate goodbye`);
    return;
  }

  // S19 — kill any pending nudges immediately so they don't fire after goodbye.
  // Fire-and-forget; cron-side check (cron-nudges.js) is the second line of defense.
  cancelNudges(tenant.id, from, null, 'unsubscribed')
    .catch(e => console.error('[woofparade S19] cancelNudges failed:', e.message));

  await sendMessage(from,
    `Okay... I'll stop. _walks away slowly_ ${PAW}\nYou're unsubscribed.\n\nBut if you change your mind, I'll be here.`,
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
  const { tenant, from, phoneNumberId, waToken, history, cart } = ctx;
  // S16 PDF v1.4: "Of course! Apurv from our team will be with you shortly..."
  await sendMessage(from,
    `Of course! Apurv from our team will be with you shortly ${PAW}\n\n` +
    `What's the best time to reach out, and what should I tell them you'd like to chat about?`,
    waToken, phoneNumberId);

  // S16 mute window: suppress Vaani auto-replies for 30min so Apurv can take over
  // without bot interference. Stored in cart.woofparade.humanHandoffUntil (epoch ms).
  // Checked at top of handle() — if not yet expired, handler returns silently.
  try {
    const r = cart?.woofparade || {};
    r.humanHandoffUntil = Date.now() + 30 * 60 * 1000;  // +30min
    await upsertConversation(tenant.id, from, { ...(cart || {}), woofparade: r });
  } catch (e) {
    console.error('[woofparade S16] failed to set humanHandoffUntil:', e.message);
  }

  // Kill any pending nudges so we don't WhatsApp them while Apurv is dealing with it
  cancelNudges(tenant.id, from, null, 'human_handoff')
    .catch(e => console.error('[woofparade S16] cancelNudges failed:', e.message));

  const lastMsgs = formatRecentHistory(history);
  const tag = reasonCode ? ` (${reasonCode})` : '';
  const body =
    `👤 *HUMAN HELP REQUESTED${tag}*\n` +
    `From: +${from}\n\n` +
    `Recent chat:\n${lastMsgs}`;
  await pingTeam(ctx, 'apurv', body, { sosType: 'HUMAN HELP', summary: `Customer asked to speak with human${tag}` });
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
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  await sendMessage(from,
    `Lovely ${PAW} Apurv will WhatsApp you within 24 hours with international shipping options.`,
    waToken, phoneNumberId);

  // PATCH 22: actually persist the opt-in (PDF S20 said "saved to Google Sheet";
  // we persist to woofparade_optins instead, viewable in the dashboard).
  await saveOptIn(tenant.id, from, 'international', null);

  if (cart?.woofparade) {
    delete cart.woofparade.pendingOptInKind;
  }

  const body =
    `🌍 *INTERNATIONAL INQUIRY*\n` +
    `From: +${from}\n` +
    `Customer opted in for international shipping options.`;
  await pingTeam(ctx, 'apurv', body, { sosType: 'INTERNATIONAL', summary: 'Customer opted in for international shipping options' });
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
  await pingTeam(ctx, 'apurv', body, { sosType: 'BULK WHOLESALE', summary: 'Bulk/wholesale inquiry from customer' });
  await pingTeam(ctx, 'kashmira', body, { sosType: 'BULK WHOLESALE', summary: 'Bulk/wholesale inquiry from customer' });
}

// ─── S22 — PRESS ──────────────────────────────────────────────────────────

async function handlePressInquiry(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  // S22 PDF v1.4 — SOS to BOTH Apurv + Kashmira. Press email defaults to hello@thewoofparade.com.
  await sendMessage(from,
    `Lovely to hear from you! ${PAW}\n\n` +
    `For press or collaborations, please email *${PRESS_EMAIL}* — our team will get right back to you.`,
    waToken, phoneNumberId);

  const body =
    `📰 *PRESS / COLLAB INQUIRY*\n` +
    `From: +${from}\n` +
    `Pointed customer to ${PRESS_EMAIL}.\n\n` +
    `Recent chat: ${formatRecentHistory(ctx.history)}`;
  await pingTeam(ctx, 'apurv', body, { sosType: 'PRESS COLLAB', summary: 'Press/collab inquiry — pointed to email' });
  await pingTeam(ctx, 'kashmira', body, { sosType: 'PRESS COLLAB', summary: 'Press/collab inquiry — pointed to email' });
}

// ─── S26 — DISCOUNT PRESSURE (PDF v1.4 = 2-strike → Apurv) ───────────────

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
  } else {
    // PDF v1.4: after 2 declines, AUTO-route to Apurv (no opt-in prompt).
    await handleTalkToHuman(ctx, 'discount-pressure-x2');
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
  await pingTeam(ctx, 'kashmira', body, { sosType: 'ABUSIVE BLOCKED', summary: 'Customer auto-blocked after 2nd abuse strike' });
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
  await pingTeam(ctx, 'apurv', body, { sosType: 'RAGE QUIT', summary: 'Customer frustrated — take over warmly' });
  console.log(`[woofparade] rage_quit handoff: ${from}`);
}

// ─── S35 — PINCODE SERVICEABILITY ─────────────────────────────────────────

async function handlePincodeCheck(ctx, pin) {
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const ok = await isPincodeServiceable(pin);
  if (ok) {
    await sendMessage(from,
      `Yes! We deliver to *${pin}* ${PAW} Usually 4–8 days.`,
      waToken, phoneNumberId);
    return;
  }
  // PATCH 22: Not serviceable — set context flag so a follow-up YES_WHATSAPP
  // routes to S35 opt-in (not S20 international).
  ctx.cart = ctx.cart || {};
  ctx.cart.woofparade = ctx.cart.woofparade || {};
  ctx.cart.woofparade.pendingOptInKind = 'pin_nonserviceable';
  ctx.cart.woofparade.pendingOptInPin  = pin;
  await upsertConversation(tenant.id, from, ctx.history || [], ctx.cart);

  await sendMessage(from,
    `We don't ship to *${pin}* yet ${PAW} Want me to notify you when we open up your area?`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Choose:',
    [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
    waToken, phoneNumberId);
}

// PATCH 22 — S35 PDF v1.4: founder confirmed (21 May 2026) data source =
// Shopify shipping zones (option A). True Shopify GraphQL deliveryProfiles
// wiring is a future task; for now we use a broader hardcoded non-serviceable
// list covering India's actual non-deliverable pockets. Add to BLOCKED_PREFIXES
// as real exceptions surface from Apurv.
const BLOCKED_PREFIXES = [
  '682',  // Lakshadweep (Kavaratti)
  '744',  // Andaman & Nicobar Islands
  '796',  // Mizoram remote (Lawngtlai)
  '797',  // Nagaland remote — Apurv to confirm
];

async function isPincodeServiceable(pin) {
  if (!/^\d{6}$/.test(pin)) return false;
  return !BLOCKED_PREFIXES.some(prefix => pin.startsWith(prefix));
}

async function handlePinNonserviceableOptIn(ctx) {
  const { tenant, from, phoneNumberId, waToken, cart } = ctx;
  const pin = cart?.woofparade?.pendingOptInPin || null;
  await sendMessage(from,
    `Saved ${PAW} I'll WhatsApp you the moment we open up ${pin ? `*${pin}*` : 'your area'}.`,
    waToken, phoneNumberId);

  await saveOptIn(tenant.id, from, 'pin_nonserviceable', pin ? { pin } : null);

  if (cart?.woofparade) {
    delete cart.woofparade.pendingOptInKind;
    delete cart.woofparade.pendingOptInPin;
  }
  console.log(`[woofparade] pin_nonserviceable opt-in: ${from} pin=${pin}`);
}

// ─── S23 — MULTI-PUP ──────────────────────────────────────────────────────
// PDF v1.4 page 19: "I have 2 dogs, can I order for both?" → onboard pup #1
// using the existing pup-profile capture flow.
async function handleMultiPup(ctx) {
  const { tenant, from, phoneNumberId, waToken, history, cart } = ctx;
  await sendMessage(from,
    `Of course! Let's keep it organised ${PAW}\n\nWhat's pup #1's name?`,
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, history || [], {
    ...cart,
    woofparade: {
      ...(cart?.woofparade || {}),
      pupProfile: {
        ...((cart?.woofparade || {}).pupProfile || {}),
        awaitingPupDetails: true,
        multiPup: true,
      },
    },
  });
}

// ─── S24 — CAT OWNER ──────────────────────────────────────────────────────
// PDF v1.4 page 19: kitty sizing uses the dog chart for v1; reuses S07 path.
async function handleCatOwner(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    `Yes! Most of our pieces are designed for both pups and kitties ${PAW}\n\n` +
    `Like with pups, sizing goes by measurements (not breed). Pop in your kitty's:\n` +
    `• Back length (neck base to tail base)\n` +
    `• Chest (widest part)\n` +
    `• Neck (around the base)\n\n` +
    `In inches please.`,
    waToken, phoneNumberId);
  ctx.cart = ctx.cart || {};
  ctx.cart.woofparade = ctx.cart.woofparade || {};
  ctx.cart.woofparade.sizing = { ...(ctx.cart.woofparade.sizing || {}), awaitingMeasurements: true, isCat: true };
  await upsertConversation(ctx.tenant.id, ctx.from, ctx.history || [], ctx.cart);
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
  await pingTeam(ctx, 'kashmira', body, { sosType: 'HIGH VALUE ORDER', summary: `High-value order ${orderId} — ${formatPrice(checkout.grand)}` });
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
  await pingTeam(ctx, 'apurv', body, { sosType: 'NEW ORDER', summary: `New order ${orderId} — ${formatPrice(checkout.grand)}` });
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
  const pupName = t.split(/[,\n]/)[0].trim().slice(0, 60);

  // Patch 37: reject if input doesn't look like a pup name.
  //   - empty / too short
  //   - contains digits (probably an address fragment)
  //   - too long (likely full address)
  //   - matches customer's own first name from checkout (auto-capture bug)
  const co = cart.woofparade?.checkout || {};
  const customerFirstName = String(co.name || '').trim().split(/\s+/)[0] || '';
  const looksLikeAddress = /\d/.test(t) || t.length > 40;
  const isCustomerName = customerFirstName &&
    pupName.toLowerCase() === customerFirstName.toLowerCase();
  const tooShort = pupName.length < 2;

  // Patch 48: detect question-like replies so customer's actual question gets answered
  // instead of being saved as the pup's name.
  // Examples: "What's the return process", "How do I track", "Where is my order?"
  const lowerT = t.toLowerCase();
  const looksLikeQuestion =
    t.includes('?') ||
    /^(what|whats|how|where|why|when|who|can|could|do|does|did|is|are|will|would|should|tell|help)\b/.test(lowerT) ||
    t.length > 30;

  if (looksLikeQuestion) {
    console.log('[woofparade pupProfile] deferred — input looks like a question:',
      JSON.stringify({ text: t.slice(0, 80) }));
    // Clear the awaitingPupDetails flag so the next message routes normally.
    // We don't recurse here — module exports only `handle` and recursing would
    // re-trigger entry-level routing logic. Instead, ask the customer to repeat
    // their question; their next message will route through `handle` cleanly
    // because awaitingPupDetails is now false.
    await upsertConversation(tenant.id, from, history, {
      ...cart,
      woofparade: {
        ...(cart.woofparade || {}),
        pupProfile: { awaitingPupDetails: false, deferredAt: Date.now() },
      },
    });
    await sendMessage(from,
      `No worries — happy to help with that ${PAW} Can you send your question again? I'll get right to it.`,
      waToken, phoneNumberId);
    return;
  }

  if (tooShort || looksLikeAddress || isCustomerName) {
    console.log('[woofparade pupProfile] rejected invalid pup name input:',
      JSON.stringify({ pupName, customerFirstName, looksLikeAddress, isCustomerName, tooShort }));
    await sendMessage(from,
      `Just your pup's name ${PAW} — like *Rio* or *Mochi*. Or tap Skip.`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Or:', [POSTPURCHASE_BTN.SKIP], waToken, phoneNumberId);
    return;
  }

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
  // PATCH 43 bug #4: don't ask about photos until after delivery. Just ack here.
  await sendButtons(from, `Anything else for ${pupName}? ${PAW}`,
    [POSTPURCHASE_BTN.TRACK, POSTPURCHASE_BTN.BROWSE_MORE, PRODUCT_BTN.BACK_TO_MENU],
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
  const { from, phoneNumberId, waToken, cart } = ctx;
  if (pupName === 'new') {
    await handleNewPupAdd(ctx);
    return;
  }
  // PATCH 22: persist the tag against the most recent order (S30 Branch B/C).
  const orderId = cart?.woofparade?.lastOrderId || cart?.woofparade?.checkout?.orderId;
  if (orderId) {
    await tagOrderToPup(orderId, pupName);
    console.log(`[woofparade] tagged order ${orderId} to ${pupName} for ${from}`);
  } else {
    console.log(`[woofparade] no order to tag for ${from} (pup ${pupName})`);
  }
  await sendMessage(from,
    `Tagged this order to *${pupName}* ${PAW}`,
    waToken, phoneNumberId);
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
  await pingTeam(ctx, 'kashmira', body, { sosType: 'PHOTO RECEIVED', summary: 'Customer sent photo — awaiting feature permission' });
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
    await pingTeam(ctx, 'kashmira', body, { sosType: 'PHOTO PERMISSION', summary: 'Customer granted permission to feature pup' });
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
    await pingTeam(ctx, 'apurv', body, { sosType: 'UNFULFILLED ORDER', summary: `Order ${orderId} unfulfilled >${ageInDays.toFixed(1)}d` });
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
  await pingTeam(ctx, 'apurv', body, { sosType: 'ORDER MOD', summary: `Mod request for ${orderId}: ${text.slice(0, 80)}` });

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
  await pingTeam(ctx, 'apurv', body, { sosType: 'ADDRESS CHANGE', summary: `Address change for ${orderId}${shipped ? ' (URGENT in-transit)' : ''}` });

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
  await pingTeam(ctx, 'apurv', body, { sosType: 'UPI PAYMENT', summary: 'UPI payment claim from customer — verify and confirm' });

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

// ─── PATCH 31: S02 DRAFT APPROVAL — Apurv/Kashmira approve custom-order draft ────

async function handleApproveDraft(ctx, { draftId, newPrice }) {
  const { tenant, from, phoneNumberId, waToken } = ctx;
  const approverLabel = from === KASHMIRA_PHONE ? 'Kashmira' : 'Apurv';

  // Step 1: find the pending draft row
  let row;
  try {
    if (draftId) {
      const r = await pool.query(
        `SELECT * FROM pending_drafts
         WHERE tenant_id=$1 AND draft_id=$2 AND status IN ('pending','approved')
         ORDER BY created_at DESC LIMIT 1`,
        [tenant.id, draftId]
      );
      row = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT * FROM pending_drafts
         WHERE tenant_id=$1 AND status='pending'
         ORDER BY created_at DESC LIMIT 1`,
        [tenant.id]
      );
      row = r.rows[0];
    }
  } catch (e) {
    console.error('[woofparade approve] DB lookup failed:', e.message);
    await sendMessage(from, `\u26A0\uFE0F Couldn't look up draft \u2014 DB error. Check logs.`, waToken, phoneNumberId);
    return;
  }

  if (!row) {
    const msg = draftId
      ? `No pending draft found with ID ${draftId}.`
      : `No pending custom-order drafts to approve right now.`;
    await sendMessage(from, msg, waToken, phoneNumberId);
    return;
  }

  if (row.status === 'invoice_sent') {
    await sendMessage(from,
      `Draft ${row.draft_name} (ID ${row.draft_id}) was already approved & sent on ${new Date(row.invoice_sent_at).toISOString().slice(0,16).replace('T',' ')} UTC.`,
      waToken, phoneNumberId);
    return;
  }

  // Step 2: optionally update Shopify price
  let invoiceUrl = row.invoice_url;
  let totalPrice = null;
  if (newPrice && newPrice > 0) {
    if (!tenant.shopify_token || !tenant.shop_domain) {
      await sendMessage(from, `\u26A0\uFE0F Cannot update price \u2014 Shopify token missing on tenant.`, waToken, phoneNumberId);
      return;
    }
    const lineTitle = row.design_name
      ? `Custom Order \u2014 ${row.design_name}${row.pup_name ? ' for ' + row.pup_name : ''}`
      : 'Custom Order';
    const updated = await updateDraftOrderPrice(tenant.shopify_admin_domain || tenant.shop_domain, tenant.shopify_token, row.draft_id, newPrice, lineTitle);
    if (!updated) {
      await sendMessage(from, `\u26A0\uFE0F Failed to update price on Shopify draft ${row.draft_name}. Customer not notified.`, waToken, phoneNumberId);
      return;
    }
    invoiceUrl = updated.invoice_url;
    totalPrice = updated.total_price;
    await pool.query(
      `UPDATE pending_drafts SET invoice_url=$1, price_set=$2 WHERE id=$3`,
      [invoiceUrl, newPrice, row.id]
    );
  }

  // Step 3: mark approved
  await pool.query(
    `UPDATE pending_drafts SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
    [from, row.id]
  );

  // Step 4: send customer the payment link
  const priceLine = totalPrice ? `\u20B9${totalPrice}` : (row.price_set ? `\u20B9${row.price_set}` : 'as quoted');
  const customerMsg =
    `Great news ${PAW} Your custom order is ready to pay for.\n\n` +
    (row.design_name ? `Design: *${row.design_name}*\n` : '') +
    (row.pup_name ? `For: *${row.pup_name}*\n` : '') +
    (totalPrice || row.price_set ? `Total: *${priceLine}*\n` : '') +
    `\nPay here: ${invoiceUrl}\n\n` +
    `Once we see the payment, we'll get started on stitching. Ship-out is usually 7\u201310 days from confirmation \u2728`;

  try {
    await sendMessage(row.customer_phone, customerMsg, waToken, phoneNumberId);
  } catch (e) {
    console.error('[woofparade approve] failed to send invoice to customer:', e.message);
    await sendMessage(from, `\u26A0\uFE0F Approved on Shopify, but failed to message customer +${row.customer_phone}. Send link manually:\n${invoiceUrl}`, waToken, phoneNumberId);
    return;
  }

  // Step 5: mark invoice_sent
  await pool.query(
    `UPDATE pending_drafts SET status='invoice_sent', invoice_sent_at=NOW() WHERE id=$1`,
    [row.id]
  );

  // Step 6: confirm to approver
  await sendMessage(from,
    `\u2705 Draft ${row.draft_name} approved by ${approverLabel}.\n` +
    `Customer +${row.customer_phone} sent the payment link.\n` +
    (totalPrice ? `Price: ${priceLine}` : `Price: as set on draft`),
    waToken, phoneNumberId);

  console.log(`[woofparade S02 approve] ${row.draft_name} approved by ${approverLabel} (+${from}) for +${row.customer_phone}`);
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

  // note [pup] [text] — PATCH 22: persisted to pup_profiles.notes
  m = t.match(/^note\s+(\S+)\s+(.+)$/i);
  if (m) {
    const pup = m[1];
    const note = m[2];
    await savePupNote(tenant.id, null, pup, note);
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
    // S09 PDF v1.4 transparency line — names the specific live sale tier
    return {
      amount: Math.round(festAmt),
      label: festLabel,
      transparency: `There's a live sale running — ${festLabel}, already auto-applied for you (better than my secret WOOF15, so I've put the bigger one on) 🎉`,
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
      const sz = (it.size && it.size !== '__NO_SIZE__') ? ` (${it.size})` : '';
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

async function pingTeam(ctx, role, body, meta) {
  // role: 'apurv' | 'designer' (anouttama) | 'kashmira' | 'ops'
  // meta: optional { sosType, summary } — if provided AND vaani_team_sos
  //       template is approved for this tenant, sends via template so
  //       delivery survives outside the 24h freeform window.
  // Suppresses send when in test mode.
  if (ctx?.testMode) {
    console.log(`[woofparade testMode] would have pinged ${role}:\n${body}`);
    return;
  }
  const phone = role === 'apurv' ? APURV_PHONE
              : role === 'designer' ? APURV_PHONE  // Anouttama removed 21 May — all designer SOS -> Apurv
              : role === 'kashmira' ? KASHMIRA_PHONE
              : role === 'ops' ? APURV_PHONE  // 'ops' alias → Apurv
              : null;
  if (!phone) {
    console.log(`[woofparade] ${role.toUpperCase()}_PHONE not set — would have sent:\n${body}`);
    return;
  }

  // Template-or-freeform path: only when caller passed meta + tenant is provisioned.
  // Falls back transparently to current freeform behaviour when template not approved.
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
      console.log(`[woofparade] pinged ${role} (${phone}) via=${result.via} ok=${result.ok}`);
      return;
    } catch (e) {
      console.error(`[woofparade] template/freeform ping ${role} failed:`, e.message);
      return;
    }
  }

  // Legacy path: freeform only (used by non-SOS pings without meta).
  try {
    await sendMessage(phone, body, ctx.waToken, ctx.phoneNumberId);
    console.log(`[woofparade] pinged ${role} (${phone}) via=freeform-legacy`);
  } catch (e) {
    console.error(`[woofparade] ping ${role} failed:`, e.message);
  }
}

// ─── Claude-powered bulk address parser ────────────────────────────────────

// PIN-prefix → state lookup (Indian Postal Index Number ranges).
// Used to infer state when the customer omits it. Covers all states + UTs.
function stateFromPin(pin) {
  const p = String(pin || '').replace(/\D/g, '');
  if (p.length !== 6) return null;
  const n = parseInt(p.slice(0, 3), 10);
  if (n >= 110 && n <= 110) return 'Delhi';
  if (n >= 111 && n <= 136) return 'Haryana';
  if (n >= 140 && n <= 160) return 'Punjab';
  if (n >= 160 && n <= 160) return 'Chandigarh';
  if (n >= 171 && n <= 177) return 'Himachal Pradesh';
  if (n >= 180 && n <= 194) return 'Jammu and Kashmir';
  if (n >= 201 && n <= 285) return 'Uttar Pradesh';
  if (n >= 301 && n <= 345) return 'Rajasthan';
  if (n >= 360 && n <= 396) return 'Gujarat';
  if (n >= 400 && n <= 445) return 'Maharashtra';
  if (n >= 450 && n <= 488) return 'Madhya Pradesh';
  if (n >= 490 && n <= 497) return 'Chhattisgarh';
  if (n >= 500 && n <= 535) return 'Telangana';
  if (n >= 500 && n <= 535) return 'Andhra Pradesh';
  if (n >= 560 && n <= 591) return 'Karnataka';
  if (n >= 670 && n <= 695) return 'Kerala';
  if (n >= 600 && n <= 643) return 'Tamil Nadu';
  if (n >= 605 && n <= 605) return 'Puducherry';
  if (n >= 682 && n <= 682) return 'Lakshadweep';
  if (n >= 700 && n <= 743) return 'West Bengal';
  if (n >= 744 && n <= 744) return 'Andaman and Nicobar Islands';
  if (n >= 751 && n <= 770) return 'Odisha';
  if (n >= 781 && n <= 788) return 'Assam';
  if (n >= 790 && n <= 792) return 'Arunachal Pradesh';
  if (n >= 793 && n <= 794) return 'Meghalaya';
  if (n >= 795 && n <= 795) return 'Manipur';
  if (n >= 796 && n <= 796) return 'Mizoram';
  if (n >= 797 && n <= 798) return 'Nagaland';
  if (n >= 799 && n <= 799) return 'Tripura';
  if (n >= 800 && n <= 855) return 'Bihar';
  if (n >= 814 && n <= 835) return 'Jharkhand';
  if (n >= 831 && n <= 835) return 'Jharkhand';
  if (n >= 246 && n <= 263) return 'Uttarakhand';
  if (n >= 396 && n <= 396) return 'Dadra and Nagar Haveli';
  return null;
}

async function bulkParseAddress(text) {
  const msg = (text || '').trim();
  if (msg.length < 10) return { _missing: ['everything'] };
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const sys =
      "Extract the customer's shipping details from their message. " +
      "Reply with ONLY a JSON object: " +
      '{"name":"...","address1":"...","city":"...","state":"...","pin":"......"}. ' +
      "If any field is missing or unclear, set it to null. Do NOT invent values. " +
      "name = full name (a person's name, 2+ words preferred but 1 word OK); " +
      "address1 = house/flat/street/area/landmark — combine all street-level details here; " +
      "city = city only; state = Indian state name; pin = 6-digit pincode as string.";

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

    let { name, address1, city, state, pin } = parsed || {};

    // Normalize
    const pinClean = pin ? String(pin).replace(/\D/g, '') : '';
    const validPin = pinClean.length === 6 ? pinClean : null;

    // Infer state from PIN if missing
    if (!state && validPin) state = stateFromPin(validPin);

    // Decide what's missing
    const missing = [];
    if (!name || String(name).trim().length < 2) missing.push('name');
    if (!address1 || String(address1).trim().length < 3) missing.push('address1');
    if (!city) missing.push('city');
    if (!state) missing.push('state');
    if (!validPin) missing.push('pin');

    if (missing.length > 0) {
      return {
        _missing: missing,
        name: name ? String(name).trim() : null,
        address1: address1 ? String(address1).trim() : null,
        city: city ? String(city).trim() : null,
        state: state ? String(state).trim() : null,
        pin: validPin,
      };
    }

    return {
      name: String(name).trim(),
      address1: String(address1).trim(),
      city: String(city).trim(),
      state: String(state).trim(),
      pin: validPin,
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
      `SELECT tagged_pup, items, created_at
         FROM orders
        WHERE tenant_id = $1 AND customer_phone = $2 AND status = 'paid'
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.tenant.id, ctx.from]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let firstItem = null;
    try {
      const items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      if (Array.isArray(items) && items.length > 0) firstItem = items[0]?.title || items[0]?.name || null;
    } catch (_) {}
    return { pupName: row.tagged_pup || null, productTitle: firstItem };
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

// ─── PATCH 23 — Webhook entry for S30 after Pay Now confirmation ────────────
// Builds a minimal ctx from tenant + customerPhone + creds, loads the
// conversation, and fires handlePupProfileFlow. Used by routes/shopify-webhook.js
// in handleOrderPaid after sending "Payment confirmed!".
async function firePostPurchasePupProfile(tenant, customerPhone, waToken, phoneNumberId) {
  try {
    const conv = await getConversation(tenant.id, customerPhone);
    const history = conv?.messages || [];
    const cart = conv?.cart || {};
    const ctx = {
      tenant, from: customerPhone, waToken, phoneNumberId,
      history, cart, text: '', message: {},
    };
    await handlePupProfileFlow(ctx);
  } catch (e) {
    console.error('[woofparade firePostPurchasePupProfile] failed:', e.message);
  }
}

module.exports = { handle, firePostPurchasePupProfile };
