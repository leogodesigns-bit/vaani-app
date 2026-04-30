// handlers/rajathee.js
// Rajathee × Vaani flow — implements Rajathee_Vaani_Flow_v1.pdf verbatim.
// v1 scope = PDF Sections 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13.
// Sections 7 (cross-sell) and 10 (returning customer) are v1.1, not built here.
//
// This handler shares NOTHING with Jhilmil's flow. It only uses low-level
// transport helpers (sendMessage/sendButtons/sendList/sendImage) and
// conversation persistence (getConversation/upsertConversation).
//
// Sections 14 (fabric voice) and 15 (colour voice) are LOCKED string constants
// — never sent through the LLM, never templated, never rewritten on the fly.

const { sendMessage, sendButtons, sendList, sendImage } = require('../whatsapp');
const { getConversation, upsertConversation } = require('../db');

/**
 * Main entry point for the Rajathee flow.
 * Called from routes/webhook.js when tenant.flow_template === 'rajathee'.
 *
 * @param {Object} ctx
 * @param {Object} ctx.tenant         tenants row (must have flow_template === 'rajathee')
 * @param {Object} ctx.message        raw WhatsApp message object
 * @param {string} ctx.from           customer phone (E.164 without +)
 * @param {string} ctx.text           extracted text (text body or interactive title)
 * @param {string} ctx.phoneNumberId  Meta phone_number_id (waba sender)
 * @param {string} ctx.waToken        tenant.whatsapp_token
 * @param {Array}  ctx.history        conversation messages array
 * @param {Object} ctx.cart           conversation cart object
 */
async function handle(ctx) {
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;

  // Hard tenant guard — refuse to run on the wrong tenant even if mis-routed.
  if (tenant.flow_template !== 'rajathee') {
    console.error(
      `❌ rajathee.handle called for wrong tenant: ${tenant.shop_domain} ` +
      `(flow_template=${tenant.flow_template})`
    );
    return;
  }

  console.log(`🥻 [rajathee] ${tenant.shop_domain} — from ${from}: ${text}`);

  // SKELETON ONLY — Phase A.2 routing test.
  // Real flow (PDF Sections 1–13) lands in Phase C, one section at a time.
  await sendMessage(
    from,
    'Rajathee × Vaani — routing is live. Flow is being built.',
    waToken,
    phoneNumberId
  );

  await upsertConversation(
    tenant.id,
    from,
    [
      ...history,
      { role: 'user', content: text },
      { role: 'assistant', content: '[rajathee skeleton ack]' }
    ],
    cart
  );
}

module.exports = { handle };
