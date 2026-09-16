# KeyForge

Sistema com painel web animado, API REST, PostgreSQL no Supabase, geracao/ativacao de keys e bot do Discord.

## Iniciar

1. Instale as dependencias:

   ```powershell
   npm install
   ```

2. Copie `.env.example` para `.env` e ajuste os valores. O bot do Discord e opcional.

   ```powershell
   Copy-Item .env.example .env
   ```

3. Inicie:

   ```powershell
   npm start
   ```

4. Abra `http://localhost:3000`. O acesso inicial e usuario `1`, senha `1`.

Na primeira execucao, as tabelas PostgreSQL sao verificadas e os produtos padrao sao criados. Senhas sao armazenadas com `scrypt`; tokens de sessao sao armazenados somente como hash.

## Supabase PostgreSQL

Copie `.env.supabase.example` para `.env` e configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_DB_URL`. Na primeira inicializacao, a API aplica a migracao automaticamente e cria todas as tabelas, indices, produtos e a funcao atomica de resgate. A chave secreta fica apenas no backend; nunca coloque essa chave no cliente C++. As tabelas usam o prefixo `kf_`.

Inicialize e vincule o projeto com `npx supabase init` e `npx supabase link --project-ref cpftubhrnkxdamlonoga`. Depois aplique `npx supabase db push`. O arquivo em `supabase/migrations` cria o schema, índices, produtos e ativa RLS sem expor dados para a chave publicável.

## Discord

Crie uma aplicacao no Discord Developer Portal, adicione um bot e convide-o ao servidor com os escopos `bot` e `applications.commands`. Depois, configure:

- `DISCORD_TOKEN`: token secreto do bot.
- `DISCORD_CLIENT_ID`: Application ID.
- `DISCORD_GUILD_ID`: ID do servidor para registrar comandos imediatamente. Se vazio, registra globalmente.
- `DISCORD_ADMIN_USER_IDS` / `DISCORD_ADMIN_ROLE_IDS`: IDs autorizados, separados por virgula. Quem possui `Gerenciar servidor` tambem pode gerar keys.

Comandos: `/produtos`, `/gerarkey` e `/gerarusuario`.

## Logs pelo webhook

Defina `DISCORD_WEBHOOK_URL` no `.env` para receber o status de todas as rotas `/api/*`. Os registros usam Discord Components V2, container com destaque branco e mostram metodo, rota, status HTTP, duracao e origem mascarada. Corpos, senhas, tokens, keys e cabecalhos de autorizacao nunca sao enviados.

## API para o cliente C++

### Validar ou ativar uma key

`POST /api/client/query`

```json
{
  "key": "KF-AAAAAA-BBBBBB-CCCCCC-DDDDDD",
  "productId": "pro",
  "hwid": "identificador-estavel-do-dispositivo"
}
```

Resposta valida:

```json
{
  "valid": true,
  "productId": "pro",
  "expiresAt": "2026-12-31T00:00:00.000Z",
  "activation": 1,
  "maxActivations": 1
}
```

O primeiro uso registra o hash SHA-256 do HWID; o valor original nao e salvo. Veja `examples/cpp-client.cpp` e `examples/CMakeLists.txt` para uma integracao C++ pronta.

## Painel Database

A categoria `Database` do painel mostra a conexao Supabase PostgreSQL, latencia, contagem de registros por tabela, usuarios e keys. Administradores podem criar novos usuarios com permissao `admin` ou `operator`; hashes de senha nunca sao retornados ao navegador.

## Render

O arquivo `render.yaml` esta pronto para Blueprint Deploy. No Render, configure `SUPABASE_SERVICE_ROLE_KEY` e as credenciais do Discord. Defina `PUBLIC_URL` com a URL publica criada pelo Render. O endpoint de health check e `/api/health`.

## Rotas principais

| Metodo | Rota | Autenticacao | Uso |
|---|---|---|---|
| `POST` | `/api/login` | Nao | Abrir sessao do painel |
| `GET` | `/api/products` | Nao | Listar produtos |
| `GET` | `/api/keys` | Bearer | Listar keys |
| `POST` | `/api/keys` | Bearer | Gerar key |
| `PATCH` | `/api/keys/:id/status` | Bearer | Ativar/bloquear key |
| `POST` | `/api/licenses/validate` | Nao | Validar/ativar no C++ |
| `POST` | `/api/client/query` | Nao | Consulta de licenca pelo painel C++ |
| `GET` | `/api/client/products` | Bearer | Produtos resgatados pelo usuario logado |
| `POST` | `/api/client/redeem` | Bearer | Resgatar key e vincular produto ao usuario/HWID |
| `GET` | `/api/admin/database` | Admin | Status, tabelas, usuarios e keys |
| `POST` | `/api/admin/users` | Admin | Criar usuario do painel |

## Antes de publicar na internet

- Troque imediatamente o usuario/senha iniciais e o `SESSION_SECRET`.
- Use HTTPS por um proxy reverso e limite requisicoes no endpoint de login/validacao.
- Para varios processos ou alto volume, migre o banco JSON para PostgreSQL ou SQLite.
- Nunca inclua o token do Discord no repositorio ou no executavel C++.
