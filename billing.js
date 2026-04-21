const axios = require('axios');

const PLANS = {
  free: {
    name: 'Vaani Free',
    price: 0,
    trialDays: 0,
    features: ['Product Q&A', 'Order status']
  },
  standard: {
    name: 'Vaani Standard',
    price: 1499,
    trialDays: 7,
    features: ['Everything in Free', 'Cart building', 'Payment links', 'Abandoned cart', 'Multilingual']
  },
  premium: {
    name: 'Vaani Premium',
    price: 3999,
    trialDays: 7,
    features: ['Everything in Standard', 'Custom AI persona', 'Custom flows', 'Priority support']
  }
};

async function createSubscription(shopDomain, accessToken, plan) {
  if (plan === 'free') return { status: 'active', plan: 'free' };
  
  const planDetails = PLANS[plan];
  try {
    const res = await axios.post(
      `https://${shopDomain}/admin/api/2024-01/recurring_application_charges.json`,
      {
        recurring_application_charge: {
          name: planDetails.name,
          price: planDetails.price / 83, // Convert INR to USD approx
          trial_days: planDetails.trialDays,
          return_url: `${process.env.APP_URL}/billing/callback?shop=${shopDomain}&plan=${plan}`,
          test: process.env.NODE_ENV !== 'production'
        }
      },
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    return res.data.recurring_application_charge;
  } catch (err) {
    console.error('❌ createSubscription error:', err.message);
    return null;
  }
}

module.exports = { PLANS, createSubscription };
