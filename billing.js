const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const PLANS = {
  free: { name: 'Vaani Free', price: 0, trialDays: 0 },
  standard: { name: 'Vaani Standard', price: 18, trialDays: 7 },
  premium: { name: 'Vaani Premium', price: 48, trialDays: 7 }
};

// Plan features for AI prompt
const PLAN_FEATURES = {
  free: ['product browsing', 'basic Q&A'],
  standard: ['product browsing', 'cart building', 'abandoned cart followup', 'multilingual'],
  premium: ['product browsing', 'cart building', 'abandoned cart followup', 'multilingual', 'custom AI persona', 'priority support']
};

async function createSubscription(shopDomain, accessToken, plan) {
  if (plan === 'free') {
    await pool.query('UPDATE tenants SET tier = \'free\', billing_status = \'active\', billing_plan = \'free\' WHERE shop_domain = $1', [shopDomain]);
    return { status: 'active', plan: 'free' };
  }
  const planDetails = PLANS[plan];
  try {
    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges.json`,
      {
        recurring_application_charge: {
          name: planDetails.name,
          price: planDetails.price,
          trial_days: planDetails.trialDays,
          return_url: `${process.env.APP_URL}/billing/callback?shop=${shopDomain}&plan=${plan}`,
          test: process.env.NODE_ENV !== 'production'
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query(
      'UPDATE tenants SET billing_status = \'pending\', billing_plan = $1, billing_charge_id = $2 WHERE shop_domain = $3',
      [plan, String(charge.id), shopDomain]
    );
    return charge;
  } catch (err) {
    console.error('❌ createSubscription error:', err.response?.data || err.message);
    return null;
  }
}

async function activateSubscription(shopDomain, chargeId, accessToken) {
  try {
    await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges/${chargeId}/activate.json`,
      {},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const tenant = await pool.query('SELECT billing_plan FROM tenants WHERE shop_domain = $1', [shopDomain]);
    const plan = tenant.rows[0]?.billing_plan || 'free';
    await pool.query(
      'UPDATE tenants SET tier = $1, billing_status = \'active\' WHERE shop_domain = $2',
      [plan, shopDomain]
    );
    console.log('✅ Subscription activated for', shopDomain, 'plan:', plan);
    return true;
  } catch (err) {
    console.error('❌ activateSubscription error:', err.message);
    return false;
  }
}

async function checkSubscription(shopDomain, accessToken) {
  try {
    const res = await axios.get(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charges = res.data.recurring_application_charges;
    const active = charges.find(c => c.status === 'active');
    if (active) {
      const plan = active.name.toLowerCase().includes('standard') ? 'standard' : 
                   active.name.toLowerCase().includes('premium') ? 'premium' : 'free';
      await pool.query('UPDATE tenants SET tier = $1, billing_status = \'active\' WHERE shop_domain = $2', [plan, shopDomain]);
      return { active: true, plan };
    }
    return { active: false, plan: 'free' };
  } catch (err) {
    return { active: false, plan: 'free' };
  }
}

module.exports = { PLANS, PLAN_FEATURES, createSubscription, activateSubscription, checkSubscription };
