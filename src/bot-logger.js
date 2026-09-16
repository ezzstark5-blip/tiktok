const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags, SeparatorSpacingSize
} = require('discord.js');
const { getMeta, setMeta } = require('./database');

let botClient = null;
const queues = new Map();
const apiRoutes = new Map();
let apiUpdateTimer = null;
const channels = {
  api: () => process.env.DISCORD_CHANNEL_STATUS_API,
  keys: () => process.env.DISCORD_CHANNEL_KEYS,
  users: () => process.env.DISCORD_CHANNEL_USERS,
  database: () => process.env.DISCORD_CHANNEL_DATABASE
};

function clean(value, limit = 900) {
  return String(value ?? '—').replace(/@/g, '@\u200b').replace(/```/g, "'''").slice(0, limit);
}

function timestamp() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function card(title, body, footer = 'API • Log automatico') {
  return new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${clean(title)}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(clean(body, 3500)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${clean(footer)} • ${timestamp()}`));
}

function enqueue(channelId, task) {
  const next = (queues.get(channelId) || Promise.resolve()).then(task)
    .catch((error) => console.error('[Bot Logs]', error.message));
  queues.set(channelId, next);
  return next;
}

async function getChannel(kind) {
  if (!botClient) return null;
  const channelId = channels[kind]?.();
  if (!channelId) return null;
  const channel = await botClient.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error(`Canal ${kind} (${channelId}) nao aceita mensagens.`);
  return channel;
}

async function send(kind, title, body) {
  const channelId = channels[kind]?.();
  if (!botClient || !channelId) return false;
  return enqueue(channelId, async () => {
    const channel = await getChannel(kind);
    await channel.send({ components: [card(title, body)], flags: MessageFlags.IsComponentsV2 });
    return true;
  });
}

async function upsert(kind, title, body) {
  const channelId = channels[kind]?.();
  if (!botClient || !channelId) return false;
  return enqueue(channelId, async () => {
    const channel = await getChannel(kind);
    const metaKey = `discord_bot_${kind}_message_id`;
    let messageId = await getMeta(metaKey);
    const data = { components: [card(title, body, 'API • Painel atualizado automaticamente')], flags: MessageFlags.IsComponentsV2 };
    if (messageId) {
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit(data);
        return true;
      } catch (error) {
        if (error.code !== 10008) throw error;
        messageId = null;
      }
    }
    const message = await channel.send(data);
    await setMeta(metaKey, message.id);
    return true;
  });
}

function attachBotClient(client) { botClient = client; }

function updateApiStatus({ online = true, port, baseUrl }) {
  const uptime = Math.floor(process.uptime());
  const routes = [...apiRoutes.values()];
  const routeLines = routes.length
    ? routes.map((item) => {
      const icon = item.status >= 500 ? '🔴' : item.status >= 300 ? '🟡' : '🟢';
      return `${icon} **${clean(item.method)}** \`${clean(item.route)}\` — HTTP ${item.status} • ${item.durationMs.toFixed(1)}ms`;
    }).join('\n')
    : '🟡 Aguardando as primeiras requisicoes.';
  return upsert('api', `${online ? '🟢' : '🔴'} STATUS DA API`,
    `**Estado**\n\`${online ? 'OPERACIONAL' : 'INDISPONIVEL'}\`\n\n` +
    `**Endpoint**\n\`${clean(baseUrl || `http://localhost:${port}`)}\`\n\n` +
    `**Porta**\n\`${clean(port)}\`\n\n` +
    `**Uptime**\n\`${uptime}s\`\n\n` +
    `**Status por rota**\n${routeLines}`);
}

function recordApiRequest({ method, route, status, durationMs }) {
  apiRoutes.set(`${method} ${route}`, { method, route, status, durationMs });
  if (apiRoutes.size > 15) apiRoutes.delete(apiRoutes.keys().next().value);
  clearTimeout(apiUpdateTimer);
  apiUpdateTimer = setTimeout(() => {
    updateApiStatus({ online: true, port: process.env.PORT || 3000, baseUrl: process.env.PUBLIC_URL });
  }, 750);
  apiUpdateTimer.unref();
}

function updateDatabaseStatus(status) {
  const tableLines = (status.tables || []).map((table) => `• \`${clean(table.name)}\` — **${table.rows}** registros`).join('\n');
  return upsert('database', `${status.online ? '🟢' : '🔴'} STATUS DA DATABASE`,
    `**Provedor**\n\`${clean(status.engine || 'PostgreSQL')}\`\n\n` +
    `**Estado**\n\`${status.online ? 'CONECTADA' : 'INDISPONIVEL'}\`\n\n` +
    `**Latencia**\n\`${Number(status.latencyMs || 0).toFixed(1)} ms\`\n\n` +
    `**SSL**\n\`${status.ssl === false ? 'DESATIVADO' : 'ATIVO'}\`\n\n` +
    `**Tabelas**\n${tableLines || 'Nenhuma informacao disponivel.'}`);
}

function logKey(action, license, actor = 'sistema') {
  return send('keys', '🔑 LOG DE KEY',
    `**Evento**\n\`${clean(action)}\`\n\n` +
    `**Key**\n\`${clean(license.key || license.licenseKey || 'nao informada')}\`\n\n` +
    `**Produto**\n\`${clean(license.productId)}\`\n\n` +
    `**Status**\n\`${clean(license.status || 'active')}\`\n\n` +
    `**Responsavel**\n\`${clean(actor)}\``);
}

function logKeyBatch(action, licenses, actor = 'sistema') {
  const first = licenses[0] || {};
  const preview = licenses.slice(0, 20);
  const keyList = preview.map((license, index) => `${index + 1}. \`${clean(license.key)}\``).join('\n');
  const remaining = licenses.length > preview.length ? `\n-# ... e mais ${licenses.length - preview.length} keys no arquivo entregue ao solicitante.` : '';
  return send('keys', '🔑 LOTE DE KEYS',
    `**Evento**\n\`${clean(action)}\`\n\n` +
    `**Quantidade**\n\`${licenses.length}\`\n\n` +
    `**Produto**\n\`${clean(first.productId)}\`\n\n` +
    `**Responsavel**\n\`${clean(actor)}\`\n\n` +
    `**Preview das keys**\n${keyList}${remaining}`);
}

function logUser(action, user, actor = 'sistema') {
  return send('users', '👤 LOG DE USUARIO',
    `**Evento**\n\`${clean(action)}\`\n\n` +
    `**Usuario**\n\`${clean(user.username)}\`\n\n` +
    `**Permissao**\n\`${clean(user.role || 'customer')}\`\n\n` +
    `**Responsavel**\n\`${clean(actor)}\``);
}

module.exports = { attachBotClient, updateApiStatus, updateDatabaseStatus, recordApiRequest, logKey, logKeyBatch, logUser };
