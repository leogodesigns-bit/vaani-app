const fs = require('fs');
let webhook = fs.readFileSync('routes/webhook.js', 'utf8');

// Replace the product selected handler with full shortlist flow
webhook = webhook.replace(
  `    // Handle product selected from list
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
        '✨ *' + productTitle + '*\\n' + productDesc + '\\n\\nShall I keep this aside for you? 💛',
        ['Add to shortlist 💛', 'See more products'],
        waToken, phoneNumberId
      );
      return;
    }`,

  `    // Handle product selected from list
    const isProductSelected = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('product_');
    if (isProductSelected) {
      const productId = message.interactive.list_reply.id.replace('product_', '');
      const productTitle = message.interactive.list_reply.title;
      const productDesc = message.interactive.list_reply.description || '';
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: 'Selected: ' + productTitle }],
        { ...conv?.cart, pending_product: { id: productId, title: productTitle, price: productDesc } }
      );
      await sendButtons(from,
        '✨ *' + productTitle + '*\\n' + productDesc + '\\n\\nShall I keep this aside for you? 💛',
        ['Add to shortlist 💛', 'See more products'],
        waToken, phoneNumberId
      );
      return;
    }

    // Handle "Add to shortlist"
    const isAddToShortlist = text === 'Add to shortlist 💛';
    if (isAddToShortlist && conv?.cart?.pending_product) {
      const product = conv.cart.pending_product;
      const shortlist = conv.cart.shortlist || [];
      shortlist.push(product);
      await upsertConversation(tenant.id, from,
        [...history, { role: 'user', content: text }],
        { ...conv.cart, shortlist, pending_product: null }
      );
      const shortlistText = shortlist.map((p, i) => (i+1) + '. ' + p.title + ' — ' + p.price).join('\\n');
      await sendButtons(from,
        '💛 Added to your shortlist!\\n\\n*Your shortlist:*\\n' + shortlistText + '\\n\\nWhat would you like to do?',
        ['Send checkout link', 'Add more items'],
        waToken, phoneNumberId
      );
      return;
    }

    // Handle "Send checkout link"
    const wantsCheckout = text === 'Send checkout link' || text.toLowerCase().includes('checkout') || text.toLowerCase().includes('buy now');
    if (wantsCheckout && conv?.cart?.shortlist?.length > 0 && tenant.tier !== 'free') {
      const shortlist = conv.cart.shortlist;
      try {
        const lineItems = shortlist.map(p => ({
          title: p.title,
          quantity: 1,
          price: p.price?.replace('₹','') || '0'
        }));
        const draft = await createDraftOrder(tenant.shop_domain, tenant.shopify_token, lineItems, from);
        if (draft?.invoice_url) {
          const itemList = shortlist.map(p => '• ' + p.title).join('\\n');
          await sendMessage(from,
            '🛍️ *Your order is ready!*\\n\\n' + itemList + '\\n\\nClick to complete payment 👇\\n' + draft.invoice_url + '\\n\\n_Link valid for 24 hours_',
            waToken, phoneNumberId
          );
          await upsertConversation(tenant.id, from,
            [...history, { role: 'user', content: text }, { role: 'assistant', content: '[checkout link sent]' }],
            { ...conv.cart, last_draft_order: draft.id, shortlist: [] }
          );
          return;
        }
      } catch (err) {
        console.error('Draft order error:', err.message);
      }
    }`
);

fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ Shortlist flow added');
