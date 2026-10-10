import { Client, GatewayIntentBits, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { Store } from './store.js';
import { createApi } from './api.js';
import { summaryEmbed, panelComponents, panelEmbed, pinModal, resultModal, panelV2 } from './commands.js';

const c = config();
if (!c.token || !c.clientId || !c.guildId || !c.channelId) { console.error('Preencha DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID e RESULT_CHANNEL_ID no .env.'); process.exit(1); }
const store = new Store(c.dataFile, c.ttl);
await store.load();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: { parse: [] } });
let channel = null, flushing = false;

function chunkEmbeds(embeds) {
  const out = [];
  let cur = [], size = 0;
  const part = (e) => JSON.stringify(e).length;
  for (const e of embeds ?? []) {
    const s = part(e);
    if (cur.length >= 10 || size + s > 5500) { out.push(cur); cur = []; size = 0; }
    cur.push(e); size += s;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

async function ensurePanel(force) {
  try {
    const pid = c.panelChannelId || c.channelId;
    let ch = null;
    try { ch = await client.channels.fetch(pid); } catch { return; }
    if (!ch?.isTextBased || !ch.isTextBased()) return;
    const saved = await store.getPanel();
    if (!force && saved && saved.channelId === pid && saved.messageId) {
      try { const msg = await ch.messages.fetch(saved.messageId); await msg.edit({ components: panelV2(), flags: MessageFlags.IsComponentsV2 }); return; } catch {}
    }
    const msg = await ch.send({ components: panelV2(), flags: MessageFlags.IsComponentsV2 });
    await store.setPanel(pid, msg.id);
  } catch (e) { console.error('Painel:', e.message); }
}
async function flush() {
  if (!channel || flushing) return;
  flushing = true;
  try {
    for (const row of await store.pending()) {
      try {
        const ids = [];
        if (row.result.embeds?.length) {
          for (const part of chunkEmbeds(row.result.embeds)) {
            const msg = await channel.send({ content: row.targetId ? `<@${row.targetId}>` : `PIN ${row.pin}`, embeds: part, allowedMentions: { users: [row.targetId] }, nonce: `${row.createdAt}${row.pin}${ids.length}`, enforceNonce: true });
            ids.push(msg.id);
          }
        } else {
          const msg = await channel.send({ embeds: [summaryEmbed(row)], allowedMentions: { parse: [] }, nonce: `${row.createdAt}${row.pin}`, enforceNonce: true });
          ids.push(msg.id);
        }
        for (const text of row.result.log ?? []) {
          const msg = await channel.send({ content: text, allowedMentions: { parse: [] } });
          ids.push(msg.id);
        }
        await store.delivered(row.pin, ids);
      } catch (error) {
        console.error('Envio ao Discord pendente; nova tentativa em 20 segundos.', error.code ?? error.message);
        break;
      }
    }
  } finally { flushing = false; }
}

client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild || message.author?.bot) return;
    const m = (message.content ?? '').trim().match(/^\+clear\s+(\d{1,3})\s*$/i);
    if (!m) return;
    let member = message.member;
    try { if (!member) member = await message.guild.members.fetch(message.author.id); } catch {}
    const allowed = member?.permissions?.has(PermissionFlagsBits.ManageGuild) || (c.roleId && member?.roles.cache.has(c.roleId));
    if (!allowed) return;
    const n = Math.max(1, Math.min(100, parseInt(m[1], 10)));
    const fetched = await message.channel.messages.fetch({ limit: n });
    if (fetched.size > 0) await message.channel.bulkDelete(fetched, true);
    const conf = await message.channel.send(`Apagadas ${fetched.size} mensagens.`);
    setTimeout(() => { conf.delete().catch(() => {}); }, 5000);
  } catch (e) { console.error('clear:', e.message); }
});
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton()) {
    try {
      const allowedBtn = interaction.guildId === c.guildId && (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || (c.roleId && interaction.member.roles.cache.has(c.roleId)));
      if (!allowedBtn) return await interaction.reply({ content: 'Somente para a equipe autorizada.', flags: MessageFlags.Ephemeral });
      if (interaction.customId === 'genpin') {
        try {
          const row = await store.create(interaction.user.id, null);
          console.log(`pin gerado=${row.pin} avulso por=${interaction.user.id} (botao)`);
          return await interaction.reply({ content: `PIN: **${row.pin}**\nValidade: <t:${Math.floor(row.expiresAt / 1000)}:R>. Uso único.`, flags: MessageFlags.Ephemeral });
        } catch (e) { return await interaction.reply({ content: e.message ?? 'Não foi possível gerar.', flags: MessageFlags.Ephemeral }); }
      }
      if (interaction.customId === 'getresult') return await interaction.showModal(resultModal());
    } catch { try { await interaction.reply({ content: 'Não foi possível abrir.', flags: MessageFlags.Ephemeral }); } catch {} }
    return;
  }
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId === 'modal-pin') {
        const raw = (interaction.fields.getTextInputValue('usuario') ?? '').trim();
        const m = raw.match(/\d{17,20}/);
        if (!m) return await interaction.reply({ content: 'Informe um ID ou menção válida.', flags: MessageFlags.Ephemeral });
        const row = await store.create(interaction.user.id, m[0]);
        console.log(`pin gerado=${row.pin} alvo=${m[0]} por=${interaction.user.id} (modal)`);
        return await interaction.reply({ content: `PIN: **${row.pin}** para <@${m[0]}>\nValidade: <t:${Math.floor(row.expiresAt / 1000)}:R>. Uso único.`, flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'modal-result') {
        const pin = (interaction.fields.getTextInputValue('pin') ?? '').trim();
        const row = await store.get(pin);
        if (!row) return await interaction.reply({ content: 'PIN não encontrado.', flags: MessageFlags.Ephemeral });
        if (!row.result) return await interaction.reply({ content: row.expiresAt <= Date.now() ? 'PIN expirado sem resultado.' : 'Aguardando o scanner enviar o resultado.', flags: MessageFlags.Ephemeral });
        return await interaction.reply({ embeds: [summaryEmbed(row)], flags: MessageFlags.Ephemeral });
      }
    } catch { try { await interaction.reply({ content: 'Não foi possível concluir.', flags: MessageFlags.Ephemeral }); } catch {} }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    const allowed = interaction.guildId === c.guildId && (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || (c.roleId && interaction.member.roles.cache.has(c.roleId)));
    if (!allowed) return await interaction.reply({ content: 'Comando disponível somente para a equipe autorizada.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'pin') {
      const target = interaction.options.getUser('usuario', true);
      const row = await store.create(interaction.user.id, target.id);
      console.log(`pin gerado=${row.pin} alvo=${target.id}(${target.tag}) por=${interaction.user.id}`);
      await interaction.editReply({ content: `PIN: **${row.pin}**\nValidade: <t:${Math.floor(row.expiresAt / 1000)}:R>. Uso único. Entregue este PIN ao usuário para digitar no scanner.` });
    } else if (interaction.commandName === 'painel') { await ensurePanel(true); await interaction.editReply({ content: 'Painel publicado.' }); } else if (interaction.commandName === 'resultado') {
      const row = await store.get(interaction.options.getString('pin', true));
      if (!row) return await interaction.editReply({ content: 'PIN não encontrado.' });
      if (!row.result) return await interaction.editReply({ content: row.expiresAt <= Date.now() ? 'PIN expirado sem resultado.' : 'Aguardando o scanner enviar o resultado.' });
      await interaction.editReply({ embeds: [summaryEmbed(row)] });
    }
  } catch (error) {
    const message = (error.message?.startsWith('Você já tem') || error.message?.startsWith('Aguarde')) ? error.message : 'Não foi possível concluir o comando. Tente novamente.';
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message });
      else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch { console.error('Falha ao responder ao comando.'); }
  }
});

client.once(Events.ClientReady, async () => {
  try {
    channel = await client.channels.fetch(c.channelId);
    if (!channel?.isTextBased() || channel.guildId !== c.guildId || !channel.send) throw new Error('Canal de resultados inválido.');
    const perms = channel.permissionsFor(client.user);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Bot precisa Ver Canal, Enviar Mensagens e Inserir Links no canal.');
    const server = createApi(store);
    server.on('error', () => { console.error('Não foi possível iniciar a API. Confira HOST e PORT.'); process.exit(1); });
    server.listen(c.port, c.host, () => console.log(`Bot conectado. API em ${c.host}:${c.port}.`));
    const timer = setInterval(flush, 20_000);
    await ensurePanel(false);
    await flush();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(); client.destroy(); });
  } catch (error) { console.error(error.message); client.destroy(); process.exitCode = 1; }
});
client.on(Events.Error, () => console.error('Erro na conexão do Discord.'));
try { await client.login(c.token); } catch { console.error('Falha ao conectar ao Discord. Confira o token.'); process.exitCode = 1; }
