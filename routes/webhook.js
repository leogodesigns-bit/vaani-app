const express = require('express');
const router = express.Router();
const { getTenant, getConversation, upsertConversation } = require('../db');
const { getAIResponse } = require('../ai');
const { sendMessage } = require('../whatsapp');

// Meta webhook verification
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

// Incoming WhatsApp messages
router.post('/', async (req, res) => {
  res.sendStatus(200); // Always respond fast to Meta

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const metadata = changes?.value?.metadata;

    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;
    const phoneNumberId = metadata?.phone_number_id;

    console.log(`📩 [${phoneNumberId}] Message from ${from}: ${text}`);

    // Find tenant by phone number ID
    // For now use a default tenant lookup - will improve with phone mapping
    const tenants = await require('../db').pool?.query('SELECT * FROM tenants LIMIT 1');
    const tenant = tenants?.rows?.[0];
    if (!tenant) {
      console.log('⚠️ No tenant found for this number');
      return;
    }

    // Get or create conversation
    const conv = await getConversation(tenant.id, from);
    const history = conv?.messages || [];

    // Get AI response
    const aiReply = await getAIResponse(tenant, from, text, history);

    // Update conversation history
    const updatedHistory = [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: aiReply }
    ];
    await upsertConversation(tenant.id, from, updatedHistory, conv?.cart || {});

    // Send reply
    const token = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN;
    await sendMessage(from, aiReply, token, phoneNumberId);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

module.exports = router;
