const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { createTenant } = require('../db');

// ─── Helper: get OAuth credentials by app variant ──────────────────────────
function getCreds(variant) {
  if (variant === 'custom') {
    return {
      apiKey: process.env.SHOPIFY_API_KEY_CUSTOM,
      apiSecret: process.env.SHOPIFY_API_SECRET_CUSTOM,
      scopes: process.env.SHOPIFY_SCOPES_CUSTOM,
      callbackPath: '/shopify/callback-custom',
      label: 'Vaani Custom',
    };
  }
  return {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES,
    callbackPath: '/shopify/callback',
    label: 'Vaani',
  };
}

// ─── Shared install logic ──────────────────────────────────────────────────
function buildInstallRedirect(shop, variant) {
  const c = getCreds(variant);
  return `https://${shop}/admin/oauth/authorize?client_id=${c.apiKey}&scope=${c.scopes}&redirect_uri=${process.env.APP_URL}${c.callbackPath}`;
}

// ─── Shared callback logic ─────────────────────────────────────────────────
async function handleCallback(req, res, variant) {
  const { shop, code, hmac } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');

  const c = getCreds(variant);

  // Verify HMAC
  const params = Object.keys(req.query).filter(k => k !== 'hmac').sort().map(k => `${k}=${req.query[k]}`).join('&');
  const digest = crypto.createHmac('sha256', c.apiSecret).update(params).digest('hex');
  if (digest !== hmac) {
    console.error(`❌ HMAC mismatch for ${c.label} install on ${shop}`);
    return res.status(401).send('Invalid HMAC');
  }

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: c.apiKey,
      client_secret: c.apiSecret,
      code,
    });

    const accessToken = response.data.access_token;
    await createTenant(shop, accessToken);
    console.log(`✅ ${c.label} installed on ${shop}`);

    res.redirect(`/dashboard?shop=${encodeURIComponent(shop)}&first_install=1`);
  } catch (err) {
    console.error(`OAuth error (${c.label}):`, err.message);
    res.status(500).send(`
      <html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;background:#f8f8ff">
        <h2 style="color:#ef4444">Installation failed</h2>
        <p>Please try again, or email <a href="mailto:leogodesigns@gmail.com" style="color:#6366f1">leogodesigns@gmail.com</a> for help.</p>
        <p style="color:#888;font-size:13px;margin-top:20px">Error: ${err.message}</p>
      </body></html>
    `);
  }
}

// ─── Routes: Vaani Public ──────────────────────────────────────────────────
router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  res.redirect(buildInstallRedirect(shop, 'public'));
});

router.get('/callback', (req, res) => handleCallback(req, res, 'public'));

// ─── Routes: Vaani Custom ──────────────────────────────────────────────────
router.get('/install-custom', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  res.redirect(buildInstallRedirect(shop, 'custom'));
});

router.get('/callback-custom', (req, res) => handleCallback(req, res, 'custom'));

module.exports = router;
