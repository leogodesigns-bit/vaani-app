const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { createTenant, getTenant, updateTenant } = require('../db');

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
  if (variant === 'woof') {
    return {
      apiKey: process.env.SHOPIFY_API_KEY_WOOF,
      apiSecret: process.env.SHOPIFY_API_SECRET_WOOF,
      scopes: process.env.SHOPIFY_SCOPES_WOOF,
      callbackPath: '/shopify/callback-woof',
      label: 'Vaani Woof',
    };
  }
  if (variant === 'rajathee') {
    return {
      apiKey: process.env.SHOPIFY_API_KEY_RAJATHEE,
      apiSecret: process.env.SHOPIFY_API_SECRET_RAJATHEE,
      scopes: process.env.SHOPIFY_SCOPES_RAJATHEE,
      callbackPath: '/shopify/callback-rajathee',
      label: 'Vaani Rajathee',
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

function buildInstallRedirect(shop, variant) {
  const c = getCreds(variant);
  return `https://${shop}/admin/oauth/authorize?client_id=${c.apiKey}&scope=${encodeURIComponent(c.scopes)}&redirect_uri=${encodeURIComponent(process.env.APP_URL + c.callbackPath)}`;
}

function verifyHmacFromRawUrl(rawUrl, secret) {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return false;
  const rawQuery = rawUrl.slice(qIdx + 1);
  const pairs = rawQuery.split('&');
  let receivedHmac = null;
  const kept = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const k = eq === -1 ? p : p.slice(0, eq);
    if (k === 'hmac') { receivedHmac = decodeURIComponent(p.slice(eq + 1)); continue; }
    if (k === 'signature') continue;
    kept.push(p);
  }
  if (!receivedHmac) return false;
  kept.sort();
  const msg = kept.join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(receivedHmac, 'utf8'));
  } catch (e) { return false; }
}

async function handleCallback(req, res, variant) {
  const { shop, code, host } = req.query;
  if (!shop || !code) return res.status(400).send('Missing parameters');

  const c = getCreds(variant);

  if (!verifyHmacFromRawUrl(req.originalUrl, c.apiSecret)) {
    console.error(`HMAC mismatch for ${c.label} install on ${shop}`);
    return res.status(401).send('Invalid HMAC');
  }

  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: c.apiKey,
      client_secret: c.apiSecret,
      code,
    });

    const accessToken = response.data.access_token;
    const SHOP_DOMAIN_MAP = {
      'udhuxy-pc.myshopify.com': 'rajathee.myshopify.com',
      'vs6xap-uz.myshopify.com': 'thewoofparade.com',
    };
    const dbShop = SHOP_DOMAIN_MAP[shop] || shop;
    const existing = await getTenant({ shopDomain: dbShop });
    if (existing) {
      await updateTenant(dbShop, { shopifyToken: accessToken });
    } else {
      await createTenant({ shopDomain: dbShop, shopifyToken: accessToken });
    }
    console.log(`${c.label} installed on ${dbShop} (oauth shop=${shop})`);

    const hostParam = host ? `&host=${encodeURIComponent(host)}` : '';
    return res.redirect(`https://${shop}/admin/apps/${c.apiKey}?shop=${encodeURIComponent(shop)}${hostParam}`);
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`OAuth error (${c.label}):`, detail);
    res.status(500).send(`
      <html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;background:#f8f8ff">
        <h2 style="color:#ef4444">Installation failed</h2>
        <p>Please try again, or email <a href="mailto:leogodesigns@gmail.com" style="color:#6366f1">leogodesigns@gmail.com</a> for help.</p>
        <p style="color:#888;font-size:13px;margin-top:20px">Error: ${err.message}</p>
      </body></html>
    `);
  }
}

router.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return res.status(400).send('Invalid shop');
  res.redirect(buildInstallRedirect(shop, 'public'));
});

router.get('/callback', (req, res) => handleCallback(req, res, 'public'));

router.get('/install-custom', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return res.status(400).send('Invalid shop');
  res.redirect(buildInstallRedirect(shop, 'custom'));
});

router.get('/callback-custom', (req, res) => handleCallback(req, res, 'custom'));

router.get('/install-woof', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return res.status(400).send('Invalid shop');
  res.redirect(buildInstallRedirect(shop, 'woof'));
});

router.get('/callback-woof', (req, res) => handleCallback(req, res, 'woof'));

router.get('/install-rajathee', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return res.status(400).send('Invalid shop');
  res.redirect(buildInstallRedirect(shop, 'rajathee'));
});

router.get('/callback-rajathee', (req, res) => handleCallback(req, res, 'rajathee'));

module.exports = router;
