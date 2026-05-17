// handlers/woofparade-qa.js
// Free-form FAQ matcher for Woof Parade — uses tenant's dashboard-managed FAQs.
// Mirrors rajathee-qa.js. Voice: warm, woofy, Rio-coded.

const Anthropic = require('@anthropic-ai/sdk');
const { sendMessage } = require('../whatsapp');
const { getTenantSettings } = require('../settings-cache');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── BACKWARD-COMPAT / SHARED ──────────────────────────────────────────────
const WOOF_KEYWORD_RE = /\b(dog|pup|puppy|pet|kurta|sherwani|bandana|collar|jersey|festive|casual|accessor|custom|size|sizing|order|track|cod|woof|paw|rio|breed|labrador|golden|husky|pug|cat|kitty)\b/i;

function isDogRelated(text) {
  return WOOF_KEYWORD_RE.test(text || '');
}

// ─── FREE-FORM MATCHER ─────────────────────────────────────────────────────

function buildMatchPrompt(faqs) {
  if (!faqs || faqs.length === 0) return null;
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
    console.error('[woofparade-qa] ANTHROPIC_API_KEY not set');
    return null;
  }

  let faqs = [];
  try {
    const settings = await getTenantSettings(tenantId);
    faqs = settings.faqs || [];
  } catch (e) {
    console.error('[woofparade-qa] settings fetch failed:', e.message);
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
      console.warn('[woofparade-qa] unexpected match output:', raw);
      return null;
    }
    return faqs[idx - 1];
  } catch (err) {
    console.error('[woofparade-qa] match failed:', err.message);
    return null;
  }
}

async function sendFaqMatch(ctx, faq) {
  const { from, phoneNumberId, waToken } = ctx;
  if (!faq || !faq.a) return false;
  await sendMessage(from, faq.a, waToken, phoneNumberId);
  return true;
}

// ─── BUILT-IN PDF S17 ANSWERS ──────────────────────────────────────────────
// Hardcoded fallback answers for common questions covered in PDF Section 5.
// Used when the tenant hasn't configured FAQs in the dashboard yet.

const BUILTIN_FAQS = {
  // Delivery / shipping
  delivery: {
    pattern: /\b(deliver|delivery|shipping|ship to|how long|when will|when does|days to)\b/i,
    answer:
      'We ship pan-India 🚚 Free on orders ₹899+. ' +
      'Delivery usually takes 4–8 days once dispatched.',
  },
  // Exchange / return policy
  exchange: {
    pattern: /\b(exchange|return|refund policy|return policy|7[\s-]day)\b/i,
    answer:
      "We offer a 7-day return/exchange on size issues 🐾 " +
      "Item must be unworn with tags intact. " +
      "Refunds processed within 5–7 working days after we receive the return. " +
      "Full policy: https://thewoofparade.com/policies/refund-policy",
  },
  // Festival sale
  festival: {
    pattern: /\b(festival sale|festive sale|festival discount|sale running|any sale|current offer|buy.*get)\b/i,
    answer:
      "Buy 1 Get 15% off, Buy 2+ Get 20% off — auto-applied at checkout 🎉",
  },
  // "Are you a real person?" — PDF S17 v1.4 update: NEVER admits AI
  realperson: {
    pattern: /\b(real person|are you (a )?(human|bot|ai|robot|real))\b/i,
    answer:
      "I'm Rio, Woof Parade's co-founder 🐾 Pretty smart for a pup — " +
      "but if you'd rather chat with my hooman, just say the word.",
  },
};

// Returns { q, a } matching the built-in pattern, or null if no match.
function matchBuiltinFaq(text) {
  if (!text) return null;
  for (const [key, { pattern, answer }] of Object.entries(BUILTIN_FAQS)) {
    if (pattern.test(text)) {
      return { q: key, a: answer };
    }
  }
  return null;
}

// ─── OFF-TOPIC MESSAGING ───────────────────────────────────────────────────

async function sendOffTopicWarning(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I'm here to help your pup look like a showstopper 🐾 " +
    "Tap an option below or ask me about an outfit, size, or order.",
    waToken, phoneNumberId);
}

async function sendOffTopicMute(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I'll wait right here whenever you'd like to talk pup wardrobe 🐾 " +
    "Send anything dog-related or tap an option, and we'll pick up.",
    waToken, phoneNumberId);
}

module.exports = {
  matchFaq,
  sendFaqMatch,
  matchBuiltinFaq,
  WOOF_KEYWORD_RE,
  isDogRelated,
  sendOffTopicWarning,
  sendOffTopicMute,
  BUILTIN_FAQS,
};
