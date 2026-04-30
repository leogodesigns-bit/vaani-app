// handlers/rajathee.js
// Rajathee × Vaani flow — implements Rajathee_Vaani_Flow_v1.pdf verbatim,
// with brand tagline supplied by founder ("Effortless and Elegant...").
// v1 scope = PDF Sections 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13.
// Sections 7 (cross-sell) and 10 (returning customer) are v1.1, not built here.
//
// This handler shares NOTHING with Jhilmil's flow. It only uses low-level
// transport helpers (sendMessage/sendButtons/sendList/sendImage) and
// conversation persistence (getConversation/upsertConversation).
//
// Sections 14 (fabric voice) and 15 (colour voice) are LOCKED string constants
// — never sent through the LLM, never templated, never rewritten on the fly.
//
// Phase progress:
//   C.1 — Section 1 Welcome flow  ← THIS COMMIT
//   C.2 — Section 2 Browse by fabric  (next)
//   C.3 — Section 3 Browse by colour
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

// ─── CONSTANTS ────────────────────────────────────────────────────────────

// PDF Section 1 — Welcome body.
// Tagline replaced per founder direction (30 Apr 2026): the placeholder
// "Where heritage drapes elegance" from the PDF is superseded by Rajathee's
// canonical brand line, "Effortless and Elegant Sarees for Women on the Move."
const WELCOME_BODY =
  'Welcome to Rajathee.\n' +
  'Effortless and Elegant Sarees for Women on the Move.\n' +
  'How would you like to browse today?';

// Greeting patterns. Matches whole word or punctuation-trimmed.
const GREETING_RE = /^(hi+|hello+|hey+|helo+|namaste|namaskar|start|help)[!.?\s]*$/i;

// Welcome list row IDs — stable contract for future sections to dispatch on.
const WELCOME_ROW = {
  BROWSE_FABRIC: 'welcome_browse_fabric',
  BROWSE_COLOUR: 'welcome_browse_colour',
  BESTSELLERS:   'welcome_bestsellers',
  AKSHAY:        'welcome_akshay_tritiya',
  STYLING:       'welcome_styling_help',
};

// ─── ENTRY POINT ──────────────────────────────────────────────────────────

/**
 * Main entry point for the Rajathee flow.
 * Called from routes/webhook.js when tenant.flow_template === 'rajathee'.
 *
 * @param {Object} ctx
 * @param {Object} ctx.tenant         tenants row (must have flow_template === 'rajathee')
 * @param {Object} ctx.message        raw WhatsApp message object
 * @param {string} ctx.from           customer phone (E.164 without +)
 * @param {string} ctx.text           extracted text (text body or interactive title)
 * @param {string} ctx.phoneNumberId  Meta phone_number_id (waba sender)
 * @param {string} ctx.waToken        tenant.whatsapp_token
 * @param {Array}  ctx.history        conversation messages array
 * @param {Object} ctx.cart           conversation cart object
 */
async function handle(ctx) {
  const { tenant, message, from, text, phoneNumberId, waToken, history, cart } = ctx;

  // Hard tenant guard — refuse to run on the wrong tenant even if mis-routed.
  if (tenant.flow_template !== 'rajathee') {
    console.error(
      `❌ rajathee.handle called for wrong tenant: ${tenant.shop_domain} ` +
      `(flow_template=${tenant.flow_template})`
    );
    return;
  }

  console.log(`[rajathee] ${tenant.shop_domain} — from ${from}: ${text}`);

  // Detect intent.
  const trimmed = (text || '').trim();
  const isGreeting = GREETING_RE.test(trimmed);

  // PDF Section 1 — Welcome flow.
  // Triggered by any greeting, or by ambiguous text (Section 11 fallback).
  // Phase C.1 routes everything that isn't a known intent to Welcome.
  // Future phases will branch BEFORE this fallback (e.g. C.2 catches
  // welcome_browse_fabric taps before we re-hit Welcome).
  if (isGreeting || isAmbiguous(message, trimmed)) {
    await sendWelcome(ctx);
    return;
  }

  // No-op for unknown taps from previous Welcome menus —
  // safer than re-greeting on every tap. Real handlers land in C.2+.
  console.log(`[rajathee] no handler yet for: ${trimmed}`);
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

// ─── HELPERS ──────────────────────────────────────────────────────────────

// Treat a message as ambiguous (and route to Welcome) only when there's
// no prior conversation state to pick up from. Once history exists we
// don't want to re-greet on every odd word — let other handlers decide.
function isAmbiguous(message, trimmed) {
  // Empty / very short / unclear text from a fresh-feeling moment.
  if (!trimmed) return true;
  // Single emoji or one-word non-greetings on a fresh conversation feel
  // like greetings in spirit. We'll tighten this in Phase C.11 (edge cases).
  return false;
}

module.exports = {
  handle,
  // Exported for tests.
  WELCOME_BODY,
  WELCOME_ROW,
  GREETING_RE,
};
