const fs = require('fs');
let code = fs.readFileSync('routes/webhook.js', 'utf8');

// Find and replace the greeting text regardless of exact format
code = code.replace(
  /`✨ Welcome to Ikaa Jewellery!\\n\\nWe have \${products\.length} pieces\. What are you looking for\?`/,
  '`✨ Welcome to Ikaa Jewellery!\\n\\nWhat are you looking for today?`'
);
code = code.replace(
  /`✨ Welcome to Ikaa Jewellery!\\n\\nWe have \${products\.length} pieces\. What are you looking for\?`/g,
  '`✨ Welcome to Ikaa Jewellery!\\n\\nWhat are you looking for today?`'
);

// Fix: show top 3 buttons + "More" if 4+ categories
code = code.replace(
  'const topCats = catNames.slice(0, 3).map(c => c.replace(/[💛💍📌✨🛍️]/gu, \'\').trim());',
  `const cleanCats = catNames.map(c => c.replace(/[💛💍📌✨🛍️]/gu, '').trim());
          const topCats = cleanCats.length > 3 
            ? [...cleanCats.slice(0, 2), 'More Categories']
            : cleanCats.slice(0, 3);`
);

fs.writeFileSync('routes/webhook.js', code);
console.log('✅ Fixed');
console.log('Greeting snippet:', code.match(/Welcome to Ikaa.*?looking/s)?.[0]);
