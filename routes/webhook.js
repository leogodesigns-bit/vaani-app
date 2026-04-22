const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse, detectLanguage } = require('../ai');
const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
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

// Helper: send 3 products starting at offset, return how many were sent
async function sendProductPage(from, products, offset, waToken, phoneNumberId) {
  const page = products.slice(offset, offset + 3);
  const emojis = ['1.', '2.', '3.'];
  for (let i = 0; i < page.length; i++) {
    const p = page[i];
    const imageUrl = p.images?.[0]?.src;
    const price = p.variants?.[0]?.price || 'N/A';
    const num = offset + i + 1;
    const caption = num + '. ' + p.title + ' — ₹' + price;
    if (imageUrl) {
      await sendImage(from, imageUrl, caption, waToken, phoneNumberId);
    } else {
      await sendMessage(from, caption, waToken, phoneNumberId);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return page.length;
}

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
      const all = await pool.query('SELECT shop_domain, whatsapp_number FROM tenants');
      console.log(all.rows);
      return;
    }
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
      const currentMonth = new Date().toISOString().slice(0, 7);
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
    // cart holds: { current_category, product_offset, shortlist, pending_product, ... }
    const cart = conv?.cart || {};

    // ─── KEYWORDS ────────────────────────────────────────────────────────────
    const greetKeywords = ['hi', 'hello', 'hey', 'hii', 'helo', 'namaste', 'namaskar', 'start', 'help'];
    const isGreeting = greetKeywords.some(k => text.toLowerCase().trim() === k || text.toLowerCase().trim() === k + '!');
    const browseKeywords = ['show', 'product', 'browse', 'catalogue', 'catalog', 'what do you have', 'collection', 'more product', 'see product', 'view product'];
    const categoryKeywords = ['earring', 'jhumki', 'ring', 'saree pin', 'necklace', 'chain', 'pendant'];
    const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));
    const isMoreCategories = text.toLowerCase().includes('more categor');
    const isRefreshCmd = text.toLowerCase().trim() === 'refresh categories' || text.toLowerCase().trim() === '/refresh';
    const isCategory = categoryKeywords.some(k => text.toLowerCase().includes(k));

    // ─── SEE MORE ─────────────────────────────────────────────────────────────
    const isSeeMore = text.toLowerCase().includes('see more');

    if (isSeeMore && cart.current_category && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      // Filter: in stock only
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );

      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      const catProducts = categorized[cart.current_category] || inStock;

      const newOffset = (cart.product_offset || 0) + 3;

      if (newOffset >= catProducts.length) {
        await sendMessage(from, "That's all our " + cart.current_category + " for now! 💛", waToken, phoneNumberId);
        await sendButtons(from, 'What would you like to do?', ['Back to categories', 'View shortlist 💛'], waToken, phoneNumberId);
        await upsertConversation(tenant.id, from,
          [...history, { role: 'user', content: text }, { role: 'assistant', content: '[end of category]' }],
          { ...cart, product_offset: newOffset }
        );
      } else {
        const sent = await sendProductPage(from, catProducts, newOffset, waToken, phoneNumberId);
        const buttons = ['Add to shortlist 💛'];
        if (newOffset + sent < catProducts.length) buttons.push('See more products');
        buttons.push('Back to categories');
        await sendButtons(from, 'See something you like? 💛', buttons, waToken, phoneNumberId);
        await upsertConversation(tenant.id, from,
          [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed more products]' }],
          { ...cart, product_offset: newOffset }
        );
      }
      return;
    }

    // ─── ADD TO SHORTLIST ─────────────────────────────────────────────────────
    const isAddToShortlist = text.toLowerCase().includes('add to shortlist') || text.toLowerCase().includes('shortlist');

    if (isAddToShortlist && cart.current_category && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );

      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      const catProducts = categorized[cart.current_category] || inStock;

      // windowStart = last shown page start (product_offset points to NEXT page)
      const windowStart = Math.max(0, (cart.product_offset || 3) - 3);
      const windowProducts = catProducts.slice(windowStart, windowStart + 3);

      if (windowProducts.length === 0) {
        await sendMessage(from, "Hmm, I couldn't find the products. Try browsing again! 😊", waToken, phoneNumberId);
        return;
      }

      // Send as list — use cumulative numbers matching what user saw
      const rows = windowProducts.map((p, i) => ({
        id: 'shortlist_' + p.id,
        title: (windowStart + i + 1) + '. ' + p.title.substring(0, 24),
        description: '₹' + (p.variants?.[0]?.price || 'N/A')
      }));

      const sections = [{ title: 'Pick one to add 💛', rows }];
      await sendList(from, 'Which one would you like to shortlist? 💛', sections, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed shortlist picker]' }],
        { ...cart }
      );
      return;
    }

    // ─── SHORTLIST ITEM SELECTED ──────────────────────────────────────────────
    const isShortlistSelected = message.type === 'interactive' &&
      message.interactive?.list_reply?.id?.startsWith('shortlist_');

    if (isShortlistSelected) {
      const productId = message.interactive.list_reply.id.replace('shortlist_', '');
      const productTitle = message.interactive.list_reply.title.replace(/^\d+\.\s*/, '');
      const productPrice = message.interactive.list_reply.description || '';

      const shortlist = cart.shortlist || [];
      const alreadyIn = shortlist.some(i => i.id === productId);

      if (!alreadyIn) {
        shortlist.push({ id: productId, title: productTitle, price: productPrice });
      }

      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: 'Shortlisted: ' + productTitle }],
        { ...cart, shortlist }
      );

      const shortlistSummary = shortlist.map((i, n) => (n + 1) + '. ' + i.title + ' — ' + i.price).join('\n');
      const buttons = ['Add more 💛', 'Send checkout link'];
      if (shortlist.length < 3) buttons.unshift('Back to categories');

      await sendButtons(from,
        (alreadyIn ? '✅ Already in your shortlist!\n\n' : '✅ Added to shortlist!\n\n') +
        '*Your shortlist:*\n' + shortlistSummary,
        buttons.slice(0, 3),
        waToken, phoneNumberId
      );
      return;
    }

    // ─── SEND CHECKOUT LINK ───────────────────────────────────────────────────
    const isCheckout = text.toLowerCase().includes('checkout') || text.toLowerCase().includes('send checkout');

    if (isCheckout && cart.shortlist?.length > 0 && tenant.tier !== 'free') {
      const lineItems = cart.shortlist.map(item => ({
        title: item.title,
        quantity: 1,
        price: item.price.replace('₹', '') || '0'
      }));
      try {
        const draft = await createDraftOrder(tenant.shop_domain, tenant.shopify_token, lineItems, from);
        if (draft?.invoice_url) {
          const summary = cart.shortlist.map((i, n) => (n + 1) + '. ' + i.title + ' — ' + i.price).join('\n');
          await sendMessage(from,
            '🛒 Your order is ready!\n\n' + summary + '\n\n👉 Complete your payment here:\n' + draft.invoice_url,
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

    if (isCheckout && tenant.tier === 'free') {
      await sendMessage(from,
        'Cart building is available on Standard and above.\n\nUpgrade here: ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
        waToken, phoneNumberId
      );
      return;
    }

    // ─── BACK TO CATEGORIES ───────────────────────────────────────────────────
    const isBackToCategories = text.toLowerCase().includes('back to categor');

    if (isBackToCategories && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      const catNames = Object.keys(categorized);
      const cleanCats = catNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
      const topCats = cleanCats.length > 3 ? [...cleanCats.slice(0, 2), 'More Categories'] : cleanCats.slice(0, 3);
      await sendButtons(from, '✨ What are you looking for?', topCats, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[back to categories]' }],
        { shortlist: cart.shortlist || [] } // preserve shortlist, reset browse state
      );
      return;
    }

    // ─── REFRESH ─────────────────────────────────────────────────────────────
    if (isRefreshCmd) {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const newCats = await generateCategories(products);
      await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(newCats), tenant.id]);
      await sendMessage(from, '✅ Categories refreshed! New categories: ' + newCats.map(c => c.name).join(', '), waToken, phoneNumberId);
      return;
    }

    // ─── MORE CATEGORIES ──────────────────────────────────────────────────────
    if (isMoreCategories && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const catNames = Object.keys(categorizeProducts(inStock, aiCategories));
      const sections = [{
        title: 'Our Collections',
        rows: catNames.map((c, i) => ({ id: `cat_${i}`, title: c.substring(0, 24), description: 'Tap to browse' }))
      }];
      await sendList(from, '✨ Here are all our collections:', sections, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed all categories]' }],
        { ...cart }
      );
      return;
    }

    // ─── GREETING / BROWSE / CATEGORY ────────────────────────────────────────
    if ((isBrowsing || isCategory || isGreeting) && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);

      // ✅ Filter out-of-stock: keep products where at least one variant is available
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );

      if (inStock.length > 0) {
        let aiCategories = tenant.categories;
        if (!aiCategories || aiCategories.length === 0) {
          console.log('Generating AI categories for', tenant.shop_domain);
          aiCategories = await generateCategories(inStock);
          await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
          console.log('Categories saved:', aiCategories.map(c => c.name).join(', '));
        }
        const categorized = categorizeProducts(inStock, aiCategories);
        const catNames = Object.keys(categorized);

        if (isCategory) {
          const textWords = text.toLowerCase().split(' ');
          const matchedCat = catNames.find(c => {
            const cName = c.toLowerCase().replace(/[💛💍📌✨🛍️]/gu, '').trim();
            return textWords.some(word => word.length > 3 && (cName.startsWith(word) || word === cName.split(' ')[0]));
          });

          // Also handle category selected from list (e.g. "cat_0")
          const listCatIndex = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('cat_')
            ? parseInt(message.interactive.list_reply.id.replace('cat_', ''))
            : -1;
          const finalCat = matchedCat || (listCatIndex >= 0 ? catNames[listCatIndex] : null);
          const catProducts = finalCat ? categorized[finalCat] : inStock;

          await sendMessage(from, 'Here are our ' + (finalCat || 'products') + ' ✨', waToken, phoneNumberId);
          await sendProductPage(from, catProducts, 0, waToken, phoneNumberId);

          const buttons = ['Add to shortlist 💛'];
          if (catProducts.length > 3) buttons.push('See more products');
          buttons.push('Back to categories');
          await sendButtons(from, 'See something you like? 💛', buttons.slice(0, 3), waToken, phoneNumberId);

          // ✅ Save state: current category + offset
          await upsertConversation(tenant.id, from,
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed catalogue]' }],
            { ...cart, current_category: finalCat, product_offset: 3 }
          );

        } else {
          // Show greeting + category buttons
          const cleanCats = catNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
          const topCats = cleanCats.length > 3
            ? [...cleanCats.slice(0, 2), 'More Categories']
            : cleanCats.slice(0, 3);
          await sendButtons(from, `✨ Welcome to ${tenant.store_name || 'our store'}!\n\nWhat are you looking for today?`, topCats, waToken, phoneNumberId);
          await upsertConversation(tenant.id, from,
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed catalogue]' }],
            { ...cart }
          );
        }
        return;
      }
    }

    // Also handle category tap from list (cat_N)
    const isCatFromList = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('cat_');
    if (isCatFromList && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const catIndex = parseInt(message.interactive.list_reply.id.replace('cat_', ''));
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      );
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      const catNames = Object.keys(categorized);
      const finalCat = catNames[catIndex];
      const catProducts = finalCat ? categorized[finalCat] : inStock;

      await sendMessage(from, 'Here are our ' + (finalCat || 'products') + ' ✨', waToken, phoneNumberId);
      await sendProductPage(from, catProducts, 0, waToken, phoneNumberId);

      const buttons = ['Add to shortlist 💛'];
      if (catProducts.length > 3) buttons.push('See more products');
      buttons.push('Back to categories');
      await sendButtons(from, 'See something you like? 💛', buttons.slice(0, 3), waToken, phoneNumberId);

      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed category from list]' }],
        { ...cart, current_category: finalCat, product_offset: 3 }
      );
      return;
    }

    // ─── HANDLE OLD product_ list selection ───────────────────────────────────
    const isProductSelected = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('product_');
    if (isProductSelected) {
      const productId = message.interactive.list_reply.id.replace('product_', '');
      const productTitle = message.interactive.list_reply.title;
      const productDesc = message.interactive.list_reply.description || '';
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: 'Selected: ' + productTitle }],
        { ...cart, pending_product: { id: productId, title: productTitle, price: productDesc } }
      );
      await sendButtons(from,
        '✨ *' + productTitle + '*\n' + productDesc + '\n\nWould you like to order this?',
        ['Add to shortlist 💛', 'See more products'],
        waToken, phoneNumberId
      );
      return;
    }

    // ─── DEFAULT AI RESPONSE ──────────────────────────────────────────────────
    const lang = detectLanguage(text);
    const langInstruction = lang !== 'english' ? `Respond in ${lang}.` : '';
    const aiReply = await getAIResponse(tenant, from, langInstruction ? langInstruction + ' ' + text : text, history);
    await upsertConversation(tenant.id, from,
      [...history, { role: 'user', content: text }, { role: 'assistant', content: aiReply }],
      cart
    );
    await sendMessage(from, aiReply, waToken, phoneNumberId);
    console.log(`🤖 AI replied to ${from}: ${aiReply.substring(0, 50)}...`);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

module.exports = router;
