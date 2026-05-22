const axios = require('axios');

async function sendMessage(to, text, token, phoneNumberId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Message sent to ${to}`);
  } catch (err) {
    console.error('❌ sendMessage error:', err.response?.data || err.message);
  }
}

async function sendButtons(to, bodyText, buttons, token, phoneNumberId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b, i) => ({
              type: 'reply',
              reply: { id: `btn_${i}`, title: b.substring(0, 20) }
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Buttons sent to ${to}`);
  } catch (err) {
    console.error('❌ sendButtons error:', err.response?.data || err.message);
  }
}

async function sendList(to, bodyText, sections, token, phoneNumberId, buttonText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: (buttonText && buttonText.length <= 20) ? buttonText : 'Browse Products',
            sections
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ List sent to ${to}`);
  } catch (err) {
    console.error('❌ sendList error:', err.response?.data || err.message);
  }
}

async function sendImage(to, imageUrl, caption, token, phoneNumberId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, caption }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Image sent to ${to}`);
  } catch (err) {
    console.error('❌ sendImage error:', err.response?.data || err.message);
  }
}

module.exports = { sendMessage, sendButtons, sendList, sendImage };
