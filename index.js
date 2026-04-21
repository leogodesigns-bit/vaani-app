require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/shopify', require('./routes/install'));
app.use('/webhook', require('./routes/webhook'));
app.use('/dashboard', require('./routes/dashboard'));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Vaani is running 🟢', version: '1.0.0' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Vaani server running on port ${PORT}`);
});
