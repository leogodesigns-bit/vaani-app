const fs = require('fs');

// 1. Add message count column
const dbScript = `
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:hPUxuUBbuGhvfVYsqfKpnbWKAUTFypqx@shinkansen.proxy.rlwy.net:41185/railway', ssl: { rejectUnauthorized: false } });
Promise.all([
  pool.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS monthly_messages INTEGER DEFAULT 0'),
  pool.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_month VARCHAR(7)')
]).then(() => { console.log('✅ Message tracking columns added'); pool.end(); });
`;
fs.writeFileSync('/tmp/tier-db.js', dbScript);

// 2. Update webhook to enforce free tier limit
let webhook = fs.readFileSync('routes/webhook.js', 'utf8');

webhook = webhook.replace(
  `    console.log(\`📩 [\${phoneNumberId}] Message from \${from}: \${text}\`);`,
  `    console.log(\`📩 [\${phoneNumberId}] Message from \${from}: \${text}\`);

    // Enforce free tier message cap (70/month)
    if (tenant.tier === 'free' || !tenant.tier) {
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      const convCheck = await pool.query(
        'SELECT monthly_messages, message_month FROM conversations WHERE tenant_id = $1 AND customer_phone = $2',
        [tenant.id, from]
      );
      const conv = convCheck.rows[0];
      const msgCount = (conv?.message_month === currentMonth) ? (conv?.monthly_messages || 0) : 0;
      
      if (msgCount >= 70) {
        await sendMessage(from,
          'You have reached the free plan limit of 70 messages this month.\\n\\nUpgrade to Standard for unlimited messages + cart building + more!\\n\\n👉 ' + process.env.APP_URL + '/pricing?shop=' + tenant.shop_domain,
          tenant.whatsapp_token || process.env.WHATSAPP_TOKEN,
          phoneNumberId
        );
        return;
      }
      
      // Increment message count
      await pool.query(
        \`INSERT INTO conversations (tenant_id, customer_phone, monthly_messages, message_month, messages, cart)
         VALUES ($1, $2, 1, $3, '[]', '{}')
         ON CONFLICT (tenant_id, customer_phone)
         DO UPDATE SET 
           monthly_messages = CASE WHEN conversations.message_month = $3 THEN conversations.monthly_messages + 1 ELSE 1 END,
           message_month = $3\`,
        [tenant.id, from, currentMonth]
      );
    }`
);

fs.writeFileSync('routes/webhook.js', webhook);
console.log('✅ Tier limit enforcement added');

// 3. Update pricing page cap note
let index = fs.readFileSync('index.js', 'utf8');
index = index.replace(
  '<li>Unlimited messages</li>',
  '<li>70 messages/month</li>'
);
index = index.replace(
  "const PLANS = {\n  free:     { name: 'Vaani Free',     price: 0,",
  "const FREE_MSG_LIMIT = 70;\nconst PLANS = {\n  free:     { name: 'Vaani Free',     price: 0,"
);
fs.writeFileSync('index.js', index);
console.log('✅ Pricing page updated');
