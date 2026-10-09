import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, AttachmentBuilder, escapeMarkdown } from 'discord.js';
export function commands(roleId) {
  const pin = new SlashCommandBuilder().setName('pin').setDescription('Gera um PIN de 8 dígitos para o scanner').addUserOption(o => o.setName('usuario').setDescription('Pessoa que usará o scanner').setRequired(true));
  const result = new SlashCommandBuilder().setName('resultado').setDescription('Consulta o resultado de um PIN').addStringOption(o => o.setName('pin').setDescription('PIN de 8 dígitos').setMinLength(8).setMaxLength(8).setRequired(true));
  if (!roleId) for (const cmd of [pin, result]) cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [pin.toJSON(), result.toJSON()];
}
export function resultEmbed(row) {
  const r = row.result;
  const embed = new EmbedBuilder().setTitle('Scanner · verificação concluída').setColor(r.failed ? 0xe8a23a : 0x727780)
    .addFields({ name: 'PIN', value: row.pin, inline: true }, { name: 'Usuário associado', value: `<@${row.targetId}>`, inline: true }, { name: 'Gerado por', value: `<@${row.ownerId}>`, inline: true }, { name: 'Resultado', value: r.failed ? 'Falha ao consultar processos' : r.fiveMDetected ? 'FiveM detectado' : 'FiveM não detectado' }, { name: 'Processos correspondentes', value: String(r.matches), inline: true })
    .setFooter({ text: 'Perfis salvos localmente; não comprovam conta ativa ou identidade. Consulta não detecta cheats.' }).setTimestamp(r.receivedAt);
  const steam=r.steam||{status:'not_reported',accounts:[]};
  const statuses={ok:'Leitura concluída',not_found:'Lista de perfis Steam não encontrada',unavailable:'Não foi possível ler os perfis Steam',partial:'Leitura parcial',truncated:'Limitado aos primeiros 100 perfis',not_reported:'Cliente antigo: perfis Steam não informados'};
  embed.addFields({name:`Steam · ${steam.accounts.length} perfil(is) salvo(s)`,value:statuses[steam.status]||'Não informado'});
  for(const account of steam.accounts.slice(0,12)) {
    const name=escapeMarkdown(account.displayName||'Sem nome').replace(/@/g,'＠');
    embed.addFields({name:'Perfil Steam',value:`${name}\n[${account.steamId}](https://steamcommunity.com/profiles/${account.steamId})`,inline:true});
  }
  if(steam.accounts.length>12) embed.addFields({name:'Lista completa',value:'Os demais perfis estão no arquivo steam-profiles.json anexado.'});
  return embed;
}
export function resultMessage(row) {
  const accounts=row.result.steam?.accounts||[];
  return {embeds:[resultEmbed(row)],...(accounts.length>12?{files:[new AttachmentBuilder(Buffer.from(JSON.stringify(accounts,null,2),'utf8'),{name:'steam-profiles.json'})]}:{})};
}
