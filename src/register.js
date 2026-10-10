import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const c = config();
if (!c.token || !c.clientId || !c.guildId) { console.error('Preencha DISCORD_TOKEN, DISCORD_CLIENT_ID e DISCORD_GUILD_ID no .env.'); process.exit(1); }
const rest = new REST({ version: '10' }).setToken(c.token);
await rest.put(Routes.applicationGuildCommands(c.clientId, c.guildId), { body: commands(c.roleId) });
console.log('Comandos registrados.');
