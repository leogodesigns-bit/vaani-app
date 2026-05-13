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
    "We ship anywhere in India. Your order reaches you in 4-5 days after dispatch, and shipping is on us for orders above ₹999. " +
    "We'll send tracking the moment it's on its way.",
  [INTENTS.RETURNS]:
    "You have 7 days from delivery to return or exchange — we just ask that the saree is unworn and in its original packaging. " +
    "Return shipping is on us for your first request.",
  [INTENTS.FABRIC_CARE]:
    "Care depends on the weave. As a rule: gentle hand wash in cold water, dry in the shade, and iron on low. " +
    "Silks and silk blends are happiest with dry cleaning. Each saree arrives with a care label specific to its fabric — that's the one to follow.",
  [INTENTS.PAYMENT]:
    "On WhatsApp, we accept UPI — GPay, PhonePe, Paytm, and any UPI app of your choice. " +
    "For card or net banking, the easiest route is rajathee.com.",
  [INTENTS.SIZING]:
    "Each Rajathee saree is 6.2 to 6.5 metres and comes with a matching unstitched blouse piece. " +
    "At checkout you can add Fall & Pico finishing (₹180) or Ready to Wear stitching (₹1100). " +
    "Sarees are one-size, so they sit beautifully on most.",
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
    "I'm here to help you find the right saree, share styling notes, and take care of your order. " +
    "Tap an option below or ask me anything about a saree.",
    waToken, phoneNumberId);
}

async function sendOffTopicMute(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I'll wait here whenever you'd like to talk sarees. " +
    "Send me anything saree-related, or tap an option, and we'll pick up from there.",
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
