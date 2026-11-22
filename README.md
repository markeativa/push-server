# Push Server 2.0

Servidor de notificações push multi-site com painel único. Mesma estrutura, layout e rotas da versão 1; o que mudou está abaixo.

## Início rápido
```bash
cp .env.example .env     # defina ADMIN_PASSWORD (12+ caracteres) e BASE_URL
npm install
npm start                # painel em http://localhost:3000
npm test                 # teste de ponta a ponta (não envia push real)
```
Na primeira execução, se existir `data/db.json` (versão 1), ele é importado automaticamente e renomeado para `db.json.imported` (backup).

## Como usar
1. **Sites** → cadastre o site/app com suas origens (`https://meusite.com`). Cada um recebe um código `site_xxxxxxxxxxxx`.
2. Cole no site o snippet mostrado no painel e hospede `sw.js` na raiz dele:
   `<script src="https://SEU-SERVIDOR/push-client.js" data-site="site_xxxxxxxxxxxx"></script>`
3. **Enviar** → escolha o site, preencha, e envie agora ou agende.

Sites já em produção continuam funcionando sem `data-site` **se** a origem deles estiver cadastrada em um único site (o servidor resolve pelo cadastro). O ideal é adicionar o `data-site`.

## Armazenamento: por que migrei para SQLite agora
O JSON antigo reescrevia o arquivo inteiro a cada inscrição/envio, sem controle de concorrência (duas requisições simultâneas podiam sobrescrever uma à outra), e não permite consultas como "cliques por notificação" sem carregar tudo na memória. Com cliques, agendamento e filtros por site isso deixaria de ser viável.

SQLite (modo WAL) resolve isso **sem novo serviço para manter**: gravações transacionais e atômicas, sem corrupção em queda de energia, leitura concorrente, índices. Todo o SQL está em `lib/store.js`, com API assíncrona, então a migração para PostgreSQL é uma troca de **um arquivo** (esquema equivalente em `docs/schema.postgres.sql`).

| Requisito | Como é atendido |
|---|---|
| Inscrições e histórico após reinício | Banco em `DATA_DIR/push.db` (teste automatizado confirma) |
| Chaves VAPID | `VAPID_PUBLIC/PRIVATE` no ambiente (recomendado) ou `data/vapid.json` (0600). O servidor avisa se a chave pública mudar |
| Gravações simultâneas | Transações SQLite + `busy_timeout`; envio "reivindicado" de forma atômica |
| Futura migração | Esquema portável + SQL isolado em `lib/store.js` |

**Importante:** em hospedagens com disco efêmero (Render free, Heroku, etc.) o arquivo do banco se perde a cada deploy. Use disco persistente (`DATA_DIR`) ou migre para Postgres/Supabase. Backup: `npm run backup`.

### Migrando para PostgreSQL/Supabase (quando precisar)
1. Rode `docs/schema.postgres.sql` no banco. 2. Reescreva `lib/store.js` com `pg` (troque `?` por `$1…`, transações por `BEGIN/COMMIT`; o claim vira `UPDATE … WHERE status='scheduled' RETURNING id`). 3. Copie as tabelas do SQLite (`sqlite3 push.db .dump` ou script). 4. Mantenha as mesmas chaves VAPID. Com Supabase, use só a connection string no servidor; nunca no navegador.

## Isolamento entre sites
Cada inscrição pertence a um `site_id`. Ao enviar, o painel exige o site e o servidor só cria entregas para inscrições **ativas daquele site**. A lista de destinatários é fixada no momento do envio.
A inscrição só é aceita se `Origin` (cabeçalho do navegador) **estiver cadastrada para o site informado** e o site estiver ativo. O domínio enviado pelo navegador nunca é confiado sozinho.

## Rastreamento de cliques
O push não leva o link final: leva `BASE_URL/r/<token>`, um token único por inscrito e por notificação. Só quando a pessoa **toca** na notificação o navegador abre esse link, o servidor registra data/hora e redireciona (302) para o destino. Receber não conta.
- **Cliques** = total de toques. **Pessoas que clicaram** = inscritos distintos. **Taxa de cliques** = pessoas que clicaram ÷ entregas aceitas.
- Ignorados: `HEAD` (pré-visualizadores de link) e duplo-toque em menos de 3 s. Não se guarda IP nem User-Agent.
- O destino vem sempre do banco, nunca da URL: não há redirecionamento aberto.

## Agendamento
Na tela Enviar, "Agendar envio (opcional)". Um agendador roda a cada 15 s (`lib/push.js`).
- **Sem duplicidade:** o envio é "reivindicado" por uma atualização atômica (`scheduled → sending`) que também cria as linhas de entrega. Ticks repetidos, cliques duplos ou mais de uma instância não reenviam.
- **Queda no meio do envio:** ao voltar, o servidor retoma notificações `sending` e envia **somente** as entregas ainda pendentes. (Se o processo cair entre o envio e o registro de um lote de 50, esse lote pode ser reenviado; é o limite de qualquer sistema "pelo menos uma vez".)
- Quem se inscreve antes do horário recebe; o site é revalidado no momento (desativado = não envia). Dá para cancelar enquanto estiver agendada.
- Horários são guardados em UTC; o painel usa o fuso do navegador.

## Segurança
- **Login:** bloqueio de 15 min após 5 falhas por IP, atraso fixo nas falhas, senha mínima de 12 caracteres (o servidor não sobe com a senha de exemplo), comparação em tempo constante. Sessões ficam no banco (só o hash do token), expiram em 12 h e são revogadas no "Sair".
- **Admin:** todas as rotas administrativas exigem sessão; limitador por IP; IDs validados por formato; sem CORS.
- **Públicas:** CORS só para origens de sites ativos (nunca `*`); limite de requisições; corpo máx. 20 KB (2 MB só no upload de ícone).
- **Inscrição:** endpoint precisa ser `https` de serviço push conhecido (Google, Mozilla, Apple, Microsoft; extras em `PUSH_ENDPOINT_ALLOW`), o que impede o servidor de ser usado para requisições a endereços arbitrários (SSRF); chaves `p256dh`/`auth` validadas por formato e tamanho.
- **Links:** só http(s), sem credenciais; por padrão o destino precisa ser do próprio site (opção por site para permitir externos). Ícone só pode ser um upload feito pelo painel; upload valida os bytes reais (PNG/JPG/WEBP).
- **VAPID privada:** nunca sai do processo, não aparece em nenhuma resposta nem log, arquivo 0600.
- **Frontend:** o painel usa CSP restritiva (sem scripts/estilos inline), toda saída é escapada, e a API de inscritos não devolve endpoint, chaves nem IP.
- Cabeçalhos: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS em HTTPS.

## Limitações conhecidas
- O cabeçalho `Origin` é imposto pelos navegadores, mas um script fora do navegador pode forjá-lo. Por isso, além do cadastro, há validação rigorosa, limite por IP e remoção de inscrições no painel. Isso protege contra outros sites, não contra um atacante dedicado que conheça o código do site.
- Limitadores ficam em memória (uma instância). Com várias instâncias, mova-os para um proxy/Redis.
- `TRUST_PROXY` deve refletir sua hospedagem; se estiver errado, o limite de login pode ser contornado ou bloquear todos juntos.
- Envio imediato espera até 20 s pela resposta; listas muito grandes continuam em segundo plano e aparecem como "Enviando" no histórico.
- O histórico da v1 não tinha o site da notificação: ele foi atribuído ao primeiro site migrado.
