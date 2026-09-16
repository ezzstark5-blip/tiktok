require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const {
  ensureDatabase, verifyPassword, hashPassword,
  checkDatabase, findUserByUsername, findSessionUser,
  insertSession, deleteSession, deleteUserById, getUserById, countAdmins,
  updateUserRole, updateUserPassword, revokeUserSessions,
  deleteKeyById, deleteKeysBulk, getAllKeys, getAdminOverview, getDatabaseStatus,
  insertKeyHistory, getKeyHistory, getAuditLogs, listKeysPage
} = require('./database');
const { createKey, createKeys, validateKey, redeemKey, listUserProducts, listProducts, setKeyStatus, updateKey } = require('./licenses');
const { createUser } = require('./users');
const { startDiscordBot } = require('./discord');
const { updateApiStatus, updateDatabaseStatus, recordApiRequest, logKey, logKeyBatch, logUser } = require('./bot-logger');
const { encryptJson, decryptJson } = require('./encryption');
const logger = require('./logger');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, '..', 'public');
const sessionLifetime = 12 * 60 * 60 * 1000;
const registrationAttempts = new Map();
const loginAttempts = new Map();
const generationJobs = new Map();
const rolePermissions = {
  viewer: new Set(['read']), customer: new Set(['read-own']),
  support: new Set(['read', 'key:block']), operator: new Set(['read', 'key:block', 'key:create']),
  admin: new Set(['read', 'key:block', 'key:create', 'key:edit', 'key:delete', 'user:manage']),
  superadmin: new Set(['read', 'key:block', 'key:create', 'key:edit', 'key:delete', 'user:manage', 'settings:manage'])
};

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
    if (!token || !user) {
      logger.warning('Tentativa de acesso sem autorizacao', { method: request.method, path: request.path, ip: request.ip });
      return response.status(401).json({ error: 'Sessao invalida ou expirada.' });
    }
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requirePermission(permission) {
  return (request, response, next) => {
    if (!rolePermissions[request.user?.role]?.has(permission)) {
      logger.warning('Permissao insuficiente', { user: request.user?.username, permission, path: request.path });
      return response.status(403).json({ error: 'Sua permissao nao autoriza esta operacao.' });
    }
    next();
  };
}

function requireAdmin(request, response, next) {
  if (!['admin', 'superadmin'].includes(request.user?.role)) return response.status(403).json({ error: 'Acesso restrito a administradores.' });
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
  const attemptKey = `${request.ip}:${username.toLowerCase()}`;
  const now = Date.now();
  const attempt = loginAttempts.get(attemptKey);
  if (attempt?.blockedUntil > now) return response.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  const user = await findUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password))) {
    const failures = (attempt?.failures || 0) + 1;
    loginAttempts.set(attemptKey, { failures, blockedUntil: failures >= 5 ? now + 15 * 60 * 1000 : 0 });
    logger.warning('Falha de login', { username, ip: request.ip, failures });
    return response.status(401).json({ error: 'Usuario ou senha incorretos.' });
  }
  loginAttempts.delete(attemptKey);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + sessionLifetime).toISOString();
  await insertSession({ id: crypto.randomUUID(), userId: user.id, tokenHash, expiresAt });
  logUser('LOGIN REALIZADO', user, 'painel web');
  logger.audit({ level: 'SUCCESS', action: 'LOGIN', entityType: 'user', entityId: user.id, actorId: user.id, actorName: user.username, ipAddress: request.ip });
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
  logger.audit({ level: 'INFO', action: 'LOGOUT', entityType: 'user', entityId: request.user.id, actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip });
  response.status(204).end();
});

app.get('/api/products', async (_request, response) => response.json(await listProducts()));

