// handlers/rajathee-qa.js
// PDF Section 13 — Smart Q&A intent classifier.

const Anthropic = require('@anthropic-ai/sdk');
const { sendMessage } = require('../whatsapp');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INTENTS = {
  SHIPPING:    'shipping',
  RETURNS:     'returns',
  FABRIC_CARE: 'fabric_care',
  PAYMENT:     'payment',
  SIZING:      'sizing',
  OFF_TOPIC:   'off_topic',
};

const VALID_INTENTS = Object.values(INTENTS);

const FAQ_ANSWERS = {
  [INTENTS.SHIPPING]:
    "We ship across India. Delivery takes 4-5 days after dispatch, and shipping is free on orders above ₹999. " +
    "Once your order is on its way, we'll share the tracking details with you.",
  [INTENTS.RETURNS]:
    "We allow returns and exchanges within 7 days. Items must be unworn, unused, and in original packaging. " +
    "We cover return shipping for the first request.",
  [INTENTS.FABRIC_CARE]:
    "Care varies by fabric. Each saree comes with a care label - please follow the instructions there. " +
    "We'll be sharing detailed fabric-specific care soon.",
  [INTENTS.PAYMENT]:
    "On WhatsApp, we accept UPI, GPay, PhonePe, Paytm, and other UPI apps. " +
    "For card payments, please order through our website rajathee.com.",
  [INTENTS.SIZING]:
    "Each Rajathee saree is approximately 6.2 to 6.5 meters and comes with a matching unstitched blouse piece. " +
    "Fall & Pico finishing (₹180) and Ready to Wear stitching (₹1100) are available as add-ons during checkout. " +
    "Sarees are one-size, so they fit most.",
};

const CLASSIFY_SYSTEM_PROMPT =
  "You classify customer questions for a saree store. " +
  "Reply with EXACTLY ONE WORD from this list: shipping, returns, fabric_care, payment, sizing, off_topic. " +
  "shipping = delivery time, where they ship, tracking, dispatch. " +
  "returns = returns, exchanges, refunds, return policy. " +
  "fabric_care = wash, iron, dry clean, care, maintain. " +
  "payment = how to pay, UPI, cards, COD, payment methods. " +
  "sizing = saree length, blouse size, fit, ready to wear, fall and pico. " +
  "off_topic = anything else (shoes, hiring, store address, complaints not about saree details). " +
  "Reply with ONLY the single word. No explanation. No punctuation.";

const SAREE_KEYWORD_RE = /\b(saree|sari|lehenga|blouse|fabric|cotton|crepe|silk|modal|satin|colou?r|mul|fall|pico|ready to wear|drape)\b/i;

function isSareeRelated(text) {
  return SAREE_KEYWORD_RE.test(text || '');
}

async function classifyIntent(text) {
  if (!text || text.trim().length === 0) return INTENTS.OFF_TOPIC;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[rajathee-qa] ANTHROPIC_API_KEY not set, defaulting to off_topic');
    return INTENTS.OFF_TOPIC;
  }
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const raw = (r.content[0]?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    if (VALID_INTENTS.includes(raw)) return raw;
    console.warn('[rajathee-qa] unexpected intent:', raw, '- defaulting to off_topic');
    return INTENTS.OFF_TOPIC;
  } catch (err) {
    console.error('[rajathee-qa] classification failed:', err.message);
    return INTENTS.OFF_TOPIC;
  }
}

async function sendFaqAnswer(ctx, intent) {
  const { from, phoneNumberId, waToken } = ctx;
  const answer = FAQ_ANSWERS[intent];
  if (!answer) return false;
  await sendMessage(from, answer, waToken, phoneNumberId);
  return true;
}

async function sendOffTopicWarning(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I help with sarees - finding the right one, styling tips, and orders. " +
    "Tap an option below or ask me about a saree.",
    waToken, phoneNumberId);
}

async function sendOffTopicMute(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I'll wait until you have a saree question. " +
    "Send me anything saree-related (or tap an option) and I'll be right back.",
    waToken, phoneNumberId);
}

module.exports = {
  INTENTS,
  VALID_INTENTS,
  FAQ_ANSWERS,
  CLASSIFY_SYSTEM_PROMPT,
  SAREE_KEYWORD_RE,
  isSareeRelated,
  classifyIntent,
  sendFaqAnswer,
  sendOffTopicWarning,
  sendOffTopicMute,
};
