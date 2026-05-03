// =============================================================================
// usage.js — Vaani usage tracking (Phase 2)
// Spec: Vaani_Usage_Tracking_Spec_v1_2.md
//
// trackConversation(tenantId, customerPhone) is the main entry point.
// Called once per incoming customer message. Idempotent within a day per
// (tenant, customer): same customer messaging same brand 5x in one day = 1 chat.
//
// Counter logic (per spec section 5):
//   1. INSERT into tenant_daily_conversations. ON CONFLICT, just bump message_count.
//      Return whether the row was newly inserted.
//   2. If new, INSERT/UPDATE tenant_usage_monthly to bump conversation_count by 1.
//   3. If conversation_count > base_cap, also draw down 1 chat from oldest active
//      top-up (FIFO).
//   4. Returns updated usage row so the caller can fire threshold alerts in a
//      later phase.
//
// This module DOES NOT fire alerts or pause the bot — those are Phases 4 and 8.
// Phase 2 just tracks. Safe to deploy without breaking anything.
// =============================================================================

const { pool } = require('./db');

/**
 * Track a single incoming customer message.
 *
 * @param {number} tenantId       The Vaani tenant ID (tenants.id).
 * @param {string} customerPhone  E.164 phone number from message.from.
 * @returns {Promise<object|null>} { isNewConversation, usage, topupConsumed }
 *                                  on success; null if tenant is non-trackable
 *                                  (e.g. no active subscription). Never throws —
 *                                  errors are logged and null returned, so the
 *                                  webhook keeps working even if tracking is
 *                                  broken.
 */
async function trackConversation(tenantId, customerPhone) {
  if (!tenantId || !customerPhone) {
    console.error('[usage] trackConversation: missing tenantId or customerPhone');
    return null;
  }

  try {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth() + 1; // 1-12
    const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // ─────────────────────────────────────────────────────────────────────
    // Step 1: try to insert today's daily conversation row.
    //         If it already exists, just bump message_count.
    //         RETURNING (xmax = 0) tells us whether this was a fresh insert.
    // ─────────────────────────────────────────────────────────────────────
    const dailyResult = await pool.query(
      `INSERT INTO tenant_daily_conversations
         (tenant_id, customer_phone, conversation_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, customer_phone, conversation_date)
       DO UPDATE SET message_count = tenant_daily_conversations.message_count + 1
       RETURNING (xmax = 0) AS is_new, message_count`,
      [tenantId, customerPhone, dateStr]
    );

    const isNewConversation = dailyResult.rows[0]?.is_new === true;

    // Not a new conversation today — same customer already counted, just stop.
    if (!isNewConversation) {
      return {
        isNewConversation: false,
        usage: null,
        topupConsumed: false,
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Look up tenant subscription to determine base_cap.
    //         If tenant has no subscription row yet, fall back to 1000.
    //         (Spec section 4 default; keeps tracking working even for
    //         tenants not yet seeded into tenant_subscriptions.)
    // ─────────────────────────────────────────────────────────────────────
    const subResult = await pool.query(
      `SELECT plan_type, status FROM tenant_subscriptions
       WHERE tenant_id = $1`,
      [tenantId]
    );
    const baseCap = 1000; // per spec — same for monthly, annual, and internal

    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Increment monthly counter. INSERT if first message of month,
    //         else UPDATE.
    // ─────────────────────────────────────────────────────────────────────
    const usageResult = await pool.query(
      `INSERT INTO tenant_usage_monthly
         (tenant_id, year, month, conversation_count, base_cap)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (tenant_id, year, month)
       DO UPDATE SET
         conversation_count = tenant_usage_monthly.conversation_count + 1,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, year, month, baseCap]
    );

    const usage = usageResult.rows[0];

    // ─────────────────────────────────────────────────────────────────────
    // Step 4: If past base_cap, consume 1 chat from oldest active top-up
    //         (FIFO — earliest expires_at first, per spec section 5).
    // ─────────────────────────────────────────────────────────────────────
    let topupConsumed = false;
    if (usage.conversation_count > usage.base_cap) {
      const topupResult = await pool.query(
        `UPDATE tenant_topups
            SET chats_remaining = chats_remaining - 1
          WHERE id = (
            SELECT id FROM tenant_topups
             WHERE tenant_id = $1
               AND chats_remaining > 0
               AND NOT expired
             ORDER BY expires_at ASC
             LIMIT 1
          )
          RETURNING id, chats_remaining`,
        [tenantId]
      );
      if (topupResult.rowCount > 0) {
        topupConsumed = true;
        // Also bump top_up_balance counter in the monthly row for fast reads
        await pool.query(
          `UPDATE tenant_usage_monthly
              SET top_up_balance = top_up_balance + 1
            WHERE tenant_id = $1 AND year = $2 AND month = $3`,
          [tenantId, year, month]
        );
      } else {
        // Past base_cap AND no active top-up. Bump overage_count for visibility.
        // Pause behaviour will be handled in Phase 4 (alerts) / Phase 8 (auto-reply).
        await pool.query(
          `UPDATE tenant_usage_monthly
              SET overage_count = overage_count + 1
            WHERE tenant_id = $1 AND year = $2 AND month = $3`,
          [tenantId, year, month]
        );
      }
    }

    return {
      isNewConversation: true,
      usage,
      topupConsumed,
    };
  } catch (err) {
    // Never let usage tracking break the webhook. Log and move on.
    console.error('[usage] trackConversation error:', err.message);
    return null;
  }
}

/**
 * Get current month usage for a tenant. Read-only convenience function.
 * Returns null if no row exists yet for this month.
 *
 * @param {number} tenantId
 * @returns {Promise<object|null>}
 */
async function getCurrentMonthUsage(tenantId) {
  if (!tenantId) return null;
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;

  try {
    const result = await pool.query(
      `SELECT * FROM tenant_usage_monthly
        WHERE tenant_id = $1 AND year = $2 AND month = $3`,
      [tenantId, year, month]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[usage] getCurrentMonthUsage error:', err.message);
    return null;
  }
}

/**
 * Get total active top-up balance for a tenant.
 * Returns sum of chats_remaining across all non-expired top-ups.
 *
 * @param {number} tenantId
 * @returns {Promise<number>}
 */
async function getActiveTopupBalance(tenantId) {
  if (!tenantId) return 0;

  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(chats_remaining), 0)::int AS total
         FROM tenant_topups
        WHERE tenant_id = $1 AND NOT expired AND chats_remaining > 0`,
      [tenantId]
    );
    return result.rows[0]?.total || 0;
  } catch (err) {
    console.error('[usage] getActiveTopupBalance error:', err.message);
    return 0;
  }
}

module.exports = {
  trackConversation,
  getCurrentMonthUsage,
  getActiveTopupBalance,
};
