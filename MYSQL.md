# MySQL configurado

O bot usa MySQL para PINs, sessões, resultados e confirmação de entrega ao Discord. O scanner continua falando apenas com a API Node; as credenciais MySQL não vão para o executável.

1. No seu cliente MySQL, conecte ao `defaultdb` e execute **schema.sql**. O arquivo cria `scanner_owners` e `scanner_scans`, sem apagar dados existentes.
2. Na pasta do bot, execute `npm ci` para instalar as dependências atualizadas.
3. Confira as variáveis `DB_*` do `.env`. A configuração local foi preenchida. No pacote para distribuição há apenas `.env.example`, sem senha.
4. Execute `npm run db:check`. Depois de criar as tabelas, ele deve informar conexão SSL e tabelas encontradas.
5. Reinicie o bot com `npm start`. Os comandos `/pin` e `/resultado` agora usam o MySQL. Os IDs/token do Discord e a URL `Scanner.server.txt` continuam necessários.

## SSL

O transporte SSL é obrigatório e não tem alternativa em texto puro. Conforme solicitado, `DB_SSL_VERIFY=false` desativa a verificação da identidade do servidor; os dados continuam criptografados. Para validar o certificado depois, configure `DB_SSL_VERIFY=true` e `DB_SSL_CA=C:/caminho/ca.pem`.

## Tabelas

- `scanner_owners`: identifica o moderador e permite bloquear a criação concorrente de PINs para respeitar o limite de cinco ativos.
- `scanner_scans`: PIN de oito dígitos, IDs do moderador/usuário, validade, token de sessão, resultado, horário de recebimento e ID da mensagem do Discord.

PIN é texto (`CHAR(8)`), para preservar zeros à esquerda. IDs do Discord também são texto. Horários são milissegundos Unix UTC. Consultas usam parâmetros e as operações de uso do PIN e envio do resultado usam transações com bloqueio de linha. Reenvio não sobrescreve resultado já recebido.

Use uma instância do bot para consumir a fila do Discord. O arquivo JSON antigo não é mais usado em produção; nenhum histórico antigo é importado automaticamente. Preserve-o se precisar migrá-lo depois. O SQL não altera tabelas antigas incompatíveis se já existirem com o mesmo nome.

## Testes

- `npm test`: contrato HTTP e integração do cliente C# com a API, sem Discord ou banco remoto.
- `npm run test:mysql`: conexão MySQL real e testes do repositório/API em **tabelas temporárias**, removidas ao fechar a conexão. Não cria tabelas definitivas nem grava registros reais. Requer permissão para criar tabelas temporárias.
- `npm run db:check`: somente leitura; confirma SSL e existência das tabelas.

Referência: [SSL no mysql2](https://sidorares.github.io/node-mysql2/docs/documentation/ssl).
