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
  const names = ['kf_users', 'kf_products', 'kf_license_keys', 'kf_activations', 'kf_sessions', 'kf_meta'];
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
    .eq('redeemed_by_user_id', userId).eq('status', 'active').gt('expires_at', new Date().toISOString())
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
    id: row.id, key: row.license_key, productId: row.product_id, status: row.status,
    maxActivations: Number(row.max_activations), createdBy: row.created_by,
    redeemedByUserId: row.redeemed_by_user_id || null,
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    activations: activations.filter((item) => item.license_id === row.id).map((item) => ({
      hwidHash: item.hwid_hash, activatedAt: iso(item.activated_at),
      ...(item.last_seen_at ? { lastSeenAt: iso(item.last_seen_at) } : {})
    }))
  }));
}

async function getAdminOverview() {
  await ensureDatabase();
  const [{ data: users, error }, keys, status] = await Promise.all([
    getClient().from('kf_users').select('id,username,role,created_at').order('created_at'),
    getAllKeys(), getDatabaseStatus()
  ]);
  fail(error);
  return {
    status,
    users: users.map((row) => ({ id: row.id, username: row.username, role: row.role, createdAt: iso(row.created_at) })),
    keys: keys.map((row) => ({ ...row, activationCount: row.activations.length }))
  };
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
  const { error } = await getClient().from('kf_users').delete().eq('id', id);
  fail(error);
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
  insertSession, deleteSession, deleteUserById, getClient, getActiveProducts, getUserProducts,
  getAllKeys, getAdminOverview
};
