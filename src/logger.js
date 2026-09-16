const { insertAudit } = require('./database');

const debugEnabled = String(process.env.DEBUG_MODE || '').toLowerCase() === 'true';
const levels = new Set(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'DEBUG']);

function maskKey(value) {
  const clean = String(value || '');
  if (!clean) return undefined;
  return `key-****-${clean.replaceAll('-', '').slice(-4)}`;
}

function sanitize(details = {}) {
  const blocked = /password|senha|token|secret|credential|authorization/i;
  return Object.fromEntries(Object.entries(details).flatMap(([key, value]) => {
    if (blocked.test(key)) return [];
    if (/^(key|licenseKey)$/i.test(key)) return [[key, maskKey(value)]];
    return [[key, value]];
  }));
}

function write(level, message, details = {}) {
  const normalized = levels.has(level) ? level : 'INFO';
  if (normalized === 'DEBUG' && !debugEnabled) return;
  const safe = sanitize(details);
  const suffix = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  const output = `[${new Date().toISOString()}] [${normalized}] ${message}${suffix}`;
  if (normalized === 'ERROR') console.error(output);
  else if (normalized === 'WARNING') console.warn(output);
  else console.log(output);
}

function audit(event) {
  const payload = { ...event, level: levels.has(event.level) ? event.level : 'INFO', details: sanitize(event.details) };
  write(payload.level, payload.action, payload.details);
  return insertAudit(payload).catch((error) => {
    // Circuit breaker: nu inunda logurile Render cu aceeasi eroare la
    // fiecare request cat timp baza e in mentenanta (DDL/migrari).
    const key = String(error.code || error.message).slice(0, 80);
    const now = Date.now();
    audit._last = audit._last || {};
    if (!audit._last[key] || now - audit._last[key] > 60000) {
      audit._last[key] = now;
      console.error(`[AUDIT_ERROR] ${error.message}`);
    }
  });
}

module.exports = {
  debugEnabled, maskKey, audit,
  info: (message, details) => write('INFO', message, details),
  success: (message, details) => write('SUCCESS', message, details),
  warning: (message, details) => write('WARNING', message, details),
  error: (message, details) => write('ERROR', message, details),
  debug: (message, details) => write('DEBUG', message, details)
};
