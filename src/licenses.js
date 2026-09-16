const crypto = require('node:crypto');
const { getClient, getActiveProducts, getUserProducts } = require('./database');

function makeKey() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `KF-${raw.match(/.{1,6}/g).join('-')}`;
}

function fail(error) {
  if (error) throw new Error(`Supabase: ${error.message}`);
}

async function createKeys({ productId, days = 30, maxActivations = 1, quantity = 1, createdBy = 'api' }) {
  const parsedDays = Number(days);
  const parsedMax = Number(maxActivations);
  const parsedQuantity = Number(quantity);
  if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) throw new Error('A duracao deve ser um numero inteiro entre 1 e 3650 dias.');
  if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 100) throw new Error('O limite de ativacoes deve estar entre 1 e 100.');
  if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 50) throw new Error('A quantidade deve estar entre 1 e 50 keys.');

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
    id: license.id, license_key: license.key, product_id: license.productId,
    status: license.status, max_activations: license.maxActivations,
    created_by: license.createdBy, created_at: license.createdAt, expires_at: license.expiresAt
  }));
  const { error } = await db.from('kf_license_keys').insert(rows);
  fail(error);
  return licenses;
}

async function createKey(options) { return (await createKeys({ ...options, quantity: 1 }))[0]; }

async function activateKey({ key, productId = null, hwid, userId = null }) {
  const fingerprint = crypto.createHash('sha256').update(String(hwid)).digest('hex');
  const { data, error } = await getClient().rpc('kf_redeem_key', {
    p_key: String(key).trim().toUpperCase(), p_product_id: productId || null,
    p_hwid_hash: fingerprint, p_user_id: userId || null
  });
  fail(error);
  return data;
}

async function validateKey({ key, productId, hwid }) {
  if (!key || !productId || !hwid) throw new Error('key, productId e hwid sao obrigatorios.');
  if (String(hwid).length > 200) throw new Error('HWID invalido.');
  return activateKey({ key, productId, hwid });
}

async function redeemKey({ key, hwid, userId }) {
  if (!key || !hwid || !userId) throw new Error('key, hwid e userId sao obrigatorios.');
  if (String(hwid).length > 200) throw new Error('HWID invalido.');
  return activateKey({ key, hwid, userId });
}

async function listUserProducts(userId) { return getUserProducts(userId); }
async function listProducts() { return getActiveProducts(); }

async function setKeyStatus(id, status) {
  const { data, error } = await getClient().from('kf_license_keys').update({ status }).eq('id', id).select('*').maybeSingle();
  fail(error);
  if (!data) return null;
  return {
    id: data.id, key: data.license_key, productId: data.product_id, status: data.status,
    maxActivations: Number(data.max_activations), createdBy: data.created_by,
    createdAt: new Date(data.created_at).toISOString(), expiresAt: new Date(data.expires_at).toISOString(), activations: []
  };
}

module.exports = { createKey, createKeys, validateKey, redeemKey, listUserProducts, listProducts, setKeyStatus };
