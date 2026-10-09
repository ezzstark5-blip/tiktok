import { SlashCommandBuilder, PermissionFlagsBits, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, SeparatorBuilder, FileBuilder, MessageFlags, AttachmentBuilder, escapeMarkdown } from 'discord.js';
export function commands(roleId) {
  const pin = new SlashCommandBuilder().setName('pin').setDescription('Gera um PIN de 8 dígitos para o scanner').addUserOption(o => o.setName('usuario').setDescription('Pessoa que usará o scanner').setRequired(true));
  const result = new SlashCommandBuilder().setName('resultado').setDescription('Consulta o resultado de um PIN').addStringOption(o => o.setName('pin').setDescription('PIN de 8 dígitos').setMinLength(8).setMaxLength(8).setRequired(true));
  if (!roleId) for (const cmd of [pin, result]) cmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [pin.toJSON(), result.toJSON()];
}
const text=value=>new TextDisplayBuilder().setContent(value);
const safe=value=>escapeMarkdown(String(value).replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,80)).replace(/@/g,'＠');
const payload=container=>({flags:MessageFlags.IsComponentsV2,components:[container],allowedMentions:{parse:[]}});

export function noticeMessage(message) {
  return payload(new ContainerBuilder().setAccentColor(0x727780).addTextDisplayComponents(text(message)));
}
export function pinMessage(row) {
  return noticeMessage(`## PIN gerado\n# ${row.pin}\n**Usuário associado:** <@${row.targetId}>\n**Validade:** <t:${Math.floor(row.expiresAt/1000)}:R>\n-# Uso único. Entregue este PIN à pessoa para digitar no scanner.`);
}
export async function discordProfile(client,id) {
  try {
    const user=await client.users.fetch(id);
    return {id:user.id,username:user.username,displayName:user.globalName||user.username,avatarUrl:user.displayAvatarURL({extension:'png',size:128}),createdAt:user.createdTimestamp};
  } catch {return null;}
}
export function resultMessage(row,profile=null) {
  const r=row.result,steam=r.steam||{status:'not_reported',accounts:[]};
  const container=new ContainerBuilder().setAccentColor(r.failed?0xe8a23a:0x727780)
    .addTextDisplayComponents(text(`## Scanner · verificação concluída\n**PIN:** ${row.pin} · **Recebido:** <t:${Math.floor(r.receivedAt/1000)}:f>`))
    .addSeparatorComponents(new SeparatorBuilder());
  let discord=`### Discord associado ao PIN\n<@${row.targetId}> · ID: \`${row.targetId}\``;
  if(profile && profile.id===row.targetId) {
    discord+=`\n**Nome:** ${safe(profile.displayName)} · **Usuário:** ${safe(profile.username)}\n**Conta criada:** <t:${Math.floor(profile.createdAt/1000)}:D>`;
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(discord)).setThumbnailAccessory(new ThumbnailBuilder().setURL(profile.avatarUrl).setDescription('Avatar do usuário associado ao PIN')));
  } else container.addTextDisplayComponents(text(discord+'\n-# Perfil indisponível na API; identificação pelo ID associado.'));
  container.addTextDisplayComponents(text(`-# Usuário escolhido no comando /pin; não é uma detecção da conta aberta no PC.\n**Solicitado por:** <@${row.ownerId}>`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`### Resultado\n**${r.failed?'Falha ao consultar processos':r.fiveMDetected?'FiveM detectado':'FiveM não detectado'}**\nProcessos correspondentes: **${r.matches}**`));
  const statuses={ok:'Leitura concluída',not_found:'Lista de perfis Steam não encontrada',unavailable:'Não foi possível ler os perfis Steam',partial:'Leitura parcial',truncated:'Limitado aos primeiros 100 perfis',not_reported:'Cliente antigo: perfis Steam não informados'};
  container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(`### Steam · ${steam.accounts.length} perfil(is) salvo(s)\n${statuses[steam.status]||'Não informado'}`));
  // Bound total text under the 4000-character Components V2 message limit.
  for(const account of steam.accounts.slice(0,4)) container.addTextDisplayComponents(text(`**${safe(account.displayName||'Sem nome')}**\n[${account.steamId}](https://steamcommunity.com/profiles/${account.steamId})`));
  const message=payload(container);
  if(steam.accounts.length>4) {
    container.addTextDisplayComponents(text('Lista completa de perfis no arquivo abaixo.')).addFileComponents(new FileBuilder().setURL('attachment://steam-profiles.json'));
    message.files=[new AttachmentBuilder(Buffer.from(JSON.stringify(steam.accounts,null,2),'utf8'),{name:'steam-profiles.json'})];
  }
  const detection=r.detection;
  if(detection && detection.status!=='not_reported') {
    const counts=Object.fromEntries(['exact','review','context'].map(level=>[level,detection.findings.filter(f=>f.level===level).length]));
    container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(`### Indícios · ${detection.status==='partial'?'cobertura parcial':'coleta concluída'}\nHashes fornecidos: **${counts.exact}** · Revisar: **${counts.review}** · Contexto: **${counts.context}**\nArquivos: ${detection.filesChecked} · Eventos: ${detection.eventsChecked}`));
    for(const finding of detection.findings.slice(0,3)) container.addTextDisplayComponents(text(`**${safe(finding.rule)}** (${safe(finding.level)})\n${safe(finding.evidence)}`));
    container.addFileComponents(new FileBuilder().setURL('attachment://detection-report.json'));
    message.files=[...(message.files||[]),new AttachmentBuilder(Buffer.from(JSON.stringify(detection,null,2),'utf8'),{name:'detection-report.json'})];
  }
  container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text('-# Perfis locais não comprovam identidade ou conta ativa. Indícios exigem revisão; ausência não garante sistema limpo.'));
  return message;
}
