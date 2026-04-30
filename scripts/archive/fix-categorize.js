const fs = require('fs');

// Update webhook.js
let webhook = fs.readFileSync('routes/webhook.js', 'utf8');
webhook = webhook.replace(
  "const { categorizeProducts } = require('../utils/categorize');",
  "const { categorizeProducts } = require('../utils/categorize');\nconst { generateCategories } = require('../utils/autoCategorize');"
);
webhook = webhook.replace(
  'const categorized = categorizeProducts(products);',
  `let aiCategories = tenant.categories;
        if (!aiCategories || aiCategories.length === 0) {
          console.log('Generating AI categories for', tenant.shop_domain);
          aiCategories = await generateCategories(products);
          await pool.query('UPDATE tenants SET categories = $1 WHERE id = $2', [JSON.stringify(aiCategories), tenant.id]);
          console.log('Categories saved:', aiCategories.map(c => c.name).join(', '));
        }
        const categorized = categorizeProducts(products, aiCategories);`
);
fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ webhook.js updated');
