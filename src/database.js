const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { bootstrapSchema } = require('./bootstrap');

let client;
let initialized = false;
let initializationPromise;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Variavel ${name} nao configurada para o Supabase.`);
  return value;
}

function getClient() {
  if (!client) {
    client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return client;
}

function fail(error) {
  if (error) throw new Error(`Supabase: ${error.message}`);
}

function iso(value) { return value ? new Date(value).toISOString() : null; }

function mapLicense(row) {
  return {
    id: row.id, key: row.key_hint || row.license_key, productId: row.product_id, status: row.status,
    maxActivations: Number(row.max_activations), createdBy: row.created_by,
    redeemedByUserId: row.redeemed_by_user_id || null,
    notes: row.notes || '', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at), activations: []
  };
}

async function ensureDatabase() {
  if (initialized) return;
  if (!initializationPromise) initializationPromise = initializeDatabase();
  try {
    await initializationPromise;
    initialized = true;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}

async function initializeDatabase() {
  if (process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || (process.env.SUPABASE_DB_PASSWORD && process.env.SUPABASE_DB_HOST)) {
    await bootstrapSchema();
  }
  const db = getClient();
  let schemaCheck = await db.from('kf_products').select('id').limit(1);
  if (schemaCheck.error?.code === 'PGRST205') {
    await bootstrapSchema();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      schemaCheck = await db.from('kf_products').select('id').limit(1);
      if (!schemaCheck.error) break;
    }
  }
  fail(schemaCheck.error);
  const { count, error: countError } = await db.from('kf_users').select('id', { count: 'exact', head: true });
  fail(countError);
  if (!count) console.warn('[Supabase] Nenhum usuario cadastrado. Use /gerarusuario no bot para criar o primeiro acesso.');
  const products = [
    { id: 'stark-menu', name: 'Stark Menu', description: 'Acesso ao produto Stark Menu.', price: 59.9, active: true },
    { id: 'bypass-cfx', name: 'Bypass CFX', description: 'Acesso ao produto Bypass CFX.', price: 39.9, active: true },
    { id: 'stark-spoofer', name: 'Stark Spoofer', description: 'Acesso ao produto Stark Spoofer.', price: 49.9, active: true }
  ];
  const { error } = await db.from('kf_products').upsert(products, { onConflict: 'id' });
  fail(error);
  console.log('[Supabase] REST conectado e esquema verificado.');
}

async function checkDatabase() {
  await ensureDatabase();
  const started = process.hrtime.bigint();
  const { error } = await getClient().from('kf_products').select('id').limit(1);
  fail(error);
  return { online: true, latencyMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function tableCount(table) {
  const { count, error } = await getClient().from(table).select('*', { count: 'exact', head: true });
  fail(error);
  return count || 0;
}

async function getDatabaseStatus() {
  await ensureDatabase();
  const started = process.hrtime.bigint();
  const names = ['kf_users', 'kf_products', 'kf_license_keys', 'kf_activations', 'kf_sessions', 'kf_audit_logs', 'kf_key_history', 'kf_meta'];
  const counts = await Promise.all(names.map(tableCount));
  return {
    online: true, latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
    engine: 'PostgreSQL (Supabase REST)', database: 'postgres',
    host: 'cpftubhrnkxdamlonoga.supabase.co', ssl: true,
    tables: names.map((name, index) => ({ name, rows: counts[index] }))
  };
}

async function getActiveProducts() {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_products')
    .select('id,name,description,price,active').eq('active', true).order('name');
  fail(error);
  return data.map((row) => ({ ...row, price: Number(row.price), active: Boolean(row.active) }));
}

async function getUserProducts(userId) {
  await ensureDatabase();
  const { data: keys, error } = await getClient().from('kf_license_keys')
    .select('id,product_id,expires_at,max_activations,kf_products(name)')
    .eq('redeemed_by_user_id', userId).in('status', ['active', 'used']).gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false });
  fail(error);
  if (!keys.length) return [];
  const { data: activations, error: activationError } = await getClient().from('kf_activations')
    .select('license_id').in('license_id', keys.map((item) => item.id));
  fail(activationError);
  return keys.map((row) => ({
    productId: row.product_id, name: row.kf_products?.name || row.product_id,
    expiresAt: iso(row.expires_at),
    activationCount: activations.filter((item) => item.license_id === row.id).length,
    maxActivations: Number(row.max_activations)
  }));
}

async function getAllKeys() {
  await ensureDatabase();
  const db = getClient();
  const [{ data: keys, error }, { data: activations, error: activationError }] = await Promise.all([
    db.from('kf_license_keys').select('*').order('created_at', { ascending: false }),
    db.from('kf_activations').select('*')
  ]);
  fail(error); fail(activationError);
  return keys.map((row) => ({
    id: row.id, key: row.key_hint || row.license_key, productId: row.product_id, status: row.status,
    maxActivations: Number(row.max_activations), createdBy: row.created_by,
    redeemedByUserId: row.redeemed_by_user_id || null,
    notes: row.notes || '', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(row.expires_at),
    activations: activations.filter((item) => item.license_id === row.id).map((item) => ({
      hwidHash: item.hwid_hash, activationIp: item.activation_ip || null, activatedAt: iso(item.activated_at),
      ...(item.last_seen_at ? { lastSeenAt: iso(item.last_seen_at) } : {})
    }))
  }));
}

async function getAdminOverview() {
  await ensureDatabase();
  const [{ data: users, error }, keys, status, auditLogs] = await Promise.all([
    getClient().from('kf_users').select('id,username,role,created_at').order('created_at'),
    getAllKeys(), getDatabaseStatus(), getAuditLogs({ limit: 30 })
  ]);
  fail(error);
  return {
    status,
    users: users.map((row) => ({ id: row.id, username: row.username, role: row.role, createdAt: iso(row.created_at) })),
    keys: keys.map((row) => ({ ...row, activationCount: row.activations.length })),
    auditLogs
  };
}

async function insertAudit({ level = 'INFO', action, entityType = 'system', entityId = null, actorId = null, actorName = 'system', ipAddress = null, details = {} }) {
  await ensureDatabase();
  const { error } = await getClient().from('kf_audit_logs').insert({
    level, action, entity_type: entityType, entity_id: entityId,
    actor_id: actorId, actor_name: actorName, ip_address: ipAddress, details
  });
  fail(error);
}

async function getAuditLogs({ limit = 100, level, action } = {}) {
  await ensureDatabase();
  let query = getClient().from('kf_audit_logs').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 100, 500));
  if (level) query = query.eq('level', level);
  if (action) query = query.ilike('action', `%${action}%`);
  const { data, error } = await query;
  fail(error);
  return data.map((row) => ({ id: row.id, level: row.level, action: row.action, entityType: row.entity_type,
    entityId: row.entity_id, actorName: row.actor_name, ipAddress: row.ip_address,
    details: row.details, createdAt: iso(row.created_at) }));
}

async function insertKeyHistory({ licenseId, action, oldData = null, newData = null, actorName }) {
  const { error } = await getClient().from('kf_key_history').insert({ license_id: licenseId, action, old_data: oldData, new_data: newData, actor_name: actorName });
  fail(error);
}

async function getKeyHistory(licenseId) {
  const { data, error } = await getClient().from('kf_key_history').select('*').eq('license_id', licenseId).order('created_at', { ascending: false });
  fail(error);
  return data.map((row) => ({ id: row.id, action: row.action, oldData: row.old_data, newData: row.new_data, actorName: row.actor_name, createdAt: iso(row.created_at) }));
}

async function listKeysPage({ page = 1, pageSize = 25, search = '', status = 'all', productId = 'all', sort = 'created_at', direction = 'desc' } = {}) {
  await ensureDatabase();
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const allowedSort = new Set(['created_at', 'expires_at', 'status', 'product_id']);
  let query = getClient().from('kf_license_keys').select('*', { count: 'exact' });
  if (search) query = query.or(`key_hint.ilike.%${String(search).replace(/[%(),]/g, '')}%,product_id.ilike.%${String(search).replace(/[%(),]/g, '')}%`);
  if (status === 'expired') query = query.lt('expires_at', new Date().toISOString());
  else if (status !== 'all') query = query.eq('status', status);
  if (productId !== 'all') query = query.eq('product_id', productId);
  query = query.order(allowedSort.has(sort) ? sort : 'created_at', { ascending: direction === 'asc' })
    .range((safePage - 1) * safeSize, safePage * safeSize - 1);
  const { data, count, error } = await query;
  fail(error);
  return { items: data.map(mapLicense), total: count || 0, page: safePage, pageSize: safeSize, totalPages: Math.max(1, Math.ceil((count || 0) / safeSize)) };
}

async function getMeta(key) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_meta').select('meta_value').eq('meta_key', key).maybeSingle();
  fail(error);
  return data?.meta_value || null;
}

async function setMeta(key, value) {
  await ensureDatabase();
  const { error } = await getClient().from('kf_meta').upsert({ meta_key: key, meta_value: value }, { onConflict: 'meta_key' });
  fail(error);
}

async function findUserByUsername(username) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_users')
    .select('id,username,password_hash,role,created_at').eq('username', username).maybeSingle();
  fail(error);
  return data ? { id: data.id, username: data.username, password: data.password_hash, role: data.role, createdAt: iso(data.created_at) } : null;
}

async function insertUser({ id, username, password, role, createdAt }) {
  await ensureDatabase();
  const { error } = await getClient().from('kf_users').insert({ id, username, password_hash: password, role, created_at: createdAt });
  if (error?.code === '23505') return null;
  fail(error);
  return { id, username, role, createdAt };
}

async function deleteUserById(id) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_users')
    .delete().eq('id', id).select('id,username,role,created_at').maybeSingle();
  fail(error);
  return data ? { id: data.id, username: data.username, role: data.role, createdAt: iso(data.created_at) } : null;
}

async function getUserById(id) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_users')
    .select('id,username,role,created_at').eq('id', id).maybeSingle();
  fail(error);
  return data ? { id: data.id, username: data.username, role: data.role, createdAt: iso(data.created_at) } : null;
}

async function countAdmins() {
  await ensureDatabase();
  const { count, error } = await getClient().from('kf_users')
    .select('id', { count: 'exact', head: true }).in('role', ['admin', 'superadmin']);
  fail(error);
  return count || 0;
}

async function updateUserRole(id, role) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_users')
    .update({ role }).eq('id', id).select('id,username,role,created_at').maybeSingle();
  fail(error);
  return data ? { id: data.id, username: data.username, role: data.role, createdAt: iso(data.created_at) } : null;
}

async function revokeUserSessions(id) {
  await ensureDatabase();
  const { error, count } = await getClient().from('kf_sessions')
    .delete({ count: 'exact' }).eq('user_id', id);
  fail(error);
  return count || 0;
}

async function updateUserPassword(id, password) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_users')
    .update({ password_hash: password }).eq('id', id)
    .select('id,username,role,created_at').maybeSingle();
  fail(error);
  if (!data) return null;
  await revokeUserSessions(id);
  return { id: data.id, username: data.username, role: data.role, createdAt: iso(data.created_at) };
}

async function deleteKeyById(id) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_license_keys')
    .delete().eq('id', id).select('*').maybeSingle();
  fail(error);
  return data ? mapLicense(data) : null;
}

async function deleteKeysBulk({ quantity, status = 'all', productId = 'all', order = 'newest' }) {
  await ensureDatabase();
  const amount = Number(quantity);
  if (!Number.isInteger(amount) || amount < 1 || amount > 5000) {
    const error = new Error('A quantidade deve estar entre 1 e 5000 keys.');
    error.status = 400;
    throw error;
  }
  if (!['all', 'active', 'used', 'blocked', 'revoked'].includes(status)) {
    const error = new Error('Filtro de status invalido.'); error.status = 400; throw error;
  }
  if (!['newest', 'oldest'].includes(order)) {
    const error = new Error('Ordem de exclusao invalida.'); error.status = 400; throw error;
  }

  const db = getClient();
  const deleted = [];
  while (deleted.length < amount) {
    const batchSize = Math.min(1000, amount - deleted.length);
    let query = db.from('kf_license_keys').select('*')
      .order('created_at', { ascending: order === 'oldest' }).limit(batchSize);
    if (status !== 'all') query = query.eq('status', status);
    if (productId !== 'all') query = query.eq('product_id', productId);
    const { data: selected, error: selectError } = await query;
    fail(selectError);
    if (!selected?.length) break;

    for (let index = 0; index < selected.length; index += 100) {
      const rows = selected.slice(index, index + 100);
      const { error } = await db.from('kf_license_keys').delete().in('id', rows.map((row) => row.id));
      fail(error);
      deleted.push(...rows);
    }
    if (selected.length < batchSize) break;
  }
  return deleted.map(mapLicense);
}

async function findSessionUser(tokenHash) {
  await ensureDatabase();
  const { data, error } = await getClient().from('kf_sessions')
    .select('user_id,kf_users(id,username,role,created_at)')
    .eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).maybeSingle();
  fail(error);
  const user = data?.kf_users;
  return user ? { id: user.id, username: user.username, role: user.role, createdAt: iso(user.created_at) } : null;
}

async function insertSession({ id, userId, tokenHash, expiresAt }) {
  await ensureDatabase();
  const db = getClient();
  await db.from('kf_sessions').delete().lte('expires_at', new Date().toISOString());
  const { error } = await db.from('kf_sessions').insert({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
  fail(error);
}

async function deleteSession(tokenHash) {
  await ensureDatabase();
  const { error } = await getClient().from('kf_sessions').delete().eq('token_hash', tokenHash);
  fail(error);
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error); else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) return reject(error);
      const expected = Buffer.from(hash, 'hex');
      resolve(expected.length === key.length && crypto.timingSafeEqual(expected, key));
    });
  });
}

module.exports = {
  ensureDatabase, verifyPassword, hashPassword, checkDatabase, getDatabaseStatus,
  getMeta, setMeta, findUserByUsername, insertUser, findSessionUser,
  insertSession, deleteSession, deleteUserById, getUserById, countAdmins,
  updateUserRole, updateUserPassword, revokeUserSessions,
  deleteKeyById, deleteKeysBulk, getClient, getActiveProducts, getUserProducts,
  getAllKeys, getAdminOverview, insertAudit, getAuditLogs, insertKeyHistory, getKeyHistory, listKeysPage
};
