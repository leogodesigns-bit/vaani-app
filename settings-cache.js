const { pool } = require('./db');

const cache = new Map();
const TTL_MS = 60 * 1000;

async function getTenantSettings(tenantId) {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.data;
  }

  try {
    const r = await pool.query(
      'SELECT welcome_message, faqs FROM tenant_settings WHERE tenant_id = $1',
      [tenantId]
    );
    const data = r.rows.length
      ? {
          welcome_message: r.rows[0].welcome_message || '',
          faqs: Array.isArray(r.rows[0].faqs) ? r.rows[0].faqs : [],
        }
      : { welcome_message: '', faqs: [] };

    cache.set(tenantId, { data, fetchedAt: Date.now() });
    return data;
  } catch (e) {
    console.error('[settings-cache] fetch failed for tenant', tenantId, e.message);
    if (cached) return cached.data;
    return { welcome_message: '', faqs: [] };
  }
}

function clearCache(tenantId) {
  if (tenantId == null) {
    cache.clear();
  } else {
    cache.delete(tenantId);
  }
}

module.exports = { getTenantSettings, clearCache };
