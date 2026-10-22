# Instagram e Facebook Messenger no HNBCRM: guia de configuração e uso

Como colocar o canal "Meta Messaging" (Instagram Direct + Facebook Messenger, pela API oficial da Meta) para funcionar, do
app na Meta até a primeira mensagem no inbox. Decisões técnicas e histórico: `docs/architecture/meta-messaging.md`.

## 1. O que existe hoje e o que ainda não

| Já funciona (F0) | Ainda não (próximas fases) |
|---|---|
| Ligar o módulo por organização (desligado por padrão) | Responder pelo inbox (F1): uma resposta enviada numa conversa de Instagram/Messenger fica marcada como **falha** com aviso |
| Conectar uma Página do Facebook e a conta do Instagram vinculada a ela, num login só | Mídia (fotos, áudios, vídeos, arquivos) e tipos ricos (F2): hoje entram como `[imagem]`, `[menção em story]`… |
| Mensagens de **texto** chegando no inbox, com contato e lead criados | Atendente de IA nesses canais (F3) |
| Selo de origem na lista de conversas (ícone do canal) | Saúde da conexão, alerta e botão Reconectar (F4) |
| Desconectar / Excluir o canal | API REST, MCP e callbacks de exclusão de dados da Meta (F5) |

Campanhas, grupos, templates e "Nova conversa" continuam exclusivos do WhatsApp.

## 2. Lado da Meta: um app por ambiente (uma vez)

O HNBCRM usa **um app Meta por deployment** (não um por cliente): "HNBCRM Dev" para o DEV e "HNBCRM" para o PROD. Quem
conecta um canal faz login com a própria conta do Facebook; o app é o nosso.

| | DEV | PROD |
|---|---|---|
| Deployment Convex | `tacit-chicken-195` | `careful-anaconda-127` |
| Callback de webhooks (objetos **Page** e **Instagram**) | `https://tacit-chicken-195.convex.site/webhooks/meta-messaging` | `https://careful-anaconda-127.convex.site/webhooks/meta-messaging` |
| Redirect URI do login | `https://tacit-chicken-195.convex.site/oauth/meta/callback` | `https://careful-anaconda-127.convex.site/oauth/meta/callback` |
| Política de privacidade / instruções de exclusão | `https://hnbcrm.com/privacidade` | idem |

### 2.1 Criar o app
1. https://developers.facebook.com/apps > **Criar app** > tipo **Business** (casos de uso "Messenger" e "Instagram"). Portfólio:
   o mesmo portfólio verificado do WhatsApp.
2. Configurações > Básico: anotar **App ID** e **App Secret**; preencher URL da política de privacidade, URL de instruções de
   exclusão de dados (pode ser a URL de callback `<CONVEX_SITE_URL>/webhooks/meta-messaging/data-deletion`, ver 2.2; ela devolve
   o código e a página de status que a Meta exige), categoria, ícone 1024×1024 e domínio `hnbcrm.com` (sem isso o app não pode ficar Live).
3. Produtos: **Messenger**, **Instagram** (mensagens pela Página, *não* "Instagram API with Instagram Login") e
   **Facebook Login for Business**.
4. Facebook Login for Business > Configurações: *Valid OAuth Redirect URIs* = o redirect URI do ambiente; Client OAuth login,
   Web OAuth login, Enforce HTTPS e Strict Mode ligados; Login from Devices e Embedded Browser desligados.

### 2.2 Configuração de login ("HNBCRM Mensagens")
Facebook Login for Business > **Configurations** > Create:
- Login variation **General**; token type **User access token** (não "System-user").
- Assets: **Pages** e **Instagram accounts**.
- Permissões, exatamente estas 8 (a Meta nega tudo se faltar alguma na hora do login):
  `public_profile`, `business_management`, `pages_show_list`, `pages_manage_metadata`, `pages_messaging`,
  `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages`.
- Anotar o **Configuration ID** (`config_id`).

Em Facebook Login for Business > **Configurações** (callbacks assinados com o App Secret, `signed_request`):
- **Desautorizar** = `<CONVEX_SITE_URL>/webhooks/meta-messaging/deauthorize`. Quando alguém remove o app no Facebook, o
  HNBCRM apaga o token da Página, desativa os canais e avisa os administradores ("reconecte para voltar a receber").
- **Exclusão de dados** = `<CONVEX_SITE_URL>/webhooks/meta-messaging/data-deletion`. Faz o mesmo e responde
  `{ url, confirmation_code }` apontando para `<CONVEX_SITE_URL>/meta/deletion-status?code=...`, página pública sem dados
  pessoais. Conversas, contatos e leads **não** são apagados: pertencem à organização (controladora); pedidos de exclusão de
  mensagens vão para ela ou para privacidade@hnbcrm.com (LGPD).
