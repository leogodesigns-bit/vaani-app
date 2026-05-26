// handlers/rajathee-product-search.js
// Matches free-text saree requests (name / fabric / colour) to live Shopify products.
// Scores against: title, body_html, and variant option1/option2/option3 (where colours live).
// Multi-token queries use AND logic — ALL tokens must match somewhere in the product.

const { getProducts, formatPrice, stripHtml } = require('../shopify');

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

async function loadProducts(tenant) {
  const key = tenant.shop_domain;
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.ts) < TTL_MS) return cached.products;
  const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
  cache.set(key, { ts: Date.now(), products });
  return products;
}

function buildHaystack(p) {
  const title = (p.title || '').toLowerCase();
  const body = stripHtml(p.body_html || '').toLowerCase();
  // Pull all variant option values (option1/2/3) — colours, sizes live here
  const variantOpts = (p.variants || [])
    .flatMap(v => [v.option1, v.option2, v.option3])
    .filter(Boolean)
    .map(s => s.toLowerCase())
    .join(' ');
  return { title, body, variantOpts };
}

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

// Score a single token against a product. Returns score for this token (0 if no match).
// +3 title whole-word, +2 title substring, +2 variant option match, +1 body match
function scoreToken(product, token, h) {
  const titleWords = new Set(h.title.split(/\s+/).filter(Boolean));
  if (titleWords.has(token)) return 3;
  if (h.title.includes(token)) return 2;
  if (h.variantOpts.includes(token)) return 2;
  if (h.body.includes(token)) return 1;
  return 0;
}

function scoreProduct(product, tokens) {
  const h = buildHaystack(product);
  let totalScore = 0;
  let matchedCount = 0;
  const matched = [];
  for (const t of tokens) {
    const s = scoreToken(product, t, h);
    if (s > 0) {
      totalScore += s;
      matchedCount++;
      matched.push(t);
    }
  }
  return { score: totalScore, matchedCount, matched };
}

// Main entry
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

  // Score everything
  const allScored = products
    .map(p => ({ p, ...scoreProduct(p, tokens) }))
    .filter(s => s.score > 0);

  if (allScored.length === 0) return { mode: 'none' };

  // AND filter: keep only products that matched ALL tokens
  const fullMatches = allScored
    .filter(s => s.matchedCount === tokens.length)
    .sort((a, b) => b.score - a.score);

  // Fallback: if no product matches all tokens, use partial matches sorted by matchedCount then score
  const scored = fullMatches.length > 0
    ? fullMatches
    : allScored.sort((a, b) => (b.matchedCount - a.matchedCount) || (b.score - a.score));

  const top = scored[0];
  const second = scored[1];

  // HIGH only when ALL tokens appear as whole words in the TITLE.
  // (Variant/body matches don't count — those go to LOW with options.)
  const topTitleWords = new Set((top.p.title || '').toLowerCase().split(/\s+/).filter(Boolean));
  const allTokensInTitle = tokens.every(t => topTitleWords.has(t));
  const clearWinner =
    allTokensInTitle &&
    (scored.length === 1 || top.score >= second.score + 1);

  if (clearWinner) {
    console.log(`[rajathee-search] HIGH match: "${top.p.title}" score=${top.score} matched=${top.matched.join(',')}`);
    return { mode: 'high', best: top.p, matched: top.matched };
  }

  const candidates = scored.map(s => s.p);
  const mode = fullMatches.length > 0 ? 'AND' : 'partial';
  console.log(`[rajathee-search] LOW match (${mode}): ${candidates.length} candidates for tokens=${tokens.join(',')}`);
  return { mode: 'low', candidates, matched: top.matched };
}

function formatProductCard(product) {
  const price = product.variants?.[0]?.price ? formatPrice(product.variants[0].price) : '';
  const url = `https://rajathee.com/products/${product.handle || ''}`;
  return {
    imageUrl: product.images?.[0]?.src || null,
    caption: `*${product.title}*${price ? `\n${price}` : ''}\n\n${url}`,
  };
}

function batchSizeForPage(pageIndex) {
  return pageIndex < 2 ? 3 : 4;
}

module.exports = {
  findSareeFromText,
  formatProductCard,
  batchSizeForPage,
};
