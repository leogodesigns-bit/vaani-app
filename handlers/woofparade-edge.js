// handlers/woofparade-edge.js
// Edge case helpers for Woof Parade handler.
// Covers: greeting regex, non-text message ack, human-request keyword,
// frustration keyword detection (S37), abusive message detection (S28).

const { sendMessage } = require('../whatsapp');

// Multilingual greeting regex (English + Hinglish + Marathi/Hindi Devanagari).
const GREETING_RE = /^(hi+|hello+|hey+|yo+|hola|namaste|namaskar|namaskaar|नमस्ते|नमस्कार|good\s*(morning|afternoon|evening)|start|menu|home|woof)\s*[!.।]*\s*$/iu;

// "Make my Pet look like a Showstopper!" — auto-typed from website CTA (S01).
const SHOWSTOPPER_CTA_RE = /make\s+my\s+pet\s+look\s+like\s+a\s+showstopper/i;

const NON_TEXT_TYPES = ['audio', 'image', 'sticker', 'location', 'document', 'video', 'contacts'];

function isNonTextMessage(message) {
  return !!message && NON_TEXT_TYPES.includes(message.type);
}

// "Talk to human" / "talk to apurv" / etc — S16.
const HUMAN_KEYWORD_RE = /^(human|talk to (a |my )?(human|person|hooman|apurv|kashmira|anouttama|someone|team)|need help|help me|hooman please)\s*[!.?]*\s*$/i;

function isHumanKeyword(text) {
  return HUMAN_KEYWORD_RE.test((text || '').trim());
}

// S37: frustrated language detection — 2 hits in a row triggers handoff.
const FRUSTRATION_RE = /\b(this isn'?t helping|you don'?t get it|ugh|useless|frustrated|annoying|annoyed|stupid bot|dumb bot|not working|terrible|hate this|can'?t understand|not understanding)\b/i;

function isFrustrationMessage(text) {
  return FRUSTRATION_RE.test((text || '').trim());
}

// S28: abusive language detection.
// Conservative list — only flags clearly abusive/spam content, not just rude messages.
const ABUSIVE_RE = /\b(fuck|fck|fuk|f\*+ck|bitch|asshole|cunt|motherfucker|mc|bc|bsdk|chutiya|gandu|madarchod|behenchod|randi)\b/i;

function isAbusiveMessage(text) {
  return ABUSIVE_RE.test((text || '').trim());
}

// PDF page 2: dog-related keywords used to unmute / detect on-topic.
const DOG_KEYWORD_RE = /\b(dog|pup|puppy|pet|kurta|sherwani|bandana|collar|jersey|festive|casual|accessor|custom|size|sizing|order|track|cod|woof|paw|rio|breed|labrador|golden|husky|pug|cat|kitty|kitten)\b/i;

function isDogRelated(text) {
  return DOG_KEYWORD_RE.test(text || '');
}

async function sendNonTextAck(ctx) {
  const { from, phoneNumberId, waToken, message } = ctx;
  const type = message?.type || 'unknown';
  let body;
  if (type === 'audio') {
    body = "Thanks for sharing! I can't quite listen to voice notes yet 🐾 Could you type it out — or tap *Talk to human* and Apurv will reach out?";
  } else if (type === 'sticker' || type === 'video') {
    body = "Cute! 🐾 I work best with text and tap-replies though. Pick an option below to get started.";
  } else if (type === 'image') {
    // Image gets special handling in S03 Branch A.1 (review photo) — but if we're not in that flow,
    // just acknowledge it. The main handler decides if it's a review photo or random.
    body = "Got your photo 🐾 If this is a pic of your pup in their Woof Parade outfit, our team would love to see it! Otherwise, tap an option below.";
  } else {
    body = "Thanks! 🐾 I work best with text and tap-replies. Pick an option below to get started.";
  }
  await sendMessage(from, body, waToken, phoneNumberId);
}

async function sendErrorFallback(ctx) {
  if (!ctx?.from || !ctx?.waToken || !ctx?.phoneNumberId) return;
  try {
    await sendMessage(ctx.from,
      "Something went wrong on my end 🐾 Our team has been notified. " +
      "Please try again, or reply 'human' if you'd like Apurv to help.",
      ctx.waToken, ctx.phoneNumberId);
  } catch (e) {
    console.error('[woofparade-edge] failed to send error fallback:', e.message);
  }
}

module.exports = {
  GREETING_RE,
  SHOWSTOPPER_CTA_RE,
  NON_TEXT_TYPES,
  HUMAN_KEYWORD_RE,
  FRUSTRATION_RE,
  ABUSIVE_RE,
  DOG_KEYWORD_RE,
  isNonTextMessage,
  isHumanKeyword,
  isFrustrationMessage,
  isAbusiveMessage,
  isDogRelated,
  sendNonTextAck,
  sendErrorFallback,
};