app.get('/api/keys', requireAuth, requireAdmin, async (request, response) => {
  // Cap para nao estourar o statement_timeout: ?limit= (default 1000, max 5000).
  // Para paginacao completa use GET /api/admin/keys?page=&pageSize=.
  const limit = Math.min(5000, Math.max(1, Number(request.query.limit) || 1000));
  response.json(await getAllKeys({ limit }));
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

app.post('/api/keys/batch/jobs', requireAuth, requirePermission('key:create'), async (request, response) => {
  const quantity = Number(request.body.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5000) return response.status(400).json({ error: 'A quantidade deve estar entre 1 e 5000 keys.' });
  const job = { id: crypto.randomUUID(), status: 'queued', total: quantity, created: 0, pending: quantity, errors: 0, events: [], keys: [], createdAt: new Date().toISOString() };
  generationJobs.set(job.id, job);
  response.status(202).json({ jobId: job.id, status: job.status, total: job.total });

  setImmediate(async () => {
    job.status = 'processing';
    job.events.push({ level: 'INFO', message: `Iniciando criacao de ${quantity} keys`, at: new Date().toISOString() });
    logger.info('Inicio da criacao em massa', { jobId: job.id, quantity, actor: request.user.username });
    const chunkSize = 250;
    for (let offset = 0; offset < quantity; offset += chunkSize) {
      const size = Math.min(chunkSize, quantity - offset);
      try {
        const keys = await createKeys({ productId: String(request.body.productId || ''), days: Number(request.body.days ?? 30), maxActivations: Number(request.body.maxActivations ?? 1), quantity: size, createdBy: `panel:${request.user.username}` });
        job.keys.push(...keys); job.created += keys.length; job.pending = quantity - job.created - job.errors;
        for (const key of keys) logger.success('Key criada', { jobId: job.id, key: key.key, productId: key.productId });
        job.events.push({ level: 'SUCCESS', message: `${job.created} de ${quantity} keys processadas`, at: new Date().toISOString() });
      } catch (error) {
        job.errors += size; job.pending = quantity - job.created - job.errors;
        job.events.push({ level: 'ERROR', message: `Falha no lote ${offset + 1}-${offset + size}: ${error.message}`, at: new Date().toISOString() });
        logger.error('Erro na criacao em massa', { jobId: job.id, offset, size, error: error.message });
      }
    }
    job.status = job.errors ? (job.created ? 'partial' : 'failed') : 'completed';
    job.finishedAt = new Date().toISOString();
    job.events.push({ level: job.errors ? 'WARNING' : 'SUCCESS', message: `Finalizado: ${job.created} criadas e ${job.errors} com erro`, at: job.finishedAt });
    if (job.keys.length) logKeyBatch('LOTE CRIADO PELO PAINEL', job.keys, request.user.username);
    logger.audit({ level: job.errors ? 'WARNING' : 'SUCCESS', action: 'KEY_BATCH_CREATED', entityType: 'key_batch', entityId: job.id, actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip, details: { total: quantity, created: job.created, errors: job.errors } });
    const expiry = setTimeout(() => generationJobs.delete(job.id), 30 * 60 * 1000); expiry.unref();
  });
});

app.get('/api/keys/batch/jobs/:id', requireAuth, requirePermission('key:create'), (request, response) => {
  const job = generationJobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: 'Operacao nao encontrada ou expirada.' });
  response.json(job);
});

app.patch('/api/keys/:id/status', requireAuth, requirePermission('key:block'), async (request, response) => {
  const status = request.body.status;
  if (!['active', 'blocked', 'revoked'].includes(status)) return response.status(400).json({ error: 'Status invalido.' });
  if (status === 'revoked' && !rolePermissions[request.user.role]?.has('key:edit')) return response.status(403).json({ error: 'Revogar exige permissao administrativa.' });
  const updated = await setKeyStatus(request.params.id, status);
  if (!updated) return response.status(404).json({ error: 'Key nao encontrada.' });
  logKey(`STATUS ALTERADO PARA ${status.toUpperCase()}`, updated, request.user.username);
  await insertKeyHistory({ licenseId: updated.id, action: `STATUS_${status.toUpperCase()}`, newData: { status }, actorName: request.user.username });
  logger.audit({ level: 'INFO', action: 'KEY_STATUS_CHANGED', entityType: 'key', entityId: updated.id, actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip, details: { status } });
  response.json(updated);
});

