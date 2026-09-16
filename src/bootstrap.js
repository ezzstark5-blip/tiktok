const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

const ADVISORY_LOCK_ID = 42424201;

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

// Imparte un fisier .sql in statement-uri individuale, respectand
// dollar-quoting ($$ ... $$ / $tag$ ... $tag$), string-uri si comentarii.
// FARA asta, node-postgres trimite tot fisierul ca un singur query
// implicit-tranzactional: un statement lent face rollback la TOT si
// migratia nu mai progreseaza niciodata (cazul 20260916020000).
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let dollarTag = null;
  let inSingleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next2 = sql.slice(i, i + 2);
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (next2 === '*/') { current += sql[i + 1]; i += 1; inBlockComment = false; }
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && sql[i + 1] === "'") { current += sql[i + 1]; i += 1; }
      else if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (next2 === '--') { inLineComment = true; current += ch; continue; }
    if (next2 === '/*') { inBlockComment = true; current += ch; continue; }
    if (ch === "'") { inSingleQuote = true; current += ch; continue; }
    const tagMatch = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/);
    if (tagMatch) { dollarTag = tagMatch[0]; current += dollarTag; i += dollarTag.length - 1; continue; }
    if (ch === ';') {
      if (current.replace(/--[^\n]*/g, '').trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.replace(/--[^\n]*/g, '').trim()) statements.push(current.trim());
  return statements;
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
    // DDL-ul (CREATE INDEX GIN, backfill batch, ANALYZE) depaseste usor
    // statement_timeout-ul default de pe planul free. Marim timeout-ul doar
    // pentru sesiunea de migrare (nu afecteaza restul aplicatiei).
    query_timeout: 120000,
    statement_timeout: 120000
  });
  try {
    console.log('[Supabase] Criando/atualizando o banco automaticamente...');
    await client.connect();
    let haveLock = false;
    try {
      // O lock e adquirido UMA vez antes de qualquer DDL. Se outro deploy
      // estiver migrando, falhamos de forma retryable; jamais informamos
      // "sucesso" com migrations incompletas.
      const { rows: lockRows } = await client.query(
        'SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_ID]
      );
      if (!lockRows?.[0]?.locked) {
        const lockError = new Error('Migrations em andamento por outra instancia; nova tentativa sera feita automaticamente.');
        lockError.code = 'MIGRATION_LOCKED';
        throw lockError;
      }
      haveLock = true;
      await client.query(`create table if not exists public.kf_schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )`);
      // Projetos existentes foram criados antes do controle de versao. Fazemos
      // baseline apenas quando TODOS os artefatos principais daquela migration
      // ja existem; migrations parciais continuam sendo reaplicadas com seguranca.
      const { rows: migrationCountRows } = await client.query('select count(*)::int as count from public.kf_schema_migrations');
      if (migrationCountRows[0].count === 0) {
        const { rows: baselineRows } = await client.query(`select
          to_regclass('public.kf_license_keys') is not null as v100,
          to_regclass('public.kf_audit_logs') is not null
            and to_regclass('public.kf_key_history') is not null
            and exists (select 1 from information_schema.columns where table_schema='public' and table_name='kf_license_keys' and column_name='key_hash')
            and exists (select 1 from information_schema.columns where table_schema='public' and table_name='kf_activations' and column_name='activation_ip')
            and to_regprocedure('public.kf_redeem_key(text,text,text,uuid,text)') is not null
            and not exists (select 1 from public.kf_license_keys where key_hash is null limit 1)
            and exists (select 1 from pg_constraint where conname='kf_license_keys_status_check'
              and pg_get_constraintdef(oid) ilike '%blocked%'
              and pg_get_constraintdef(oid) not ilike '%disabled%') as v200,
          to_regclass('public.idx_kf_keys_hint_trgm') is not null
            and to_regclass('public.idx_kf_keys_status_created') is not null
            and to_regclass('public.idx_kf_activations_license') is not null as v300`);
        const baseline = baselineRows[0];
        const completed = [
          baseline.v100 && '20260916010000_keyforge_schema.sql',
          baseline.v200 && '20260916020000_professional_admin.sql',
          baseline.v300 && '20260916030000_fix_statement_timeout.sql'
        ].filter(Boolean);
        for (const filename of completed) {
          await client.query('insert into public.kf_schema_migrations(filename) values($1) on conflict do nothing', [filename]);
        }
      }
      const { rows: appliedRows } = await client.query('select filename from public.kf_schema_migrations');
      const applied = new Set(appliedRows.map((row) => row.filename));
      for (const migrationFile of migrationFiles) {
        if (applied.has(migrationFile)) continue;
        await client.query("SET statement_timeout = '120s'").catch(() => {});
        const sql = await fs.readFile(path.join(migrationDirectory, migrationFile), 'utf8');
        // Tranzactie PER STATEMENT, nu per fisier: un statement lent face
        // rollback doar la el, iar la retry statement-urile deja aplicate
        // sunt no-op (IF NOT EXISTS / WHERE ... IS NULL / guard DO).
        for (const statement of splitStatements(sql)) {
          const isCall = /^\s*CALL\b/i.test(statement);
          if (!isCall) await client.query('BEGIN');
          try {
            await client.query(statement);
            if (!isCall) await client.query('COMMIT');
          } catch (error) {
            if (!isCall) await client.query('ROLLBACK').catch(() => {});
            throw new Error(`${migrationFile}: ${error.message}`);
          }
        }
        await client.query('insert into public.kf_schema_migrations(filename) values($1) on conflict do nothing', [migrationFile]);
        console.log(`[Supabase] Migratie aplicata: ${migrationFile}`);
      }
      await client.query("NOTIFY pgrst, 'reload schema'").catch(() => {});
    } finally {
      if (haveLock) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    }
    console.log('[Supabase] Banco criado/atualizado com sucesso.');
  } catch (error) {
    throw new Error(`Falha ao criar o banco automaticamente: ${error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { bootstrapSchema, splitStatements };
