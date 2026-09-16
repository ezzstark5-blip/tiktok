const {
  Client, ContainerBuilder, TextDisplayBuilder, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, AttachmentBuilder, FileBuilder
} = require('discord.js');
const { createKeys, listProducts } = require('./licenses');
const { createUser } = require('./users');
const { attachBotClient, logKeyBatch, logUser } = require('./bot-logger');

const productChoices = [
  { name: 'Stark Menu', value: 'stark-menu' },
  { name: 'Bypass CFX', value: 'bypass-cfx' },
  { name: 'Stark Spoofer', value: 'stark-spoofer' }
];

function csv(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function interactionWasAcknowledged(error) {
  return error?.code === 'InteractionAlreadyReplied'
    || error?.code === 40060
    || error?.rawError?.code === 40060
    || /already been acknowledged/i.test(error?.message || '');
}

function whiteContainer(title, body, footer = null) {
  const container = new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`),
      new TextDisplayBuilder().setContent(body)
    );
  if (footer) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  return container;
}

const privateComponentsV2Flags = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;

async function startDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.log('[Discord] Desativado: configure DISCORD_TOKEN e DISCORD_CLIENT_ID no .env.');
    return null;
  }

  const commands = [
    new SlashCommandBuilder().setName('produtos').setDescription('Mostra os produtos disponiveis.'),
    new SlashCommandBuilder()
      .setName('gerarkey')
      .setDescription('Gera uma nova key.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) => option.setName('produto').setDescription('Produto da key').setRequired(true).addChoices(...productChoices))
      .addIntegerOption((option) => option.setName('dias').setDescription('Validade em dias').setMinValue(1).setMaxValue(3650).setRequired(true))
      .addIntegerOption((option) => option.setName('ativacoes').setDescription('Numero de dispositivos').setMinValue(1).setMaxValue(100))
      .addIntegerOption((option) => option.setName('quantidade').setDescription('Quantidade de keys (ate 5000)').setMinValue(1).setMaxValue(5000)),
    new SlashCommandBuilder()
      .setName('gerarusuario')
      .setDescription('Cria um usuario para acessar o cliente.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) => option.setName('usuario').setDescription('Nome de login').setMinLength(3).setMaxLength(50).setRequired(true))
      .addStringOption((option) => option.setName('senha').setDescription('Senha (minimo 6 caracteres)').setMinLength(6).setMaxLength(128).setRequired(true))
      .addStringOption((option) => option.setName('cargo').setDescription('Tipo da conta').addChoices(
        { name: 'Cliente', value: 'customer' },
        { name: 'Operador', value: 'operator' },
        { name: 'Administrador', value: 'admin' }
      ))
  ].map((command) => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  else await rest.put(Routes.applicationCommands(clientId), { body: commands });

  const allowedUsers = csv(process.env.DISCORD_ADMIN_USER_IDS);
  const allowedRoles = csv(process.env.DISCORD_ADMIN_ROLE_IDS);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const processingInteractions = new Set();

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (processingInteractions.has(interaction.id)) return;
    processingInteractions.add(interaction.id);
    const cleanupTimer = setTimeout(() => processingInteractions.delete(interaction.id), 15 * 60 * 1000);
    cleanupTimer.unref();
    try {
      if (interaction.commandName === 'produtos') {
        const products = await listProducts();
        const body = products.map((p) => `### ${p.name}\n\`${p.id}\` • R$ ${p.price.toFixed(2)}`).join('\n\n');
        await interaction.reply({
          components: [whiteContainer('Produtos disponiveis', body, `${products.length} produto${products.length === 1 ? '' : 's'}`)],
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

      if (interaction.commandName === 'gerarkey' || interaction.commandName === 'gerarusuario') {
        const roleIds = new Set(interaction.member?.roles?.cache?.keys?.() || []);
        const explicitlyAllowed = allowedUsers.has(interaction.user.id) || [...allowedRoles].some((id) => roleIds.has(id));
        const hasPermission = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!explicitlyAllowed && !hasPermission) {
          await interaction.reply({
            components: [whiteContainer('Acesso negado', 'Voce nao tem permissao para usar este comando.')],
            flags: privateComponentsV2Flags
          });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'gerarkey') {
        const productId = interaction.options.getString('produto');
        const days = interaction.options.getInteger('dias');
        const maxActivations = interaction.options.getInteger('ativacoes') || 1;
        const quantity = interaction.options.getInteger('quantidade') || 1;
        const licenses = await createKeys({
          productId,
          days,
          maxActivations,
          quantity,
          createdBy: `discord:${interaction.user.id}`
        });
        logKeyBatch('LOTE CRIADO PELO DISCORD', licenses, `discord:${interaction.user.username}`);
        const productName = productChoices.find((product) => product.value === productId)?.name || productId;
        const expirationTimestamp = Math.floor(new Date(licenses[0].expiresAt).getTime() / 1000);
        const keyList = licenses.map((license, index) => `${index + 1}. ${license.key}`).join('\n');
        const preview = licenses.slice(0, 20).map((license, index) => `${index + 1}. ${license.key}`).join('\n');
        const filename = `api-keys-${Date.now()}.txt`;
        const component = whiteContainer(
          `${quantity === 1 ? 'Token gerado' : 'Tokens gerados'} com sucesso`,
          `### Keys (${licenses.length})\n\`\`\`\n${preview}\n\`\`\`${licenses.length > 20 ? `\n-# Preview das primeiras 20 keys. O lote completo esta no arquivo abaixo.\n` : '\n'}`+
          `**Produto:** ${productName}\n`+
          `**Validade:** ${days} dia${days === 1 ? '' : 's'}\n`+
          `**Ativacoes:** ${maxActivations}\n`+
          `**Expira em:** <t:${expirationTimestamp}:F> (<t:${expirationTimestamp}:R>)`,
          `Gerado por ${interaction.user.username}`
        );
        const reply = { components: [component], flags: MessageFlags.IsComponentsV2 };
        if (licenses.length > 20) {
          component.addFileComponents(new FileBuilder().setURL(`attachment://${filename}`));
          reply.files = [new AttachmentBuilder(Buffer.from(`${keyList}\n`, 'utf8'), { name: filename, description: `Lote com ${licenses.length} keys` })];
        }
        await interaction.editReply(reply);
        return;
      }

      if (interaction.commandName === 'gerarusuario') {
        const user = await createUser({
          username: interaction.options.getString('usuario'),
          password: interaction.options.getString('senha'),
          role: interaction.options.getString('cargo') || 'customer'
        });
        logUser('USUARIO CRIADO PELO DISCORD', user, `discord:${interaction.user.username}`);
        const component = whiteContainer(
          'Usuario criado com sucesso',
          `**Usuario:** \`${user.username}\`\n**Cargo:** \`${user.role}\``,
          `Criado por ${interaction.user.username}`
        );
        await interaction.editReply({ components: [component], flags: MessageFlags.IsComponentsV2 });
      }
    } catch (error) {
      if (interactionWasAcknowledged(error)) {
        console.warn(`[Discord] Interacao ${interaction.id} ja havia sido respondida; duplicata ignorada.`);
        return;
      }
      const message = `Erro: ${error.message}`;
      const errorComponent = whiteContainer('Nao foi possivel concluir', message);
      const usesComponentsV2 = true;
      try {
        if (interaction.deferred && usesComponentsV2) {
          await interaction.editReply({ components: [errorComponent], flags: MessageFlags.IsComponentsV2 });
        }
        else if (interaction.deferred) await interaction.editReply({ content: message });
        else if (interaction.replied) await interaction.followUp({ components: [errorComponent], flags: privateComponentsV2Flags });
        else if (usesComponentsV2) await interaction.reply({ components: [errorComponent], flags: privateComponentsV2Flags });
        else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      } catch (replyError) {
        console.error('[Discord] Nao foi possivel responder a interacao:', replyError.message);
      }
    }
  });

  client.on('error', (error) => console.error('[Discord] Cliente:', error.message));

  client.once('clientReady', () => console.log(`[Discord] Bot conectado como ${client.user.tag}.`));
  await client.login(token);
  attachBotClient(client);
  return client;
}

module.exports = { startDiscordBot };
