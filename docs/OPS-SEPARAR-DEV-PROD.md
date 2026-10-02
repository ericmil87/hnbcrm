# Ops — separar `dev` (tacit-chicken-195) de `prod` (careful-anaconda-127)

> Escrito e **EXECUTADO em 02/10/2026** (registro na §7). Antes, o hnbcrm.com apontava para o deployment **dev**, que era
> a produção de fato. Agora: prod = `careful-anaconda-127` (hnbcrm.com, clientes reais), dev = `tacit-chicken-195`
> (desenvolvimento e demos, neutralizado). Resumo operacional na seção "Deployments" do `CLAUDE.md` da raiz.

## 0. Fatos que mandam no plano

- **Backup/restore do Convex** copia tabelas + file storage. **Não** copia envs, código, nem funções agendadas
  (`_scheduled_functions`). Restore é destrutivo no destino (substitui tudo). Pode-se restaurar no prod um backup
  feito no dev ("Restore from: outro deployment").
- O schema no prod precisa ser o **mesmo do dev** (os documentos têm os campos novos do MVP Central — `settings.modules`,
  `units`, `departments`…). Logo o código que vai para o prod é o working tree atual (ou o commit dele).
- `npx convex deploy` sem `CONVEX_DEPLOY_KEY` e com `CONVEX_DEPLOYMENT=dev:…` publica no **prod do projeto**. Com
  `CONVEX_DEPLOY_KEY` no ambiente, publica no deployment da chave. **Hoje o `.env.local` tem a chave do DEV**
  (usada pelo simulador da demo) — isso faria `convex deploy` cair no dev. Renomear essa variável (ver §5).
- Webhooks externos apontam para `https://tacit-chicken-195.convex.site`: **bridge/wuzapi** (3 instâncias ativas,
  URL gravada POR instância no gateway), **Meta** (1 canal, hoje em erro) e **Resend** (eventos de e-mail).
- Pendentes agendadas no dev em 02/10: 1 `groupPostWorker.tick`, 2 `scheduledMessages.deliver`.

## 1. Preparar o prod (sem downtime)

1. Chave: colar em `convex-prod-key.env.local` (`CONVEX_DEPLOY_KEY=prod:careful-anaconda-127|…`). Arquivo já está no
   `.gitignore` (`.env.*`).
2. **Envs no prod** = cópia das do dev, exceto as marcadas:
   `APP_URL`, `SITE_URL` (= `https://hnbcrm.com`), `JWKS` e `JWT_PRIVATE_KEY` (**as mesmas do dev**, para as sessões
   e tokens existentes continuarem válidos), `CHANNEL_ENCRYPTION_KEY` (**a mesma**, senão nenhum token de canal
   descriptografa), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`, `WA_BRIDGE_DEFAULT_URL`,
   `WA_BRIDGE_ADMIN_TOKEN`, `WA_BRIDGE_HMAC_SECRET`, `WHISPER_SERVICE_URL`, `WHISPER_SERVICE_TOKEN`,
   `OPENROUTER_API_KEY`, `OPENCODE_GO_API`, `LLM_PLATFORM_ORDER`, `WA_TEST_RESET_PHONES`.
   Não copiar: `CONVEX_OPENAI_*` (padrão do Convex), e **`RESEND_TEST_MODE` fica ausente no prod** (envio real).
   Comando por variável: `CONVEX_DEPLOY_KEY=<prod> npx convex env set NOME "valor"` (ou pelo dashboard).
3. **Código no prod:** `env -u CONVEX_DEPLOY_KEY npx convex deploy` a partir do working tree atual (schema + funções
   + crons). O prod fica vazio até o restore; os crons rodam em cima de nada, sem efeito.

## 2. Janela de migração (~15 min, horário de pouco movimento)

1. Avisar os 2 clientes ativos (mensagens que chegarem na janela podem ficar para trás; ver passo 6).
2. **Backup Now** no dev (com file storage).
3. No prod: Settings → Backup & Restore → **Restore from: dev/eric-milfont** → o backup recém-feito.
4. **Re-apontar os webhooks** para `https://careful-anaconda-127.convex.site`:
   - **Bridge:** rodar no PROD a op `channelConfigs:internalRepointBridgeWebhooks` (a escrever: para cada canal
     bridge ativo, `POST /webhook` no wuzapi com o token da instância e a URL nova — endpoint por instância; o HMAC
     por instância não muda). Conferir com `GET /webhook`.
   - **Meta:** no app da Meta, Webhooks → Callback URL `…/webhooks/whatsapp` + verify token (o mesmo).
   - **Resend:** Webhooks → URL `…/webhooks/resend` (conferir o path em `convex/http.ts`).
