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
