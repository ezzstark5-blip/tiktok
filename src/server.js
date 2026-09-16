require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const {
  ensureDatabase, verifyPassword,
  checkDatabase, findUserByUsername, findSessionUser,
  insertSession, deleteSession, deleteUserById, getAllKeys, getAdminOverview
} = require('./database');
const { createKey, validateKey, redeemKey, listUserProducts, listProducts, setKeyStatus } = require('./licenses');
const { createUser } = require('./users');
const { startDiscordBot } = require('./discord');
const { WebhookLogger } = require('./webhook-logger');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, '..', 'public');
const sessionLifetime = 12 * 60 * 60 * 1000;
const webhookLogger = new WebhookLogger(process.env.DISCORD_WEBHOOK_URL);
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
    webhookLogger.apiRequest({
      method: request.method,
      route: routePath,
      status: response.statusCode,
      durationMs
    });
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
  response.json({ ok: true, service: 'keyforge-api', database });
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
  } catch (error) {
    if (user?.id) await deleteUserById(user.id).catch(() => {});
    throw error;
  }
});

app.post('/api/logout', requireAuth, async (request, response) => {
  const tokenHash = crypto.createHash('sha256').update(bearerToken(request)).digest('hex');
  await deleteSession(tokenHash);
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
  response.status(201).json(license);
});

app.patch('/api/keys/:id/status', requireAuth, requireAdmin, async (request, response) => {
  const status = request.body.status;
  if (!['active', 'disabled'].includes(status)) return response.status(400).json({ error: 'Status invalido.' });
  const updated = await setKeyStatus(request.params.id, status);
  if (!updated) return response.status(404).json({ error: 'Key nao encontrada.' });
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
    service: 'keyforge-api',
    serverTime: new Date().toISOString()
  });
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
  response.status(result.valid ? 200 : 403).json(result);
});

app.get('/api/admin/database', requireAuth, requireAdmin, async (_request, response) => {
  response.json(await getAdminOverview());
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (request, response) => {
  response.status(201).json(await createUser(request.body));
});

app.get('*path', (_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.status || 500).json({ error: error.message || 'Erro interno.' });
});

async function main() {
  await ensureDatabase();
  await webhookLogger.initializePersistentState();
  const databaseHealth = await checkDatabase();
  webhookLogger.databaseStatus(databaseHealth);
  setInterval(async () => {
    const started = process.hrtime.bigint();
    try {
      const health = await checkDatabase();
      webhookLogger.databaseStatus(health);
    } catch (error) {
      webhookLogger.databaseStatus({ online: false, latencyMs: Number(process.hrtime.bigint() - started) / 1e6 });
      console.error('[Postgres] Monitor:', error.message);
    }
  }, 60000).unref();
  await new Promise((resolve, reject) => {
    const server = app.listen(port, resolve);
    server.once('error', reject);
  });
  console.log(`[API] http://localhost:${port}`);
  webhookLogger.systemOnline(port);
  await startDiscordBot();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = app;
