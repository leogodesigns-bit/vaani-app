// ───────────────────────────────────────────────────────────────────────
// Phase 5: WhatsApp message templates
//
// This module sends template messages via Meta Cloud API. Templates are
// pre-approved messages that can be sent OUTSIDE the 24-hour customer
// service window — critical for billing alerts that may fire when the
// brand owner hasn't messaged the bot recently.
//
// Per-tenant architecture: each tenant's WABA has its own approved
// templates. We track approval status in tenants.templates_approved
// (JSONB map of template_name → status).
//
// Public API:
//   sendTemplate({ to, templateName, params, tenant, waToken, phoneNumberId })
//     Sends a template message. Returns { ok: true, messageId } on success
//     or { ok: false, error } on failure.
//
//   isTemplateApproved(tenant, templateName)
//     Returns true if Meta has approved this template for tenant's WABA.
//
//   sendTemplateOrFreeform({ to, templateName, params, freeformText, ... })
//     Tries template first; if not approved or send fails, falls back to
//     freeform text. This is the main entry point for alerts.js.
// ───────────────────────────────────────────────────────────────────────

const axios = require('axios');

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ─── Template registry ──────────────────────────────────────────────────
// Defines all 6 Vaani templates and how to populate their {{N}} variables.
// Each entry: { language, paramOrder } — paramOrder lists what the caller
// must provide as `params` to fill the template body in order.
const TEMPLATES = {
  vaani_threshold_70: {
    language: 'en',
    paramOrder: ['brandName', 'used', 'cap', 'remaining'],
  },
  vaani_threshold_90: {
    language: 'en',
    paramOrder: ['brandName', 'used', 'cap', 'remaining'],
  },
  vaani_threshold_100: {
    language: 'en',
    paramOrder: ['brandName', 'used', 'cap'],
  },
  vaani_topup_confirmed: {
    language: 'en',
    paramOrder: ['brandName', 'newBalance'],
  },
  vaani_subscription_paused: {
    language: 'en',
    paramOrder: ['brandName'],
  },
  vaani_subscription_unpaused: {
    language: 'en',
    paramOrder: ['brandName'],
  },
};

// ─── isTemplateApproved ─────────────────────────────────────────────────
// Checks tenant.templates_approved JSONB map for an 'approved' status.
// Returns false if tenant has no namespace, no template entry, or status
// is anything other than 'approved'.
function isTemplateApproved(tenant, templateName) {
  if (!tenant) return false;
  if (!tenant.template_namespace) return false;
  const map = tenant.templates_approved || {};
  return map[templateName] === 'approved';
}

// ─── sendTemplate ───────────────────────────────────────────────────────
// Sends a WhatsApp template message via Meta Cloud API.
//
// Args:
//   to            — recipient phone (E.164 format, e.g. "918805100535")
//   templateName  — must match a key in TEMPLATES registry
//   params        — object with values for paramOrder fields
//   tenant        — tenant row (for namespace lookup)
//   waToken       — tenant's whatsapp_token
//   phoneNumberId — sender phone_number_id
//
// Returns: { ok: boolean, messageId?, error? }
async function sendTemplate({ to, templateName, params, tenant, waToken, phoneNumberId }) {
  const tplDef = TEMPLATES[templateName];
  if (!tplDef) {
    return { ok: false, error: `Unknown template: ${templateName}` };
  }
  if (!tenant?.template_namespace) {
    return { ok: false, error: `Tenant has no template_namespace set` };
  }
  if (!waToken || !phoneNumberId) {
    return { ok: false, error: `Missing waToken or phoneNumberId` };
  }

  // Build positional params in correct order
  const components = [];
  if (tplDef.paramOrder.length > 0) {
    const parameters = tplDef.paramOrder.map(key => {
      const v = params?.[key];
      if (v === undefined || v === null) {
        // Don't crash — substitute a safe placeholder so Meta doesn't 400
        return { type: 'text', text: '—' };
      }
      return { type: 'text', text: String(v) };
    });
    components.push({ type: 'body', parameters });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: tplDef.language },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  try {
    const res = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${waToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    const messageId = res.data?.messages?.[0]?.id;
    console.log(`[templates] sent ${templateName} → ${to} (msgId=${messageId})`);
    return { ok: true, messageId };
  } catch (err) {
    const errBody = err.response?.data || { message: err.message };
    console.error(`[templates] send failed for ${templateName} → ${to}:`, JSON.stringify(errBody));
    return { ok: false, error: errBody };
  }
}

// ─── sendTemplateOrFreeform ─────────────────────────────────────────────
// Main entry point used by alerts.js. Tries to send via template if
// approved, otherwise falls back to plain freeform text. Either way,
// the recipient gets a message (assuming they're inside 24-hr window
// for the freeform case).
//
// Args:
//   ...all sendTemplate args, plus:
//   freeformText  — the plain text version to send if template fails
//   sendMessage   — the whatsapp.js sendMessage function (for fallback)
//
// Returns: { ok, via: 'template' | 'freeform' | 'none', error? }
async function sendTemplateOrFreeform({
  to,
  templateName,
  params,
  tenant,
  waToken,
  phoneNumberId,
  freeformText,
  sendMessage,
}) {
  // Try template path first
  if (isTemplateApproved(tenant, templateName)) {
    const result = await sendTemplate({
      to, templateName, params, tenant, waToken, phoneNumberId,
    });
    if (result.ok) {
      return { ok: true, via: 'template', messageId: result.messageId };
    }
    // Template was approved but send failed (rare — probably token/network)
    console.error(`[templates] approved template ${templateName} send failed, falling back to freeform`);
  }

  // Freeform fallback
  if (!sendMessage || !freeformText) {
    return { ok: false, via: 'none', error: 'No freeform fallback configured' };
  }
  try {
    await sendMessage(to, freeformText, waToken, phoneNumberId);
    return { ok: true, via: 'freeform' };
  } catch (err) {
    return { ok: false, via: 'none', error: err.message };
  }
}

// ─── markTemplateStatus ─────────────────────────────────────────────────
// Updates tenants.templates_approved[templateName] = status.
// Used by founder commands when reviewing Meta approval results.
async function markTemplateStatus(pool, tenantId, templateName, status) {
  const validStatuses = ['approved', 'pending', 'rejected', 'paused'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of ${validStatuses.join(', ')}`);
  }
  if (!TEMPLATES[templateName]) {
    throw new Error(`Unknown template: ${templateName}`);
  }
  await pool.query(
    `UPDATE tenants
     SET templates_approved = COALESCE(templates_approved, '{}'::jsonb) || jsonb_build_object($1::text, $2::text)
     WHERE id = $3`,
    [templateName, status, tenantId]
  );
}

// ─── getAllTemplateNames ────────────────────────────────────────────────
function getAllTemplateNames() {
  return Object.keys(TEMPLATES);
}

module.exports = {
  TEMPLATES,
  isTemplateApproved,
  sendTemplate,
  sendTemplateOrFreeform,
  markTemplateStatus,
  getAllTemplateNames,
};
