// handlers/rajathee-edge.js
// PDF Section 12 — Edge case helpers for Rajathee handler.

const { sendMessage } = require('../whatsapp');

// Multilingual greeting regex (English + Hinglish + Marathi/Hindi Devanagari).
const GREETING_RE = /^(hi+|hello+|hey+|namaste|namaskar|namaskaar|namaskaaram|नमस्ते|नमस्कार|hola|good\s*(morning|afternoon|evening)|start|menu|home)\s*[!.।]*\s*$/iu;

const NON_TEXT_TYPES = ['audio', 'image', 'sticker', 'location', 'document', 'video', 'contacts'];

function isNonTextMessage(message) {
  return !!message && NON_TEXT_TYPES.includes(message.type);
}

const STYLIST_KEYWORD_RE = /^(stylist|talk to (a )?stylist|need help|help me choose|styling help)\s*[!.?]*\s*$/i;

function isStylistKeyword(text) {
  return STYLIST_KEYWORD_RE.test((text || '').trim());
}

async function sendNonTextAck(ctx) {
  const { from, phoneNumberId, waToken, message } = ctx;
  const type = message?.type || 'unknown';
  let body;
  if (type === 'audio') {
    body = "Thanks for sharing! I can't listen to voice notes yet — could you type your question, or tap Talk to a stylist and our team will reach out?";
  } else if (type === 'image' || type === 'sticker' || type === 'video') {
    body = "Thanks for sharing! I can't see images yet, but I'd love to help. Pick an option below or describe what you're looking for.";
  } else {
    body = "Thanks! I work best with text and tap-replies. Pick an option below to get started.";
  }
  await sendMessage(from, body, waToken, phoneNumberId);
}

async function sendOffTopicPrompt(ctx) {
  const { from, phoneNumberId, waToken } = ctx;
  await sendMessage(from,
    "I help with sarees — finding the right one, styling tips, and orders. " +
    "Pick a starting point below, or tell me what you're looking for in a few words.",
    waToken, phoneNumberId);
}

async function sendErrorFallback(ctx) {
  if (!ctx?.from || !ctx?.waToken || !ctx?.phoneNumberId) return;
  try {
    await sendMessage(ctx.from,
      "Something went wrong on my end. Our team has been notified. " +
      "Please try again, or reply 'stylist' if you'd like a person to help.",
      ctx.waToken, ctx.phoneNumberId);
  } catch (e) {
    console.error('[rajathee-edge] failed to send error fallback:', e.message);
  }
}

module.exports = {
  GREETING_RE,
  NON_TEXT_TYPES,
  STYLIST_KEYWORD_RE,
  isNonTextMessage,
  isStylistKeyword,
  sendNonTextAck,
  sendOffTopicPrompt,
  sendErrorFallback,
};
