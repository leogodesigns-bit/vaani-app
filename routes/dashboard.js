const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Vaani Dashboard — coming soon' });
});

module.exports = router;
