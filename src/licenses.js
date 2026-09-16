const crypto = require('node:crypto');
const { getClient, getActiveProducts, getUserProducts } = require('./database');

function makeKey() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `KF-${raw.match(/.{1,6}/g).join('-')}`;
}

function hashKey(key) { return crypto.createHash('sha256').update(String(key).trim().toUpperCase()).digest('hex'); }
function maskKey(key, id) { return `KF-****-****-${String(key).replaceAll('-', '').slice(-6)}-${String(id).slice(0, 6)}`; }

function fail(error) {
  if (error) throw new Error(`Supabase: ${error.message}`);
}

const activationLocks = new Map();

async function withActivationLock(keyDigest, task) {
  const previous = activationLocks.get(keyDigest) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  activationLocks.set(keyDigest, current);
  try { return await current; }
  finally { if (activationLocks.get(keyDigest) === current) activationLocks.delete(keyDigest); }
}

async function activateKeyWithoutRpc({ key, productId, fingerprint, userId, activationIp }) {
  const db = getClient();
  const keyDigest = hashKey(key);
  return withActivationLock(keyDigest, async () => {
    const { data: license, error } = await db.from('kf_license_keys')
      .select('id,product_id,status,expires_at,max_activations,redeemed_by_user_id')
      .eq('key_hash', keyDigest).maybeSingle();
    fail(error);
    if (!license) return { valid: false, reason: 'KEY_NOT_FOUND' };
    if (productId && license.product_id !== productId) return { valid: false, reason: 'WRONG_PRODUCT' };
    if (license.status === 'blocked' || license.status === 'disabled') return { valid: false, reason: 'KEY_BLOCKED' };
    if (license.status === 'revoked') return { valid: false, reason: 'KEY_REVOKED' };
    if (new Date(license.expires_at) <= new Date()) return { valid: false, reason: 'KEY_EXPIRED' };
    if (userId && license.redeemed_by_user_id && license.redeemed_by_user_id !== userId) {
      return { valid: false, reason: 'KEY_ALREADY_REDEEMED' };
    }

    const { data: activations, error: activationError } = await db.from('kf_activations')
      .select('hwid_hash,activated_at').eq('license_id', license.id).order('activated_at');
    fail(activationError);
    const existingIndex = activations.findIndex((item) => item.hwid_hash === fingerprint);
    if (existingIndex >= 0) {
      const { error: updateError } = await db.from('kf_activations').update({
        last_seen_at: new Date().toISOString(), activation_ip: activationIp ? String(activationIp).slice(0, 64) : null
      }).eq('license_id', license.id).eq('hwid_hash', fingerprint);
      fail(updateError);
      return { valid: true, productId: license.product_id, expiresAt: license.expires_at,
        activation: existingIndex + 1, maxActivations: Number(license.max_activations) };
    }
    if (activations.length >= Number(license.max_activations)) return { valid: false, reason: 'ACTIVATION_LIMIT' };

    const now = new Date().toISOString();
    const { error: insertError } = await db.from('kf_activations').insert({
      license_id: license.id, hwid_hash: fingerprint, activated_at: now, last_seen_at: now,
      activation_ip: activationIp ? String(activationIp).slice(0, 64) : null
    });
    if (insertError?.code !== '23505') fail(insertError);
    const changes = { status: 'used', updated_at: now };
    if (userId && !license.redeemed_by_user_id) changes.redeemed_by_user_id = userId;
    const { error: licenseError } = await db.from('kf_license_keys').update(changes).eq('id', license.id);
    fail(licenseError);
    return { valid: true, productId: license.product_id, expiresAt: license.expires_at,
      activation: activations.length + 1, maxActivations: Number(license.max_activations) };
  });
}

