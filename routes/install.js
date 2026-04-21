const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { createTenant } = require('../db');

// Step 1: Begin OAuth
router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const redirectUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES}&redirect_uri=${process.env.APP_URL}/shopify/callback`;
  res.redirect(redirectUrl);
});

// Step 2: OAuth callback - exchange code for token
router.get('/callback', async (req, res) => {
  const { shop, code, hmac } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');

  // Verify HMAC
  const params = Object.keys(req.query).filter(k => k !== 'hmac').sort().map(k => `${k}=${req.query[k]}`).join('&');
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(401).send('Invalid HMAC');

  try {
    // Exchange code for access token
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code
    });

    const accessToken = response.data.access_token;
    await createTenant(shop, accessToken);
    console.log(`✅ Vaani installed on ${shop}`);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h1>✅ Vaani installed successfully!</h1>
        <p>Your WhatsApp AI Sales Bot is being set up for <strong>${shop}</strong></p>
        <p>You'll receive setup instructions on WhatsApp shortly.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send('Installation failed');
  }
});

module.exports = router;
