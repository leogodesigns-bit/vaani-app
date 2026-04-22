const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse, detectLanguage } = require('../ai');
const { sendMessage, sendButtons, sendList } = require('../whatsapp');
const { getProducts } = require('../shopify');
const { categorizeProducts } = require('../utils/categorize');
const { generateCategories } = require('../utils/autoCategorize');

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

    const tenantResult = await pool.query('SELECT * FROM tenants WHERE whatsapp_number = $1', [phoneNumberId]);
    const tenant = tenantResult.rows[0] || (await pool.query('SELECT * FROM tenants LIMIT 1')).rows[0];
    if (!tenant) { console.log('⚠️ No tenant found'); return; }
    const waToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;

    const message = entry?.messages?.[0];
    if (!message) return;

    const from = message.from;
    let text = '';
    if (message.type === 'text') {
      text = message.text.body;
    } else if (message.type === 'interactive') {
      text = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
    } else {
      return;
    }

    console.log(`📩 [${phoneNumberId}] Message from ${from}: ${text}`);

    const conv = await getConversation(tenant.id, from);
    const history = conv?.messages || [];

    // Browse/catalogue intent
    const greetKeywords = ['hi', 'hello', 'hey', 'hii', 'helo', 'namaste', 'namaskar', 'start', 'help'];
    const isGreeting = greetKeywords.some(k => text.toLowerCase().trim() === k || text.toLowerCase().trim() === k + '!');
    const browseKeywords = ['show', 'product', 'browse', 'catalogue', 'catalog', 'what do you have', 'collection', 'more product', 'see product', 'view product'];
    const categoryKeywords = ['earring', 'jhumki', 'ring', 'saree pin', 'necklace', 'chain', 'pendant'];
    const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));
    const isCategory = categoryKeywords.some(k => text.toLowerCase().includes(k));

    if ((isBrowsing || isCategory || isGreeting) && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);

      if (products.length > 0) {
        let aiCategories = tenant.categories;
        if (!aiCategories || aiCategories.length === 0) {
          console.log('Generating AI categories for', tenant.shop_domain);
          aiCategories = await generateCategories(products);
          await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
          console.log('Categories saved:', aiCategories.map(c => c.name).join(', '));
        }
        const categorized = categorizeProducts(products, aiCategories);
        const catNames = Object.keys(categorized);

        if (isCategory) {
          // Find matching category and show its products as list
          const textWords = text.toLowerCase().split(" "); const matchedCat = catNames.find(c => { const cName = c.toLowerCase().replace(/[💛💍📌✨🛍️]/gu,"").trim(); return textWords.some(word => word.length > 3 && (cName.startsWith(word) || word === cName.split(" ")[0])); });
          const catProducts = matchedCat ? categorized[matchedCat] : products;

          const sections = [{
            title: matchedCat || 'Products',
            rows: catProducts.slice(0, 10).map(p => ({
              id: `product_${p.id}`,
              title: p.title.substring(0, 24),
              description: `₹${p.variants?.[0]?.price || 'N/A'}`
            }))
          }];
          await sendList(from, `Here are our ${matchedCat || 'products'} ✨`, sections, waToken, phoneNumberId);

        } else {
          // Show category buttons (max 3)
          const topCats = catNames.slice(0, 3).map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
          await sendButtons(from, `✨ Welcome to Ikaa Jewellery!\n\nWe have ${products.length} pieces. What are you looking for?`, topCats, waToken, phoneNumberId);
        }

        await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed catalogue]' }], conv?.cart || {});
        return;
      }
    }

    // Default AI response
    const lang = detectLanguage(text);
    const langInstruction = lang !== 'english' ? `Respond in ${lang}.` : '';
    const aiReply = await getAIResponse(tenant, from, langInstruction ? langInstruction + ' ' + text : text, history);
    await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: aiReply }], conv?.cart || {});
    await sendMessage(from, aiReply, waToken, phoneNumberId);
    console.log(`🤖 AI replied to ${from}: ${aiReply.substring(0, 50)}...`);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

module.exports = router;
