const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem('kf_token'), products: [], keys: [], keysForbidden: false, database: null, health: null };
const view = { licensePage: 1, databaseKeyPage: 1, pageSize: 25 };
let generatedKeysText = '';
const selectedKeys = new Set();
let consoleLines = ['[INFO] Console pronto.'];

function svgIcon(name) {
  return `<svg aria-hidden="true"><use href="#${name}"></use></svg>`;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 204) return null;
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error(`A API retornou uma resposta invalida (HTTP ${response.status}).`); }
  }
  if (!response.ok) throw new Error(data.error || data.reason || 'Falha na requisicao.');
  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2400);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(value));
}

function effectiveStatus(key) { return new Date(key.expiresAt) <= new Date() ? 'expired' : key.status; }
function statusLabel(status) { return ({ active: 'ATIVA', used: 'UTILIZADA', blocked: 'BLOQUEADA', revoked: 'REVOGADA', expired: 'EXPIRADA', disabled: 'BLOQUEADA' })[status] || String(status).toUpperCase(); }
function operationLog(level, message, at = new Date().toISOString()) {
  const time = new Date(at).toLocaleTimeString('pt-BR');
  consoleLines.push(`[${time}] [${level}] ${message}`);
  consoleLines = consoleLines.slice(-250);
  $('#operation-console').textContent = consoleLines.join('\n');
  $('#operation-console').scrollTop = $('#operation-console').scrollHeight;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

async function loadDashboard() {
  // 1) Valideaza sesiunea cu un endpoint accesibil oricarui rol.
  // BUG VECHI: aici se cereau din prima /api/keys (doar admin) intr-un
  // Promise.all — orice user non-admin, orice 403 sau timeout de Supabase
  // arunca tot si facea logout() SILENTIOS, fara mesaj. De aia "Entrar no
  // painel" parea ca nu functioneaza desi login-ul reusea.
  try {
    await api('/api/client/products');
  } catch (error) {
    logout(false);
    $('#login-error').textContent = error.message || 'Sessao invalida ou expirada.';
    return;
  }
  // 2) Date publice/ieftine — esecul aici e critic, inapoi la login CU mesaj.
  try {
    [state.products, state.health] = await Promise.all([api('/api/products'), api('/api/health')]);
  } catch (error) {
    logout(false);
    $('#login-error').textContent = error.message;
    return;
  }
  // 3) Keys cere admin — 403 la non-admin e normal, intram oricum in painel.
  state.keysForbidden = false;
  try {
    const page = await api('/api/admin/keys?page=1&pageSize=100&sort=id&direction=desc');
    state.keys = page.items;
  } catch (error) {
    state.keys = [];
    state.keysForbidden = true;
  }
  try {
    render();
  } catch {
    logout(false);
    $('#login-error').textContent = 'Falha ao carregar o painel.';
    return;
  }
  $('#login-view').classList.add('hidden');
  $('#dashboard-view').classList.remove('hidden');
  if (state.keysForbidden) toast('Sem permissao para listar keys (restrito a administradores).');
  loadDatabase().catch(() => {});
}

async function loadDatabase() {
  state.database = await api('/api/admin/database');
  renderDatabase();
}

function renderDatabase() {
  if (!state.database) return;
  const { status } = state.database;
  $('#db-status-label').textContent = status.online ? 'Supabase conectado' : 'Supabase indisponivel';
  $('#db-host').textContent = status.host;
  $('#db-latency').textContent = status.latencyMs == null ? '-- ms' : `${Number(status.latencyMs).toFixed(1)} ms`;
  $('#db-name').textContent = status.database;
  $('#db-ssl').textContent = status.ssl ? 'SSL ATIVO' : 'SEM SSL';
  $('.db-indicator').style.background = status.online ? 'var(--accent)' : 'var(--red)';
  $('#db-table-grid').innerHTML = status.tables.map((table) => `<article class="db-table-card"><span>${escapeHtml(table.name)}</span><strong>${table.rows}</strong></article>`).join('');
  renderDatabaseUsers();
  renderDatabaseKeys();
  $('#audit-table').innerHTML = (state.database.auditLogs || []).map((entry) => `<tr><td><span class="log-level level-${entry.level.toLowerCase()}">${escapeHtml(entry.level)}</span></td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.entityType)}${entry.entityId ? ` · <code>${escapeHtml(entry.entityId.slice(0, 8))}</code>` : ''}</td><td>${escapeHtml(entry.actorName)}</td><td>${formatDate(entry.createdAt)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhuma operacao registrada.</td></tr>';
}

function renderDatabaseUsers() {
  if (!state.database) return;
  const term = $('#user-search').value.trim().toLowerCase();
  const role = $('#user-role-filter').value;
  const users = state.database.users.filter((user) =>
    (!term || user.username.toLowerCase().includes(term)) && (role === 'all' || user.role === role)
  );
  $('#users-count').textContent = `${users.length}/${state.database.users.length}`;
  $('#users-table').innerHTML = users.map((user) => `<tr><td><div class="user-cell"><span>${escapeHtml(user.username.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(user.username)}</strong></div></td><td><span class="status role-${escapeHtml(user.role)}">${escapeHtml(user.role.toUpperCase())}</span></td><td>${formatDate(user.createdAt)}</td><td><div class="row-actions"><button class="action-btn" data-user-role="${user.id}" data-current-role="${escapeHtml(user.role)}" title="Alterar permissao">Permissao</button><button class="action-btn" data-user-password="${user.id}" title="Redefinir senha">Senha</button><button class="action-btn" data-user-sessions="${user.id}" title="Encerrar todas as sessoes">Sessoes</button><button class="action-btn danger-link" data-user-delete="${user.id}" data-username="${escapeHtml(user.username)}" title="Excluir usuario">Excluir</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhum usuario encontrado.</td></tr>';
}

function renderDatabaseKeys() {
  if (!state.database) return;
  const term = $('#db-key-search').value.trim().toLowerCase();
  const keys = state.database.keys.filter((key) => !term || key.key.toLowerCase().includes(term) || key.productId.toLowerCase().includes(term));
  const totalPages = Math.max(1, Math.ceil(keys.length / view.pageSize));
  view.databaseKeyPage = Math.min(view.databaseKeyPage, totalPages);
  const start = (view.databaseKeyPage - 1) * view.pageSize;
  const page = keys.slice(start, start + view.pageSize);
  $('#db-keys-table').innerHTML = page.map((key) => { const status = effectiveStatus(key); return `<tr><td><code>${escapeHtml(key.key)}</code></td><td>${escapeHtml(key.productId)}</td><td><span class="status ${status}">${statusLabel(status)}</span></td><td>${key.activationCount}/${key.maxActivations}</td><td>${formatDate(key.createdAt)}</td><td>${formatDate(key.expiresAt)}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Nenhuma key encontrada.</td></tr>';
  $('#db-keys-page-info').textContent = keys.length ? `${start + 1}–${Math.min(start + view.pageSize, keys.length)} de ${keys.length} keys` : '0 resultados';
  $('#db-keys-prev').disabled = view.databaseKeyPage === 1;
  $('#db-keys-next').disabled = view.databaseKeyPage === totalPages;
}

function renderLicenseTable() {
  const term = $('#key-search').value.trim().toLowerCase();
  const status = $('#key-status-filter').value;
  const keys = state.keys.filter((key) =>
    (!term || key.key.toLowerCase().includes(term) || key.productId.toLowerCase().includes(term)) &&
    (status === 'all' || effectiveStatus(key) === status)
  );
  const totalPages = Math.max(1, Math.ceil(keys.length / view.pageSize));
  view.licensePage = Math.min(view.licensePage, totalPages);
  const start = (view.licensePage - 1) * view.pageSize;
  const page = keys.slice(start, start + view.pageSize);
  const rows = page.map((key) => { const currentStatus = effectiveStatus(key); return `<tr><td><input type="checkbox" data-select-key="${key.id}" ${selectedKeys.has(key.id) ? 'checked' : ''} /></td><td><code>${escapeHtml(key.key)}</code></td><td>${escapeHtml(key.productId)}</td><td><span class="status ${currentStatus}">${statusLabel(currentStatus)}</span></td><td>${key.activations.length}/${key.maxActivations}</td><td>${formatDate(key.expiresAt)}</td><td><div class="row-actions"><button class="action-btn" data-key-id="${key.id}" data-status="${['active', 'used'].includes(key.status) ? 'blocked' : 'active'}">${['active', 'used'].includes(key.status) ? 'Bloquear' : 'Ativar'}</button><button class="action-btn" data-edit-key="${key.id}">Editar</button><button class="action-btn" data-key-history="${key.id}">Historico</button><button class="action-btn danger-link" data-delete-key="${key.id}" data-key-label="${escapeHtml(key.key)}">Excluir</button></div></td></tr>`; }).join('');
  $('#keys-table').innerHTML = rows || '<tr><td colspan="7" class="empty">Nenhuma key encontrada.</td></tr>';
  $('#selected-count').textContent = selectedKeys.size;
  $('#select-page-keys').checked = page.length > 0 && page.every((key) => selectedKeys.has(key.id));
  $('#keys-page-info').textContent = keys.length ? `${start + 1}–${Math.min(start + view.pageSize, keys.length)} de ${keys.length} keys` : '0 resultados';
  $('#keys-prev').disabled = view.licensePage === 1;
  $('#keys-next').disabled = view.licensePage === totalPages;
}

function render() {
  if (state.health) {
    $('#api-environment').textContent = String(state.health.environment || 'development').toUpperCase();
    $('#api-base-url').textContent = state.health.publicUrl || window.location.origin;
    const latency = Number(state.health.database?.latencyMs ?? 0);
    $('.system-pill span').textContent = `API operacional · ${latency.toFixed(0)}ms`;
  }
  $('#total-keys').textContent = state.keys.length;
  $('#active-keys').textContent = state.keys.filter((key) => key.status === 'active' && new Date(key.expiresAt) > new Date()).length;
  $('#total-activations').textContent = state.keys.reduce((sum, key) => sum + key.activations.length, 0);
  $('#total-products').textContent = state.products.length;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  $('#keys-today').textContent = state.keys.filter((key) => new Date(key.createdAt) >= today).length;
  $('#used-keys').textContent = state.keys.filter((key) => key.status === 'used' || key.activations.length > 0).length;
  $('#expired-keys').textContent = state.keys.filter((key) => effectiveStatus(key) === 'expired').length;
  $('#blocked-keys').textContent = state.keys.filter((key) => ['blocked', 'disabled'].includes(key.status)).length;
  $('#license-total').textContent = state.keys.length;
  $('#license-active').textContent = state.keys.filter((key) => key.status === 'active' && new Date(key.expiresAt) > new Date()).length;
  $('#license-disabled').textContent = state.keys.filter((key) => ['blocked', 'disabled'].includes(key.status)).length;
  $('#license-expired').textContent = state.keys.filter((key) => new Date(key.expiresAt) <= new Date()).length;
  $('#key-product').innerHTML = state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join('');
  const bulkProduct = $('#bulk-delete-product');
  const selectedBulkProduct = bulkProduct.value || 'all';
  bulkProduct.innerHTML = `<option value="all">Todos os produtos</option>${state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join('')}`;
  if ([...bulkProduct.options].some((option) => option.value === selectedBulkProduct)) bulkProduct.value = selectedBulkProduct;
  $('#product-grid').innerHTML = state.products.map((product, index) => `<article class="product-card"><span class="product-number">0${index + 1}</span><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.description)}</p><footer><strong>R$ ${Number(product.price).toFixed(2).replace('.', ',')}</strong><code>${escapeHtml(product.id)}</code></footer></article>`).join('');

  renderLicenseTable();
  renderCharts();

  $('#recent-list').innerHTML = state.keys.slice(0, 5).map((key) => { const status = effectiveStatus(key); return `<div class="activity"><span class="activity-icon">${svgIcon('i-key')}</span><div><code>${escapeHtml(key.key)}</code><small>${escapeHtml(key.productId)} · ${formatDate(key.createdAt)}</small></div><span class="status ${status}">${statusLabel(status)}</span></div>`; }).join('') || '<p class="empty">As novas keys aparecerao aqui.</p>';
}

function renderCharts() {
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - index)); return date; });
  const totals = days.map((day) => state.keys.filter((key) => { const created = new Date(key.createdAt); return created >= day && created < new Date(day.getTime() + 86400000); }).length);
  const max = Math.max(1, ...totals);
  $('#creation-chart').innerHTML = days.map((day, index) => `<div><span style="height:${Math.max(4, totals[index] / max * 100)}%" title="${totals[index]} keys"></span><small>${day.toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0, 3)}</small></div>`).join('');
  const statuses = ['active', 'used', 'blocked', 'revoked', 'expired'];
  $('#status-chart').innerHTML = statuses.map((status) => { const count = state.keys.filter((key) => effectiveStatus(key) === status).length; const percent = state.keys.length ? count / state.keys.length * 100 : 0; return `<div><header><span>${statusLabel(status)}</span><b>${count}</b></header><i><span class="chart-${status}" style="width:${percent}%"></span></i></div>`; }).join('');
}

function navigate(target) {
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active-page', page.id === target));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.target === target));
  const names = {
    overview: 'Dashboard', 'generate-keys': 'Gerar keys', licenses: 'Licencas', products: 'Produtos',
    users: 'Usuarios', 'create-user': 'Criar usuario', logs: 'Logs e auditoria', database: 'Database'
  };
  $('#page-title').textContent = names[target];
  if (['users', 'logs', 'database'].includes(target)) loadDatabase().catch((error) => toast(error.message));
}

function logout(callApi = true) {
  if (callApi && state.token) api('/api/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  sessionStorage.removeItem('kf_token');
  $('#dashboard-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    state.token = result.token;
    sessionStorage.setItem('kf_token', result.token);
    await loadDashboard();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

$('#show-password').addEventListener('click', () => { $('#password').type = $('#password').type === 'password' ? 'text' : 'password'; });
$('#logout').addEventListener('click', () => logout());
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.target)));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
$('#key-search').addEventListener('input', () => { view.licensePage = 1; renderLicenseTable(); });
$('#key-status-filter').addEventListener('change', () => { view.licensePage = 1; renderLicenseTable(); });
$('#user-search').addEventListener('input', renderDatabaseUsers);
$('#user-role-filter').addEventListener('change', renderDatabaseUsers);
$('#db-key-search').addEventListener('input', () => { view.databaseKeyPage = 1; renderDatabaseKeys(); });
$('#keys-prev').addEventListener('click', () => { view.licensePage -= 1; renderLicenseTable(); });
$('#keys-next').addEventListener('click', () => { view.licensePage += 1; renderLicenseTable(); });
$('#db-keys-prev').addEventListener('click', () => { view.databaseKeyPage -= 1; renderDatabaseKeys(); });
$('#db-keys-next').addEventListener('click', () => { view.databaseKeyPage += 1; renderDatabaseKeys(); });
$('#refresh-database').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.classList.add('loading');
  button.disabled = true;
  try { await loadDatabase(); toast('Database atualizado'); }
  catch (error) { toast(error.message); }
  finally { button.classList.remove('loading'); button.disabled = false; }
});

$('#refresh-logs').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadDatabase(); toast('Logs atualizados'); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$('#key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const request = { productId: $('#key-product').value, days: Number($('#key-days').value), maxActivations: Number($('#key-activations').value), quantity: Number($('#key-quantity').value) };
    const started = await api('/api/keys/batch/jobs', { method: 'POST', body: JSON.stringify(request) });
    const progressBox = $('#generation-progress');
    progressBox.classList.remove('hidden');
    operationLog('INFO', `Iniciando criacao de ${request.quantity} keys...`);
    let result;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      result = await api(`/api/keys/batch/jobs/${started.jobId}`);
      const completed = result.created + result.errors;
      const percent = Math.round(completed / result.total * 100);
      $('#job-progress-bar').value = percent; $('#job-percent').textContent = `${percent}%`;
      $('#job-created').textContent = result.created; $('#job-pending').textContent = result.pending; $('#job-errors').textContent = result.errors;
      $('#job-status').textContent = result.status === 'processing' ? 'Processando lote...' : statusLabel(result.status);
      const known = Number(progressBox.dataset.events || 0);
      result.events.slice(known).forEach((entry) => operationLog(entry.level, entry.message, entry.at));
      progressBox.dataset.events = result.events.length;
      if (['completed', 'partial', 'failed'].includes(result.status)) break;
    }
    progressBox.dataset.events = '0';
    state.keys.unshift(...result.keys);
    render();
    const box = $('#generated-key');
    generatedKeysText = result.keys.map((license, index) => `${index + 1}. ${license.key}`).join('\n');
    const preview = result.keys.slice(0, 50).map((license, index) => `${index + 1}. ${license.key}`).join('\n');
    box.querySelector('pre').textContent = `${preview}${result.created > 50 ? `\n\n... mais ${result.created - 50} keys. Use Copiar ou Baixar para obter o lote completo.` : ''}`;
    box.querySelector('small').textContent = `${result.created} KEY${result.created === 1 ? '' : 'S'} CRIADA${result.created === 1 ? '' : 'S'}`;
    box.classList.remove('hidden');
    toast(`${result.created} key${result.created === 1 ? '' : 's'} criada${result.created === 1 ? '' : 's'} com sucesso`);
  } catch (error) { toast(error.message); }
});

$('#copy-generated-keys').addEventListener('click', async () => {
  await navigator.clipboard.writeText(generatedKeysText);
  toast('Keys copiadas');
});

$('#download-generated-keys').addEventListener('click', () => {
  const blob = new Blob([`${generatedKeysText}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `api-keys-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
  toast('Arquivo de keys baixado');
});

$('#keys-table').addEventListener('click', async (event) => {
  const checkbox = event.target.closest('[data-select-key]');
  if (checkbox) {
    if (checkbox.checked) selectedKeys.add(checkbox.dataset.selectKey); else selectedKeys.delete(checkbox.dataset.selectKey);
    $('#selected-count').textContent = selectedKeys.size;
    return;
  }
  const deleteButton = event.target.closest('[data-delete-key]');
  if (deleteButton) {
    if (!window.confirm(`Excluir permanentemente a key ${deleteButton.dataset.keyLabel}? Esta acao tambem apaga suas ativacoes.`)) return;
    if (window.prompt('Segunda confirmacao: digite DELETE') !== 'DELETE') return toast('Exclusao cancelada');
    deleteButton.disabled = true;
    try {
      const result = await api(`/api/admin/keys/${deleteButton.dataset.deleteKey}`, { method: 'DELETE', headers: { 'x-confirm-action': 'DELETE' } });
      state.keys = state.keys.filter((key) => key.id !== result.key.id);
      if (state.database) state.database.keys = state.database.keys.filter((key) => key.id !== result.key.id);
      render();
      if (state.database) renderDatabase();
      toast('Key excluida permanentemente');
    } catch (error) { toast(error.message); deleteButton.disabled = false; }
    return;
  }
  const editButton = event.target.closest('[data-edit-key]');
  if (editButton) {
    const key = state.keys.find((item) => item.id === editButton.dataset.editKey);
    const days = window.prompt('Renovar por quantos dias a partir de agora?', '30');
    if (days === null) return;
    const maxActivations = window.prompt('Limite de ativacoes (1-100):', String(key.maxActivations));
    if (maxActivations === null) return;
    const notes = window.prompt('Observacoes (ate 500 caracteres):', key.notes || '');
    if (notes === null) return;
    try {
      const updated = await api(`/api/admin/keys/${key.id}`, { method: 'PATCH', body: JSON.stringify({ expiresAt: new Date(Date.now() + Number(days) * 86400000).toISOString(), maxActivations: Number(maxActivations), notes }) });
      state.keys = state.keys.map((item) => item.id === updated.id ? { ...item, ...updated } : item); render(); toast('Key atualizada');
    } catch (error) { toast(error.message); }
    return;
  }
  const historyButton = event.target.closest('[data-key-history]');
  if (historyButton) {
    try {
      const history = await api(`/api/admin/keys/${historyButton.dataset.keyHistory}/history`);
      operationLog('INFO', `Historico da key: ${history.length} operacao(oes)`);
      history.slice(0, 20).reverse().forEach((item) => operationLog('INFO', `${item.action} por ${item.actorName}`, item.createdAt));
      navigate('logs');
    } catch (error) { toast(error.message); }
    return;
  }
  const button = event.target.closest('[data-key-id]');
  if (!button) return;
  try {
    const updated = await api(`/api/keys/${button.dataset.keyId}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) });
    state.keys = state.keys.map((key) => key.id === updated.id ? updated : key);
    render();
    toast('Status atualizado');
  } catch (error) { toast(error.message); }
});

