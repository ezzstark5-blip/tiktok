require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');

const baseUrl = process.env.TEST_API_URL || 'http://localhost:3000';
const executable = 'C:\\Users\\Stark\\Downloads\\SRC SHARK\\SCR STARK\\tests\\x64\\Release\\AuthSmokeTest.exe';
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
  return { response, payload: response.status === 204 ? null : await response.json() };
}

test('cliente C++ faz login, resgata key e recebe o produto', async (t) => {
  const suffix = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const username = `cpp_${suffix}`;
  const password = `Cpp_${suffix}`;
  let userId;
  let keyId;
  let adminToken;

  t.after(async () => {
    if (adminToken) await request('/api/logout', { method: 'POST', token: adminToken, body: {} });
    if (keyId) await supabase.from('kf_license_keys').delete().eq('id', keyId);
    if (userId) {
      await supabase.from('kf_sessions').delete().eq('user_id', userId);
      await supabase.from('kf_users').delete().eq('id', userId);
    }
  });

  const admin = await request('/api/login', { method: 'POST', body: { username: '1', password: '1' } });
  assert.equal(admin.response.status, 200);
  adminToken = admin.payload.token;

  const user = await request('/api/admin/users', {
    method: 'POST', token: adminToken, body: { username, password, role: 'customer' }
  });
  assert.equal(user.response.status, 201);
  userId = user.payload.id;

  const license = await request('/api/keys', {
    method: 'POST', token: adminToken,
    body: { productId: 'stark-menu', days: 30, maxActivations: 1 }
  });
  assert.equal(license.response.status, 201);
  keyId = license.payload.id;

  const result = spawnSync(executable, [username, password, license.payload.key, 'stark-menu'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, STARK_API_URL: baseUrl }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CPP_AUTH_OK stark-menu/);
});

test('cliente C++ cria usuario com key e entra com o produto liberado', async (t) => {
  const suffix = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const username = `regcpp_${suffix}`;
  const password = `Reg_${suffix}`;
  let userId;
  let keyId;
  let adminToken;

  t.after(async () => {
    const { data: user } = await supabase.from('kf_users').select('id').eq('username', username).maybeSingle();
    userId = userId || user?.id;
    if (adminToken) await request('/api/logout', { method: 'POST', token: adminToken, body: {} });
    if (keyId) await supabase.from('kf_license_keys').delete().eq('id', keyId);
    if (userId) {
      await supabase.from('kf_sessions').delete().eq('user_id', userId);
      await supabase.from('kf_users').delete().eq('id', userId);
    }
  });

  const admin = await request('/api/login', { method: 'POST', body: { username: '1', password: '1' } });
  assert.equal(admin.response.status, 200);
  adminToken = admin.payload.token;

  const license = await request('/api/keys', {
    method: 'POST', token: adminToken,
    body: { productId: 'bypass-cfx', days: 30, maxActivations: 1 }
  });
  assert.equal(license.response.status, 201);
  keyId = license.payload.id;

  const result = spawnSync(executable, ['--register', username, password, license.payload.key, 'bypass-cfx'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, STARK_API_URL: baseUrl }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /CPP_REGISTER_OK bypass-cfx/);

  const { data: created } = await supabase.from('kf_users').select('id').eq('username', username).single();
  userId = created.id;
});
