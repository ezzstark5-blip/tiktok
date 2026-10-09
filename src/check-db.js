import { createDatabase, verifyDatabase } from './database.js';
let pool;
try {
  pool=createDatabase(); const state=await verifyDatabase(pool);
  console.log(`MySQL conectado com SSL (${state.cipher}).`);
  console.log(state.schemaReady ? 'Tabelas encontradas.' : 'Execute schema.sql no defaultdb para criar as tabelas.');
} catch(error) { console.error('Falha na conexão MySQL:',error.code || error.message); process.exitCode=1; }
finally { if(pool) await pool.end(); }
