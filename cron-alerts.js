// cron-alerts.js — Phase 4 daily safety-net cron for threshold alerts
//
// Calls alerts.runDailyCheck() once per day at 9 AM IST (03:30 UTC).
// Self-healing: if the process restarts mid-day, it picks up correctly because
// the alerts module itself is idempotent (alerts_sent JSONB blocks re-fire).

const { runDailyCheck } = require('./alerts');
const { sendMessage } = require('./whatsapp');

const CRON_HOUR_IST = 9;   // 9 AM IST
const CRON_MIN_IST = 0;
// IST is UTC+5:30. 9:00 IST = 03:30 UTC.
const CRON_HOUR_UTC = 3;
const CRON_MIN_UTC = 30;

const CHECK_INTERVAL_MS = 60 * 1000;  // poll every minute, fire if it's the right minute

let lastFiredDay = null;  // YYYY-MM-DD string

function isItTime() {
  const now = new Date();
  return now.getUTCHours() === CRON_HOUR_UTC && now.getUTCMinutes() === CRON_MIN_UTC;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function tick() {
  try {
    if (!isItTime()) return;
    const today = todayKey();
    if (lastFiredDay === today) return;  // already ran today
    lastFiredDay = today;

    console.log('[cron-alerts] Triggering daily threshold check...');
    const result = await runDailyCheck({ sendMessage });
    console.log('[cron-alerts] Daily check result:', result);
  } catch (err) {
    console.error('[cron-alerts] tick error (non-fatal):', err.message);
  }
}

function start() {
  console.log(`[cron-alerts] Scheduled: daily ${CRON_HOUR_IST}:${String(CRON_MIN_IST).padStart(2,'0')} IST (${CRON_HOUR_UTC}:${String(CRON_MIN_UTC).padStart(2,'0')} UTC)`);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { start };
