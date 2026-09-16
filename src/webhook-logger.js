const fs = require('node:fs/promises');
const path = require('node:path');
const { getMeta, setMeta } = require('./database');

const COMPONENTS_V2_FLAG = 1 << 15;
const WHITE = 0xFFFFFF;
const STATE_FILE = path.join(__dirname, '..', 'data', 'webhook-status.json');
const API_ROUTES = [
  ['GET', '/api/health'], ['POST', '/api/login'], ['POST', '/api/logout'],
  ['GET', '/api/products'], ['GET', '/api/keys'], ['POST', '/api/keys'],
  ['PATCH', '/api/keys/:id/status'], ['POST', '/api/licenses/validate'],
  ['POST', '/api/client/query'], ['GET', '/api/admin/database'],
  ['POST', '/api/admin/users'], ['POSTGRES', 'supabase']
];

const keyOf = (method, route) => `${String(method).toUpperCase()} ${route}`;
const defaults = () => Object.fromEntries(API_ROUTES.map(([method, route]) => [keyOf(method, route), {
  method, route, status: null, durationMs: null, updatedAt: null
}]));

function statusInfo(status) {
  if (status === null) return ['🟡', 'AGUARDANDO'];
  if (status >= 500) return ['🔴', 'ERRO'];
  if (status >= 300) return ['🟡', status >= 400 ? 'ATENCAO' : 'REDIRECIONADA'];
  return ['🟢', 'ONLINE'];
}

function safe(value) {
  return String(value ?? '—').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1').replace(/@/g, '@\u200b');
}

function payload(state, port) {
  const items = Object.values(state.routes);
  const formatLine = (item) => {
    const [icon, label] = statusInfo(item.status);
    const code = item.status === null ? '---' : item.status;
    const speed = item.durationMs === null ? '---' : `${item.durationMs.toFixed(1)}ms`;
    const codeLabel = item.method === 'POSTGRES' ? (item.status === 200 ? 'CONECTADO' : label) : `HTTP ${code}`;
    return `${icon} **${safe(item.method)}** \`${safe(item.route)}\`\n-# ${codeLabel} • ${speed}`;
  };
  const apiLines = items.filter((item) => item.method !== 'POSTGRES').map(formatLine);
  const databaseLines = items.filter((item) => item.method === 'POSTGRES').map(formatLine);
  const overall = items.some((item) => item.status >= 500)
    ? '🔴 ERRO DETECTADO'
    : items.some((item) => item.status === null || item.status >= 300)
      ? '🟡 MONITORANDO'
      : '🟢 TODOS OS SISTEMAS OPERACIONAIS';
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return {
    flags: COMPONENTS_V2_FLAG,
    components: [{
      type: 17,
      accent_color: WHITE,
      components: [
        { type: 10, content: `# ${overall}\n-# KeyForge API • Porta ${safe(port)}` },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: `## Status das rotas\n${apiLines.join('\n\n')}` },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: `## Database\n${databaseLines.join('\n\n')}` },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: `-# Ultima atualizacao: ${now} • Mensagem atualizada automaticamente.` }
      ]
    }]
  };
}

class WebhookLogger {
  constructor(url) {
    this.url = String(url || '').trim();
    this.enabled = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(this.url);
    this.port = process.env.PORT || 3000;
    this.state = { messageId: null, routes: defaults() };
    this.queue = Promise.resolve();
    this.ready = Promise.resolve();
  }

  async initializePersistentState() {
    try {
      let raw = await getMeta('discord_webhook_status');
      if (!raw) raw = await fs.readFile(STATE_FILE, 'utf8').catch(() => null);
      if (!raw) return;
      const stored = JSON.parse(raw);
      this.state.messageId = stored.messageId || null;
      this.state.routes = { ...defaults(), ...(stored.routes || {}) };
    } catch (error) {
      console.error('[Webhook] Estado invalido:', error.message);
    }
  }

  async save() {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    const serialized = JSON.stringify(this.state);
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, STATE_FILE);
    await setMeta('discord_webhook_status', serialized);
  }

  enqueue(change) {
    if (!this.enabled) return Promise.resolve(false);
    this.queue = this.queue.then(() => this.ready).then(change).then(() => this.publish()).catch((error) => {
      console.error('[Webhook] Falha ao atualizar painel:', error.message);
      return false;
    });
    return this.queue;
  }

  async fetchDiscord(url, options, attempt = 0) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    if (response.status === 429 && attempt < 2) {
      const body = await response.json().catch(() => ({}));
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(body.retry_after || 1) * 1000, 15000)));
      return this.fetchDiscord(url, options, attempt + 1);
    }
    return response;
  }

  async publish() {
    const body = JSON.stringify(payload(this.state, this.port));
    const joiner = this.url.includes('?') ? '&' : '?';
    if (this.state.messageId) {
      const edited = await this.fetchDiscord(`${this.url}/messages/${this.state.messageId}${joiner}with_components=true`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
      });
      if (edited.ok) { await this.save(); return true; }
      if (edited.status !== 404) throw new Error(`Discord respondeu ${edited.status}: ${(await edited.text()).slice(0, 250)}`);
      this.state.messageId = null;
    }
    const created = await this.fetchDiscord(`${this.url}${joiner}with_components=true&wait=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    if (!created.ok) throw new Error(`Discord respondeu ${created.status}: ${(await created.text()).slice(0, 250)}`);
    this.state.messageId = (await created.json()).id;
    await this.save();
    console.log(`[Webhook] Painel unico criado: ${this.state.messageId}`);
    return true;
  }

  apiRequest({ method, route, status, durationMs }) {
    return this.enqueue(async () => {
      const key = keyOf(method, route);
      this.state.routes[key] = {
        ...(this.state.routes[key] || { method, route }), status, durationMs, updatedAt: new Date().toISOString()
      };
    });
  }

  databaseStatus({ online, latencyMs }) {
    return this.enqueue(async () => {
      const key = keyOf('POSTGRES', 'supabase');
      this.state.routes[key] = {
        method: 'POSTGRES', route: 'supabase', status: online ? 200 : 500,
        durationMs: latencyMs ?? null, updatedAt: new Date().toISOString()
      };
    });
  }

  systemOnline(port) {
    this.port = port;
    return this.enqueue(async () => {});
  }
}

module.exports = { WebhookLogger };
