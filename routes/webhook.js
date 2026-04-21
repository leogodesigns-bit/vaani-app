const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { getConversation, upsertConversation } = require('../db');
const { getAIResponse } = require('../ai');
const { sendMessage } = require('../whatsapp');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = body.entry?.[0]?.changes?.[0]?.value?.metadata;
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;
    const phoneNumberId = metadata?.phone_number_id;
    console.log(`📩 [${phoneNumberId}] Message from ${from}: ${text}`);

    const result = await pool.query('SELECT * FROM tenants LIMIT 1');
    const tenant = result.rows[0];
    if (!tenant) { console.log('⚠️ No tenant found'); return; }

    const conv = await getConversation(tenant.id, from);
    const history = conv?.messages || [];
    const aiReply = await getAIResponse(tenant, from, text, history);
    const updatedHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: aiReply }];
    await upsertConversation(tenant.id, from, updatedHistory, conv?.cart || {});

    const token = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    await sendMessage(from, aiReply, token, phoneNumberId);
    console.log(`🤖 AI replied to ${from}: ${aiReply.substring(0, 50)}...`);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

module.exports = router;
