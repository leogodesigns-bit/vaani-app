const express = require('express');
const router = express.Router();
router.use((req, res, next) => { console.log(`🔵 INCOMING ${req.method} ${req.url}`); next(); });
// Pool now imported from ../db
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse, detectLanguage } = require('../ai');
const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
const { getProducts, createDraftOrder } = require('../shopify');
const { categorizeProducts } = require('../utils/categorize');
const { generateCategories } = require('../utils/autoCategorize');
const { refreshAllCategories } = require('../scheduler');

const { pool } = require('../db');
const { trackConversation } = require('../usage');
const { isFounderCommand, handleFounderCommand } = require('../founder');
const { checkAndFireAlerts } = require('../alerts');
const rajatheeHandler = require('../handlers/rajathee');
const woofparadeHandler = require('../handlers/woofparade');

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

// Weighted shuffle: higher score = more likely to appear early, but still random
function weightedShuffle(products, scores) {
  return products
    .map(p => ({
      product: p,
      // weight = score + 1 (so unscored items still have chance), multiplied by random
      weight: (scores[String(p.id)] || 0) + 1
    }))
    .sort((a, b) => {
      // Mix of weight and randomness: higher weight = higher chance but not guaranteed
      const aScore = a.weight * (0.3 + Math.random() * 0.7);
      const bScore = b.weight * (0.3 + Math.random() * 0.7);
      return bScore - aScore;
    })
    .map(x => x.product);
}

