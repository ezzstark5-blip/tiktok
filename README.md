# Backend OAuth do TikTok

## Configuracao

1. Copie `.env.example` para `.env`.
2. Preencha `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET` com as credenciais novas.
3. Gere uma chave longa para `FIVEM_API_KEY`.
4. Use a mesma chave em `Config.TikTok.BackendApiKey`.
5. Troque `PUBLIC_BASE_URL` e `TIKTOK_REDIRECT_URI` pelo dominio HTTPS real.
6. Cadastre exatamente `TIKTOK_REDIRECT_URI` no TikTok Developer Portal.

A URL de callback deve ser, por exemplo:

```text
https://streamer.seudominio.com/tiktok/callback
```

## Executar

```bash
npm start
```

O backend precisa ficar acessivel publicamente por HTTPS. O recurso FiveM chama:

- `POST /api/tiktok/session`
- `GET /api/tiktok/session/:id`

Ambas as rotas exigem `Authorization: Bearer FIVEM_API_KEY`.

## Teste

```bash
curl https://seu-dominio.com/health
```

Nunca coloque o arquivo `.env` no repositorio nem compartilhe o `TIKTOK_CLIENT_SECRET`.
