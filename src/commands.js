import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, TextDisplayBuilder, ContainerBuilder } from 'discord.js';

export function commands(roleId) {
  const pin = new SlashCommandBuilder().setName('pin').setDescription('Gera um PIN de 8 dígitos para o scanner').addUserOption(o => o.setName('usuario').setDescription('Pessoa que usará o scanner').setRequired(true));
  const result = new SlashCommandBuilder().setName('resultado').setDescription('Consulta o resultado de um PIN').addStringOption(o => o.setName('pin').setDescription('PIN de 8 dígitos').setMinLength(8).setMaxLength(8).setRequired(true));
  const painel = new SlashCommandBuilder().setName('painel').setDescription('Publica o painel com botões de PIN e resultado');
  if (!roleId) for (const cmd of [pin, result, painel]) cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [pin.toJSON(), result.toJSON(), painel.toJSON()];
}

export function panelV2() {
  const container = new ContainerBuilder().setAccentColor(0x2b2d31)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Painel do scanner\n**Gerar PIN** — cria um PIN de uso único na hora.\n**Consultar resultado** — cole um PIN e veja o resultado.'))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('genpin').setLabel('Gerar PIN').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
      new ButtonBuilder().setCustomId('getresult').setLabel('Consultar resultado').setStyle(ButtonStyle.Secondary).setEmoji('🔍')));
  return [container];
}
export function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('genpin').setLabel('Gerar PIN').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
    new ButtonBuilder().setCustomId('getresult').setLabel('Consultar resultado').setStyle(ButtonStyle.Secondary).setEmoji('🔍'))];
}
export function panelEmbed() {
  return new EmbedBuilder().setTitle('Painel do scanner').setColor(0x2b2d31)
    .setDescription('**Gerar PIN** — cria um PIN de uso único para o scanner.\n**Consultar resultado** — cole um PIN e veja o resultado.');
}
export function pinModal() {
  const m = new ModalBuilder().setCustomId('modal-pin').setTitle('Gerar PIN');
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('usuario').setLabel('Usuário (ID ou menção)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)));
  return m;
}
export function resultModal() {
  const m = new ModalBuilder().setCustomId('modal-result').setTitle('Consultar resultado');
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pin').setLabel('Cole o PIN').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(8).setMaxLength(8)));
  return m;
}
export function summaryEmbed(row) {
  const r = row.result;
  return new EmbedBuilder().setTitle('Scanner · resultado recebido').setColor(r.failed ? 0xe8a23a : 0x727780)
    .addFields({ name: 'PIN', value: row.pin, inline: true }, { name: 'Usuário associado', value: row.targetId ? `<@${row.targetId}>` : 'avulso', inline: true }, { name: 'Gerado por', value: `<@${row.ownerId}>`, inline: true }, { name: 'Achados', value: String(r.matches), inline: true })
    .setFooter({ text: 'Relato do cliente; exige revisão humana.' }).setTimestamp(r.receivedAt);
}