- `<CONVEX_SITE_URL>` é o `.convex.site` do ambiente (DEV e PROD têm apps e URLs separados). Conexões feitas antes da F5 não
  têm o `user_id` da Meta gravado: rode o backfill `opsMeta:internalMetaBackfillUserId` (dry run primeiro) ou reconecte a Página.

### 2.3 Papéis e modo Live
- Funções do app: administradores e **testers** (quem for conectar canais precisa de papel no app; o tester aceita o convite em
  https://developers.facebook.com/requests/).
- Alternar o app para **Ativo (Live)**. Sem App Review, o app fica em **Standard Access**: só recebe mensagens de Páginas/IG
  em que a pessoa que conectou tem papel no app **e** no ativo. Isso basta para as contas da própria empresa e para clientes
  em que um administrador do HNBCRM é admin do Meta Business. Abrir para qualquer cliente exige App Review (fora deste guia).

### 2.4 Variáveis de ambiente no Convex
Sem flag = DEV; `--prod` = PROD (regra do projeto: nunca confundir). O *verify token* é inventado por você
(`openssl rand -hex 24`) e repetido no Dashboard no passo 2.5.
```bash
npx convex env set META_MESSAGING_APP_ID <app id>
npx convex env set META_MESSAGING_APP_SECRET <app secret>
npx convex env set META_MESSAGING_LOGIN_CONFIG_ID <config_id>
npx convex env set META_MESSAGING_WEBHOOK_VERIFY_TOKEN <token inventado>
npx convex env list | grep META_MESSAGING_   # confere os 4 nomes sem mostrar valores
```
Sem `META_MESSAGING_APP_ID`/`_LOGIN_CONFIG_ID`, o botão Conectar responde "Instagram/Messenger não está configurado neste
ambiente". Sem `_APP_SECRET`, todo webhook é recusado com 401 (fail-closed).

### 2.5 Webhooks no Dashboard (depois do deploy do backend)
Produto **Webhooks** > escolher o objeto > Callback URL e Verify token do ambiente > "Verificar e salvar" (o backend responde o
`hub.challenge`). Assinar os campos:
- **Page**: `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_postbacks`, `message_reactions`,
  `message_edits`, `messaging_referrals`, `standby`.
- **Instagram**: `messages`, `messaging_seen`, `message_reactions`, `messaging_postbacks`, `messaging_referral`,
  `message_edit`, `standby`.
O botão "Testar" do Dashboard envia um payload de teste que o backend aceita com 200 e descarta.

**Pegadinha medida (22/10/2026):** "Verificar e salvar" registra só a URL. Os campos precisam ser inscritos **no nível do app**
(botão "Editar assinaturas" ao lado da URL, em cada objeto); sem isso a Meta não envia nada, mesmo com a Página inscrita.
Conferir e, se preciso, corrigir pela API (token `APP_ID|APP_SECRET`):
```bash
curl -s "https://graph.facebook.com/v26.0/<APP_ID>/subscriptions?access_token=<APP_ID>|<APP_SECRET>"   # cada objeto deve listar "fields"
curl -s -X POST "https://graph.facebook.com/v26.0/<APP_ID>/subscriptions" -d object=page -d callback_url=<CALLBACK> \
  -d verify_token=<VERIFY_TOKEN> -d fields=messages,message_echoes,message_deliveries,message_reads,messaging_postbacks,message_reactions,message_edits,messaging_referrals,standby \
  -d "access_token=<APP_ID>|<APP_SECRET>"
curl -s -X POST "https://graph.facebook.com/v26.0/<APP_ID>/subscriptions" -d object=instagram -d callback_url=<CALLBACK> \
  -d verify_token=<VERIFY_TOKEN> -d fields=messages,messaging_seen,message_reactions,messaging_postbacks,messaging_referral,message_edit,standby \
  -d "access_token=<APP_ID>|<APP_SECRET>"
```
A inscrição da Página (`POST /{page-id}/subscribed_apps`, feita pelo HNBCRM ao conectar) cobre também o Instagram vinculado;
não é preciso inscrever a conta IG separadamente.

**Acesso padrão (Standard Access), medido:** mesmo com o app publicado, a Meta só entrega mensagens de pessoas com papel no
app (administrador, desenvolvedor, testador, ou "Testador do Instagram" em Funções do app, com o convite aceito). Uma DM de
um perfil sem papel não gera webhook, e a API responde erro 2534084 pedindo acesso avançado a `instagram_manage_messages`.
Para clientes reais é preciso App Review.

## 3. Lado do cliente: o que a conta precisa ter
- Uma **Página do Facebook publicada** (o Messenger é da Página).
- Uma **conta profissional do Instagram** (Business ou Creator) **vinculada à Página** (Instagram > Configurações > Centro de
  Contas > Facebook; ou Meta Business Suite > Contas do Instagram > Conectar). Instagram sem Página ainda não é suportado.
- No app do Instagram: Configurações > Mensagens e respostas a stories > Controles de mensagens > **"Permitir acesso às
  mensagens"** (ferramentas conectadas) ligado. Sem isso as DMs não chegam.
- A pessoa que vai conectar precisa, na Página, das tarefas **Mensagens** e **Moderação** (admin tem todas) e de papel no
  app Meta (seção 2.3).
- Se a Página usa a **Caixa de Entrada do Meta Business Suite** como "app padrão", o HNBCRM recebe as conversas como *standby*
  e não consegue responder. Em Configurações da Página > Mensagens avançadas, defina o HNBCRM como app padrão (ou aceite
  só receber).

## 4. No HNBCRM: ligar, conectar, testar
1. **Configurações > Canais** (precisa de permissão `settings:manage`): card **"Mais canais: Instagram e Facebook
   Messenger"** > ligar. Aparece o aviso de Standard Access (seção 2.3).
2. **Adicionar canal > "Instagram / Facebook Messenger (oficial)"**: abre o login da Meta. Escolha a Página e o Instagram
   e conceda todas as permissões.
3. Volta para Configurações > Canais com um toast:

   | `?meta=` | Significado | O que fazer |
   |---|---|---|
   | `ok` | conectado | nada |
   | `selecionar` | mais de uma Página | marcar "Messenger da Página X" / "Instagram @y" e **Conectar selecionadas** |
   | `cancelado` | você fechou o diálogo | repetir |
   | `expirado` | demorou mais de 10 min | repetir |
   | `sem_permissao` | faltou permissão no diálogo | repetir concedendo todas |
   | `sem_pagina` | nenhuma Página na conta (ou, ao reconectar, Página diferente) | vincular a Página / usar a mesma |
   | `sem_papel` | a conta não tem tarefas de mensagens/moderação na Página, ou não tem papel no app | ajustar papéis (seções 2.3 e 3) |
   | `conta_em_uso` | Página ou IG já conectados em outra organização | desconectar lá primeiro |
   | `modulo_off` | o módulo foi desligado no meio | ligar e repetir |
   | `falha_meta` | erro de rede/Meta | repetir; se persistir, ver logs (seção 5) |
4. Os canais aparecem como cards agrupados por Página ("Página X: Messenger + Instagram"), com estado **Conectado**, quem
   conectou, e os botões **Desconectar** e **Excluir**.
   **Atenção com o atendente IA:** um atendente configurado para "todos os canais" (sem canais específicos) passa a
   responder no Instagram e no Messenger **no momento em que o canal é conectado**, inclusive em autopilot, com a mesma
   persona do WhatsApp. Se não for isso que você quer, restrinja os canais do atendente ou pause a IA antes de conectar.
5. **Teste:** de outro perfil, mande uma DM para a Página (pelo Messenger) e outra para o Instagram. Cada uma vira uma
   conversa no inbox com o selo do canal; o contato recebe o nome do perfil (ou `@usuário`), **sem telefone**, e um lead
   entra no funil padrão. A mesma pessoa no Instagram e no Messenger vira **dois contatos** (vínculo manual fica para depois).

## 5. Diagnóstico
```bash
npx convex logs                       # DEV (acrescente --prod para PROD)
npx convex data metaConnections       # 1 linha por Página: authState ok | reauth_required | revoked (token nunca aparece)
npx convex data channelConfigs        # canais instagram/messenger com messengerPageId / instagramAccountId
```
- Webhook chegou mas nada no inbox: conferir `authState` e `status` do canal (`disabled` quando o módulo está desligado),
  e se a mensagem é de texto (mídia vira placeholder; eco, entregue/lida, reação são ignorados até F1/F2).
- Webhook não chega: no Dashboard, o objeto certo está assinado com o campo `messages`? A URL é a do ambiente certo? O toggle
  "Permitir acesso às mensagens" está ligado? A conta que mandou tem papel no app (Standard Access)?
- 401 nos logs: `META_MESSAGING_APP_SECRET` não bate com o App Secret do app que está chamando.
- Nunca copie PSID, IGSID, tokens ou texto de mensagem de cliente para tickets ou chats: os logs já mascaram (4 últimos dígitos).

## 6. Desconectar, excluir, desligar o módulo
- **Desconectar**: revoga a credencial, desativa os dois canais da Página (Messenger e Instagram) e libera a Página para outra
  organização. Conversas e contatos ficam. Reconectar (F4) reaproveita os mesmos canais.
- **Excluir**: apaga o canal; a credencial é apagada quando o último canal da Página sai.
- **Desligar o módulo**: desativa todos os canais Meta da organização (a tela pede confirmação: mensagens recebidas nesse
  período **não** entram no HNBCRM). Religar reativa só os canais que o módulo desativou, se a credencial ainda estiver ok.
  Desconectar e Excluir funcionam mesmo com o módulo desligado.
- Revogar o HNBCRM nas configurações do Facebook do usuário, trocar a senha ou perder o papel na Página invalida a credencial:
  até a F4 isso não gera alerta; o sintoma é envio/perfil falhando com erro 190 nos logs.

## 7. Monitoramento manual até a F4 (sem saúde automática nem Reconectar)

Até a F4 não há verificação diária da credencial, alerta nem botão Reconectar. O que fazer à mão:

- **Sintoma de credencial morta** (senha trocada, app revogado em facebook.com/settings > Integrações comerciais, papel na
  Página perdido, Página desvinculada do portfólio): envios passam a falhar com "Este canal precisa ser reconectado" e o card
  do canal mostra **"Precisa reconectar"** (`authState: reauth_required`, gravado quando a Meta devolve erro 190). As mensagens
  recebidas podem continuar entrando por um tempo.
- **Como conferir** (sem flag = DEV; `--prod` = PROD):
  ```bash
  npx convex data metaConnections --prod          # authState, authDetail, lastHealthAt, dataAccessExpiresAt (token nunca aparece)
  npx convex logs --prod | grep -i "meta"          # erros 190/10/613 do envio; "meta echo" nos ecos
  curl -s "https://graph.facebook.com/v26.0/debug_token?input_token=<token da Página>&access_token=<APP_ID>|<APP_SECRET>"
  ```
  (o token da Página só sai do banco cifrado; para o `debug_token` gere um no Dashboard, em Casos de uso > Messenger > Gere
  tokens de acesso, e descarte depois.)
- **Como reconectar à mão**: Configurações > Canais > **Desconectar** o canal e **Conectar** de novo pela opção
  "Instagram / Facebook Messenger (oficial)" com a MESMA conta da Meta. Conversas, contatos e leads ficam; a conexão
  nova reaproveita os canais da Página (índice por conexão).
- **`data_access_expires_at`** (~90 dias): quando faltar menos de 14 dias, reconectar à mão pelo mesmo caminho.
- **Webhooks parados** (a Meta desinscreve o app após ~1 h de falhas): `GET /{app-id}/subscriptions` deve mostrar `active: true`
  com `fields` nos dois objetos (seção 2.5); `GET /{page-id}/subscribed_apps` deve listar o app. Reassinar pela API se faltar.
- **Standard Access**: uma pessoa nova que não recebe resposta provavelmente não tem papel no app (seção 2.5). Até o App
  Review, é o esperado.

## 8. Produção (PROD): o app da Meta e as envs

- Um app Meta serve UM deployment (o callback de webhook é um por objeto). Para o PROD, ou o app atual passa a apontar para
  `careful-anaconda-127` (e o DEV ganha um app novo só com testers), ou cria-se um app "HNBCRM" novo repetindo as seções 2.1 a 2.5.
  O app que vai para App Review deve ser o de PROD.
- Envs em PROD (cada uma com `--prod`; valores do app de PROD):
  ```bash
  npx convex env set META_MESSAGING_APP_ID <id> --prod
  npx convex env set META_MESSAGING_APP_SECRET <segredo> --prod
  npx convex env set META_MESSAGING_LOGIN_CONFIG_ID <config_id> --prod
  npx convex env set META_MESSAGING_WEBHOOK_VERIFY_TOKEN <token> --prod
  npx convex env list --prod | grep META_MESSAGING_
  ```
- Redirect URI `https://careful-anaconda-127.convex.site/oauth/meta/callback`; webhooks dos objetos Page e Instagram em
  `https://careful-anaconda-127.convex.site/webhooks/meta-messaging` com os campos da seção 2.5 (conferir `fields` pela API).
- Deploy do backend com os testes verdes (`npm run deploy:prod`); o frontend sobe pela Vercel no merge em `main`.
- Primeiro cliente real: a pessoa que conecta precisa de papel no app (admin/dev/tester) e papel na Página; os clientes
  finais dela só recebem resposta depois do App Review (seção 2.5).

## 9. Ambiente de desenvolvimento
- `npm run dev` sobe o Convex DEV; só o DEV deve ter o app "HNBCRM Dev" apontando para ele. **Nunca conecte ativos de
  cliente no DEV.**
- Testes (`npm run test`) não precisam das envs: usam `fetch` stubado e fixtures em `convex/__fixtures__/meta/` (sintéticas,
  marcadas). Uma captura real anonimizada pode substituí-las.
- Build guards que vão falhar se a regra for quebrada: `outboundDispatchPort.test.ts` (envio só pela porta única),
  `channelTransport.test.ts`, `metaOAuthReturnPath.test.ts` (URL de retorno bate com a rota do frontend), `secretScan.test.ts`
  (tokens `EAA…`/`IGAA…` em arquivo = build quebrado).
