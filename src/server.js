require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const {
  ensureDatabase, verifyPassword,
  checkDatabase, findUserByUsername, findSessionUser,
  insertSession, deleteSession, deleteUserById, getAllKeys, getAdminOverview, getDatabaseStatus
} = require('./database');
const { createKey, createKeys, validateKey, redeemKey, listUserProducts, listProducts, setKeyStatus } = require('./licenses');
const { createUser } = require('./users');
const { startDiscordBot } = require('./discord');
const { updateApiStatus, updateDatabaseStatus, recordApiRequest, logKey, logKeyBatch, logUser } = require('./bot-logger');
const { encryptJson, decryptJson } = require('./encryption');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, '..', 'public');
const sessionLifetime = 12 * 60 * 60 * 1000;
const registrationAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(publicDir));

app.use('/api', (request, response, next) => {
  const startedAt = process.hrtime.bigint();
  response.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const routePath = request.route?.path
      ? `${request.baseUrl}${request.route.path}`
      : `${request.baseUrl}${request.path}`;
    const logEntry = {
      method: request.method,
      route: routePath,
      status: response.statusCode,
      durationMs
    };
    recordApiRequest(logEntry);
  });
  next();
});

function bearerToken(request) {
  const header = request.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function requireAuth(request, response, next) {
  try {
    const token = bearerToken(request);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = token ? await findSessionUser(tokenHash) : null;
    if (!token || !user) return response.status(401).json({ error: 'Sessao invalida ou expirada.' });
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(request, response, next) {
  if (request.user?.role !== 'admin') return response.status(403).json({ error: 'Acesso restrito a administradores.' });
  next();
}

function limitRegistration(request, response, next) {
  const now = Date.now();
  const key = request.ip || request.socket.remoteAddress || 'local';
  const previous = registrationAttempts.get(key);
  const entry = !previous || now - previous.startedAt > 10 * 60 * 1000
    ? { startedAt: now, count: 0 }
    : previous;
  entry.count += 1;
  registrationAttempts.set(key, entry);
  if (entry.count > 10) return response.status(429).json({ error: 'Muitas tentativas de cadastro. Aguarde alguns minutos.' });
  next();
}

app.get('/api/health', async (_request, response) => {
  const database = await checkDatabase();
  response.json({
    ok: true,
    service: 'api-control-center',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${port}`,
    database
  });
});

app.post('/api/login', async (request, response) => {
  const username = String(request.body.username || '');
  const password = String(request.body.password || '');
  const user = await findUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password))) {
    return response.status(401).json({ error: 'Usuario ou senha incorretos.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + sessionLifetime).toISOString();
  await insertSession({ id: crypto.randomUUID(), userId: user.id, tokenHash, expiresAt });
  logUser('LOGIN REALIZADO', user, 'painel web');
  response.json({ token, expiresAt, user: { username: user.username, role: user.role } });
});

app.post('/api/register', limitRegistration, async (request, response) => {
  let user;
  try {
    user = await createUser({
      username: request.body.username,
      password: request.body.password,
      role: 'customer'
    });
    const result = await redeemKey({
      key: request.body.key,
      hwid: request.body.hwid,
      userId: user.id
    });
    if (!result.valid) {
      await deleteUserById(user.id);
      user = null;
      return response.status(403).json(result);
    }
    response.status(201).json({
      created: true,
      user: { username: user.username, role: user.role },
      productId: result.productId,
      expiresAt: result.expiresAt
    });
    logUser('USUARIO REGISTRADO', user, 'cadastro publico');
    logKey('KEY RESGATADA NO CADASTRO', {
      key: request.body.key, productId: result.productId, status: 'redeemed'
    }, user.username);
  } catch (error) {
    if (user?.id) await deleteUserById(user.id).catch(() => {});
    throw error;
  }
});

app.post('/api/logout', requireAuth, async (request, response) => {
  const tokenHash = crypto.createHash('sha256').update(bearerToken(request)).digest('hex');
  await deleteSession(tokenHash);
  logUser('LOGOUT REALIZADO', request.user, 'painel web');
  response.status(204).end();
});

app.get('/api/products', async (_request, response) => response.json(await listProducts()));

app.get('/api/keys', requireAuth, requireAdmin, async (_request, response) => {
  response.json(await getAllKeys());
});

app.post('/api/keys', requireAuth, requireAdmin, async (request, response) => {
  const license = await createKey({
    productId: String(request.body.productId || ''),
    days: Number(request.body.days ?? 30),
    maxActivations: Number(request.body.maxActivations ?? 1),
    createdBy: `panel:${request.user.username}`
  });
  logKey('KEY CRIADA PELO PAINEL', license, request.user.username);
  response.status(201).json(license);
});

app.post('/api/keys/batch', requireAuth, requireAdmin, async (request, response) => {
  const licenses = await createKeys({
    productId: String(request.body.productId || ''),
    days: Number(request.body.days ?? 30),
    maxActivations: Number(request.body.maxActivations ?? 1),
    quantity: Number(request.body.quantity ?? 1),
    createdBy: `panel:${request.user.username}`
  });
  logKeyBatch('LOTE CRIADO PELO PAINEL', licenses, request.user.username);
  response.status(201).json({ quantity: licenses.length, keys: licenses });
});

app.patch('/api/keys/:id/status', requireAuth, requireAdmin, async (request, response) => {
  const status = request.body.status;
  if (!['active', 'disabled'].includes(status)) return response.status(400).json({ error: 'Status invalido.' });
  const updated = await setKeyStatus(request.params.id, status);
  if (!updated) return response.status(404).json({ error: 'Key nao encontrada.' });
  logKey(`STATUS ALTERADO PARA ${status.toUpperCase()}`, updated, request.user.username);
  response.json(updated);
});

app.post('/api/licenses/validate', async (request, response) => {
  const result = await validateKey({
    key: request.body.key,
    productId: request.body.productId,
    hwid: request.body.hwid
  });
  response.status(result.valid ? 200 : 403).json(result);
});

app.post('/api/client/query', async (request, response) => {
  const result = await validateKey({
    key: request.body.key,
    productId: request.body.productId,
    hwid: request.body.hwid
  });
  response.status(result.valid ? 200 : 403).json({
    ...result,
    service: 'api-control-center',
    serverTime: new Date().toISOString()
  });
});

app.post('/api/client/secure-query', async (request, response) => {
  const payload = decryptJson(request.body);
  const result = await validateKey({ key: payload.key, productId: payload.productId, hwid: payload.hwid });
  response.status(result.valid ? 200 : 403).json(encryptJson({
    ...result,
    service: 'api-control-center',
    serverTime: new Date().toISOString()
  }));
});

app.get('/api/client/products', requireAuth, async (request, response) => {
  response.json(await listUserProducts(request.user.id));
});

app.post('/api/client/redeem', requireAuth, async (request, response) => {
  const result = await redeemKey({
    key: request.body.key,
    hwid: request.body.hwid,
    userId: request.user.id
  });
  if (result.valid) logKey('KEY RESGATADA PELO CLIENTE', {
    key: request.body.key, productId: result.productId, status: 'redeemed'
  }, request.user.username);
  response.status(result.valid ? 200 : 403).json(result);
});

app.get('/api/admin/database', requireAuth, requireAdmin, async (_request, response) => {
  response.json(await getAdminOverview());
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (request, response) => {
  const user = await createUser(request.body);
  logUser('USUARIO CRIADO PELO PAINEL', user, request.user.username);
  response.status(201).json(user);
});

app.get('*path', (_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || 'Erro interno.' });
});

async function main() {
  await ensureDatabase();
  const monitorServices = async () => {
    const started = process.hrtime.bigint();
    try {
      const status = await getDatabaseStatus();
      updateDatabaseStatus(status);
      updateApiStatus({ online: true, port, baseUrl: process.env.PUBLIC_URL });
    } catch (error) {
      const offline = { online: false, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, tables: [] };
      updateDatabaseStatus(offline);
      updateApiStatus({ online: false, port, baseUrl: process.env.PUBLIC_URL });
      console.error('[Postgres] Monitor:', error.message);
    }
  };
  await new Promise((resolve, reject) => {
    const server = app.listen(port, resolve);
    server.once('error', reject);
  });
  console.log(`[API] http://localhost:${port}`);
  await startDiscordBot();
  await monitorServices();
  setInterval(monitorServices, 60000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = app;
