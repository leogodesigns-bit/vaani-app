const express = require('express');
const router = express.Router();
const { verifyShopifyHmac } = require('../middleware/shopifyHmac');

router.post('/customers/redact', verifyShopifyHmac, (req, res) => {
  console.log('Customer redact request:', req.body);
  res.sendStatus(200);
});

router.post('/shop/redact', verifyShopifyHmac, (req, res) => {
  console.log('Shop redact request:', req.body);
  res.sendStatus(200);
});

router.post('/customers/data_request', verifyShopifyHmac, (req, res) => {
  console.log('Customer data request:', req.body);
  res.sendStatus(200);
});

module.exports = router;
