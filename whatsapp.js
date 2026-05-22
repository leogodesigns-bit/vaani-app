const axios = require('axios');

// ─── Sent-message capture (for dashboard rendering) ────────────────────
// Each successful outbound send appends one entry to a per-recipient queue.
// db.upsertConversation drains this queue and writes the entries into
// conversations.messages so the dashboard can show the real reply text
// instead of debug placeholders like "[woofparade S01 welcome]".
const __sentQueue = new Map();

function __push(to, kind, content) {
  if (!__sentQueue.has(to)) __sentQueue.set(to, []);
  __sentQueue.get(to).push({
    role: 'assistant',
    kind,
    content,
    ts: new Date().toISOString(),
  });
}

function drainSentMessages(to) {
  const q = __sentQueue.get(to) || [];
  __sentQueue.delete(to);
  return q;
}

function __renderButtons(bodyText, buttons) {
  const labels = (buttons || []).map(b => '[' + b + ']').join(' ');
  return bodyText + (labels ? '\n\n' + labels : '');
}

function __renderList(bodyText, sections, buttonText) {
  const lines = [bodyText, ''];
  lines.push('▼ ' + (buttonText || 'Browse Products'));
  for (const sec of (sections || [])) {
    if (sec.title) lines.push('  • ' + sec.title);
    for (const row of (sec.rows || [])) {
      const desc = row.description ? ' — ' + row.description : '';
      lines.push('    · ' + (row.title || '') + desc);
    }
  }
  return lines.join('\n');
}

async function sendMessage(to, text, token, phoneNumberId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    __push(to, 'text', text);
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
    __push(to, 'buttons', __renderButtons(bodyText, buttons));
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
    __push(to, 'list', __renderList(bodyText, sections, buttonText));
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
    __push(to, 'image', '[image] ' + (caption || imageUrl));
    console.log(`✅ Image sent to ${to}`);
  } catch (err) {
    console.error('❌ sendImage error:', err.response?.data || err.message);
  }
}

module.exports = { sendMessage, sendButtons, sendList, sendImage, drainSentMessages };
