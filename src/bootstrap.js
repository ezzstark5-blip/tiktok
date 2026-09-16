const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

function databaseUrl() {
  const configured = String(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();
  if (configured && !configured.includes('[YOUR-PASSWORD]')) return configured;
  const password = String(process.env.SUPABASE_DB_PASSWORD || '').trim();
  const host = String(process.env.SUPABASE_DB_HOST || '').trim();
  const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  if (!password || !host) return '';
  const user = host.includes('.pooler.supabase.com') ? `postgres.${projectRef}` : 'postgres';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/postgres`;
}

async function bootstrapSchema() {
  const connectionString = databaseUrl();
  if (!connectionString) {
    const error = new Error('As tabelas ainda nao existem. Configure SUPABASE_DB_URL no .env para a API cria-las automaticamente.');
    error.code = 'SUPABASE_SCHEMA_MISSING';
    throw error;
  }
  const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260916010000_keyforge_schema.sql');
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({
    connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  try {
    console.log('[Supabase] Criando/atualizando o banco automaticamente...');
    await client.connect();
    await client.query('BEGIN');
    await client.query(sql);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('[Supabase] Banco criado/atualizado com sucesso.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`Falha ao criar o banco automaticamente: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { bootstrapSchema };
