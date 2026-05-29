const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getOrder } = require('../db');

// Rajathee UPI payee (IDBI merchant VPA).
const UPI_VPA   = 'idb260300711947@idbi';
const UPI_PAYEE = 'LVSG SAREES OPC PVT LTD';

// GET /qr/:orderId.png — dynamic UPI QR with the exact order amount baked in.
router.get('/:orderId.png', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await getOrder(orderId).catch(() => null);
    if (!order) return res.status(404).send('order not found');
    let amount = Number(order.grand_total || 0);
    const amtOverride = Number(req.query.amt);
    if (amtOverride && amtOverride > 0 && amtOverride <= amount) amount = amtOverride;
    amount = amount.toFixed(2);
    const link = 'upi://pay?pa=' + encodeURIComponent(UPI_VPA)
      + '&pn=' + encodeURIComponent(UPI_PAYEE)
      + '&am=' + amount + '&cu=INR&tn=' + encodeURIComponent(orderId);
    const png = await QRCode.toBuffer(link, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (e) {
    console.error('[qr route] error:', e.message);
    res.status(500).send('qr error');
  }
});

module.exports = router;
