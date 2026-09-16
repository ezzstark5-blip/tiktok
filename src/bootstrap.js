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
  const migrationDirectory = path.join(__dirname, '..', 'supabase', 'migrations');
  const migrationFiles = (await fs.readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
  const client = new Client({
    connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    // DDL-ul (CREATE INDEX GIN, backfill UPDATE, ANALYZE) depaseste usor
    // statement_timeout-ul default de pe planul free. Marim timeout-ul doar
    // pentru sesiunea de migrare (nu afecteaza restul aplicatiei).
    query_timeout: 120000,
    statement_timeout: 120000
  });
  try {
    console.log('[Supabase] Criando/atualizando o banco automaticamente...');
    await client.connect();
    // Centura + bretele: timeout marit explicit pentru sesiunea DDL
    // (pooler-ul Supavisor poate ignora parametrul din connection string).
    await client.query("SET statement_timeout = '120s'").catch(() => {});
    // Lock advisory: doua instante Render pornite simultan la deploy nu
    // trebuie sa migreze in paralel (CREATE INDEX ia ACCESS EXCLUSIVE si
    // blocheaza tot — inclusiv insert-uri simple → statement timeout).
    const { rows } = await client.query('SELECT pg_try_advisory_lock(42424201) AS locked');
    if (!rows?.[0]?.locked) {
      console.log('[Supabase] Alt proces migreaza deja — sar peste bootstrap.');
      return;
    }
    try {
      // O tranzactie PER fisier, nu una uriasa pentru toate: un statement
      // lent nu mai tine lock-uri pe tot + nu mai face rollback la tot.
      for (const migrationFile of migrationFiles) {
        const sql = await fs.readFile(path.join(migrationDirectory, migrationFile), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('COMMIT');
          console.log(`[Supabase] Migratie aplicata: ${migrationFile}`);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }
      await client.query("NOTIFY pgrst, 'reload schema'");
    } finally {
      await client.query('SELECT pg_advisory_unlock(42424201)').catch(() => {});
    }
    console.log('[Supabase] Banco criado/atualizado com sucesso.');
  } catch (error) {
    throw new Error(`Falha ao criar o banco automaticamente: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { bootstrapSchema };
