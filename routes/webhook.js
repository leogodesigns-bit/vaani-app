const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse, detectLanguage } = require('../ai');
const { sendMessage, sendButtons, sendList } = require('../whatsapp');
const { getProducts, createDraftOrder } = require('../shopify');
const { categorizeProducts } = require('../utils/categorize');
const { generateCategories } = require('../utils/autoCategorize');
const { refreshAllCategories } = require('../scheduler');

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
    let tenant = tenantResult.rows[0];
    if (!tenant) {
      console.log('⚠️ No tenant found for phone_number_id:', phoneNumberId);
      console.log('Available tenants:');
      const all = await pool.query('SELECT shop_domain, whatsapp_number FROM tenants');
      console.log(all.rows);
      return;
    }
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

    // Enforce free tier message cap (70/month)
    if (tenant.tier === 'free' || !tenant.tier) {
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      const convCheck = await pool.query(
        'SELECT monthly_messages, message_month FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
        [tenant.id, from]
      );
      const conv = convCheck.rows[0];
      const msgCount = (conv?.message_month === currentMonth) ? (conv?.monthly_messages || 0) : 0;
      
      if (msgCount >= 70) {
        await sendMessage(from,
          'You have reached the free plan limit of 70 messages this month.\n\nUpgrade to Standard for unlimited messages + cart building + more!\n\n👉 ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
          tenant.whatsapp_token || process.env.WHATSAPP_TOKEN,
          phoneNumberId
        );
        return;
      }
      
      // Increment message count
      await pool.query(
        `INSERT INTO conversations (tenant_id, customer_phone, monthly_messages, message_month, messages, cart)
         VALUES ($1, $2, 1, $3, '[]', '{}')
         ON CONFLICT (tenant_id, customer_phone)
         DO UPDATE SET 
           monthly_messages = CASE WHEN conversations.message_month = $3 THEN conversations.monthly_messages + 1 ELSE 1 END,
           message_month = $3`,
        [tenant.id, from, currentMonth]
      );
    }

    const conv = await getConversation(tenant.id, from);
    const history = conv?.messages || [];

    // Browse/catalogue intent
    const greetKeywords = ['hi', 'hello', 'hey', 'hii', 'helo', 'namaste', 'namaskar', 'start', 'help'];
    const isGreeting = greetKeywords.some(k => text.toLowerCase().trim() === k || text.toLowerCase().trim() === k + '!');
    const browseKeywords = ['show', 'product', 'browse', 'catalogue', 'catalog', 'what do you have', 'collection', 'more product', 'see product', 'view product'];
    const categoryKeywords = ['earring', 'jhumki', 'ring', 'saree pin', 'necklace', 'chain', 'pendant'];
    const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));
    const isMoreCategories = text.toLowerCase().includes('more categor');
    const isRefreshCmd = text.toLowerCase().trim() === 'refresh categories' || text.toLowerCase().trim() === '/refresh';
    const isCategory = categoryKeywords.some(k => text.toLowerCase().includes(k));

    if (isRefreshCmd) {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const newCats = await generateCategories(products);
      await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(newCats), tenant.id]);
      await sendMessage(from, '✅ Categories refreshed! New categories: ' + newCats.map(c => c.name).join(', '), waToken, phoneNumberId);
      return;
    }

    if (isMoreCategories && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(products);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const catNames = Object.keys(categorizeProducts(products, aiCategories));
      const sections = [{
        title: 'Our Collections',
        rows: catNames.map((c, i) => ({ id: `cat_${i}`, title: c.substring(0, 24), description: 'Tap to browse' }))
      }];
      await sendList(from, '✨ Here are all our collections:', sections, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed all categories]' }], conv?.cart || {});
      return;
    }

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
          const cleanCats = catNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
          const topCats = cleanCats.length > 3 
            ? [...cleanCats.slice(0, 2), 'More Categories']
            : cleanCats.slice(0, 3);
          await sendButtons(from, `✨ Welcome to Ikaa Jewellery!\n\nWhat are you looking for today?`, topCats, waToken, phoneNumberId);
        }

        await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed catalogue]' }], conv?.cart || {});
        return;
      }
    }

    // Handle product selected from list
    const isProductSelected = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('product_');
    if (isProductSelected) {
      const productId = message.interactive.list_reply.id.replace('product_', '');
      const productTitle = message.interactive.list_reply.title;
      const productDesc = message.interactive.list_reply.description || '';
      
      // Save selected product to cart context
      await upsertConversation(tenant.id, from, 
        [...history, { role: 'user', content: 'Selected: ' + productTitle }],
        { pending_product: { id: productId, title: productTitle, price: productDesc } }
      );
      
      await sendButtons(from,
        '✨ *' + productTitle + '*\n' + productDesc + '\n\nWould you like to order this?',
        ['Yes, order this!', 'See more products'],
        waToken, phoneNumberId
      );
      return;
    }

    // Handle order confirmation
    const wantsToBuy = text.toLowerCase().includes('yes, order') || text.toLowerCase() === 'buy' || text.toLowerCase() === 'order';
    if (wantsToBuy && conv?.cart?.pending_product && tenant.tier !== 'free') {
      const product = conv.cart.pending_product;
      try {
        const draft = await createDraftOrder(
          tenant.shop_domain,
          tenant.shopify_token,
          [{ variant_id: null, product_id: product.id, quantity: 1, title: product.title }],
          from
        );
        if (draft?.invoice_url) {
          await sendMessage(from,
            '🛒 Your order is ready!\n\n*' + product.title + '*\n\nClick to complete payment:\n' + draft.invoice_url,
            waToken, phoneNumberId
          );
          await upsertConversation(tenant.id, from, 
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[payment link sent]' }],
            { last_draft_order: draft.id }
          );
          return;
        }
      } catch (err) {
        console.error('Draft order error:', err.message);
      }
    }

    // Free tier can't build cart
    if (wantsToBuy && tenant.tier === 'free') {
      await sendMessage(from,
        'Cart building is available on Standard and above.\n\nUpgrade here: ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
        waToken, phoneNumberId
      );
      return;
    }

    // Handle product selected from list
    const isProductSelected = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('product_');
    if (isProductSelected) {
      const productId = message.interactive.list_reply.id.replace('product_', '');
      const productTitle = message.interactive.list_reply.title;
      const productDesc = message.interactive.list_reply.description || '';
      
      // Save selected product to cart context
      await upsertConversation(tenant.id, from, 
        [...history, { role: 'user', content: 'Selected: ' + productTitle }],
        { pending_product: { id: productId, title: productTitle, price: productDesc } }
      );
      
      await sendButtons(from,
        '✨ *' + productTitle + '*\n' + productDesc + '\n\nWould you like to order this?',
        ['Add to shortlist 💛', 'See more products'],
        waToken, phoneNumberId
      );
      return;
    }

    // Handle order confirmation
    const wantsToBuy = text.toLowerCase().includes('yes, order') || text.toLowerCase() === 'buy' || text.toLowerCase() === 'order';
    if (wantsToBuy && conv?.cart?.pending_product && tenant.tier !== 'free') {
      const product = conv.cart.pending_product;
      try {
        const draft = await createDraftOrder(
          tenant.shop_domain,
          tenant.shopify_token,
          [{ variant_id: null, product_id: product.id, quantity: 1, title: product.title }],
          from
        );
        if (draft?.invoice_url) {
          await sendMessage(from,
            '🛒 Your order is ready!\n\n*' + product.title + '*\n\nClick to complete payment:\n' + draft.invoice_url,
            waToken, phoneNumberId
          );
          await upsertConversation(tenant.id, from, 
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[payment link sent]' }],
            { last_draft_order: draft.id }
          );
          return;
        }
      } catch (err) {
        console.error('Draft order error:', err.message);
      }
    }

    // Free tier can't build cart
    if (wantsToBuy && tenant.tier === 'free') {
      await sendMessage(from,
        'Cart building is available on Standard and above.\n\nUpgrade here: ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
        waToken, phoneNumberId
      );
      return;
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
