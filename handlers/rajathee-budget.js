// handlers/rajathee-budget.js
// Detects budget phrases in free-text saree queries.
// Returns the price cap and the message with the budget phrase stripped, so
// the remaining text can be passed to saree-search for token matching.

// Patterns covered (case-insensitive):
//   "under 1000", "below 1500", "less than 2000"
//   "budget 1500", "budget of 2000", "my budget is 1500"
//   "max 1500", "maximum 2000", "upto 1500", "up to 1500"
//   Hinglish/Hindi: "1000 se kam", "1000 ke andar", "1000 tak"
//   Currency-tolerant: "₹1000", "rs 1000", "rs. 1000", "inr 1000"
//   Shorthand: "1k" -> 1000, "1.5k" -> 1500

const NUM = '(?:₹\\s*|rs\\.?\\s*|inr\\s*)?(\\d+(?:\\.\\d+)?)(k)?';

const PATTERNS = [
  new RegExp('\\b(?:under|below|less\\s+than|upto|up\\s+to|max(?:imum)?)\\s+' + NUM + '\\b', 'i'),
  new RegExp('\\bbudget(?:\\s+of|\\s+is)?\\s+' + NUM + '\\b', 'i'),
  new RegExp('\\b' + NUM + '\\s+(?:se\\s+kam|ke\\s+andar|tak)\\b', 'i'),
];

function parseNumber(digits, kSuffix) {
  const n = parseFloat(digits);
  if (isNaN(n)) return null;
  return kSuffix ? Math.round(n * 1000) : Math.round(n);
}

function detectBudget(text) {
  if (!text || typeof text !== 'string') return null;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const max = parseNumber(m[1], m[2]);
    if (!max || max <= 0) continue;
    const cleanedText = text.replace(re, ' ').replace(/\s+/g, ' ').trim();
    return { maxPrice: max, cleanedText };
  }
  return null;
}

function variantMinPrice(product) {
  const prices = (product?.variants || [])
    .map(v => parseFloat(v.price))
    .filter(p => !isNaN(p) && p > 0);
  return prices.length ? Math.min(...prices) : Infinity;
}

function filterByBudget(products, maxPrice) {
  if (!Array.isArray(products) || !maxPrice) return [];
  return products.filter(p => variantMinPrice(p) <= maxPrice);
}

module.exports = {
  detectBudget,
  filterByBudget,
  variantMinPrice,
};
