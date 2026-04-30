const fs = require('fs');
let code = fs.readFileSync('routes/webhook.js', 'utf8');

// Replace LIMIT 1 fallback with proper phone_number_id lookup
code = code.replace(
  `const tenantResult = await pool.query('SELECT * FROM tenants WHERE whatsapp_number = $1', [phoneNumberId]);
    const tenant = tenantResult.rows[0] || (await pool.query('SELECT * FROM tenants LIMIT 1')).rows[0];`,
  `const tenantResult = await pool.query('SELECT * FROM tenants WHERE whatsapp_number = $1', [phoneNumberId]);
    let tenant = tenantResult.rows[0];
    if (!tenant) {
      console.log('⚠️ No tenant found for phone_number_id:', phoneNumberId);
      console.log('Available tenants:');
      const all = await pool.query('SELECT shop_domain, whatsapp_number FROM tenants');
      console.log(all.rows);
      return;
    }`
);

fs.writeFileSync('routes/webhook.js', code);
console.log('✅ Tenant mapping fixed');
