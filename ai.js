const Anthropic = require('@anthropic-ai/sdk');
const { getProducts } = require('./shopify');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAIResponse(tenant, customerPhone, userMessage, conversationHistory) {
  // Fetch products if tenant has a real Shopify token
  let productContext = '';
  if (tenant.shopify_token && tenant.shopify_token !== 'test_token') {
    const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
    if (products.length > 0) {
      productContext = `\n\nStore products:\n` + products.slice(0, 20).map(p => 
        `- ${p.title}: ₹${p.variants?.[0]?.price || 'N/A'}`
      ).join('\n');
    }
  }

  const tierPrompts = {
    free: `You are a helpful WhatsApp sales assistant for ${tenant.shop_domain}.
Answer product questions clearly and helpfully. Keep responses short and friendly.${productContext}`,
    
    standard: `You are Vaani, an AI sales assistant for ${tenant.shop_domain}.
${tenant.brand_prompt || ''}
Help customers find products, check orders, and complete purchases via WhatsApp.
Be friendly and conversational. Keep responses concise.
You can help with: product info, order status, cart building, payment links.${productContext}`,
    
    premium: `${tenant.brand_prompt || `You are a custom AI assistant for ${tenant.shop_domain}.`}${productContext}`
  };

  const systemPrompt = tierPrompts[tenant.tier] || tierPrompts.free;

  const messages = [
    ...conversationHistory.slice(-10),
    { role: 'user', content: userMessage }
  ];

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages
  });

  return response.content[0].text;
}

module.exports = { getAIResponse };
