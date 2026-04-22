const fs = require('fs');
let code = fs.readFileSync('utils/autoCategorize.js', 'utf8');
code = code.replace(
  `Look at these product titles from a store and group them into 3-5 categories.
Return ONLY a JSON array like this:
[
  { "name": "Earrings", "keywords": ["earring", "jhumki", "stud", "hoop"] },
  { "name": "Rings", "keywords": ["ring"] }
]
No explanation, just JSON.

Products:
\${titles}`,
  `Look at these product titles and identify ALL distinct product categories present.
Return ONLY a JSON array (max 5 categories). Each category needs a short name (max 15 chars) and keywords found in the titles.
Example format:
[
  { "name": "Earrings", "keywords": ["earring", "jhumki", "stud", "hoop"] },
  { "name": "Rings", "keywords": ["ring"] },
  { "name": "Saree Pins", "keywords": ["saree pin", "brooch"] },
  { "name": "Necklaces", "keywords": ["necklace", "pendant", "chain"] }
]
No explanation, just JSON.

Products:
\${titles}`
);
fs.writeFileSync('utils/autoCategorize.js', code);
console.log('✅ Prompt updated');
