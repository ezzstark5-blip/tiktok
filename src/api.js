import { createServer } from 'node:http';

export function createApi(store) {
  const buckets = new Map();
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method !== 'POST' || !['/v1/claim', '/v1/result'].includes(req.url)) return reply(404, { error: 'Não encontrado.' });
    const now = Date.now();
    for (const [key, item] of buckets) if (item.until <= now) buckets.delete(key);
    const key = req.socket.remoteAddress;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { count: 0, until: now + 60_000 }; buckets.set(key, bucket); }
    if (++bucket.count > 30) return reply(429, { error: 'Muitas tentativas. Aguarde um minuto.' });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) return reply(413, { error: 'Conteúdo muito grande.' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Dados inválidos.' });
      if (req.url === '/v1/claim') {
        if (typeof body.pin !== 'string' || !/^[0-9]{8}$/.test(body.pin) || typeof body.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.clientId)) return reply(400, { error: 'PIN ou sessão inválidos.' });
        const row = await store.claim(body.pin, body.clientId);
        return row ? reply(200, { token: row.token }) : reply(403, { error: 'PIN inválido, expirado ou já utilizado.' });
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) return reply(401, { error: 'Sessão inválida.' });
      if (!Number.isInteger(body.matches) || body.matches < 0 || body.matches > 10000 || typeof body.fiveMDetected !== 'boolean' || typeof body.failed !== 'boolean' || body.fiveMDetected !== (!body.failed && body.matches > 0) || (body.failed && body.matches !== 0)) return reply(400, { error: 'Resultado inválido.' });
      const row = await store.submit(token, { matches: body.matches, fiveMDetected: body.fiveMDetected, failed: body.failed });
      return row ? reply(200, { ok: true, queued: !row.delivered }) : reply(403, { error: 'Sessão inválida ou expirada.' });
    } catch (error) {
      if (error instanceof SyntaxError) return reply(400, { error: 'JSON inválido.' });
      console.error('Falha ao processar requisição:', error.name);
      if (!res.headersSent) reply(500, { error: 'Não foi possível salvar. Tente novamente.' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
