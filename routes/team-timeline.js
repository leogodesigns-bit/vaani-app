const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /team-timeline/:tenantId
// Returns all non-completed pending_drafts for the tenant, with the full
// team_messages timeline grouped by recipient phone.
//
// Statuses included: 'pending', 'invoice_sent' (still in flight)
// Excluded: 'paid', 'cancelled' (drop off the dashboard)
router.get('/:tenantId', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  if (!tenantId || isNaN(tenantId)) {
    return res.status(400).json({ error: 'invalid tenantId' });
  }

  try {
    // 1. Pull the open drafts
    const draftsRes = await pool.query(
      `SELECT id, draft_id, draft_name, pup_name, design_name, summary,
              customer_phone, status, price_set, approved_by, approved_at,
              invoice_sent_at, escalated_at, created_at
         FROM pending_drafts
        WHERE tenant_id = $1 AND status IN ('pending', 'invoice_sent')
        ORDER BY created_at DESC
        LIMIT 50`,
      [tenantId]
    );
    const drafts = draftsRes.rows;
    if (drafts.length === 0) {
      return res.json({ drafts: [] });
    }

    // 2. Pull all team_messages for these drafts in one query
    const draftIds = drafts.map(d => d.draft_id).filter(Boolean);
    const tmRes = draftIds.length === 0 ? { rows: [] } : await pool.query(
      `SELECT wamid, recipient_phone, recipient_role, sos_type, template_name,
              params, draft_id, sent_at, delivered_at, read_at,
              failed_at, failure_reason, replied_at, reply_text
         FROM team_messages
        WHERE tenant_id = $1 AND draft_id = ANY($2::bigint[])
        ORDER BY sent_at ASC`,
      [tenantId, draftIds]
    );

    // 3. Group team_messages by draft_id -> recipient_phone
    const byDraft = new Map();
    for (const m of tmRes.rows) {
      const did = String(m.draft_id);
      if (!byDraft.has(did)) byDraft.set(did, new Map());
      const rmap = byDraft.get(did);
      if (!rmap.has(m.recipient_phone)) {
        rmap.set(m.recipient_phone, {
          phone: m.recipient_phone,
          role: m.recipient_role,
          messages: [],
        });
      }
      rmap.get(m.recipient_phone).messages.push({
        wamid: m.wamid,
        sos_type: m.sos_type,
        template_name: m.template_name,
        sent_at: m.sent_at,
        delivered_at: m.delivered_at,
        read_at: m.read_at,
        failed_at: m.failed_at,
        failure_reason: m.failure_reason,
        replied_at: m.replied_at,
        reply_text: m.reply_text,
      });
    }

    // 4. Build response
    const out = drafts.map(d => {
      const rmap = byDraft.get(String(d.draft_id)) || new Map();
      return {
        id: d.id,
        draft_id: String(d.draft_id),
        draft_name: d.draft_name,
        pup_name: d.pup_name,
        design_name: d.design_name,
        summary: d.summary,
        customer_phone: d.customer_phone,
        status: d.status,
        price_set: d.price_set,
        approved_by: d.approved_by,
        approved_at: d.approved_at,
        invoice_sent_at: d.invoice_sent_at,
        escalated_at: d.escalated_at,
        created_at: d.created_at,
        recipients: Array.from(rmap.values()),
      };
    });

    res.json({ drafts: out });
  } catch (e) {
    console.error('[team-timeline] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
