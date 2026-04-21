const axios = require('axios');

async function sendMessage(to, message, whatsappToken, phoneNumberId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ Message sent to ${to}`);
  } catch (err) {
    console.error('❌ sendMessage error:', err.response?.data || err.message);
  }
}

module.exports = { sendMessage };
