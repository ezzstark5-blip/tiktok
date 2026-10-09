import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
export function commands(roleId) {
  const pin = new SlashCommandBuilder().setName('pin').setDescription('Gera um PIN de 8 dígitos para o scanner').addUserOption(o => o.setName('usuario').setDescription('Pessoa que usará o scanner').setRequired(true));
  const result = new SlashCommandBuilder().setName('resultado').setDescription('Consulta o resultado de um PIN').addStringOption(o => o.setName('pin').setDescription('PIN de 8 dígitos').setMinLength(8).setMaxLength(8).setRequired(true));
  if (!roleId) for (const cmd of [pin, result]) cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [pin.toJSON(), result.toJSON()];
}
export function resultEmbed(row) {
  const r = row.result;
  return new EmbedBuilder().setTitle('Scanner · resultado recebido').setColor(r.failed ? 0xe8a23a : 0x727780)
    .addFields({ name: 'PIN', value: row.pin, inline: true }, { name: 'Usuário associado', value: `<@${row.targetId}>`, inline: true }, { name: 'Gerado por', value: `<@${row.ownerId}>`, inline: true }, { name: 'Resultado', value: r.failed ? 'Falha ao consultar processos' : r.fiveMDetected ? 'FiveM detectado' : 'FiveM não detectado' }, { name: 'Processos correspondentes', value: String(r.matches), inline: true })
    .setFooter({ text: 'Relato do cliente • consulta nomes de processos; não comprova identidade, integridade ou ausência de cheats.' }).setTimestamp(r.receivedAt);
}
