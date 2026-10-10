import { createServer } from 'node:http';

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : null; }

function validEmbed(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (e.title !== undefined && (typeof e.title !== 'string' || e.title.length > 256)) return false;
  if (e.description !== undefined && (typeof e.description !== 'string' || e.description.length > 4096)) return false;
  if (e.color !== undefined && !Number.isInteger(e.color)) return false;
  if (e.fields !== undefined) {
    if (!Array.isArray(e.fields) || e.fields.length > 25) return false;
    for (const f of e.fields) {
      if (!f || typeof f !== 'object') return false;
      if (typeof f.name !== 'string' || f.name.length === 0 || f.name.length > 256) return false;
      if (typeof f.value !== 'string' || f.value.length === 0 || f.value.length > 1024) return false;
      if (f.inline !== undefined && typeof f.inline !== 'boolean') return false;
    }
  }
  return true;
}

export function createApi(store) {
  const buckets = new Map();
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) return reply(200, { ok: true });
    if (req.method !== 'POST' || !['/v1/claim', '/v1/result'].includes(req.url)) return reply(404, { error: 'Não encontrado.' });
    const now = Date.now();
    for (const [key, item] of buckets) if (item.until <= now) buckets.delete(key);
    const key = req.socket.remoteAddress;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { count: 0, until: now + 60_000 }; buckets.set(key, bucket); }
    if (++bucket.count > 30) return reply(429, { error: 'Muitas tentativas. Aguarde um minuto.' });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64_000) return reply(413, { error: 'Conteúdo muito grande.' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Dados inválidos.' });
      if (req.url === '/v1/claim') {
        if (typeof body.pin !== 'string' || typeof body.clientId !== 'string') return reply(400, { error: 'PIN ou sessão inválidos.' });
        const row = await store.claim(body.pin, body.clientId);
        return row ? reply(200, { token: row.token }) : reply(403, { error: 'PIN inválido, expirado ou já utilizado.' });
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) return reply(401, { error: 'Sessão inválida.' });
      if (!Number.isInteger(body.matches) || body.matches < 0 || body.matches > 10000 || typeof body.fiveMDetected !== 'boolean' || typeof body.failed !== 'boolean' || (body.failed && body.matches !== 0)) return reply(400, { error: 'Resultado inválido.' });
      let embeds = null, log = null;
      if (body.embeds !== undefined) {
        if (!Array.isArray(body.embeds) || body.embeds.length === 0 || body.embeds.length > 10 || !body.embeds.every(validEmbed)) return reply(400, { error: 'Embeds inválidas.' });
        embeds = body.embeds;
      }
      if (body.log !== undefined) {
        if (!Array.isArray(body.log) || body.log.length === 0 || body.log.length > 12 || !body.log.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 1900)) return reply(400, { error: 'Log inválido.' });
        log = body.log;
      }
      const row = await store.submit(token, { matches: body.matches, fiveMDetected: body.fiveMDetected, failed: body.failed, embeds, log });
      return row ? reply(200, { ok: true, queued: !row.delivered }) : reply(403, { error: 'Sessão inválida ou expirada.' });
    } catch (error) {
      if (error instanceof SyntaxError) return reply(400, { error: 'JSON inválido.' });
      console.error('Falha ao processar requisição:', error.name);
      if (!res.headersSent) reply(500, { error: 'Não foi possível salvar. Tente novamente.' });
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  return server;
}
