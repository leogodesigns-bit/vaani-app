const fs = require('fs');
let code = fs.readFileSync('routes/webhook.js', 'utf8');

// Handle "More Categories" button tap → show list of all categories
code = code.replace(
  `const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));`,
  `const isBrowsing = browseKeywords.some(k => text.toLowerCase().includes(k));
    const isMoreCategories = text.toLowerCase().includes('more categor');`
);

code = code.replace(
  `if ((isBrowsing || isCategory || isGreeting)`,
  `if (isMoreCategories && tenant.shopify_token && tenant.shopify_token !== 'test_token') {
      const products = await getProducts(tenant.shop_domain, tenant.shopify_token);
      let aiCategories = tenant.categories;
      if (!aiCategories || aiCategories.length === 0) {
        aiCategories = await generateCategories(products);
        await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
      }
      const catNames = Object.keys(categorizeProducts(products, aiCategories));
      const sections = [{
        title: 'Our Collections',
        rows: catNames.map((c, i) => ({ id: \`cat_\${i}\`, title: c.substring(0, 24), description: 'Tap to browse' }))
      }];
      await sendList(from, '✨ Here are all our collections:', sections, waToken, phoneNumberId);
      await upsertConversation(tenant.id, from, [...history, { role: 'user', content: text }, { role: 'assistant', content: '[showed all categories]' }], conv?.cart || {});
      return;
    }

    if ((isBrowsing || isCategory || isGreeting)`
);

fs.writeFileSync('routes/webhook.js', code);
console.log('✅ Fixed');
