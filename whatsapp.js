const axios = require('axios');

// ─── Sent-message capture (for dashboard rendering) ────────────────────
// Each successful outbound send appends one entry to a per-recipient queue.
// db.upsertConversation drains this queue and writes the entries into
// conversations.messages so the dashboard can show the real reply text
// instead of debug placeholders like "[woofparade S01 welcome]".
const __sentQueue = new Map();
const __wamidQueue = new Map();

function __push(to, kind, content) {
  if (!__sentQueue.has(to)) __sentQueue.set(to, []);
  __sentQueue.get(to).push({
    role: 'assistant',
    kind,
    content,
    ts: new Date().toISOString(),
  });
}

function __wamidPush(to, wamid) {
  if (!wamid) return;
  if (!__wamidQueue.has(to)) __wamidQueue.set(to, []);
  __wamidQueue.get(to).push(wamid);
}
function drainWamids(to) {
  const q = __wamidQueue.get(to) || [];
  __wamidQueue.delete(to);
  return q;
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
    const _r = await axios.post(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    __push(to, 'text', text);
    console.log(`✅ Message sent to ${to}`);
    const _wm = _r?.data?.messages?.[0]?.id || null;
    __wamidPush(to, _wm);
    return _wm;
  } catch (err) {
    console.error('❌ sendMessage error:', err.response?.data || err.message);
  }
}

async function sendButtons(to, bodyText, buttons, token, phoneNumberId) {
  try {
    const _rb = await axios.post(
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
    const _wb = _rb?.data?.messages?.[0]?.id || null;
    __wamidPush(to, _wb);
    return _wb;
  } catch (err) {
    console.error('❌ sendButtons error:', err.response?.data || err.message);
  }
}

async function sendList(to, bodyText, sections, token, phoneNumberId, buttonText) {
  try {
    const _rl = await axios.post(
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
    const _wl = _rl?.data?.messages?.[0]?.id || null;
    __wamidPush(to, _wl);
    return _wl;
  } catch (err) {
    console.error('❌ sendList error:', err.response?.data || err.message);
  }
}

async function sendImage(to, imageUrl, caption, token, phoneNumberId) {
  try {
    const _ri = await axios.post(
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
    const _wi = _ri?.data?.messages?.[0]?.id || null;
    __wamidPush(to, _wi);
    return _wi;
  } catch (err) {
    console.error('❌ sendImage error:', err.response?.data || err.message);
  }
}

module.exports = { sendMessage, sendButtons, sendList, sendImage, drainSentMessages, drainWamids };
