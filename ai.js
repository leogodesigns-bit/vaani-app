const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAIResponse(tenant, customerPhone, userMessage, conversationHistory) {
  const tierPrompts = {
    free: `You are a helpful WhatsApp sales assistant for ${tenant.shop_domain}. 
Answer product questions clearly and helpfully. Keep responses short and friendly.
If asked about products, say you can help find information on the store.`,
    
    standard: `You are Vaani, an AI sales assistant for ${tenant.shop_domain}.
${tenant.brand_prompt || ''}
You help customers find products, check orders, and complete purchases via WhatsApp.
Be friendly, helpful, and conversational. Keep responses concise.
You can help with: product info, order status, cart building, payment links.`,
    
    premium: tenant.brand_prompt || `You are a custom AI assistant for ${tenant.shop_domain}.`
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
