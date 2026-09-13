'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

function loadEnv() {
    try {
        const fs = require('node:fs');
        const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
            if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
        }
    } catch (_) {}
}
loadEnv();

const config = {
    port: Number(process.env.PORT || 8080),
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri: process.env.TIKTOK_REDIRECT_URI || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    fivemApiKey: process.env.FIVEM_API_KEY || '',
    ttlSeconds: Number(process.env.SESSION_TTL_SECONDS || 600)
};
const sessions = new Map();

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function html(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${message}</p>`);
}

function authorized(req) {
    return Boolean(config.fivemApiKey) && req.headers.authorization === `Bearer ${config.fivemApiKey}`;
}

function cleanup() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
}

function getBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 32 * 1024) req.destroy();
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function requireConfig() {
    const missing = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI', 'FIVEM_API_KEY']
        .filter(key => !process.env[key]);
    return missing;
}

function createAuthorizeUrl(state) {
    const query = new URLSearchParams({
        client_key: config.clientKey,
        response_type: 'code',
        scope: 'user.info.basic,user.info.profile',
        redirect_uri: config.redirectUri,
        state
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${query}`;
}

function requestJson(url, options) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = require('node:https').request({
            hostname: target.hostname,
            path: `${target.pathname}${target.search}`,
            method: options.method || 'GET',
            headers: options.headers || {}
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve({ status: response.statusCode || 500, data: JSON.parse(body || '{}') });
                } catch (_) {
                    reject(new Error('TikTok retornou uma resposta inválida.'));
                }
            });
        });
        request.setTimeout(15000, () => request.destroy(new Error('Tempo esgotado na API do TikTok.')));
        request.on('error', reject);
        if (options.body) request.write(options.body);
        request.end();
    });
}

async function finishCallback(url, res) {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const session = state && sessions.get(state);
    if (!session) return html(res, 400, 'Sessão inválida', 'Volte ao jogo e tente iniciar o login novamente.');
    if (error || !code) {
        session.result = { ok: false, error: 'Autorização cancelada no TikTok.' };
        return html(res, 400, 'Autorização cancelada', 'Você pode fechar esta página e voltar ao jogo.');
    }

    try {
        const tokenBody = new URLSearchParams({
            client_key: config.clientKey,
            client_secret: config.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.redirectUri
        }).toString();
        const token = await requestJson('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) },
            body: tokenBody
        });
        if (token.status >= 400 || !token.data.access_token) throw new Error('Não foi possível obter o token do TikTok.');

        const profile = await requestJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,username,display_name,bio_description', {
            headers: { Authorization: `Bearer ${token.data.access_token}` }
        });
        const user = profile.data && profile.data.data && profile.data.data.user;
        if (profile.status >= 400 || !user) throw new Error('Não foi possível consultar o perfil TikTok.');

        session.result = {
            ok: true,
            username: user.username || '',
            displayName: user.display_name || '',
            bio: user.bio_description || '',
            openId: user.open_id || ''
        };
        return html(res, 200, 'TikTok conectado', 'Conta autorizada. Você pode fechar esta página e voltar ao jogo.');
    } catch (err) {
        session.result = { ok: false, error: err.message };
        return html(res, 502, 'Falha no TikTok', 'Não foi possível concluir a autorização. Volte ao jogo e tente novamente.');
    }
}

const server = http.createServer(async (req, res) => {
    cleanup();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/tiktok/callback') return finishCallback(url, res);

    if (!authorized(req)) return json(res, 401, { ok: false, error: 'Não autorizado.' });
    if (requireConfig().length) return json(res, 503, { ok: false, error: 'Backend OAuth não configurado.' });

    if (req.method === 'POST' && url.pathname === '/api/tiktok/session') {
        const id = crypto.randomBytes(24).toString('hex');
        sessions.set(id, { expiresAt: Date.now() + config.ttlSeconds * 1000, result: null });
        return json(res, 201, { ok: true, sessionId: id, authorizationUrl: createAuthorizeUrl(id), expiresIn: config.ttlSeconds });
    }

    const match = url.pathname.match(/^\/api\/tiktok\/session\/([a-f0-9]{48})$/);
    if (req.method === 'GET' && match) {
        const session = sessions.get(match[1]);
        if (!session || session.expiresAt <= Date.now()) return json(res, 404, { ok: false, status: 'expired' });
        if (!session.result) return json(res, 200, { ok: true, status: 'pending' });
        sessions.delete(match[1]);
        return json(res, 200, { ok: true, status: 'complete', result: session.result });
    }

    if (req.method === 'POST' && url.pathname === '/api/tiktok/session/cancel') {
        const body = JSON.parse((await getBody(req)) || '{}');
        if (body.sessionId) sessions.delete(body.sessionId);
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: 'Rota não encontrada.' });
});

server.listen(config.port, () => {
    console.log(`TikTok OAuth backend ouvindo na porta ${config.port}`);
    if (requireConfig().length) console.warn('Configure o arquivo .env antes de usar o OAuth.');
});
