export function config() {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    token: process.env.DISCORD_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
    channelId: process.env.RESULT_CHANNEL_ID ?? '',
    panelChannelId: process.env.PANEL_CHANNEL_ID ?? '',
    roleId: process.env.STAFF_ROLE_ID ?? '',
    ttl: num(process.env.PIN_TTL_MINUTES, 60) * 60_000,
    host: process.env.HOST ?? '0.0.0.0',
    port: num(process.env.PORT, 3000),
    dataFile: process.env.DATA_FILE ?? './data/db.json',
  };
}
