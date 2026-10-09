import {createDatabase} from './database.js';
const pool=createDatabase();
try {
  const [columns]=await pool.execute("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='scanner_scans'");
  if(!columns.length) throw new Error('Execute schema.sql primeiro.');
  for(const [name,type] of [['steam_accounts','JSON NULL'],['steam_status','VARCHAR(20) NULL'],['detection_report','JSON NULL']]) {
    if(!columns.some(c=>c.name===name)) await pool.query(`ALTER TABLE scanner_scans ADD COLUMN ${name} ${type}`);
  }
  console.log('Colunas Steam e detecção prontas. Nenhum registro removido.');
} catch(error) {console.error(error.code || error.message);process.exitCode=1;}
finally {await pool.end();}
