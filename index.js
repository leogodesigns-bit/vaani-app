require('dotenv').config();
const express = require('express');
const { initDB } = require('./db');
const { startScheduler } = require('./scheduler');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/shopify', require('./routes/install'));
app.use('/webhook', require('./routes/webhook'));
app.use('/dashboard', require('./routes/dashboard'));

app.get('/', (req, res) => {
  res.json({ status: 'Vaani is running 🟢', version: '1.0.0' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 Vaani server running on port ${PORT}`);
  await initDB();
  startScheduler();
});
