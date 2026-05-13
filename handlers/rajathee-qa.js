// handlers/rajathee-qa.js
// Free-form FAQ matcher — uses tenant's dashboard-managed FAQs as the knowledge base.
// Backward-compat shims kept for any old call sites.

const Anthropic = require('@anthropic-ai/sdk');
const { sendMessage } = require('../whatsapp');
const { getTenantSettings } = require('../settings-cache');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── BACKWARD-COMPAT CONSTANTS (do not remove — other handlers may import) ──
const INTENTS = {
  SHIPPING: 'shipping', RETURNS: 'returns', FABRIC_CARE: 'fabric_care',
  PAYMENT:  'payment',  SIZING:  'sizing',  OFF_TOPIC: 'off_topic',
};
const VALID_INTENTS = Object.values(INTENTS);
const SAREE_KEYWORD_RE = /\b(saree|sari|lehenga|blouse|fabric|cotton|crepe|silk|modal|satin|colou?r|mul|fall|pico|ready to wear|drape)\b/i;
const FAQ_ANSWERS = {}; // deprecated, kept for export compatibility

function isSareeRelated(text) {
  return SAREE_KEYWORD_RE.test(text || '');
}

// ─── FREE-FORM MATCHER ─────────────────────────────────────────────────────

function buildMatchPrompt(faqs) {
  if (!faqs || faqs.length === 0) {
    return null;
  }
  const numbered = faqs.map((f, i) => `${i + 1}. ${f.q}`).join('\n');
  return (
    "You match customer questions to the best FAQ topic from the list below. " +
    "Reply with EXACTLY ONE NUMBER (the FAQ number that best matches), OR the word 'none' if no FAQ fits. " +
    "Match generously — if the customer's question is about ANY of these topics, even using different words, return the number. " +
    "Only return 'none' if the question is clearly off-topic (e.g. asking about hiring, store address, unrelated products).\n\n" +
    "FAQs:\n" + numbered + "\n\n" +
    "Reply with ONLY a number or 'none'. No explanation."
  );
}

async function matchFaq(text, tenantId) {
  if (!text || text.trim().length === 0) return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[rajathee-qa] ANTHROPIC_API_KEY not set');
    return null;
  }

  let faqs = [];
  try {
    const settings = await getTenantSettings(tenantId);
    faqs = settings.faqs || [];
  } catch (e) {
    console.error('[rajathee-qa] settings fetch failed:', e.message);
    return null;
  }

  if (faqs.length === 0) return null;

  const systemPrompt = buildMatchPrompt(faqs);
  if (!systemPrompt) return null;

  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });
    const raw = (r.content[0]?.text || '').trim().toLowerCase();
    if (raw === 'none') return null;
    const idx = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > faqs.length) {
      console.warn('[rajathee-qa] unexpected match output:', raw);
      return null;
    }
    return faqs[idx - 1]; // { q, a }
  } catch (err) {
    console.error('[rajathee-qa] match failed:', err.message);
    return null;
  }
}

async function sendFaqMatch(ctx, faq) {
  const { from, phoneNumberId, waToken } = ctx;
  if (!faq || !faq.a) return false;
  await sendMessage(from, faq.a, waToken, phoneNumberId);
  return true;
}

// ─── DEPRECATED (kept for backward compatibility) ──────────────────────────

async function classifyIntent(text) {
  // Always returns OFF_TOPIC now — callers should switch to matchFaq.
  return INTENTS.OFF_TOPIC;
}

async function sendFaqAnswer(ctx, intent) {
  // No-op — old call sites should switch to sendFaqMatch.
  return false;
}

// ─── OFF-TOPIC MESSAGING ───────────────────────────────────────────────────

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
  // New API
  matchFaq,
  sendFaqMatch,
  // Legacy exports
  INTENTS,
  VALID_INTENTS,
  FAQ_ANSWERS,
  SAREE_KEYWORD_RE,
  isSareeRelated,
  classifyIntent,
  sendFaqAnswer,
  sendOffTopicWarning,
  sendOffTopicMute,
};
