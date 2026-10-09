import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';
const c = config();
await new REST({ version: '10' }).setToken(c.token).put(Routes.applicationGuildCommands(c.clientId, c.guildId), { body: commands(c.roleId) });
console.log('Comandos /pin e /resultado registrados no servidor.');
