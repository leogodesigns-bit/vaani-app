const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateCategories(products) {
  const titles = products.slice(0, 50).map(p => p.title).join('\n');
  
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Look at these product titles from a store and group them into 3-5 categories.
Return ONLY a JSON array like this:
[
  { "name": "Earrings", "keywords": ["earring", "jhumki", "stud", "hoop"] },
  { "name": "Rings", "keywords": ["ring"] }
]
No explanation, just JSON.

Products:
${titles}`
    }]
  });

  try {
    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('❌ Category parse error:', e.message);
    return [{ name: 'All Products', keywords: [] }];
  }
}

function matchCategory(productTitle, categories) {
  const t = productTitle.toLowerCase();
  for (const cat of categories) {
    if (cat.keywords.some(k => t.includes(k.toLowerCase()))) {
      return cat.name;
    }
  }
  return categories[categories.length - 1]?.name || 'Other';
}

module.exports = { generateCategories, matchCategory };