5. **Re-armar as agendadas:** as 2 `scheduledMessages.deliver` (reagendar pelo inbox ou op interna) e o tick de
   publicação de grupo (pausar/retomar a publicação em /app/grupos re-arma o worker). Follow-ups da IA: o watchdog
   horário resgata `scheduled` sem `runAt` sozinho.
6. **Mensagens que chegaram no dev durante a janela:** comparar `messages` por `externalId` entre dev e prod
   (export filtrado) e reinjetar as que faltarem; se a janela for curta, aceitar a perda.
7. **Vercel:** trocar a URL do backend (§4) e redeployar. Testar login, inbox, envio de uma mensagem, um webhook
   chegando (mandar um "oi" para o número de teste).

## 3. Neutralizar o dev (OBRIGATÓRIO logo depois)

O dev vira uma cópia congelada com credenciais reais dentro. Sem isto ele continua agindo no mundo:
- `npx convex env set RESEND_TEST_MODE true` no dev (nenhum e-mail sai; digests/avisos de orgs reais morrem aqui).
- Op `channelConfigs:internalDisarmAllChannels` (a escrever): `isActive:false` + status `disabled` em TODO canal
  (bridge e Meta) e apagar `bridgeTokenEncrypted`/credenciais Meta. Evita que health check, logout por
  exclusividade de número, publicação de grupo ou campanha do dev falem com o gateway/Meta reais.
- Cancelar agendadas pendentes no dev (dashboard → Schedules) e pausar campanhas/publicações ativas.
- Remover `OPENROUTER_API_KEY`/`OPENCODE_GO_API` do dev? Não — a demo usa IA. Manter, com `monthlyConversationBudget`.
- **Opcional, recomendado:** apagar do dev as orgs reais (manter só `acme-corp-test` e `grupo-terrae-demo`), para o
  dev não carregar dados de cliente. Fazer por op interna de cascata, com dryRun primeiro.

## 4. Vercel (o que ajustar)

Recomendado (padrão Convex):
- **Build Command:** `npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL`
  (o deploy publica o backend no prod E injeta a URL certa no build do front — um só passo, sem risco de front
  e backend divergirem).
- **Environment Variables → Production:** `CONVEX_DEPLOY_KEY` = chave do prod (marcar só *Production*).
  `VITE_SITE_URL=https://hnbcrm.com` continua. Remover qualquer `VITE_CONVEX_URL` fixo da Production (passa a vir
  do deploy).
- **Preview:** `VITE_CONVEX_URL=https://tacit-chicken-195.convex.cloud` (previews batem no dev) e Build Command
  padrão `npm run build` (sem deploy de backend em preview). Em Vercel isso se faz com variável por ambiente;
  se o Build Command for único, usar `npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL`
  só com a chave presente — sem `CONVEX_DEPLOY_KEY` no Preview o comando falha, então prefira o build condicional:
  `if [ -n "$CONVEX_DEPLOY_KEY" ]; then npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL; else npm run build; fi`.

Alternativa mínima (se não quiser mexer no build): manter `vite build` e só trocar a env
`VITE_CONVEX_URL` da Production para `https://careful-anaconda-127.convex.cloud`; o backend passa a ser publicado
à mão com `npx convex deploy` daqui. Funciona, mas front e backend podem divergir se alguém esquecer um dos dois.

## 5. Máquina local depois da separação

- `.env.local`: `CONVEX_DEPLOYMENT=dev:tacit-chicken-195` (fica) · `VITE_CONVEX_URL=https://tacit-chicken-195.convex.cloud`
  (fica) · **renomear `CONVEX_DEPLOY_KEY` → `CONVEX_DEV_ADMIN_KEY`** (o simulador da demo passa a ler esse nome;
  assim `npx convex deploy` sem flags vai para o prod, e `npx convex dev` continua no dev).
- Rotina: desenvolver com `npx convex dev` (dev); publicar com `npx convex deploy` (prod) **só depois** de testes
  verdes e `git status` limpo de trabalho alheio; ou deixar o Vercel publicar no merge em `main` (§4).
- Scripts/ops que hoje assumem "dev = produção" (memória `convex-dev-e-producao`): atualizar.

## 6. Ordem sugerida com a branch da demo

