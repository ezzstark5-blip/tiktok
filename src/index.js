import { Client, GatewayIntentBits, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { Store } from './store.js';
import { createApi } from './api.js';
import { summaryEmbed } from './commands.js';

const c = config();
if (!c.token || !c.clientId || !c.guildId || !c.channelId) { console.error('Preencha DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID e RESULT_CHANNEL_ID no .env.'); process.exit(1); }
const store = new Store(c.dataFile, c.ttl);
await store.load();
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
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

async function flush() {
  if (!channel || flushing) return;
  flushing = true;
  try {
    for (const row of await store.pending()) {
      try {
        const ids = [];
        if (row.result.embeds?.length) {
          for (const part of chunkEmbeds(row.result.embeds)) {
            const msg = await channel.send({ content: `<@${row.targetId}>`, embeds: part, allowedMentions: { users: [row.targetId] }, nonce: `${row.createdAt}${row.pin}${ids.length}`, enforceNonce: true });
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

client.on(Events.InteractionCreate, async interaction => {
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
    } else if (interaction.commandName === 'resultado') {
      const row = await store.get(interaction.options.getString('pin', true));
      if (!row) return await interaction.editReply({ content: 'PIN não encontrado.' });
      if (!row.result) return await interaction.editReply({ content: row.expiresAt <= Date.now() ? 'PIN expirado sem resultado.' : 'Aguardando o scanner enviar o resultado.' });
      await interaction.editReply({ embeds: [summaryEmbed(row)] });
    }
  } catch (error) {
    const message = error.message?.startsWith('Você já tem') ? error.message : 'Não foi possível concluir o comando. Tente novamente.';
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
    await flush();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(); client.destroy(); });
  } catch (error) { console.error(error.message); client.destroy(); process.exitCode = 1; }
});
client.on(Events.Error, () => console.error('Erro na conexão do Discord.'));
try { await client.login(c.token); } catch { console.error('Falha ao conectar ao Discord. Confira o token.'); process.exitCode = 1; }
