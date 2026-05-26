// handlers/rajathee-product-search.js
// Matches free-text saree requests (name / fabric / colour) to live Shopify products.
// Returns { mode: 'high'|'low'|'none', best?, candidates? }

const { getProducts, formatPrice, stripHtml } = require('../shopify');

// 10-minute in-memory cache per shop domain
const cache = new Map(); // shop_domain -> { ts, products }
const TTL_MS = 10 * 60 * 1000;

async function loadProducts(tenant) {
  const key = tenant.shop_domain;
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.ts) < TTL_MS) return cached.products;
  const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
  cache.set(key, { ts: Date.now(), products });
  return products;
}

// Build a haystack string for each product = title + stripped body
function buildHaystack(p) {
  const title = (p.title || '').toLowerCase();
  const body = stripHtml(p.body_html || '').toLowerCase();
  return { title, body, combined: `${title} ${body}` };
}

// Tokenize user text — drop common filler words
const STOP = new Set([
  'i','want','need','show','me','please','the','a','an','this','that','one',
  'saree','sari','do','you','have','any','your','for','in','with','and','or',
  'looking','some','can','get','give','see','tell','about','more','it','is',
  'are','am','my','to','of','on','at','from','plz','pls','ok','okay','yes','no',
  'hi','hello','hey','hii','hiii','dear','mam','madam','sir'
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !STOP.has(t));
}

// Score a product against tokens
// +3 if token matches a word in title (whole word)
// +2 if token is substring of title
// +1 if token appears in body
function scoreProduct(product, tokens) {
  const h = buildHaystack(product);
  const titleWords = new Set(h.title.split(/\s+/).filter(Boolean));
  let score = 0;
  const matched = [];
  for (const t of tokens) {
    if (titleWords.has(t)) { score += 3; matched.push(t); continue; }
    if (h.title.includes(t)) { score += 2; matched.push(t); continue; }
    if (h.body.includes(t)) { score += 1; matched.push(t); continue; }
  }
  return { score, matched };
}

// Main entry — called from rajathee.js
// Returns:
//   { mode: 'none' }                       — no signal at all, let AI fallback handle
//   { mode: 'high', best }                 — confident single match
//   { mode: 'low',  candidates: [p1,p2,p3] } — 2-3 closest, ask which
async function findSareeFromText(tenant, userText) {
  const tokens = tokenize(userText);
  if (tokens.length === 0) return { mode: 'none' };

  let products;
  try {
    products = await loadProducts(tenant);
  } catch (err) {
    console.error('[rajathee-search] loadProducts failed:', err.message);
    return { mode: 'none' };
  }
  if (!products || products.length === 0) return { mode: 'none' };

  const scored = products
    .map(p => ({ p, ...scoreProduct(p, tokens) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { mode: 'none' };

  const top = scored[0];
  const second = scored[1];

  // HIGH confidence: top scores >= 3 AND (only 1 result OR top is clearly ahead of #2)
  const clearWinner =
    top.score >= 3 &&
    (scored.length === 1 || top.score >= second.score + 2);

  if (clearWinner) {
    console.log(`[rajathee-search] HIGH match: "${top.p.title}" score=${top.score} matched=${top.matched.join(',')}`);
    return { mode: 'high', best: top.p, matched: top.matched };
  }

  // LOW confidence: return top 3
  const candidates = scored.slice(0, 3).map(s => s.p);
  console.log(`[rajathee-search] LOW match: ${candidates.length} candidates for tokens=${tokens.join(',')}`);
  return { mode: 'low', candidates, matched: top.matched };
}

// Format the product card text (used by handler to send image + caption)
function formatProductCard(product) {
  const price = product.variants?.[0]?.price ? formatPrice(product.variants[0].price) : '';
  const url = `https://rajathee.com/products/${product.handle || ''}`;
  return {
    imageUrl: product.images?.[0]?.src || null,
    caption: `*${product.title}*${price ? `\n${price}` : ''}\n\n${url}`,
  };
}

module.exports = {
  findSareeFromText,
  formatProductCard,
};