1. Commitar o MVP Central na `main` (aditivo, gated) + tag `v0.63.0-central` + branch `demo/grupo-terrae` como marcador.
2. Fazer a migração acima a partir desse commit (prod e dev com o mesmo schema).
3. A partir daí: `main` → prod (via Vercel/deploy); dev recebe o que estiver em desenvolvimento e guarda a org demo.
   A org demo também existe no prod após o restore (é inofensiva: `demoMode` nunca envia) — útil para demonstrar
   direto no hnbcrm.com; se não quiser, apagar lá.

## 7. Executado em 02/10/2026 (registro)

- 13:0x — prod `careful-anaconda-127` recebeu envs (iguais ao dev, sem `RESEND_TEST_MODE`), código (commit `e322fa8`) e componentes.
- 13:05:41 export do dev (73,8 MB com arquivos) → 13:07:06 import no prod com `--replace-all` (19.079 documentos).
- 13:07:08 re-apontamento do bridge **zerou** a URL das 3 instâncias (o `POST /webhook` do wuzapi lê `webhookurl`, não
  `webhook`); corrigido e confirmado às **13:07:55** (`GET /webhook` = URL do prod). Janela sem webhook: 47 s.
- 13:07:09 mensagens agendadas re-armadas no prod (2); worker de publicação de grupo re-armado pelo `internalWatchdog`.
- Dev neutralizado: `RESEND_TEST_MODE=true`, 5 canais desarmados (status `disabled`, credenciais apagadas), 3 agendadas
  canceladas. Dev mantém a org demo `grupo-terrae-demo` e o simulador (chave local renomeada para `CONVEX_DEV_ADMIN_KEY`).
- Pendente humano: Vercel (§4), webhook da Meta e do Resend (§2.4), aviso aos clientes sobre a janela, purga das orgs
  reais do dev (op a escrever; o dev já não envia nada).
- **Pegadinha do CLI (1.31.2):** `npx convex data` e `npx convex logs` IGNORAM `CONVEX_DEPLOY_KEY` e caem no dev —
  use `--prod` (ou `--deployment-name`). `env`, `deploy`, `import`, `export` e `run` honram a chave (e `run --prod` também).
- 13:2x — Vercel apontado para o prod (bundle do hnbcrm.com carrega `careful-anaconda-127`); teste do Eric entrou no prod
  às 13:20:40 e a IA respondeu às 13:20:53. Re-armadas 2 publicações de grupo (`internalRearmGroupPosts`) e reenviada 1
  resposta da IA das 13:03 presa sem dispatch (`internalRedispatchStuckOutbound`).
- 13:36–13:40 — logs do prod mostraram `Bridge webhook signature invalid` para a instância da org Townsville INC (9 em 45 s;
  o segredo `WA_BRIDGE_HMAC_SECRET` é idêntico nos dois deployments, então a chave no cache do gateway é que divergia —
  provavelmente já antes da migração). `opsMigration:internalReapplyBridgeHmac` (`POST /session/hmac/config` nas 3
  instâncias, HTTP 200) resolveu: zero rejeições nos 2 min seguintes. Resend: URL do webhook editada no painel (mesmo
  signing secret, já igual no prod).
- 13:52 — **API keys do dev desativadas** (21; `opsMigration:internalDeactivateAllApiKeys`): integração antiga que ainda chame
  `tacit-chicken-195.convex.site` recebe 401 em vez de gravar no dev congelado. Keys com uso recente: "site" (org Aos
  Filhos da Terra — o site envia leads via `CRM_INBOUND_URL` no Convex do próprio site, projeto em OUTRA conta Convex, sem
  acesso daqui) e "agentevendedor" (21/09). **Pendente humano:** trocar `CRM_INBOUND_URL` no deployment de produção do site
  Aos Filhos da Terra para `https://careful-anaconda-127.convex.site` (a `CRM_API_KEY` continua válida: existe no prod).
  `.mcp.json` local e `docs/WHATSAPP-VALIDACAO-LOCAL.md` já apontam para o prod.
- 14:05–14:08 — **dev purgado**: `opsPurge:internalPurgeOrganizations` (65 orgs apagadas em lotes de 250, ~90 s; ficaram
  `acme-corp-test` e `grupo-terrae-demo`) + `internalPurgeOrphanUsers` (68 usuários sem org apagados, com sessões, tokens e
  contas; restou só `ericteste@milfont.net`). A op recusa rodar fora do deployment indicado em `confirmDeployment`
  (compara com `CONVEX_SITE_URL`) e o dryRun valida os índices por tabela antes de qualquer delete.