app.patch('/api/admin/keys/:id', requireAuth, requirePermission('key:edit'), async (request, response) => {
  const updated = await updateKey(request.params.id, request.body);
  if (!updated) return response.status(404).json({ error: 'Key nao encontrada.' });
  await insertKeyHistory({ licenseId: updated.id, action: 'EDITED', newData: { expiresAt: updated.expiresAt, maxActivations: updated.maxActivations, notes: updated.notes }, actorName: request.user.username });
  logger.audit({ level: 'INFO', action: 'KEY_EDITED', entityType: 'key', entityId: updated.id, actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip });
  response.json(updated);
});

app.get('/api/admin/keys/:id/history', requireAuth, requirePermission('read'), async (request, response) => response.json(await getKeyHistory(request.params.id)));
app.get('/api/admin/keys', requireAuth, requirePermission('read'), async (request, response) => response.json(await listKeysPage(request.query)));
app.get('/api/admin/audit', requireAuth, requirePermission('read'), async (request, response) => response.json(await getAuditLogs(request.query)));

app.delete('/api/admin/keys/:id', requireAuth, requirePermission('key:delete'), async (request, response) => {
  if (request.get('x-confirm-action') !== 'DELETE') return response.status(400).json({ error: 'Confirmacao dupla obrigatoria.' });
  const deleted = await deleteKeyById(request.params.id);
  if (!deleted) return response.status(404).json({ error: 'Key nao encontrada.' });
  logKey('KEY EXCLUIDA PELO PAINEL', deleted, request.user.username);
  logger.audit({ level: 'WARNING', action: 'KEY_DELETED', entityType: 'key', entityId: deleted.id, actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip });
  response.json({ deleted: true, key: deleted });
});

app.post('/api/admin/keys/bulk-delete', requireAuth, requirePermission('key:delete'), async (request, response) => {
  if (request.body.confirmation !== 'DELETE') return response.status(400).json({ error: 'Digite DELETE para confirmar a operacao.' });
  const deleted = await deleteKeysBulk({
    quantity: request.body.quantity,
    status: String(request.body.status || 'all'),
    productId: String(request.body.productId || 'all'),
    order: String(request.body.order || 'newest')
  });
  if (deleted.length) logKeyBatch('LOTE EXCLUIDO PELO PAINEL', deleted, request.user.username);
  logger.audit({ level: 'WARNING', action: 'KEY_BULK_DELETED', entityType: 'key_batch', actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip, details: { count: deleted.length, status: request.body.status, productId: request.body.productId } });
  response.json({ deletedCount: deleted.length, deletedIds: deleted.map((key) => key.id) });
});

app.post('/api/admin/keys/bulk-action', requireAuth, requirePermission('key:block'), async (request, response) => {
  const ids = [...new Set(Array.isArray(request.body.ids) ? request.body.ids.map(String) : [])].slice(0, 500);
  const action = String(request.body.action || '');
  if (!ids.length) return response.status(400).json({ error: 'Selecione ao menos uma key.' });
  if (!['active', 'blocked', 'revoked', 'delete'].includes(action)) return response.status(400).json({ error: 'Acao em massa invalida.' });
  if (request.body.confirmation !== 'CONFIRM') return response.status(400).json({ error: 'Confirmacao dupla obrigatoria.' });
  if (['revoked', 'delete'].includes(action) && !rolePermissions[request.user.role]?.has(action === 'delete' ? 'key:delete' : 'key:edit')) {
    return response.status(403).json({ error: 'Sua permissao nao autoriza esta acao critica.' });
  }
  const changed = [];
  for (const id of ids) {
    const item = action === 'delete' ? await deleteKeyById(id) : await setKeyStatus(id, action);
    if (item) changed.push(item);
  }
  logger.audit({ level: ['delete', 'revoked'].includes(action) ? 'WARNING' : 'INFO', action: `KEY_BULK_${action.toUpperCase()}`, entityType: 'key_batch', actorId: request.user.id, actorName: request.user.username, ipAddress: request.ip, details: { count: changed.length } });
  response.json({ count: changed.length, ids: changed.map((item) => item.id), items: action === 'delete' ? [] : changed });
});

