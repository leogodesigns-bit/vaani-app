const fs = require('fs');
let code = fs.readFileSync('routes/webhook.js', 'utf8');

// 1. Save shown products + category + offset to cart when showing images
code = code.replace(
  `const shownProducts = top3.map(p => ({ id: String(p.id), title: p.title, price: p.variants?.[0]?.price || '0' }));
          await upsertConversation(tenant.id, from, history, { ...conv?.cart, last_shown: shownProducts });
          const productButtons = top3.map((p,i) => (i+1)+'. '+p.title.substring(0,15));
          await sendButtons(from, 'See something you like? 💛\\nTap to shortlist:', productButtons.slice(0,3), waToken, phoneNumberId);`,
  `const shownProducts = top3.map(p => ({ id: String(p.id), title: p.title, price: p.variants?.[0]?.price || '0' }));
          const currentOffset = conv?.cart?.browse_offset || 0;
          await upsertConversation(tenant.id, from, history, { 
            ...conv?.cart, 
            last_shown: shownProducts,
            browse_category: matchedCat || 'all',
            browse_offset: currentOffset + 3
          });
          await sendButtons(from, 
            'See something you like? 💛', 
            ['Which one? 💛', 'See more', 'Back to categories'], 
            waToken, phoneNumberId
          );`
);

// 2. Handle "Which one?" — show product names as list
code = code.replace(
  `    // Handle tapping a numbered product button
    const isNumberedProduct = conv?.cart?.last_shown && ['1','2','3'].some(n => text.startsWith(n+'.'));
    if (isNumberedProduct) {
      const idx = parseInt(text[0]) - 1;
      const product = conv.cart.last_shown[idx];
      if (product) {
        const shortlist = conv.cart.shortlist || [];
        shortlist.push(product);
        await upsertConversation(tenant.id, from, [...history, {role:'user',content:text}], { ...conv.cart, shortlist });
        const shortlistText = shortlist.map((p,i) => (i+1)+'. '+p.title+' — ₹'+p.price).join('\\n');
        await sendButtons(from, '💛 Added! Your shortlist:\\n\\n'+shortlistText+'\\n\\nWhat next?', ['Send checkout link', 'Add more items'], waToken, phoneNumberId);
        return;
      }
    }`,
  `    // Handle "Which one?" — show last shown products as list to pick
    const isWhichOne = text === 'Which one? 💛';
    if (isWhichOne && conv?.cart?.last_shown?.length > 0) {
      const shown = conv.cart.last_shown;
      const sections = [{
        title: 'Choose to shortlist',
        rows: shown.map((p,i) => ({
          id: 'pick_' + p.id,
          title: (i+1) + '. ' + p.title.substring(0, 22),
          description: '₹' + p.price
        }))
      }];
      await sendList(from, 'Which one would you like to shortlist? 💛', sections, waToken, phoneNumberId);
      return;
    }

    // Handle product picked from "Which one?" list
    const isProductPicked = message.type === 'interactive' && message.interactive?.list_reply?.id?.startsWith('pick_');
    if (isProductPicked) {
      const productId = message.interactive.list_reply.id.replace('pick_', '');
      const productTitle = message.interactive.list_reply.title;
      const productPrice = message.interactive.list_reply.description;
      const shortlist = conv?.cart?.shortlist || [];
      shortlist.push({ id: productId, title: productTitle.replace(/^[0-9]+\. /,''), price: productPrice?.replace('₹','') || '0' });
      await upsertConversation(tenant.id, from, [...history, {role:'user',content:productTitle}], { ...conv?.cart, shortlist });
      const shortlistText = shortlist.map((p,i) => (i+1) + '. ' + p.title + ' — ₹' + p.price).join('\n');
      await sendButtons(from, '💛 Added to shortlist!\n\n*Your shortlist:*\n' + shortlistText + '\n\nWhat next?', ['Send checkout link', 'Add more items'], waToken, phoneNumberId);
      return;
    }`
);

// 3. Fix "See more" — show next 3 from same category
code = code.replace(
  `const seesMore = text === 'See more products';
    if (seesMore) {
      const p2 = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const aiC = tenant.categories || await generateCategories(p2);
      const { categorizeProducts } = require('../utils/categorize');
      const cNames = Object.keys(categorizeProducts(p2, aiC));
      const clean = cNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu,'').trim());
      const top = clean.length > 3 ? [...clean.slice(0,2),'More Categories'] : clean.slice(0,3);
      await sendButtons(from, 'What would you like to browse? ✨', top, waToken, phoneNumberId);
      return;
    }`,
  `const seesMore = text === 'See more';
    if (seesMore) {
      const allP = await getProducts(tenant.shop_domain, tenant.shopify_token);
      let aiC = tenant.categories;
      if (!aiC) { aiC = await generateCategories(allP); }
      const { categorizeProducts } = require('../utils/categorize');
      const catName = conv?.cart?.browse_category;
      const categorized2 = categorizeProducts(allP, aiC);
      const catProducts2 = (catName && categorized2[catName]) ? categorized2[catName] : allP;
      const offset = conv?.cart?.browse_offset || 3;
      const next3 = catProducts2.slice(offset, offset + 3);
      if (next3.length === 0) {
        await sendButtons(from, 'No more products in this category!', ['Back to categories'], waToken, phoneNumberId);
        return;
      }
      await sendMessage(from, 'More ' + (catName || 'products') + ' ✨', waToken, phoneNumberId);
      for (let i = 0; i < next3.length; i++) {
        const p = next3[i];
        const imageUrl = p.images?.[0]?.src;
        const price = p.variants?.[0]?.price || 'N/A';
        const caption = (offset+i+1) + '. ' + p.title + ' — ₹' + price;
        if (imageUrl) await sendImage(from, imageUrl, caption, waToken, phoneNumberId);
        else await sendMessage(from, caption, waToken, phoneNumberId);
        await new Promise(r => setTimeout(r, 600));
      }
      const newShown = next3.map(p => ({ id: String(p.id), title: p.title, price: p.variants?.[0]?.price || '0' }));
      await upsertConversation(tenant.id, from, [...history, {role:'user',content:text}], { ...conv?.cart, last_shown: newShown, browse_offset: offset + 3 });
      await sendButtons(from, 'See something you like? 💛', ['Which one? 💛', 'See more', 'Back to categories'], waToken, phoneNumberId);
      return;
    }

    const isBackToCategories = text === 'Back to categories';
    if (isBackToCategories) {
      const p3 = await getProducts(tenant.shop_domain, tenant.shopify_token);
      const aiC2 = tenant.categories || await generateCategories(p3);
      const { categorizeProducts: cp } = require('../utils/categorize');
      const cNames = Object.keys(cp(p3, aiC2));
      const clean = cNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu,'').trim());
      const top = clean.length > 3 ? [...clean.slice(0,2),'More Categories'] : clean.slice(0,3);
      await sendButtons(from, 'What would you like to browse? ✨', top, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from, [...history, {role:'user',content:text}], { ...conv?.cart, browse_offset: 0 });
      return;
    }`
);

fs.writeFileSync('routes/webhook.js', code);
console.log('✅ Fixed');