$('#bulk-delete-keys').addEventListener('click', async (event) => {
  const quantity = Number($('#bulk-delete-quantity').value);
  const productId = $('#bulk-delete-product').value;
  const status = $('#bulk-delete-status').value;
  const order = $('#bulk-delete-order').value;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5000) return toast('Informe uma quantidade entre 1 e 5.000');
  const productLabel = $('#bulk-delete-product').selectedOptions[0]?.textContent || productId;
  const description = `${quantity} key(s), produto: ${productLabel}, status: ${status}, ordem: ${order === 'newest' ? 'mais recentes' : 'mais antigas'}`;
  if (!window.confirm(`ATENCAO: excluir permanentemente ${description}? As ativacoes relacionadas tambem serao apagadas.`)) return;
  if (window.prompt('Segunda confirmacao: digite DELETE') !== 'DELETE') return toast('Exclusao cancelada');
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Excluindo...';
  try {
    const result = await api('/api/admin/keys/bulk-delete', {
      method: 'POST', body: JSON.stringify({ quantity, productId, status, order, confirmation: 'DELETE' })
    });
    const removed = new Set(result.deletedIds);
    state.keys = state.keys.filter((key) => !removed.has(key.id));
    if (state.database) state.database.keys = state.database.keys.filter((key) => !removed.has(key.id));
    render();
    if (state.database) renderDatabase();
    toast(result.deletedCount ? `${result.deletedCount} key(s) excluida(s)` : 'Nenhuma key corresponde aos filtros');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Excluir selecionadas'; }
});

