const axios = require('axios');
// Pool now imported from ./db

const { pool } = require('./db');

const PLANS = {
  free:     { name: 'Vaani Free',     price: 0,  trialDays: 0, usd: 0  },
  standard: { name: 'Vaani Standard', price: 18, trialDays: 7, usd: 18 },
  premium:  { name: 'Vaani Premium',  price: 48, trialDays: 7, usd: 48 },
  custom:   { name: 'Vaani Custom',   price: null, trialDays: 7, usd: null }
};

const PLAN_FEATURES = {
  free:     ['product browsing', 'basic Q&A'],
  standard: ['product browsing', 'cart building', 'abandoned cart', 'multilingual'],
  premium:  ['product browsing', 'cart building', 'abandoned cart', 'multilingual', 'custom AI persona', 'priority support'],
  custom:   ['everything in premium', 'custom flows', 'dedicated setup', 'direct support from Leogo']
};

// Standard Shopify recurring charge
async function createSubscription(shopDomain, accessToken, plan) {
  if (plan === 'free') {
    await pool.query('UPDATE tenants SET tier = $1, billing_status = $2, billing_plan = $3 WHERE shop_domain = $4',
      ['free', 'active', 'free', shopDomain]);
    return { status: 'active', plan: 'free' };
  }
  if (plan === 'custom') return null; // Custom handled separately
  const planDetails = PLANS[plan];
  try {
    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges.json`,
      { recurring_application_charge: {
          name: planDetails.name,
          price: planDetails.usd,
          trial_days: planDetails.trialDays,
          return_url: `${process.env.APP_URL}/billing/callback?shop=${shopDomain}&plan=${plan}`,
          test: process.env.NODE_ENV !== 'production'
      }},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query('UPDATE tenants SET billing_status = $1, billing_plan = $2, billing_charge_id = $3 WHERE shop_domain = $4',
      ['pending', plan, String(charge.id), shopDomain]);
    return charge;
  } catch (err) {
    console.error('❌ createSubscription error:', err.response?.data || err.message);
    return null;
  }
}

// Custom price charge — for external custom merchants via Shopify
async function createCustomSubscription(shopDomain, accessToken, priceUSD, label) {
  try {
    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges.json`,
      { recurring_application_charge: {
          name: `Vaani Custom — ${label}`,
          price: priceUSD,
          trial_days: 7,
          return_url: `${process.env.APP_URL}/billing/callback?shop=${shopDomain}&plan=custom`,
          test: process.env.NODE_ENV !== 'production'
      }},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const charge = res.data.recurring_application_charge;
    await pool.query('UPDATE tenants SET billing_status = $1, billing_plan = $2, billing_charge_id = $3 WHERE shop_domain = $4',
      ['pending', 'custom', String(charge.id), shopDomain]);
    return charge;
  } catch (err) {
    console.error('❌ createCustomSubscription error:', err.message);
    return null;
  }
}

// Activate after merchant approves on Shopify
async function activateSubscription(shopDomain, chargeId, accessToken) {
  try {
    await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges/${chargeId}/activate.json`,
      {},
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const t = await pool.query('SELECT billing_plan FROM tenants WHERE shop_domain = $1', [shopDomain]);
    const plan = t.rows[0]?.billing_plan || 'free';
    await pool.query('UPDATE tenants SET tier = $1, billing_status = $2 WHERE shop_domain = $3',
      [plan, 'active', shopDomain]);
    console.log('✅ Activated', shopDomain, plan);
    return true;
  } catch (err) {
    console.error('❌ activateSubscription error:', err.message);
    return false;
  }
}

// Manually activate Leogo clients (no Shopify billing)
async function activateLeogoClient(shopDomain, customPriceINR, notes) {
  await pool.query(
    'UPDATE tenants SET tier = $1, billing_status = $2, billing_plan = $3, brand_prompt = COALESCE(brand_prompt, $4) WHERE shop_domain = $5',
    ['custom', 'active_leogo', 'custom', notes || '', shopDomain]
  );
  console.log('✅ Leogo client activated:', shopDomain, '₹' + customPriceINR + '/mo');
  return true;
}

module.exports = { PLANS, PLAN_FEATURES, createSubscription, createCustomSubscription, activateSubscription, activateLeogoClient };
