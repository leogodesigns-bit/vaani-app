const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse, detectLanguage } = require('../ai');
const { sendMessage, sendButtons, sendList } = require('../whatsapp');
const { getProducts } = require('../shopify');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const metadata = entry?.metadata;
    const phoneNumberId = metadata?.phone_number_id;
    const token = (await pool.query('SELECT whatsapp_token FROM tenants WHERE whatsapp_number = $1', [phoneNumberId])).rows[0]?.whatsapp_token || process.env.WHATSAPP_TOKEN;

    // Handle button replies
    const interactive = entry?.messages?.[0]?.interactive;
    const message = entry?.messages?.[0];
    if (!message) return;

    const from = message.from;
    let text = '';

    if (message.type === 'text') {
      text = message.text.body;
    } else if (message.type === 'interactive') {
      text = interactive?.button_reply?.title || interactive?.list_reply?.title || '';
    } else {
      return;
    }

    console.log(`📩 [${phoneNumberId}] Message from ${from}: ${text}`);

    const result = await pool.query('SELECT * FROM tenants WHERE whatsapp_number = $1', [phoneNumberId]);
    const tenant = result.rows[0] || (await pool.query('SELECT * FROM tenants LIMIT 1')).rows[0];
    if (!tenant) { console.log('⚠️ No tenant found'); return; }

    // Check if asking to browse/show products
    const browseKeywords = ['show', 'products', 'browse', 'catalogue', 'catalog', 'what do you have', 'earring', 'ring', 'necklace', 'jewel'];
    const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));

    if (isBrowsing && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      if (products.length > 0) {
        // Group by product type
        const categories = [...new Set(products.map(p => p.product_type).filter(Boolean))].slice(0, 3);
        
        if (categories.length >= 2) {
          // Send category buttons
          await sendButtons(
            from,
            `✨ Welcome to Ikaa Jewellery!\n\nWhat are you looking for?`,
            categories.slice(0, 3),
            token,
            phoneNumberId
          );
        } else {
          // Send product list directly
          const sections = [{
            title: 'Our Products',
            rows: products.slice(0, 10).map(p => ({
              id: `product_${p.id}`,
              title: p.title.substring(0, 24),
              description: `₹${p.variants?.[0]?.price || 'N/A'}`
            }))
          }];
          await sendList(from, '✨ Here\'s what we have at Ikaa Jewellery:', sections, token, phoneNumberId);
        }

        // Save to history
        const conv = await getConversation(tenant.id, from);
        const history = conv?.messages || [];
        await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed product catalogue]' }], conv?.cart || {});
        return;
      }
    }

    // Default AI response
    const conv = await getConversation(tenant.id, from);
    const history = conv?.messages || [];
    const lang = detectLanguage(text);
    const langInstruction = lang !== 'english' ? `Respond in ${lang}.` : '';
    const aiReply = await getAIResponse(tenant, from, langInstruction ? langInstruction + ' ' + text : text, history);
    await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: aiReply }], conv?.cart || {});
    await sendMessage(from, aiReply, token, phoneNumberId);
    console.log(`🤖 AI replied to ${from}: ${aiReply.substring(0, 50)}...`);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

module.exports = router;