app.post('/api/licenses/validate', async (request, response) => {
  const result = await validateKey({
    key: request.body.key,
    productId: request.body.productId,
    hwid: request.body.hwid, activationIp: request.ip
  });
  response.status(result.valid ? 200 : 403).json(result);
});

app.post('/api/client/query', async (request, response) => {
  const result = await validateKey({
    key: request.body.key,
    productId: request.body.productId,
    hwid: request.body.hwid, activationIp: request.ip
  });
  response.status(result.valid ? 200 : 403).json({
    ...result,
    service: 'api-control-center',
    serverTime: new Date().toISOString()
  });
});

app.post('/api/client/secure-query', async (request, response) => {
  const payload = decryptJson(request.body);
  const result = await validateKey({ key: payload.key, productId: payload.productId, hwid: payload.hwid, activationIp: request.ip });
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
    userId: request.user.id, activationIp: request.ip
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

app.patch('/api/admin/users/:id/role', requireAuth, requireAdmin, async (request, response) => {
  const role = String(request.body.role || '');
  if (!['superadmin', 'admin', 'operator', 'support', 'viewer', 'customer'].includes(role)) return response.status(400).json({ error: 'Permissao invalida.' });
  const target = await getUserById(request.params.id);
  if (!target) return response.status(404).json({ error: 'Usuario nao encontrado.' });
  if (target.id === request.user.id && !['admin', 'superadmin'].includes(role)) {
    return response.status(400).json({ error: 'Voce nao pode remover sua propria permissao de administrador.' });
  }
  if (['admin', 'superadmin'].includes(target.role) && !['admin', 'superadmin'].includes(role) && await countAdmins() <= 1) {
    return response.status(400).json({ error: 'O ultimo administrador nao pode ser rebaixado.' });
  }
  const updated = await updateUserRole(target.id, role);
  await revokeUserSessions(target.id);
  logUser('PERMISSAO ALTERADA E SESSOES REVOGADAS', updated, request.user.username);
  response.json(updated);
});

app.patch('/api/admin/users/:id/password', requireAuth, requireAdmin, async (request, response) => {
  const password = String(request.body.password || '');
  if (password.length < 6 || password.length > 128) {
    return response.status(400).json({ error: 'A senha deve ter entre 6 e 128 caracteres.' });
  }
  const updated = await updateUserPassword(request.params.id, await hashPassword(password));
  if (!updated) return response.status(404).json({ error: 'Usuario nao encontrado.' });
  logUser('SENHA REDEFINIDA E SESSOES REVOGADAS', updated, request.user.username);
  response.json(updated);
});

app.post('/api/admin/users/:id/revoke-sessions', requireAuth, requireAdmin, async (request, response) => {
  const target = await getUserById(request.params.id);
  if (!target) return response.status(404).json({ error: 'Usuario nao encontrado.' });
  if (target.id === request.user.id) return response.status(400).json({ error: 'Use Sair para encerrar sua propria sessao.' });
  const revokedCount = await revokeUserSessions(target.id);
  logUser('SESSOES REVOGADAS', target, request.user.username);
  response.json({ revokedCount });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (request, response) => {
  const target = await getUserById(request.params.id);
  if (!target) return response.status(404).json({ error: 'Usuario nao encontrado.' });
  if (target.id === request.user.id) return response.status(400).json({ error: 'Voce nao pode excluir sua propria conta.' });
  if (['admin', 'superadmin'].includes(target.role) && await countAdmins() <= 1) {
    return response.status(400).json({ error: 'O ultimo administrador nao pode ser excluido.' });
  }
  const deleted = await deleteUserById(target.id);
  logUser('USUARIO EXCLUIDO PELO PAINEL', deleted, request.user.username);
  response.json({ deleted: true, user: deleted });
});

app.get('*path', (_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

app.use((error, _request, response, _next) => {
  console.error(error);
  const status = error.status || 500;
  const payload = { error: error.message || 'Erro interno.' };
  // 503 + retryable:true permite ao painel exibir "tente de novo" em vez de erro fatal.
  if (error.code === 'STATEMENT_TIMEOUT' || status === 503) payload.retryable = true;
  response.status(status).json(payload);
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
