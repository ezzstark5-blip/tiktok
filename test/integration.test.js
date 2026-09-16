require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const baseUrl = process.env.TEST_API_URL || 'http://localhost:3000';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

test('fluxo completo: usuario, login, key, resgate e produto', async (t) => {
  const suffix = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const username = `teste_${suffix}`;
  const password = `Senha_${suffix}`;
  const hwid = `HWID-TEST-${suffix}`;
  let userId;
  let keyId;

  t.after(async () => {
    if (keyId) await supabase.from('kf_license_keys').delete().eq('id', keyId);
    if (userId) {
      await supabase.from('kf_sessions').delete().eq('user_id', userId);
      await supabase.from('kf_users').delete().eq('id', userId);
    }
  });

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);

  const adminLogin = await request('/api/login', {
    method: 'POST', body: { username: '1', password: '1' }
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.payload.user.role, 'admin');
  const adminToken = adminLogin.payload.token;

  const created = await request('/api/admin/users', {
    method: 'POST', token: adminToken, body: { username, password, role: 'customer' }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.username, username);
  userId = created.payload.id;

  const login = await request('/api/login', {
    method: 'POST', body: { username, password }
  });
  assert.equal(login.response.status, 200);
  const userToken = login.payload.token;

  const before = await request('/api/client/products', { token: userToken });
  assert.equal(before.response.status, 200);
  assert.deepEqual(before.payload, []);

  const generated = await request('/api/keys', {
    method: 'POST', token: adminToken,
    body: { productId: 'stark-spoofer', days: 30, maxActivations: 1 }
  });
  assert.equal(generated.response.status, 201);
  keyId = generated.payload.id;

  const redeemed = await request('/api/client/redeem', {
    method: 'POST', token: userToken, body: { key: generated.payload.key, hwid }
  });
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.payload.valid, true);
  assert.equal(redeemed.payload.productId, 'stark-spoofer');

  const after = await request('/api/client/products', { token: userToken });
  assert.equal(after.response.status, 200);
  assert.equal(after.payload.length, 1);
  assert.equal(after.payload[0].productId, 'stark-spoofer');

  const disabled = await request(`/api/keys/${keyId}/status`, {
    method: 'PATCH', token: adminToken, body: { status: 'disabled' }
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.status, 'disabled');

  const hidden = await request('/api/client/products', { token: userToken });
  assert.equal(hidden.response.status, 200);
  assert.deepEqual(hidden.payload, []);

  const forbidden = await request('/api/keys', { token: userToken });
  assert.equal(forbidden.response.status, 403);
});
