import { log } from './log.js';
import { createDatabase, verifyDatabase } from './database.js';
import { Client, GatewayIntentBits, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { Store } from './mysql-store.js';
import { createApi } from './api.js';
import { resultMessage } from './commands.js';
const c = config();
const pool = createDatabase();
try { const state = await verifyDatabase(pool); if (!state.schemaReady) throw new Error('Execute schema.sql no defaultdb antes de iniciar o bot.'); if (!state.steamReady) throw new Error('Execute npm run db:migrate antes de iniciar o bot.'); } catch (error) { await pool.end(); console.error(error.code || error.message); process.exit(1); }
const store = new Store(pool, c.ttl);
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
let channel, flushing = false;
async function flush() {
  if (!channel || flushing) return;
  flushing = true;
  try {
    for (const row of await store.pending()) {
      const msg = await channel.send({ ...resultMessage(row), allowedMentions: { parse: [] }, nonce: row.createdAt.toString() + row.pin, enforceNonce: true });
      await store.delivered(row.pin, msg.id);
      log('discord.delivered',{pin:row.pin,messageId:msg.id,steamCount:row.result.steam?.accounts.length||0});
    }
  } catch(error) { log('discord.delivery_pending',{retry:true,code:error.code||error.name}); }
  finally { flushing = false; }
}
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    const allowed = interaction.guildId === c.guildId && (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || (c.roleId && interaction.member.roles.cache.has(c.roleId)));
    if (!allowed) return await interaction.reply({ content: 'Comando disponível somente para a equipe autorizada.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'pin') {
      const row = await store.create(interaction.user.id, interaction.options.getUser('usuario', true).id);
      await interaction.editReply({ content: `PIN: **${row.pin}**\nValidade: <t:${Math.floor(row.expiresAt / 1000)}:R>. Uso único. Entregue este PIN ao usuário para digitar no scanner.`, flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === 'resultado') {
      const row = await store.get(interaction.options.getString('pin', true));
      await interaction.editReply(row?.result ? { ...resultMessage(row), flags: MessageFlags.Ephemeral } : { content: !row ? 'PIN não encontrado.' : row.expiresAt <= Date.now() ? 'PIN expirado sem resultado.' : 'Aguardando o scanner enviar o resultado.', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    const message = error.message?.startsWith('Você já tem') ? error.message : 'Não foi possível concluir o comando. Tente novamente.';
    try { if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message }); else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }); else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }); } catch { console.error('Falha ao responder ao comando.'); }
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
    const timer = setInterval(flush, 15_000); await flush();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(); client.destroy(); void pool.end(); });
  } catch (error) { console.error(error.message); client.destroy(); await pool.end(); process.exitCode = 1; }
});
client.on(Events.Error, () => console.error('Erro na conexão do Discord.'));
try { await client.login(c.token); } catch { console.error("Falha ao conectar ao Discord. Confira o token."); await pool.end(); process.exitCode=1; }
