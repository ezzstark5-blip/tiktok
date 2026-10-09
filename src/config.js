export function config() {
  for (const name of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'RESULT_CHANNEL_ID'])
    if (!process.env[name]) throw new Error(`Preencha ${name} no .env.`);
  const port = Number(process.env.PORT || 3000);
  const minutes = Number(process.env.PIN_TTL_MINUTES || 15);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('PORT ou PIN_TTL_MINUTES inválido.');
  return { token: process.env.DISCORD_TOKEN, clientId: process.env.DISCORD_CLIENT_ID, guildId: process.env.DISCORD_GUILD_ID, channelId: process.env.RESULT_CHANNEL_ID, roleId: process.env.STAFF_ROLE_ID, port, host: process.env.HOST || '127.0.0.1', ttl: minutes * 60_000 };
}
