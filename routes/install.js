const express = require('express');
const router = express.Router();

// Shopify OAuth - Step 1: Begin install
router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  
  const redirectUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES}&redirect_uri=${process.env.APP_URL}/shopify/callback`;
  res.redirect(redirectUrl);
});

// Shopify OAuth - Step 2: Callback
router.get('/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');
  // TODO: Exchange code for access token + save tenant
  res.send(`✅ Vaani installed on ${shop} — setup coming soon!`);
});

module.exports = router;
