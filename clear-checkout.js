const { Pool } = require('pg');
require('dotenv').config();

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const myPhone = '919403345612';
  const r = await pool.query(
    "SELECT cart FROM conversations WHERE tenant_id=2 AND customer_phone=$1",
    [myPhone]
  );
  if (!r.rows.length) {
    console.log('No conversation found for', myPhone);
    await pool.end();
    return;
  }
  const cart = r.rows[0].cart || {};
  console.log('BEFORE — rajathee state:', JSON.stringify(cart.rajathee, null, 2));

  if (cart.rajathee) {
    delete cart.rajathee.checkout;
    delete cart.rajathee.browseMode;
    delete cart.rajathee.offTopicCount;
    delete cart.rajathee.muted;
  }

  await pool.query(
    "UPDATE conversations SET cart=$1 WHERE tenant_id=2 AND customer_phone=$2",
    [cart, myPhone]
  );
  console.log('AFTER — checkout/browseMode/offTopic/muted cleared');
  await pool.end();
})();
