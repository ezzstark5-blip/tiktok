const crypto = require('node:crypto');
const { insertUser, hashPassword } = require('./database');

const ALLOWED_ROLES = new Set(['customer', 'viewer', 'support', 'operator', 'admin', 'superadmin']);

async function createUser({ username, password, role = 'customer' }) {
  const normalizedUsername = String(username || '').trim();
  const normalizedPassword = String(password || '');
  const normalizedRole = ALLOWED_ROLES.has(role) ? role : 'customer';

  if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(normalizedUsername)) {
    const error = new Error('Usuario deve ter 3 a 50 caracteres: letras, numeros, ponto, hifen ou underline.');
    error.status = 400;
    throw error;
  }
  if (normalizedPassword.length < 6 || normalizedPassword.length > 128) {
    const error = new Error('A senha deve ter entre 6 e 128 caracteres.');
    error.status = 400;
    throw error;
  }

  const createdAt = new Date().toISOString();
  const created = await insertUser({
    id: crypto.randomUUID(),
    username: normalizedUsername,
    password: await hashPassword(normalizedPassword),
    role: normalizedRole,
    createdAt
  });

  if (!created) {
    const error = new Error('Este usuario ja existe.');
    error.status = 409;
    throw error;
  }
  return created;
}

module.exports = { createUser, ALLOWED_ROLES };