$('#select-page-keys').addEventListener('change', (event) => {
  document.querySelectorAll('[data-select-key]').forEach((checkbox) => {
    checkbox.checked = event.target.checked;
    if (event.target.checked) selectedKeys.add(checkbox.dataset.selectKey); else selectedKeys.delete(checkbox.dataset.selectKey);
  });
  $('#selected-count').textContent = selectedKeys.size;
});

$('#apply-selection').addEventListener('click', async () => {
  const ids = [...selectedKeys];
  const action = $('#selection-action').value;
  if (!ids.length) return toast('Selecione ao menos uma key');
  if (!window.confirm(`Aplicar "${action}" em ${ids.length} key(s)?`)) return;
  if (window.prompt('Segunda confirmacao: digite CONFIRM') !== 'CONFIRM') return toast('Operacao cancelada');
  try {
    const result = await api('/api/admin/keys/bulk-action', { method: 'POST', body: JSON.stringify({ ids, action, confirmation: 'CONFIRM' }) });
    if (action === 'delete') state.keys = state.keys.filter((key) => !result.ids.includes(key.id));
    else state.keys = state.keys.map((key) => result.items.find((item) => item.id === key.id) || key);
    selectedKeys.clear(); render(); toast(`${result.count} key(s) alterada(s)`);
  } catch (error) { toast(error.message); }
});

