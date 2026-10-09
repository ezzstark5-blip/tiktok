import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
export function createDatabase(env = process.env) {
  for (const key of ['DB_HOST','DB_USER','DB_PASSWORD','DB_NAME']) if (!env[key]) throw new Error(`Preencha ${key} no .env.`);
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT inválida.');
  if (env.DB_SSL_VERIFY && !['true','false'].includes(env.DB_SSL_VERIFY)) throw new Error('DB_SSL_VERIFY deve ser true ou false.');
  return mysql.createPool({ host: env.DB_HOST, port, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: env.DB_SSL_VERIFY !== 'false', ...(env.DB_SSL_CA ? { ca: readFileSync(env.DB_SSL_CA,'utf8') } : {}) },
    connectionLimit: 5, queueLimit: 50, waitForConnections: true, connectTimeout: 10000, enableKeepAlive: true,
    charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
}
export async function verifyDatabase(pool) {
  const conn = await pool.getConnection();
  try {
    const [status] = await conn.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    if (!status[0]?.Value) throw new Error('Conexão MySQL sem SSL recusada.');
    const [tables] = await conn.execute("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('scanner_owners','scanner_scans')");
    return { encrypted: true, cipher: status[0].Value, schemaReady: tables.length === 2 };
  } finally { conn.release(); }
}
