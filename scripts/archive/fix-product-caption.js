const fs = require('fs');
let webhook = fs.readFileSync('routes/webhook.js', 'utf8');

webhook = webhook.replace(
  `          // Send each product as image with caption + shortlist button
          for (const p of top3) {
            const imageUrl = p.images?.[0]?.src;
            const price = p.variants?.[0]?.price || 'N/A';
            const caption = \`*\${p.title}*\\n₹\${price}\`;
            if (imageUrl) {
              await sendImage(from, imageUrl, caption, waToken, phoneNumberId);
            } else {
              await sendMessage(from, caption, waToken, phoneNumberId);
            }
            // Small delay between messages
            await new Promise(r => setTimeout(r, 500));
          }`,

  `          // Send each product as image with caption + shortlist button
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
          }`
);

fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ Caption style updated');