async function createKeys({ productId, days = 30, maxActivations = 1, quantity = 1, createdBy = 'api' }) {
  const parsedDays = Number(days);
  const parsedMax = Number(maxActivations);
  const parsedQuantity = Number(quantity);
  if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) throw new Error('A duracao deve ser um numero inteiro entre 1 e 3650 dias.');
  if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 100) throw new Error('O limite de ativacoes deve estar entre 1 e 100.');
  if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 5000) throw new Error('A quantidade deve estar entre 1 e 5000 keys.');

  const db = getClient();
  const { data: product, error: productError } = await db.from('kf_products').select('id')
    .eq('id', productId).eq('active', true).maybeSingle();
  fail(productError);
  if (!product) throw new Error('Produto nao encontrado ou inativo.');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + parsedDays * 86400000).toISOString();
  const licenses = Array.from({ length: parsedQuantity }, () => ({
    id: crypto.randomUUID(), key: makeKey(), productId, status: 'active',
    maxActivations: parsedMax, activations: [], createdBy,
    createdAt: now.toISOString(), expiresAt
  }));
  const rows = licenses.map((license) => ({
    id: license.id, license_key: maskKey(license.key, license.id), key_hint: maskKey(license.key, license.id), key_hash: hashKey(license.key), product_id: license.productId,
    status: license.status, max_activations: license.maxActivations,
    created_by: license.createdBy, created_at: license.createdAt, expires_at: license.expiresAt
  }));
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const { error } = await db.from('kf_license_keys').insert(rows.slice(index, index + chunkSize));
    fail(error);
  }
  return licenses;
}

async function createKey(options) { return (await createKeys({ ...options, quantity: 1 }))[0]; }

async function activateKey({ key, productId = null, hwid, userId = null, activationIp = null }) {
  const fingerprint = crypto.createHash('sha256').update(String(hwid)).digest('hex');
  const { data, error } = await getClient().rpc('kf_redeem_key', {
    p_key: String(key).trim().toUpperCase(), p_product_id: productId || null,
    p_hwid_hash: fingerprint, p_user_id: userId || null, p_activation_ip: activationIp || null
  });
  if (error && /function digest|digest\(text|42883/i.test(`${error.message || ''} ${error.code || ''}`)) {
    console.warn('[Licenses] RPC sem pgcrypto no search_path; usando validacao segura pelo backend.');
    return activateKeyWithoutRpc({ key, productId, fingerprint, userId, activationIp });
  }
  fail(error);
  return data;
}

async function validateKey({ key, productId, hwid, activationIp = null }) {
  if (!key || !productId || !hwid) throw new Error('key, productId e hwid sao obrigatorios.');
  if (String(hwid).length > 200) throw new Error('HWID invalido.');
  return activateKey({ key, productId, hwid, activationIp });
}

async function redeemKey({ key, hwid, userId, activationIp = null }) {
  if (!key || !hwid || !userId) throw new Error('key, hwid e userId sao obrigatorios.');
  if (String(hwid).length > 200) throw new Error('HWID invalido.');
  return activateKey({ key, hwid, userId, activationIp });
}

async function listUserProducts(userId) { return getUserProducts(userId); }
async function listProducts() { return getActiveProducts(); }

async function setKeyStatus(id, status) {
  const { data, error } = await getClient().from('kf_license_keys').update({ status }).eq('id', id).select('*').maybeSingle();
  fail(error);
  if (!data) return null;
  return {
    id: data.id, key: data.key_hint || data.license_key, productId: data.product_id, status: data.status,
    maxActivations: Number(data.max_activations), createdBy: data.created_by,
    createdAt: new Date(data.created_at).toISOString(), expiresAt: new Date(data.expires_at).toISOString(), activations: []
  };
}

async function updateKey(id, { expiresAt, maxActivations, notes }) {
  const changes = { updated_at: new Date().toISOString() };
  if (expiresAt !== undefined) {
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) throw new Error('Data de expiracao invalida.');
    changes.expires_at = date.toISOString();
  }
  if (maxActivations !== undefined) {
    const value = Number(maxActivations);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('O limite de ativacoes deve estar entre 1 e 100.');
    changes.max_activations = value;
  }
  if (notes !== undefined) changes.notes = String(notes).trim().slice(0, 500);
  const { data, error } = await getClient().from('kf_license_keys').update(changes).eq('id', id).select('*').maybeSingle();
  fail(error);
  if (!data) return null;
  return { id: data.id, key: data.key_hint || data.license_key, productId: data.product_id, status: data.status,
    maxActivations: Number(data.max_activations), notes: data.notes || '', createdBy: data.created_by,
    createdAt: new Date(data.created_at).toISOString(), expiresAt: new Date(data.expires_at).toISOString(), activations: [] };
}

module.exports = { createKey, createKeys, validateKey, redeemKey, listUserProducts, listProducts, setKeyStatus, updateKey };
