const express = require('express');
const router = express.Router();
const { getTenant } = require('../db');
const { PLANS } = require('../billing');

router.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.json({ message: 'Vaani Dashboard — add ?shop=yourstore.myshopify.com' });
  
  const tenant = await getTenant(shop);
  if (!tenant) return res.status(404).json({ error: 'Store not found' });

  res.json({
    shop: tenant.shop_domain,
    tier: tenant.tier,
    currentPlan: PLANS[tenant.tier],
    availablePlans: PLANS,
    webhookUrl: `${process.env.APP_URL}/webhook`,
    status: 'active'
  });
});

module.exports = router;
