const { insertAudit } = require('./database');

const debugEnabled = String(process.env.DEBUG_MODE || '').toLowerCase() === 'true';
const levels = new Set(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'DEBUG']);
const auditQueue = [];
let auditTimer = null;
let flushingAudit = false;
let lastAuditErrorAt = 0;

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

function scheduleAuditFlush(delay = 1000) {
  if (auditTimer) return;
  auditTimer = setTimeout(() => {
    auditTimer = null;
    flushAuditQueue();
  }, delay);
  auditTimer.unref();
}

async function flushAuditQueue() {
  if (flushingAudit || !auditQueue.length) return;
  flushingAudit = true;
  try {
    while (auditQueue.length) {
      try {
        await insertAudit(auditQueue[0]);
        auditQueue.shift();
      } catch (error) {
        if (Date.now() - lastAuditErrorAt > 60000) {
          lastAuditErrorAt = Date.now();
          console.error(`[AUDIT_ERROR] ${error.message} (evento mantido na fila)`);
        }
        scheduleAuditFlush(15000);
        break;
      }
    }
  } finally {
    flushingAudit = false;
  }
}

function audit(event) {
  const payload = { ...event, level: levels.has(event.level) ? event.level : 'INFO', details: sanitize(event.details) };
  write(payload.level, payload.action, payload.details);
  auditQueue.push(payload);
  if (auditQueue.length > 500) auditQueue.shift();
  scheduleAuditFlush();
}

module.exports = {
  debugEnabled, maskKey, audit,
  info: (message, details) => write('INFO', message, details),
  success: (message, details) => write('SUCCESS', message, details),
  warning: (message, details) => write('WARNING', message, details),
  error: (message, details) => write('ERROR', message, details),
  debug: (message, details) => write('DEBUG', message, details)
};
