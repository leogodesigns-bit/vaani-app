const crypto = require('crypto');

function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) return res.sendStatus(401);
  const body = req.rawBody || JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  if (hash !== hmacHeader) return res.sendStatus(401);
  next();
}

module.exports = { verifyShopifyHmac };