function downloadData(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
$('#export-json').addEventListener('click', () => downloadData(`keys-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.keys, null, 2), 'application/json'));
$('#export-csv').addEventListener('click', () => {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [['id', 'key', 'produto', 'status', 'criada', 'expira', 'ativacoes', 'limite'], ...state.keys.map((key) => [key.id, key.key, key.productId, effectiveStatus(key), key.createdAt, key.expiresAt, key.activations.length, key.maxActivations])];
  downloadData(`keys-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map(quote).join(',')).join('\n'), 'text/csv;charset=utf-8');
});

$('#clear-console').addEventListener('click', () => { consoleLines = ['[INFO] Console limpo.']; $('#operation-console').textContent = consoleLines[0]; });
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark-theme');
  localStorage.setItem('api_theme', dark ? 'dark' : 'light');
});
if (localStorage.getItem('api_theme') === 'dark') document.documentElement.classList.add('dark-theme');

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#new-username').value,
        password: $('#new-password').value,
        role: $('#new-role').value
      })
    });
    event.target.reset();
    await loadDatabase();
    navigate('users');
    toast('Usuario criado com sucesso');
  } catch (error) { toast(error.message); }
});

$('#users-table').addEventListener('click', async (event) => {
  const roleButton = event.target.closest('[data-user-role]');
  const passwordButton = event.target.closest('[data-user-password]');
  const sessionsButton = event.target.closest('[data-user-sessions]');
  const deleteButton = event.target.closest('[data-user-delete]');
  try {
    if (roleButton) {
      const role = window.prompt('Nova permissao: admin, operator ou customer', roleButton.dataset.currentRole);
      if (role === null) return;
      if (!['admin', 'operator', 'customer'].includes(role.trim().toLowerCase())) return toast('Permissao invalida');
      await api(`/api/admin/users/${roleButton.dataset.userRole}/role`, { method: 'PATCH', body: JSON.stringify({ role: role.trim().toLowerCase() }) });
      await loadDatabase();
      toast('Permissao alterada; sessoes anteriores encerradas');
    } else if (passwordButton) {
      const password = window.prompt('Digite a nova senha (6 a 128 caracteres):');
      if (password === null) return;
      if (password.length < 6 || password.length > 128) return toast('A senha deve ter entre 6 e 128 caracteres');
      await api(`/api/admin/users/${passwordButton.dataset.userPassword}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
      await loadDatabase();
      toast('Senha redefinida; sessoes anteriores encerradas');
    } else if (sessionsButton) {
      if (!window.confirm('Encerrar todas as sessoes ativas deste usuario?')) return;
      const result = await api(`/api/admin/users/${sessionsButton.dataset.userSessions}/revoke-sessions`, { method: 'POST' });
      toast(`${result.revokedCount} sessao(oes) encerrada(s)`);
    } else if (deleteButton) {
      if (!window.confirm(`Excluir permanentemente o usuario ${deleteButton.dataset.username}?`)) return;
      await api(`/api/admin/users/${deleteButton.dataset.userDelete}`, { method: 'DELETE' });
      await loadDatabase();
      toast('Usuario excluido');
    }
  } catch (error) { toast(error.message); }
});

if (state.token) loadDashboard();
