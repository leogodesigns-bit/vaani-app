const fs = require('fs');

let webhook = fs.readFileSync('routes/webhook.js', 'utf8');

// Add createDraftOrder import
webhook = webhook.replace(
  "const { getProducts } = require('../shopify');",
  "const { getProducts, createDraftOrder } = require('../shopify');"
);

// Handle product selection from list + buy intent
webhook = webhook.replace(
  `    // Default AI response`,
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
        '✨ *' + productTitle + '*\\n' + productDesc + '\\n\\nWould you like to order this?',
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
            '🛒 Your order is ready!\\n\\n*' + product.title + '*\\n\\nClick to complete payment:\\n' + draft.invoice_url,
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
        'Cart building is available on Standard and above.\\n\\nUpgrade here: ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
        waToken, phoneNumberId
      );
      return;
    }

    // Default AI response`
);

fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ Payment links added');
