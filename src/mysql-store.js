import { randomInt, randomBytes } from 'node:crypto';
function map(row) {
  if (!row) return null;
  return { pin: row.pin, ownerId: row.owner_id, targetId: row.target_id,
    createdAt: Number(row.created_at_ms), expiresAt: Number(row.expires_at_ms), token: row.session_token, clientId: row.client_id,
    delivered: Boolean(row.delivered), messageId: row.discord_message_id,
    result: row.received_at_ms == null ? null : { matches: row.process_matches, fiveMDetected: Boolean(row.fivem_detected), failed: Boolean(row.scan_failed), receivedAt: Number(row.received_at_ms), detection:typeof row.detection_report==="string"?JSON.parse(row.detection_report):row.detection_report, steam:{status:row.steam_status||"not_reported",accounts:typeof row.steam_accounts==="string"?JSON.parse(row.steam_accounts):(row.steam_accounts||[])} } };
}
export class Store {
  constructor(pool, ttl = 15 * 60_000) { this.pool = pool; this.ttl = ttl; }
  async transaction(fn) {
    const conn = await this.pool.getConnection();
    try { await conn.beginTransaction(); const result = await fn(conn); await conn.commit(); return result; }
    catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }
  async create(ownerId, targetId, now = Date.now()) {
    return this.transaction(async conn => {
      await conn.execute('INSERT INTO scanner_owners (owner_id) VALUES (?) ON DUPLICATE KEY UPDATE owner_id=VALUES(owner_id)',[ownerId]);
      const [active] = await conn.execute('SELECT pin FROM scanner_scans WHERE owner_id=? AND received_at_ms IS NULL AND expires_at_ms>? FOR UPDATE',[ownerId,now]);
      if (active.length >= 5) throw new Error('Você já tem 5 PINs ativos. Aguarde a conclusão ou expiração.');
      for (let attempt=0; attempt<50; attempt++) {
        const pin = randomInt(0,100_000_000).toString().padStart(8,'0');
        try {
          await conn.execute('INSERT INTO scanner_scans (pin,owner_id,target_id,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?)',[pin,ownerId,targetId,now,now+this.ttl]);
          const [rows] = await conn.execute('SELECT * FROM scanner_scans WHERE pin=?',[pin]); return map(rows[0]);
        } catch(error) { if (error.code !== 'ER_DUP_ENTRY') throw error; }
      }
      throw new Error('Não foi possível gerar PIN único.');
    });
  }
  async get(pin) { const [rows] = await this.pool.execute('SELECT * FROM scanner_scans WHERE pin=?',[pin]); return map(rows[0]); }
  async claim(pin,clientId,now=Date.now()) {
    return this.transaction(async conn => {
      const [rows] = await conn.execute('SELECT * FROM scanner_scans WHERE pin=? FOR UPDATE',[pin]);
      const row = map(rows[0]);
      if (!row || row.result || row.expiresAt<=now || (row.clientId && row.clientId!==clientId)) return null;
      if (!row.token) {
        row.token=randomBytes(32).toString('hex'); row.clientId=clientId; row.expiresAt=now+15*60_000;
        await conn.execute('UPDATE scanner_scans SET session_token=?,client_id=?,expires_at_ms=? WHERE pin=?',[row.token,clientId,row.expiresAt,pin]);
      }
      return row;
    });
  }
  async submit(token,result,now=Date.now()) {
    return this.transaction(async conn => {
      const [rows] = await conn.execute('SELECT * FROM scanner_scans WHERE session_token=? FOR UPDATE',[token]);
      const row=map(rows[0]);
      if (!row) return null;
      if (row.result) return row;
      if (row.expiresAt<=now) return null;
      await conn.execute('UPDATE scanner_scans SET process_matches=?,fivem_detected=?,scan_failed=?,received_at_ms=?,steam_accounts=?,steam_status=?,detection_report=? WHERE pin=?',[result.matches,result.fiveMDetected?1:0,result.failed?1:0,now,JSON.stringify(result.steam?.accounts||[]),result.steam?.status||"not_reported",JSON.stringify(result.detection||null),row.pin]);
      row.result={...result,receivedAt:now}; return row;
    });
  }
  async pending() {
    const [rows]=await this.pool.execute('SELECT * FROM scanner_scans WHERE delivered=0 AND received_at_ms IS NOT NULL ORDER BY received_at_ms LIMIT 100');
    return rows.map(map);
  }
  async delivered(pin,messageId) {
    await this.pool.execute('UPDATE scanner_scans SET delivered=1,discord_message_id=? WHERE pin=? AND received_at_ms IS NOT NULL AND delivered=0',[messageId,pin]);
  }
}