async function getProductScores(tenantId) {
  try {
    const res = await pool.query(
      'SELECT product_id, score FROM product_scores WHERE tenant_id = $1',
      [tenantId]
    );
    const scores = {};
    res.rows.forEach(r => { scores[r.product_id] = r.score; });
    return scores;
  } catch (err) {
    // Table might not exist yet - create it
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS product_scores (
          tenant_id INTEGER,
          product_id TEXT,
          score INTEGER DEFAULT 0,
          PRIMARY KEY (tenant_id, product_id)
        )
      `);
    } catch (e) {}
    return {};
  }
}

async function incrementProductScore(tenantId, productId) {
  try {
    await pool.query(`
      INSERT INTO product_scores (tenant_id, product_id, score)
      VALUES ($1, $2, 1)
      ON CONFLICT (tenant_id, product_id)
      DO UPDATE SET score = product_scores.score + 1
    `, [tenantId, productId]);
  } catch (err) {
    console.error('Score update error:', err.message);
  }
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
    if (!tenant.whatsapp_token) {
      console.error("❌ Tenant " + tenant.shop_domain + " has no whatsapp_token — refusing to send");
      return;
    }
    const waToken = tenant.whatsapp_token;

    const message = entry?.messages?.[0];
    if (!message) return;

    const from = message.from;

    // ─── DEDUP GUARD: prevent Meta webhook retries from re-processing ────────
    // Meta retries webhook delivery if the server is slow or returns non-200.
    // Without this, the same message can run handle() twice — causing the bot
    // to re-greet the customer or duplicate sends mid-flow.
    // (tenant_id, wamid) is a primary key; INSERT ... ON CONFLICT DO NOTHING
    // is atomic, so concurrent webhook arrivals also dedupe correctly.
    if (message.id) {
      try {
        const dedup = await pool.query(
          `INSERT INTO processed_messages (tenant_id, wamid)
           VALUES ($1, $2)
           ON CONFLICT (tenant_id, wamid) DO NOTHING
           RETURNING wamid`,
          [tenant.id, message.id]
        );
        if (dedup.rowCount === 0) {
          console.log(`[dedup] ${tenant.shop_domain} skipped duplicate wamid=${message.id} from ${from}`);
          return;
        }
      } catch (e) {
        // If the dedup table is missing or DB is down, log + proceed
        // (better to risk a duplicate than to drop the message entirely)
        console.error('[dedup] check failed (non-fatal):', e.message);
      }
    }

    // ─── PHASE 2 + 4: usage tracking + threshold alerts ─────────────────
    // Track this conversation. If a new conversation, also check thresholds
    // and fire any 70/90/100% alerts that just crossed. All errors are
    // swallowed — tracking and alerting never break the customer flow.
    trackConversation(tenant.id, from)
      .then(async (trackResult) => {
        if (!trackResult || !trackResult.isNewConversation || !trackResult.usage) return;
        const newUsed = trackResult.usage.conversation_count;
        const oldUsed = newUsed - 1;
        try {
          await checkAndFireAlerts({
            tenantId: tenant.id,
            sendMessage,
            waToken,
            phoneNumberId,
            oldUsed,
            newUsed
          });
        } catch (err) {
          console.error('[alerts] inline check failed (non-fatal):', err.message);
        }
      })
      .catch(err => {
        console.error('[usage] tracking failed (non-fatal):', err.message);
      });

    let text = '';
    if (message.type === 'text') {
      text = message.text.body;
    } else if (message.type === 'interactive') {
      text = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
    } else {
      return;
    }

    console.log(`📩 [${phoneNumberId}] Message from ${from}: ${text}`);

    // ─── PHASE 3: founder commands intercept ─────────────────────────────
    // If sender is the Leogo founder AND the message looks like an admin
    // command, hand off to founder.js and skip the customer flow entirely.
    if (isFounderCommand(from, text)) {
      await handleFounderCommand({ from, text, phoneNumberId, waToken, sendMessage });
      return;
    }

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
          tenant.whatsapp_token,
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

    // ─── FLOW ROUTING GATE ───────────────────────────────────────────────────
    // Tenants with flow_template !== 'jhilmil' are routed to a dedicated handler.
    // Default ('jhilmil') falls through to the inline Jhilmil/Ikaa flow below.
    if (tenant.flow_template === 'rajathee') {
      await rajatheeHandler.handle({
        tenant, message, from, text, phoneNumberId, waToken, history, cart
      });
      return;
    }

    if (tenant.flow_template === 'woofparade') {
      await woofparadeHandler.handle({
        tenant, message, from, text, phoneNumberId, waToken, history, cart
      });
      return;
    }

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

    if (isSeeMore && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      // Filter: in stock only
      // Sort by ID for stable ordering across fetches
      const inStock = products
        .filter(p => p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0))
        .sort((a, b) => a.id - b.id);

      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      let catProducts = null;
      if (cart.current_category) {
        catProducts = categorized[cart.current_category];
        if (!catProducts) {
          const key = Object.keys(categorized).find(k =>
            k.toLowerCase().replace(/[^a-z0-9]/g, '') ===
            cart.current_category.toLowerCase().replace(/[^a-z0-9]/g, '')
          );
          if (key) catProducts = categorized[key];
        }
      }
      catProducts = catProducts || inStock;

      // Restore session order if saved, otherwise re-shuffle
      if (cart.session_product_ids && cart.session_product_ids.length > 0) {
        const idOrder = cart.session_product_ids;
        catProducts = idOrder
          .map(id => catProducts.find(p => p.id === id))
          .filter(Boolean);
        // Add any new products not in saved order at the end
        const known = new Set(idOrder.map(String));
        const newProds = (catProducts || inStock).filter(p => !known.has(String(p.id)));
        catProducts = [...catProducts, ...newProds];
      }

      const currentOffset = cart.product_offset || 0;
      const newOffset = currentOffset + 3;

      if (currentOffset >= catProducts.length) {
        // Already showed everything
        await sendMessage(from, "That's all our " + (cart.current_category || 'products') + "! 💛", waToken, phoneNumberId);
        await sendButtons(from, 'What would you like to do?', ['Back to categories', 'View shortlist 💛'], waToken, phoneNumberId);
        await upsertConversation(tenant.id, from,
          [...history, { role: 'user', content: text }, { role: 'assistant', content: '[end of category]' }],
          { ...cart }
        );
      } else {
        // Show next page (may be partial - e.g. only 2 products left)
        const sent = await sendProductPage(from, catProducts, currentOffset, waToken, phoneNumberId);
        const savedOffset = currentOffset + sent; // exact count shown, not always +3
        const hasMore = savedOffset < catProducts.length;
        const buttons = ['Add to shortlist 💛'];
        if (hasMore) buttons.push('See more products');
        buttons.push('Back to categories');
        await sendButtons(from, 'See something you like? 💛', buttons, waToken, phoneNumberId);
        await upsertConversation(tenant.id, from,
          [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed more products: ' + catProducts.slice(currentOffset, savedOffset).map(p => p.title).join(', ') + ']' }],
          { ...cart, product_offset: savedOffset }
        );
      }
      return;
    }

    // ─── ADD TO SHORTLIST ─────────────────────────────────────────────────────
    // Strip emojis before matching button text
    const textClean = text.replace(/[^\w\s]/gi, '').toLowerCase().trim();
    const isAddToShortlist = textClean.includes('add to shortlist') || textClean === 'shortlist' || text.toLowerCase().includes('shortlist');

    if (isAddToShortlist && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const inStock = products.filter(p =>
        p.variants?.some(v => v.inventory_management === null || v.inventory_quantity > 0)
      ).sort((a, b) => a.id - b.id);

      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      // Find category with case-insensitive / partial match as fallback
      let catProducts = null;
      if (cart.current_category) {
        catProducts = categorized[cart.current_category];
        if (!catProducts) {
          // Try case-insensitive match
          const key = Object.keys(categorized).find(k =>
            k.toLowerCase().replace(/[^a-z0-9]/g, '') ===
            cart.current_category.toLowerCase().replace(/[^a-z0-9]/g, '')
          );
          if (key) catProducts = categorized[key];
        }
      }
      catProducts = catProducts || inStock;

      // Restore session order (same shuffled order the customer actually saw)
      let orderedProducts = catProducts;
      if (cart.session_product_ids && cart.session_product_ids.length > 0) {
        const idMap = {};
        catProducts.forEach(p => { idMap[String(p.id)] = p; });
        orderedProducts = cart.session_product_ids
          .map(id => idMap[String(id)])
          .filter(Boolean);
      }

      const seenUpTo = cart.product_offset || 3;
      const windowStart = Math.max(0, seenUpTo - 10);
      const windowProducts = orderedProducts.slice(windowStart, seenUpTo);
      console.log('🛍️ Shortlist: category=', cart.current_category, 'seenUpTo=', seenUpTo, 'windowProducts=', windowProducts.length, 'hasSessionIds=', !!(cart.session_product_ids));

      if (windowProducts.length === 0) {
        await sendMessage(from, "Hmm, I couldn't find the products. Try browsing again! 😊", waToken, phoneNumberId);
        return;
      }

      // Send as list — use cumulative numbers matching what user saw
      const rows = windowProducts.map((p, i) => ({
        id: 'shortlist_' + p.id,
        title: ((windowStart + i + 1) + '. ' + p.title).substring(0, 24),
        description: '₹' + (p.variants?.[0]?.price || 'N/A')
      }));

      const sections = [{ title: 'Pick one to add 💛', rows }];
      await sendList(from, 'Which one would you like to shortlist? 💛', sections, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed shortlist picker: ' + windowProducts.map(p => p.title).join(', ') + ']' }],
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
        // Learn: increment score so this product surfaces earlier for future customers
        await incrementProductScore(tenant.id, productId);
        console.log('📈 Score incremented for product:', productId, productTitle);
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
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[payment link sent: ' + cart.shortlist.length + ' item(s) — ' + cart.shortlist.map(i => i.title).join(', ') + ']' }],
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
      ).sort((a, b) => a.id - b.id);
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
      ).sort((a, b) => a.id - b.id);
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
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed all categories: ' + catNames.join(', ') + ']' }],
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
      ).sort((a, b) => a.id - b.id);

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

          // Weighted shuffle: popular (shortlisted) products surface first, with randomness
          const scores = await getProductScores(tenant.id);
          const shuffledProducts = weightedShuffle(catProducts, scores);

          await sendMessage(from, 'Here are our ' + (finalCat || 'products') + ' ✨', waToken, phoneNumberId);
          const firstSent = await sendProductPage(from, shuffledProducts, 0, waToken, phoneNumberId);

          const buttons = ['Add to shortlist 💛'];
          if (catProducts.length > firstSent) buttons.push('See more products');
          buttons.push('Back to categories');
          await sendButtons(from, 'See something you like? 💛', buttons.slice(0, 3), waToken, phoneNumberId);

          console.log('💾 Saving current_category:', finalCat, 'offset:', firstSent, 'total:', shuffledProducts.length);
          // Save shuffled product IDs so See More uses same order this session
          const shuffledIds = shuffledProducts.map(p => p.id);
          await upsertConversation(tenant.id, from,
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed ' + (finalCat || 'catalogue') + ': ' + shuffledProducts.slice(0, firstSent).map(p => p.title).join(', ') + ']' }],
            { ...cart, current_category: finalCat, product_offset: firstSent, session_product_ids: shuffledIds }
          );

        } else {
          // Show greeting + category buttons
          const cleanCats = catNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
          const topCats = cleanCats.length > 3
            ? [...cleanCats.slice(0, 2), 'More Categories']
            : cleanCats.slice(0, 3);
          await sendButtons(from, `✨ Welcome to ${tenant.store_name || 'our store'}!\n\nWhat are you looking for today?`, topCats, waToken, phoneNumberId);
          await upsertConversation(tenant.id, from,
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed welcome + categories: ' + topCats.join(', ') + ']' }],
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
      ).sort((a, b) => a.id - b.id);
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(inStock);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const categorized = categorizeProducts(inStock, aiCategories);
      const catNames = Object.keys(categorized);
      const finalCat = catNames[catIndex];
      const catProducts = finalCat ? categorized[finalCat] : inStock;

      const scoresFromList = await getProductScores(tenant.id);
      const shuffledFromList = weightedShuffle(catProducts, scoresFromList);

      await sendMessage(from, 'Here are our ' + (finalCat || 'products') + ' ✨', waToken, phoneNumberId);
      const firstSentList = await sendProductPage(from, shuffledFromList, 0, waToken, phoneNumberId);

      const buttons = ['Add to shortlist 💛'];
      if (shuffledFromList.length > firstSentList) buttons.push('See more products');
      buttons.push('Back to categories');
      await sendButtons(from, 'See something you like? 💛', buttons.slice(0, 3), waToken, phoneNumberId);

      const shuffledIdsFromList = shuffledFromList.map(p => p.id);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed ' + (finalCat || 'category') + ': ' + shuffledFromList.slice(0, firstSentList).map(p => p.title).join(', ') + ']' }],
        { ...cart, current_category: finalCat, product_offset: firstSentList, session_product_ids: shuffledIdsFromList }
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
