const fs = require('fs');
let code = fs.readFileSync('routes/webhook.js', 'utf8');

// Find and replace the entire isCategory block
const oldBlock = `        if (isCategory) {
          const textWords = text.toLowerCase().split(" ");
          const matchedCat = catNames.find(c => { const cName = c.toLowerCase().replace(/[💛💍📌✨🛍️]/gu,"").trim(); return textWords.some(word => word.length > 3 && (cName.startsWith(word) || word === cName.split(" ")[0])); });
          const catProducts = matchedCat ? categorized[matchedCat] : products;
          const top3 = catProducts.slice(0, 3);

          // Send intro message
          await sendMessage(from, \`Here are our \${matchedCat || 'products'} ✨\`, waToken, phoneNumberId);

          // Send each product as image with caption + shortlist button
          const emojis = ['1️⃣','2️⃣','3️⃣'];
          for (let i = 0; i < top3.length; i++) {
            const p = top3[i];
            const imageUrl = p.images?.[0]?.src;
            const price = p.variants?.[0]?.price || 'N/A';
            const available = p.variants?.[0]?.inventory_quantity > 0 ? 'In Stock ✅' : 'Available ✅';
            const link = \`https://\${tenant.shop_domain.replace('.myshopify.com','')}.com/products/\${p.handle || ''}\`;
            const caption = \`\${emojis[i]} *\${p.title}*\\n₹\${price} • \${available}\`;
            if (imageUrl) {
              await sendImage(from, imageUrl, caption, waToken, phoneNumberId);
            } else {
              await sendMessage(from, caption, waToken, phoneNumberId);
            }
            await new Promise(r => setTimeout(r, 600));
          }

          // After images, show options
          await sendButtons(from,
            'See something you like? 💛',
            ['Add to shortlist 💛', 'See more products'],
            waToken, phoneNumberId
          );`;

// Find if the new block already exists
if (code.includes("const emojis = ['1️⃣','2️⃣','3️⃣']")) {
  console.log('New image block already exists — checking for old sendList...');
}

// Remove the OLD sendList isCategory block (lines 149-163 area)
const oldSendList = `        if (isCategory) {
          // Find matching category and show its products as list
          const matchedCat = catNames.find(c => { const cName = c.toLowerCase().replace(/[💛💍📌✨🛍️]/gu,"").trim(); return textWords.some(word => word.length > 3 && (cName.startsWith(word) || word === cName.split(" ")[0])); });
          const catProducts = matchedCat ? categorized[matchedCat] : products;

          const sections = [{
            title: matchedCat || 'Products',
            rows: catProducts.slice(0, 10).map(p => ({
              id: \`product_\${p.id}\`,
              title: p.title.substring(0, 24),
              description: \`₹\${p.variants?.[0]?.price || 'N/A'}\`
            }))
          }];
          await sendList(from, \`Here are our \${matchedCat || 'products'} ✨\`, sections, waToken, phoneNumberId);`;

if (code.includes('// Find matching category and show its products as list')) {
  code = code.replace(oldSendList, oldBlock);
  console.log('✅ Replaced old sendList with image flow');
} else {
  console.log('Old block not found exactly — checking what is at line 149...');
  const lines = code.split('\n');
  lines.slice(145, 170).forEach((l, i) => console.log(145+i+':', l));
}

fs.writeFileSync('routes/webhook.js', code);
