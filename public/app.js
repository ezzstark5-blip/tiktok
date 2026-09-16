const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem('kf_token'), products: [], keys: [], database: null, health: null };
const view = { licensePage: 1, databaseKeyPage: 1, pageSize: 25 };
let generatedKeysText = '';

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

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

async function loadDashboard() {
  try {
    [state.products, state.keys, state.health] = await Promise.all([api('/api/products'), api('/api/keys'), api('/api/health')]);
    render();
    $('#login-view').classList.add('hidden');
    $('#dashboard-view').classList.remove('hidden');
    loadDatabase().catch(() => {});
  } catch {
    logout(false);
  }
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
  $('#db-latency').textContent = `${status.latencyMs.toFixed(1)} ms`;
  $('#db-name').textContent = status.database;
  $('#db-ssl').textContent = status.ssl ? 'SSL ATIVO' : 'SEM SSL';
  $('.db-indicator').style.background = status.online ? 'var(--accent)' : 'var(--red)';
  $('#db-table-grid').innerHTML = status.tables.map((table) => `<article class="db-table-card"><span>${escapeHtml(table.name)}</span><strong>${table.rows}</strong></article>`).join('');
  renderDatabaseUsers();
  renderDatabaseKeys();
}

function renderDatabaseUsers() {
  if (!state.database) return;
  const term = $('#user-search').value.trim().toLowerCase();
  const role = $('#user-role-filter').value;
  const users = state.database.users.filter((user) =>
    (!term || user.username.toLowerCase().includes(term)) && (role === 'all' || user.role === role)
  );
  $('#users-count').textContent = `${users.length}/${state.database.users.length}`;
  $('#users-table').innerHTML = users.map((user) => `<tr><td><div class="user-cell"><span>${escapeHtml(user.username.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(user.username)}</strong></div></td><td><span class="status role-${escapeHtml(user.role)}">${escapeHtml(user.role.toUpperCase())}</span></td><td>${formatDate(user.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nenhum usuario encontrado.</td></tr>';
}

function renderDatabaseKeys() {
  if (!state.database) return;
  const term = $('#db-key-search').value.trim().toLowerCase();
  const keys = state.database.keys.filter((key) => !term || key.key.toLowerCase().includes(term) || key.productId.toLowerCase().includes(term));
  const totalPages = Math.max(1, Math.ceil(keys.length / view.pageSize));
  view.databaseKeyPage = Math.min(view.databaseKeyPage, totalPages);
  const start = (view.databaseKeyPage - 1) * view.pageSize;
  const page = keys.slice(start, start + view.pageSize);
  $('#db-keys-table').innerHTML = page.map((key) => `<tr><td><code>${escapeHtml(key.key)}</code></td><td>${escapeHtml(key.productId)}</td><td><span class="status ${key.status}">${key.status === 'active' ? 'ATIVA' : 'BLOQUEADA'}</span></td><td>${key.activationCount}/${key.maxActivations}</td><td>${formatDate(key.createdAt)}</td><td>${formatDate(key.expiresAt)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhuma key encontrada.</td></tr>';
  $('#db-keys-page-info').textContent = keys.length ? `${start + 1}–${Math.min(start + view.pageSize, keys.length)} de ${keys.length} keys` : '0 resultados';
  $('#db-keys-prev').disabled = view.databaseKeyPage === 1;
  $('#db-keys-next').disabled = view.databaseKeyPage === totalPages;
}

function renderLicenseTable() {
  const term = $('#key-search').value.trim().toLowerCase();
  const status = $('#key-status-filter').value;
  const keys = state.keys.filter((key) =>
    (!term || key.key.toLowerCase().includes(term) || key.productId.toLowerCase().includes(term)) &&
    (status === 'all' || key.status === status)
  );
  const totalPages = Math.max(1, Math.ceil(keys.length / view.pageSize));
  view.licensePage = Math.min(view.licensePage, totalPages);
  const start = (view.licensePage - 1) * view.pageSize;
  const page = keys.slice(start, start + view.pageSize);
  const rows = page.map((key) => `<tr><td><code>${escapeHtml(key.key)}</code></td><td>${escapeHtml(key.productId)}</td><td><span class="status ${key.status}">${key.status === 'active' ? 'ATIVA' : 'BLOQUEADA'}</span></td><td>${key.activations.length}/${key.maxActivations}</td><td>${formatDate(key.expiresAt)}</td><td><button class="action-btn" data-key-id="${key.id}" data-status="${key.status === 'active' ? 'disabled' : 'active'}">${key.status === 'active' ? 'Bloquear' : 'Ativar'}</button></td></tr>`).join('');
  $('#keys-table').innerHTML = rows || '<tr><td colspan="6" class="empty">Nenhuma key encontrada.</td></tr>';
  $('#keys-page-info').textContent = keys.length ? `${start + 1}–${Math.min(start + view.pageSize, keys.length)} de ${keys.length} keys` : '0 resultados';
  $('#keys-prev').disabled = view.licensePage === 1;
  $('#keys-next').disabled = view.licensePage === totalPages;
}

function render() {
  if (state.health) {
    $('#api-environment').textContent = String(state.health.environment || 'development').toUpperCase();
    $('#api-base-url').textContent = state.health.publicUrl || window.location.origin;
    $('.system-pill span').textContent = `API operacional · ${state.health.database.latencyMs.toFixed(0)}ms`;
  }
  $('#total-keys').textContent = state.keys.length;
  $('#active-keys').textContent = state.keys.filter((key) => key.status === 'active' && new Date(key.expiresAt) > new Date()).length;
  $('#total-activations').textContent = state.keys.reduce((sum, key) => sum + key.activations.length, 0);
  $('#total-products').textContent = state.products.length;
  $('#license-total').textContent = state.keys.length;
  $('#license-active').textContent = state.keys.filter((key) => key.status === 'active' && new Date(key.expiresAt) > new Date()).length;
  $('#license-disabled').textContent = state.keys.filter((key) => key.status === 'disabled').length;
  $('#license-expired').textContent = state.keys.filter((key) => new Date(key.expiresAt) <= new Date()).length;
  $('#key-product').innerHTML = state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join('');
  $('#product-grid').innerHTML = state.products.map((product, index) => `<article class="product-card"><span class="product-number">0${index + 1}</span><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.description)}</p><footer><strong>R$ ${Number(product.price).toFixed(2).replace('.', ',')}</strong><code>${escapeHtml(product.id)}</code></footer></article>`).join('');

  renderLicenseTable();

  $('#recent-list').innerHTML = state.keys.slice(0, 5).map((key) => `<div class="activity"><span class="activity-icon">${svgIcon('i-key')}</span><div><code>${escapeHtml(key.key)}</code><small>${escapeHtml(key.productId)} · ${formatDate(key.createdAt)}</small></div><span class="status ${key.status}">${key.status === 'active' ? 'ATIVA' : 'OFF'}</span></div>`).join('') || '<p class="empty">As novas keys aparecerao aqui.</p>';
}

function navigate(target) {
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active-page', page.id === target));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.target === target));
  const names = { overview: 'Visao geral', products: 'Produtos', licenses: 'Licencas', database: 'Database' };
  $('#page-title').textContent = names[target];
  if (target === 'database') loadDatabase().catch((error) => toast(error.message));
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

$('#key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/keys/batch', { method: 'POST', body: JSON.stringify({ productId: $('#key-product').value, days: Number($('#key-days').value), maxActivations: Number($('#key-activations').value), quantity: Number($('#key-quantity').value) }) });
    state.keys.unshift(...result.keys);
    render();
    const box = $('#generated-key');
    generatedKeysText = result.keys.map((license, index) => `${index + 1}. ${license.key}`).join('\n');
    const preview = result.keys.slice(0, 50).map((license, index) => `${index + 1}. ${license.key}`).join('\n');
    box.querySelector('pre').textContent = `${preview}${result.quantity > 50 ? `\n\n... mais ${result.quantity - 50} keys. Use Copiar ou Baixar para obter o lote completo.` : ''}`;
    box.querySelector('small').textContent = `${result.quantity} KEY${result.quantity === 1 ? '' : 'S'} CRIADA${result.quantity === 1 ? '' : 'S'}`;
    box.classList.remove('hidden');
    toast(`${result.quantity} key${result.quantity === 1 ? '' : 's'} criada${result.quantity === 1 ? '' : 's'} com sucesso`);
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
  const button = event.target.closest('[data-key-id]');
  if (!button) return;
  try {
    const updated = await api(`/api/keys/${button.dataset.keyId}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) });
    state.keys = state.keys.map((key) => key.id === updated.id ? updated : key);
    render();
    toast('Status atualizado');
  } catch (error) { toast(error.message); }
});

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
    toast('Usuario criado com sucesso');
  } catch (error) { toast(error.message); }
});

if (state.token) loadDashboard();
