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
    const findings=Array.isArray(detection.findings)?detection.findings:[];
    const counts=Object.fromEntries(['exact','review','context'].map(level=>[level,findings.filter(f=>f.level===level).length]));
    const severity={exact:{dot:'🔴',label:'ALTO · hash correspondente',color:0xed4245},review:{dot:'🟡',label:'MÉDIO · revisar',color:0xfee75c},context:{dot:'🔵',label:'INFORMATIVO · contexto',color:0x3498db}};
    const strongest=counts.exact?'exact':counts.review?'review':counts.context?'context':null;
    if(strongest) container.setAccentColor(severity[strongest].color);
    const coverage=detection.status==='partial'?'cobertura parcial':detection.status==='completed'?'coleta concluída':'status da coleta: '+safe(detection.status);
    container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(`### Resultado das detecções · ${coverage}\n🔴 **Alto:** ${counts.exact} · 🟡 **Médio:** ${counts.review} · 🔵 **Informativo:** ${counts.context}\nArquivos analisados: ${detection.filesChecked??0} · Eventos analisados: ${detection.eventsChecked??0}`));
    const order={exact:0,review:1,context:2};
    const highlights=[...findings].sort((a,b)=>(order[a.level]??3)-(order[b.level]??3)).slice(0,3);
    for(const finding of highlights) {
      const level=severity[finding.level]||{dot:'⚪',label:'NÃO CLASSIFICADO'};
      container.addTextDisplayComponents(text(`${level.dot} **${level.label}**\n**${safe(finding.rule)}**\n${safe(finding.evidence)}`));
    }
    container.addTextDisplayComponents(text('-# Alto indica correspondência com hash conhecido. Médio exige revisão manual; informativo é contexto. Estes sinais não confirmam, sozinhos, que um arquivo seja cheat.'));
    container.addFileComponents(new FileBuilder().setURL('attachment://detection-report.json'));
    message.files=[...(message.files||[]),new AttachmentBuilder(Buffer.from(JSON.stringify(detection,null,2),'utf8'),{name:'detection-report.json'})];
  }
  container.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text('-# Perfis locais não comprovam identidade ou conta ativa. Indícios exigem revisão; ausência não garante sistema limpo.'));
  return message;
}
