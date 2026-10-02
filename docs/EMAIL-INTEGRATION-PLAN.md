# E-mail conectável ao CRM — plano e prioridades

Data: 2026-09-10. Base: main v0.54.0 + v0.55 (campanhas) não commitada.
Pesquisa: 5 agentes em paralelo, relatórios integrais citados no §16.

## 0. O que foi pedido (tradução em requisitos)

| # | Requisito | Onde entra |
|---|---|---|
| R1 | Cliente com **Gmail pessoal** (`@gmail.com`) | §2.1 → F1 (captura) + F4 (`gmail.send`) |
| R2 | Cliente com **Google Workspace** (domínio corporativo) | §2.1 → idem R1; sync completo só em F6 |
| R3 | Cliente com **Zoho Mail** | §2.3 → F1; API REST com polling em F5 (funciona **inclusive no plano free**) |
| R4 | Cliente com **Resend** | §2.4 → F1 nativo + envio com a key dele (BYO) em F2 |
| R5 | E-mail "conectável/integrável" ao CRM — inbox unificado, vínculo com lead | §5–§8 |
| R6 | Se hoje não faz, como implementar | §3 (o que existe), §12 (fases) |

**A resposta curta:** hoje o CRM **só envia e-mail transacional** (Resend, notificações da equipe) e
não recebe nada. E, pior, esse envio está **desligado por um default** (§4 — P0). Tornar o e-mail um
canal de verdade é viável **sem OAuth, sem IMAP e sem auditoria da Google**, reusando a infra que já
existe. O caminho caro (ler a caixa do cliente por API) só se justifica depois, e é uma decisão
comercial, não técnica.

---

## 1. Veredito em uma página

A pesquisa produziu uma fronteira nítida, e ela não está onde se imagina:

| O que você quer fazer | Custo real |
|---|---|
| **Receber** e-mail do cliente no inbox do CRM | **R$ 0** — endereço de captura + 1 registro MX. Nenhuma API de provedor. |
| **Enviar** pelo domínio do CRM/cliente com `Reply-To` da conversa | **R$ 0** — Resend, já instalado. |
| **Enviar** do endereço real do cliente no Gmail | **R$ 0** + 3–5 dias de análise (`gmail.send` é *sensitive*) |
| **Ler a caixa** do cliente no Gmail por API | **US$ 540–1.800/ano** de auditoria CASA + 6–12 semanas |
| **Ler a caixa** por IMAP | Worker externo obrigatório (impossível no Convex) + Zoho free nem tem IMAP |

Ou seja: **95% do valor está no lado que custa zero.** O inbox unificado, o vínculo com o lead, a
resposta de dentro do CRM, a thread costurada, os anexos — tudo isso sai do padrão "endereço de
captura", que é exatamente o que Pipedrive, HubSpot, Salesforce e Zoho CRM ofereceram por anos antes
de terem sync nativo, e que **todos eles mantêm até hoje** porque cobre caixa compartilhada, alias e
Google Group, que o OAuth não cobre.

O que o caminho caro compra: histórico retroativo, estado de lido/label espelhado no Gmail, e captura
automática sem o cliente configurar nada. É upgrade, não fundação.

**Recomendação: F1→F3 agora (4–6 semanas, R$ 0 de custo recorrente), F4 em seguida se um cliente
exigir "tem que sair do meu endereço", e F5/F6 só com demanda comercial nominal.**

---

## 2. O que a pesquisa fechou, por provedor

### 2.1 Gmail e Google Workspace — a fronteira está em `send` vs `read`

Classificação oficial dos escopos (developers.google.com/workspace/gmail/api/auth/scopes):

| Escopo | Classe | Verificação | CASA anual |
|---|---|---|---|
| `gmail.send` | **sensitive** | 3–5 dias úteis | **não** · US$ 0 |
| `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.metadata`, `https://mail.google.com/` | **restricted** | semanas | **sim** |

- **CASA é obrigatória** para todo app com escopo restricted que "has the ability to access data from
  or through a third-party server" — Convex é exatamente isso. Renovação **a cada 12 meses**. O
  self-scan Tier 2 acabou; só lab autorizado emite a carta, e **a Google escolhe o nível (AL1/AL2)**.
  Custos reportados por labs (nenhum oficial da Google): TAC Security US$ 540–1.800, Leviathan
  US$ 800–1.200, Bishop Fox a partir de US$ 1.500; AL2 com pentest US$ 4.500–8.000. Prazo prático
  com remediação: **6–12 semanas**. O escopo da auditoria inclui a infra de deploy e o local de
  armazenamento — Convex **e** a VPS do bridge/Whisper, se ela tocar em e-mail.
- **Boa notícia:** CRM é caso de uso *explicitamente permitido* na política do Workspace
  ("Applications that enhance productivity such as CRM tools"). Não há trave de tipo de aplicação.
- **Modo Testing não serve:** 100 usuários **e refresh token que expira em 7 dias**. Cada org
  reconectaria a caixa toda semana.
- **Marketplace e domain-wide delegation não isentam.** A isenção é para app usado só dentro do
  próprio domínio (app interno). DWD ainda exige o super-admin de cada cliente colar o Client ID no
  Admin Console — e **não existe para `@gmail.com`**, que não tem domínio nem admin.
- `gmail.metadata` é **restricted mesmo sem trazer corpo** e não aceita o parâmetro `q` no
  `messages.list`. Descartado.
- **App Password** (SMTP/IMAP sem OAuth) continua existindo para contas com 2FA, não exige nenhuma
  verificação — mas o admin do Workspace pode desabilitar para todo o domínio, a UX de setup é feia,
  e é dívida técnica com validade desconhecida. Aceitável para piloto de 5–20 clientes, **nunca como
  arquitetura definitiva**.
- **Limite de envio:** 500 destinatários/dia no Gmail pessoal, 2.000 no Workspace, janela **rolante**
  de 24h. Consequência dura: **a caixa do cliente não é canal de campanha** (§10.3).

### 2.2 Microsoft 365 (cliente futuro provável) — o melhor dos três tecnicamente

Graph API com `Mail.Read`/`Mail.ReadWrite`/`Mail.Send` delegated, **sem CASA**. A vantagem decisiva
sobre a Google é **dispensar o Pub/Sub**: a notificação é um POST direto no `convex/router.ts`.

- Subscription de `message`: **10.080 min (~7 dias)**, ou **1.440 min (~1 dia)** se pedir resource
  data. **1.000 subscriptions por caixa.** Latência média **< 1 min**, máx. 3 min.
- Renovação por `PATCH` — **cabe no cron horário que `exports.ts` já tem**.
- Handshake: POST com `?validationToken=` → responder **200 `text/plain`** com o token.
- ⚠️ A autenticação do webhook é `clientState` (≤128 chars) — **mais fraco que HMAC, o segredo viaja
  no payload**. Abaixo do padrão que o projeto pratica no bridge.
- Usar `lifecycleNotificationUrl` mesmo sendo opcional: o evento `missed` avisa notificação perdida.

**Basic Auth na Microsoft está morta e IMAP lá não tem justificativa nenhuma:** IMAP/POP/EWS caíram em
set/2022; **SMTP AUTH foi completamente desabilitado depois de 30/abr/2026** ("no exceptions or
extensions"), tenants novos já nascem sem, remoção final no 2º sem/2027; **app passwords pararam e não
podem ser regeneradas**. Sobrou IMAP/SMTP só com XOAUTH2 — e como isso já exige registrar app no
Entra ID, use Graph.

### 2.3 Zoho Mail — dois achados que mudam o desenho

1. **Não existe webhook de e-mail novo.** O que a doc chama de webhook é a Dev Platform (extensões
   dentro da UI do Zoho). Pedido de feature aberto na comunidade. **Zoho Mail puro = polling.**
2. **O plano Forever Free não tem IMAP/POP** — texto da própria página de preços da Zoho. Se o
   cliente está no free, **não existe caminho IMAP**, ponto.

O que **funciona no free**: a **API REST do Zoho Mail** com polling. Rate limit de **30 req/min por
conta** (não global do app, então não escala com o número de orgs) → poll de 60s consome 1–2 req/min,
folga de 15–30×. Latência de 1 minuto é aceitável para e-mail.

**Armadilha da região — e a solução exata.** São 9 data centers (`.com`, `.eu`, `.in`, `.com.au`,
`.jp`, `zohocloud.ca`, `.com.cn`, `.ae`, `.sa`), e cada um muda o endpoint **e** o `accounts-server`.
Errar produz `invalid_code`, que se parece com bug de código. **O Zoho devolve a região no próprio
callback do OAuth:**

```
?code=…&location=us&accounts-server=https%3A%2F%2Faccounts.zoho.com
```

Regra: construir o host a partir do `accounts-server` **antes** de trocar o code, e para a API do Mail
trocar `accounts.` por `mail.`. **A região tem que ir para o schema no primeiro commit.**

Outros detalhes: IMAP **tem que ser habilitado no painel** (off por padrão) e exige app password com
2FA; hosts `imappro.zoho.com:993` (pago) vs `imap.zoho.com:993` (free); **um usuário pode ter vários
`accountId`** (aviso da própria doc). Envio externo tem limite **dinâmico** de 50–500/h baseado em
reputação — o CRM não consegue saber o teto a priori, precisa de fila e backoff no espírito do
`channelPacing`.

Existe o **Zoho Mail360** (produto separado) que é um agregador tipo Nylas feito pela Zoho, com
webhook de "new mail" — mas a doc **não descreve nenhuma verificação HMAC do webhook**, abaixo do
padrão que o projeto já pratica no bridge. E o preço por caixa não é público.

### 2.4 Resend — a dobradiça do plano

**Resend tem inbound, e isso muda tudo.** Verificado direto na doc:

- Endereço gerenciado `<qualquer>@<id>.resend.app` = **zero DNS**, catch-all de fábrica (ótimo para
  validar o fluxo antes de pedir DNS a ninguém). Ou domínio próprio com **1 registro MX** — usar
  **subdomínio dedicado** (`in.hnbcrm.com`), que não toca no `mail.hnbcrm.com` que já envia.
- **O webhook `email.received` traz só metadados** — sem corpo, sem headers:
  ```json
  { "type": "email.received",
    "data": { "email_id", "from", "to", "cc", "bcc",
              "received_for": ["forwarded@example.com"],
              "message_id": "<111@email.example.com>", "subject",
              "attachments": [{ "id", "filename", "content_type", "content_id" }] } }
  ```
  Corpo e headers vêm de `emails.receiving.get(email_id)` → `.html`/`.text`/`.headers`; anexo vem de
  `receiving.attachments.list()`, cada um com `download_url`. **Isso força exatamente o desenho de
  três tempos que o repo já usa no bridge** (§6.1) — não é atrito, é confirmação da arquitetura.
- **`received_for`** (extraído da cláusula `for` dos headers `Received`) **resolve o roteamento de
  auto-encaminhamento sem parsear corpo nenhum.** Era a parte mais frágil do padrão clássico de
  dropbox; está resolvida de graça.
- Inbound **incluído em todos os tiers, inclusive o Free** (3.000 envios/mês, 100/dia; Pro US$ 20 por
  50k). ⚠️ Reconfirmar na contratação.
- **O Resend guarda o e-mail mesmo se o nosso webhook estiver fora** — a reentrega não depende de fila
  nossa. Isso reduz muito o risco do passo 1 do ingest.
- ⚠️ **Pegadinha oficial:** *"you will not receive emails at Resend if the required MX record is not the
  lowest priority value for the domain"* → **subdomínio dedicado é obrigatório**, não preferência. É a
  mesma lição que fez `mail.hnbcrm.com` existir em vez de usar o domínio raiz.
- Alternativas tecnicamente melhores, se algum dia o Resend não servir: **Postmark** tem
  **`MailboxHash` nativo** (`user+hash@` vira campo próprio no JSON) — é literalmente o primitivo do
  padrão dropbox; e **Cloudflare Email Routing** é grátis com 25 MB e catch-all nativo.
- O `@convex-dev/resend` cobre **envio + eventos de entrega; não cobre inbound** → `httpAction`
  própria, no molde do `/webhooks/bridge`.
- Os 8 eventos de entrega (`delivered/bounced/complained/opened/clicked/failed/delayed/suppressed`)
  mapeiam 1:1 no `messages.deliveryStatus`, igual aos recibos do WhatsApp.

### 2.5 IMAP — impossível dentro do Convex, e o porquê importa

O runtime padrão do Convex (V8) **não tem `net`/`tls`** — a doc enumera as APIs e socket não está
lá. O runtime Node (`"use node"`, que é Lambda) provavelmente abre socket, mas **isso não salva o
IMAP**, por razões independentes e todas confirmadas:

1. IMAP IDLE exige conexão TCP viva por caixa, indefinidamente. Action Node morre em **10 min**.
2. Actions **não têm retry automático** (a doc é explícita) — queda no meio do fetch some em silêncio.
3. **Jobs agendados concorrentes = 8** no plano Free/Starter. 8 caixas em IDLE esgotam o deployment
   inteiro, sem sobrar slot para os crons de tarefas/exports que já rodam.
4. **Custo:** uma caixa em IDLE 24/7 a 512 MB = 360 GB-hora/mês. Uma caixa estoura 18× a franquia do
   Starter. Dez caixas ≈ **US$ 1.150/mês** só de compute.

→ Qualquer caminho IMAP exige **worker externo na VPS** que o projeto já opera (wuzapi + Whisper),
empurrando para uma `httpAction` com HMAC — **o padrão do `/webhooks/bridge`, já testado**. Infra
marginal ≈ R$ 0 (10–25 MB RSS por caixa em IDLE: 50 caixas ≈ 1 GB). **O custo real é operacional:** mais
um serviço com estado que falha em silêncio — exatamente a classe de falha do incidente de HMAC/events
do bridge, cuja lacuna era monitoramento. Exigiria heartbeat por caixa.

Se chegar a esse ponto, a escolha racional é **EmailEngine self-hosted** — US$ 1.450/ano **flat**,
contas ilimitadas, feito pela mesma casa do `imapflow`. Ele **já é o worker IMAP pronto e mantido**, e
fica mais barato que a Unipile a partir de ~3 caixas e que a Aurinko a partir de ~121; a 200 caixas dá
**US$ 0,60/caixa/mês**. Reimplementar do zero são 3–5 semanas mais cauda longa de compatibilidade com
provedores brasileiros (cPanel, Locaweb, Titan, UOL).

**Estado das libs (verificado no npm em 2026-09-10), se alguém for por esse caminho:** `imapflow` 2.0.0
é **MIT** — era AGPL até 2021, e **o que é comercial é o EmailEngine, não a lib**; o escopo
`@postalsys/imapflow` não existe mais. Trata CONDSTORE/QRESYNC/IDLE/UIDVALIDITY automaticamente.
`mailparser` (MIT) e `nodemailer` (MIT-0) ativos. **`postal-mime` 3.0.0 (MIT-0) é o parser certo para o
runtime do Convex** — sem dependências de Node. **Mortos desde 2022: `imap`, `node-imap`,
`imap-simple`.** Para limpeza de citação, `email-reply-parser` (MIT) é o vivo em npm; o `talon` do
Mailgun é melhor (remove assinatura também) mas é Python — se o serviço Whisper já é Python, um
endpoint `/strip-quote` ao lado do `/convert` sai barato.

### 2.6 Agregadores — só um resolve o problema da CASA

| Agregador | Absorve a CASA da Google? | 10 caixas | 50 | 200 |
|---|---|---|---|---|
| **Unipile** | ✅ **sim, self-serve** (cliente OAuth já certificado Tier 2) | € 50 | € 250 | ~€ 900 |
| Nylas | ⚠️ só via contrato pago (add-on "Shared Google App") | US$ 25 | US$ 105 | US$ 405 |
| Aurinko | ❌ (único com Zoho **nativo**) | US$ 10 | US$ 50 | US$ 200 |
| EmailEngine (self-host) | ❌ (por construção) | US$ 121 | US$ 121 | US$ 121 |
| **Resend inbound (captura)** | **N/A — não usa OAuth** | **US$ 0** | **US$ 0** | US$ 0–20 |

A Unipile é 5 a 9× mais caro que a alternativa mais barata, e **o prêmio é exatamente a CASA**. É
decisão de time-to-market, não de infraestrutura: se o Gmail com leitura virar prioridade comercial,
pagar a Unipile pode sair mais barato que 6–12 semanas de espera somadas ao custo do lab.

---

## 3. O que o CRM já tem (e o que falta)

**Já pronto, zero mudança** — o núcleo do inbox é mais agnóstico de canal do que parece:

| Peça | Caminho |
|---|---|
| Núcleo do ingest | `convex/conversations.ts:1278` `internalReceiveMessage` — **o validador já aceita `channel:"email"`** |
| `conversations.channel` | `convex/schema.ts:667` — `"email"` já está no union |
| Get-or-create de conversa | `convex/conversations.ts:199` |
| Lead a partir de contato | `convex/lib/inboundRouting.ts:94` `ensureLeadForContact` |
| Dedupe por e-mail | `convex/contacts.ts:464` `internalFindOrCreateContact` — **tenta e-mail PRIMEIRO**; índice `by_organization_and_email` existe |
| Anexos + defesas da v0.53 | `whatsapp.ts:1082` `internalSaveInboundAttachment` (nome enganoso, é agnóstico) + `lib/fileValidation.ts` + `lib/fileQuotas.ts` + `lib/fileRefs.ts` |
| Efeitos de outbound (menos o dispatch) | `convex/lib/outboundSideEffects.ts:17-84` |
| Cripto de segredos | `convex/lib/secretCrypto.ts` — AES-256-GCM/WebCrypto, `CHANNEL_ENCRYPTION_KEY`, formato versionado `v1:` |
| Webhooks de saída | `convex/nodeActions.ts:223` — payload **já carrega `channel`** |
| Visão de imagens | `convex/vision.ts` — **zero** menções a canal |
| Repasses IA↔humano | `convex/handoffs.ts` — agnóstico |
| Busca em mensagens | `messages.search_content` |

**Falta (23 pontos mapeados; os estruturais):**

| # | Ponto | Caminho:linha |
|---|---|---|
| 1 | `channelConfigs.channel` só aceita `"whatsapp"` (comentário diz "union-ready") | `schema.ts:604`, `channelConfigs.ts:53` |
| 2 | `createChannelConfig` exige 5 campos Meta **ou** 3 bridge | `channelConfigs.ts:203-276` |
| 3 | **Resolvedor único recusa não-whatsapp** — gargalo estrutural | `lib/channelResolve.ts:20,33` |
| 4–7 | Dispatch de outbound + o mesmo `if` em 3 lugares | `outboundSideEffects.ts:86`, `conversations.ts:872`, `:1249`, `scheduledMessages.ts:198` |
| 8 | **Atendente IA: `if (channel !== "whatsapp") return null`** | `attendant.ts:270` |
| 9 | Atendente IA: janela de 24h bloquearia e-mail (sem provider → trata como Meta) | `attendant.ts:197-204` |
| 12 | `serviceWindowFields`: `!config` → `applies=true` → **UI mostraria contador de 24h em e-mail** | `conversations.ts:30-39` |
| 13 | Rota genérica de ingest aceita `body.channel` livre mas **exige telefone** | `router.ts:944-946,961-966` |
| 15 | `ROUTE_PERMISSIONS` fail-closed — rota nova sem entrada nasce 403 | `router.ts:140-258` |
| 16 | UI: `channelIsWhatsapp` governa metade do inbox (+10 usos) | `Inbox.tsx:361`, `MessageBubble.tsx:27-28` |
| 18 | `findOrCreateContactByEmail` **não existe** (só o irmão por telefone) | `lib/inboundRouting.ts:52` |
| 20 | **Bounce/complaint do Resend é só `console.log`** | `email.ts:54-62` |
| 22 | `optOuts` é chaveado por `phone`, não por identificador genérico | `schema.ts:1690` |

**Falha silenciosa que já existe hoje:** `crm_send_message` (MCP) e `POST /api/v1/conversations/send`
são canal-agnósticos na assinatura. Numa conversa `channel:"email"` a mensagem é **gravada, o webhook
`message.sent` dispara, e nada é entregue** — o `if (channel === "whatsapp")` simplesmente não roda.
Tem que virar erro explícito antes de existir qualquer conversa de e-mail.

---

## 4. P0 — corrigir antes de qualquer feature nova

**Nenhum e-mail transacional do CRM chega a um endereço real, em nenhum deployment.**

`@convex-dev/resend` tem `testMode` com default **`true`**; `convex/email.ts:8-10` nunca o desliga —
só tem um comentário dizendo que deveria. `grep -rn testMode convex/ src/` não acha nenhuma
atribuição. E o componente **lança**:

```js
// node_modules/@convex-dev/resend/dist/component/lib.js:115-118
if (args.options.testMode) {
  if (!isTestEmail(to)) {
    throw new Error(`Test mode is enabled, but email address is not a valid resend test address...`)
```

Dos 14 call sites:
- **13 via `ctx.scheduler.runAfter(0, ...)`** → a função agendada quebra e o erro só aparece no log do
  Convex. Digest diário, lembrete de tarefa, menção em comentário, repasse, notificação de lead:
  **nada é entregue, sem sintoma visível na UI**.
- **1 inline: `convex/nodeActions.ts:151`**, o convite de novo membro, sem try/catch, depois do
  `runMutation` que cria o `teamMember` já ter commitado. Resultado: **o convite falha com erro para o
  admin depois de já ter criado o usuário com uma senha temporária que ninguém recebe.**

Ressalva: só existe deployment `ownDev` vinculado nesta máquina e ele está sem logs recentes, então a
evidência é estática (código + default do componente), não observada em produção.

**Correção (P0, ~1 dia):**
1. `testMode: false` no construtor, lido de env para manter dev seguro:
   `testMode: process.env.RESEND_TEST_MODE !== "false"` ou similar, com a env setada em prod.
2. `handleEmailEvent` deixa de ser `console.log`: persistir `bounced`/`complained` e **suprimir o
   endereço** — senão a correção troca "não entrega nada" por "entrega e queima a reputação do
   domínio sem ninguém ver".
3. Try/catch no convite, ou mover o e-mail para `scheduler.runAfter` como os outros 13.
4. Teste que falha se `testMode` voltar ao default.

Isso é pré-requisito de tudo no §12: não faz sentido construir um canal de e-mail sobre um envio que
não sai.

---

## 5. Decisões de produto (recomendação — confirmar)

| # | Decisão | Recomendação | Por quê |
|---|---|---|---|
| D1 | Unidade de conversa | **1 conversa por thread de e-mail**, não 1 por lead | `getOrCreateConversation` casa por `by_lead_and_channel` → todo e-mail do lead cairia numa única conversa infinita. Precisa de chave de thread (§7) |
| D2 | Visibilidade | **Caixa compartilhada da org** por padrão, governada pelo `inbox` que já existe | Default americano (Pipedrive: privado até para admin) não cabe em PME brasileira. Caixa individual exige um eixo "dono da thread" que o RBAC não tem |
| D3 | Allowlist de remetente | **Obrigatória, por org** | Endereço de captura é público e adivinhável. Sem allowlist, num CRM multi-tenant, alguém injeta lead e mensagem no funil alheio. Padrão Salesforce (*My Acceptable Email Addresses*) |
| D4 | SPF | **Sinal, nunca veto** | Encaminhamento quebra SPF quase sempre; DKIM sobrevive |
| D5 | Filtro de ruído | **Reciprocidade** + blocklist por `*@dominio` + headers de máquina | Reciprocidade é o mais barato e o melhor: só cria registro para contato que a equipe já respondeu. Newsletter e cold outreach não criam nada |
| D6 | Conflito de destino | **Fila de "não resolvidos"**, nunca adivinhar | Contato com vários leads abertos: Pipedrive desiste do automático e pede escolha manual. E-mail no deal errado é pior que em deal nenhum |
| D7 | Corpo HTML | **Nunca no documento** — `bodyStorageId` no File Storage | Documento do Convex tem teto de **1 MiB**; HTML com citação encadeada passa disso com frequência. Guardar cru + exibir limpo |
| D8 | Limpeza de citação | Obrigatória e heurística (`talon`/`email_reply_parser`) | **O limpo é que vai para o LLM**: assinatura de e-mail é vetor clássico de prompt injection, e thread com citação repetida infla o prompt em ordens de grandeza |
| D9 | Rastreamento de abertura | **Não construir como métrica.** Clique sim, abertura off por padrão e rotulada "estimativa" | Apple MPP = **49,29% de todas as aberturas registradas em 2026**; o pixel dispara no pré-fetch do proxy. Somado a cache do Gmail e firewall corporativo |
| D10 | Massa ≠ 1-a-1 | Campanha por e-mail **reusa `campaigns`** e **o mesmo `optOuts` org-wide** | Quem pediu SAIR no WhatsApp não deve receber campanha por e-mail. `email.complained` vira opt-out, como o 131050 da Meta já vira |
| D11 | Conta do Resend | Plataforma por padrão, **BYO key como upgrade** — mesmo desenho do provider de LLM | Na conta do CRM a reputação de IP é **compartilhada entre tenants**: um spammer degrada a entrega de todos, e a suspensão cai na conta do HNBCRM. Com BYO, DMARC alinha no domínio do cliente |
| D12 | Normalizador de assunto | Tem que conhecer **`Res:` e `Enc:`** | Outlook em português usa esses prefixos; normalizador que só conhece `Re:`/`Fwd:` quebra em metade da base brasileira |
| D13 | Normalização de endereço | Implementar (case, `+tag`, dots do Gmail) | **Não existe em lugar nenhum do repo hoje** — `João@x.com` e `joao@x.com` viram dois contatos |

⚠️ **D11 herda uma assimetria que o repo já tem no LLM: BYO é da org inteira e não tem fallback.** Key
do cliente falha → e-mail não sai. Tem que aparecer no `ChannelHealthPanel`, não num log.

---

## 6. Arquitetura

### 6.1 Inbound em três tempos (obrigatório, não é escolha)

O webhook do Resend não traz corpo nem anexo, e a `httpAction` do Convex tem teto de 20 MiB na
requisição enquanto o argumento de uma Node action é 5 MiB e um documento é 1 MiB. Logo:

```
POST /webhooks/email  (httpAction, runtime V8)
  1. rawBody = await request.text()         ← cru primeiro, sempre
  2. verifica assinatura (HMAC/svix)        ← env ausente = descarta, nunca aceita sem verificar
  3. resolve o tenant por `received_for` / endereço de captura
     └─ tenant desconhecido → 200 + descarte (não vaza existência de org, não faz o Resend retentar)
  4. ctx.scheduler.runAfter(0, internal.emailIngest.internalIngest, { emailId, configId })
  5. return 200                              ← sempre rápido
     ↓
internalIngest (internalAction)
  6. fetch emails.receiving.get(emailId)    → html/text/headers
  7. fetch cada attachment.download_url     → ctx.storage.store(blob), teto próprio de 25 MB
  8. parse: Message-ID/In-Reply-To/References, limpeza de citação, normalização de endereço
  9. ctx.runMutation(internalReceiveEmail)
     ↓
internalReceiveEmail (internalMutation)
 10. allowlist de remetente → reciprocidade → dedupe por Message-ID
 11. resolve thread (§7) → findOrCreateContactByEmail → ensureLeadForContact
 12. internalReceiveMessage({ channel: "email", ... })   ← o núcleo que já existe
```

Esse é, linha por linha, o padrão de `convex/bridge.ts:62-110`. Duas lições do arquivo que valem aqui:
instância desconhecida devolve **200 e descarta**; env var ausente **descarta, nunca aceita sem
verificar**; assinatura inválida devolve **401**.

⚠️ Agendar de dentro de uma **action** não é transacional ("scheduled functions execute even if the
action subsequently fails"). O `runAfter` do passo 4 está numa httpAction — se ela falhar depois, o job
roda de todo jeito. Para atomicidade, agendar de dentro de mutation.

### 6.2 Outbound

Dois caminhos, escolhidos por config do canal:

- **Pelo domínio do CRM ou do cliente (Resend):** `Reply-To: conv-<id>@in.hnbcrm.com` → a resposta do
  cliente cai **direto na conversa certa, sem heurística de assunto**. É o caminho padrão.
- **Pelo endereço real do cliente no Gmail (`gmail.send`, F4):** MIME montado em base64url, `threadId`
  **mais** `Subject` igual e `In-Reply-To`/`References` corretos — só o `threadId` funciona no Gmail e
  quebra o threading no cliente do destinatário.

Em ambos: reusar `applyOutboundMessageSideEffects` (audit/activity/webhook/patch já genéricos) e
ramificar só no dispatch (`outboundSideEffects.ts:86`).

### 6.3 Por que não IMAP, em uma linha

Ver §2.5. Se um dia for inevitável: worker na VPS → `httpAction` com HMAC, padrão do bridge, e
preferir **EmailEngine** a reimplementar IMAP.

### 6.4 Três peças do repo para copiar quase literalmente

O projeto já resolveu "falar com serviço externo" três vezes. Reusar o desenho, não só a ideia:

1. **Builder puro + um único ponto de rede** — `convex/lib/bridgeSession.ts` monta
   `BridgeHttpRequest {url, method, headers, body}` **sem tocar a rede**, e `channelConfigs.ts:38-49`
   (`bridgeFetchJson`) é o único que dá `fetch`. Resultado: o protocolo fica **100% testável sem rede**.
   Fazer igual para Gmail/Zoho/Resend — `lib/emailProtocol.ts` puro + um executor.
2. **Ingress HMAC com 200 rápido** — `convex/bridge.ts:63` (`request.text()` antes de tudo) → `:97`
   (`verifyBridgeSignature` via Web Crypto) → `:110` (`scheduler.runAfter(0, …)`). Com as três decisões
   do arquivo: instância desconhecida = **200 + descarte**; env ausente = **descarta**; assinatura
   inválida = **401**.
3. **Serviço na VPS com Bearer** — `convex/transcription.ts:130-200` (`WHISPER_SERVICE_URL` +
   `WHISPER_SERVICE_TOKEN`). Se um dia houver worker de e-mail: `EMAIL_WORKER_URL`/`_TOKEN`, mesma
   forma, e provisionamento gerenciado no molde de `WA_BRIDGE_DEFAULT_URL`/`WA_BRIDGE_ADMIN_TOKEN`.

---

## 7. Threading — o miolo técnico

`threadId` do Gmail é **local à caixa e proprietário**: o mesmo fio tem id diferente na caixa de cada
vendedor, e o destinatário fora do Gmail não tem nenhum. Os headers RFC 5322 (`Message-ID`,
`In-Reply-To`, `References`) são universais.

**Resolução, nesta ordem:**
1. Algum `references[]`/`inReplyTo` já conhecido → mesma conversa.
2. `threadId` do provedor já conhecido → mesma conversa (**campo auxiliar, nunca chave**).
3. Fallback: (assunto normalizado + participantes + janela de tempo).
4. Senão, conversa nova, raiz = este `Message-ID`.

**Nunca costurar só por assunto normalizado** — "Orçamento" casaria leads diferentes.

Ao enviar, **guardar o `Message-ID` próprio** e indexar **todos** os IDs vistos na thread. Mandar
`In-Reply-To` **e** `References` (a doc do Resend só menciona `In-Reply-To`; mandar os dois, senão
thread longa fragmenta no Gmail).

---

## 8. Modelo de dados (proposta)

```
emailChannelConfigs  (ou channelConfigs com channel:"email" — ver §11)
  organizationId, channel:"email", status
  mode: "capture" | "gmail_api" | "zoho_api" | "imap"     // cresce por fase
  captureAddress: string                                   // org-<token>@in.hnbcrm.com
  fromDomain?, replyToStrategy
  allowedSenders: string[]                                 // D3 — allowlist
  blockedSenders?: string[]                                // D5
  byoResendKeyRef?: { kind:"orgSecret", id }                // D11
  -- só nas fases de API:
  providerRegion?: string                                   // Zoho: .com/.eu/... (§2.3)
  oauthRefreshTokenEncrypted?, oauthScope?, oauthExpiresAt?, subjectEmail?

emailThreads
  organizationId, conversationId, leadId
  rootMessageId: string                                    // chave canônica
  knownMessageIds: string[]                                 // todos os IDs vistos
  providerThreadId?: string                                 // auxiliar
  subjectNormalized: string                                 // conhece Re:/Res:/Fwd:/Enc: (D12)
  participants: string[]
  index: by_organization_and_root, by_organization_and_message_id

messages  (campos novos)
  emailSubject?, emailFrom?, emailTo?[], emailCc?[]
  emailMessageId?, emailInReplyTo?, emailReferences?[]
  bodyStorageId?                                            // HTML no File Storage (D7)
  rawEmlStorageId?                                          // .eml cru, p/ DKIM/reencaminhamento fiel
  bodyTextClean?                                            // o que vai para a UI e para o LLM (D8)

emailUnresolved    // D6 — fila de não resolvidos
  organizationId, emailId, candidateLeadIds[], reason, status

optOuts            // generalizar: phone → identifier + kind:"phone"|"email"
```

Notas:
- `contentType` hoje é `text|image|file|audio` — e-mail cabe em `text` com metadata, mas vale avaliar.
- Campo pesquisável tem que ser **cópia rasa de topo** (precedente: `transcriptText`,
  `imageDescription`) — search index do Convex não indexa campo aninhado.
- **Regra de segredo, nas três camadas que importam:** cifrado com `secretCrypto` **sempre**; **nunca**
  em `metadata` (a lição do `stripMediaKeyMaterial` da v0.53, que varre o metadata inteiro antes do
  banco); nunca em audit, webhook ou export (`lib/exportSanitize.ts` + teste de build). Onde morar:
  `orgSecrets` precisa de `purpose` novo (hoje é `v.union(v.literal("llm-api-key"))`) e é o lugar certo
  para **credencial de conta** (senha IMAP, refresh token); segredo **de configuração do canal** segue o
  precedente de `channelConfigs` (`appSecretEncrypted`, `accessTokenEncrypted`,
  `bridgeTokenEncrypted`). Em nenhum dos dois casos o valor decifrado pode sair de uma action — e
  `internalGetOrgSecretEncrypted` já está na `TOOL_DENYLIST`, onde o equivalente de e-mail também
  precisa entrar.
- Refresh token **precisa ser reescrito** (alguns provedores rotacionam a cada refresh) — hoje nada no
  repo atualiza um segredo existente. Cuidado com OCC se duas actions renovarem a mesma conta em
  paralelo: usar lock no molde de `conversations.aiTurnLock`.

---

## 9. Segurança e LGPD

**Multi-tenant:** D3 (allowlist) é requisito de segurança, não de qualidade. Endereço de captura é
público; sem allowlist é injeção cross-tenant.

**Prompt injection:** o corpo do e-mail entra no histórico que o atendente IA lê. Tem que viajar dentro
do `lib/promptEnvelope.ts` (envelope de dado não-confiável) como a descrição de visão já faz, e o corpo
**limpo** é que vai para o LLM (D8). Assinatura de rodapé é vetor clássico.

**O RBAC tem que alcançar o LLM.** A Attio documenta como limitação conhecida que conteúdo privado
"may remain discoverable elsewhere through features like Ask Attio". No HNBCRM isso é literal: Copiloto
e Atendente leem histórico. Se e-mail privado entrar no `historyTextOf` sem filtro de visibilidade, um
agente **extrai por pergunta o que não veria por clique**.

**LGPD — `emailAck` é mais forte que o `lgpdAck` existente.** A base legal **não é consentimento do
funcionário** (ANPD: consentimento de subordinado não é "livre") — é **legítimo interesse da ORG**, que
é a controladora; o HNBCRM é operador. E-mail corporativo pode ser monitorado **desde que haja política
prévia comunicada**. O aceite precisa cobrir: (a) a org tem política interna comunicada; (b) informou
os titulares **inclusive os remetentes externos** — o cliente que escreve não sabe que vai parar num
CRM; (c) finalidade e exclusões definidas; (d) IA pode processar; (e) transferência internacional;
(f) **blocklist não é retroativa**. E-mail entra na cascata de `lib/leadCascade.ts` **desde o dia 1**
(direito de eliminação, art. 18).

Rastreamento de abertura sem avisar o destinatário é a exposição mais desnecessária do conjunto: coleta
IP/UA/timestamp num recurso que é ~50% ruído (D9).

---

## 10. Integração com o que já existe

### 10.1 Atendente IA em e-mail
Destravar `attendant.ts:270` e **não** aplicar a janela de 24h (`:197-204`) — ela é regra da Meta, não
de e-mail. `conversations.ts:30-39` precisa parar de devolver `applies=true` quando `config` é null,
senão a UI mostra contador de WhatsApp numa conversa de e-mail. Visão e repasses funcionam sem
alteração. Tom/formato de resposta em e-mail é diferente de WhatsApp — a persona precisa saber em que
canal está.

### 10.2 Copiloto e MCP
Não existe tool de enviar e-mail. `crm_send_message` é agnóstico na assinatura e **falha em silêncio**
numa conversa de e-mail (§3) — corrigir primeiro.

### 10.3 Campanhas
Campanha por e-mail reusa `campaigns` + `optOuts` (D10). **Nunca** pela caixa conectada do cliente
(500–2.000/dia, §2.1) — sai pelo Resend com domínio autenticado. HubSpot separa formalmente por esse
motivo: caixa em volume alto vira blocklist.

---

## 11. Decisão de modelagem: `channelConfigs` ou tabela nova?

`channelConfigs` hoje é profundamente WhatsApp: `createChannelConfig` exige 5 campos Meta ou 3 bridge
e rejeita mistura; `channelResolve.ts` recusa não-whatsapp; `channelPacing`, `campaigns` e
`aiSettings` todos filtram por `channel === "whatsapp"`.

**Recomendação: estender `channelConfigs`** (o comentário do schema já diz "union-ready"), mas
introduzir **um resolvedor irmão** em vez de alargar `channelResolve.ts` — este é usado por enqueue,
claim, commit e dispatch do WhatsApp, e mexer nele coloca em risco o caminho que já está em produção.
Ponto de decisão acima dele, ramificando por `conversation.channel`.

---

## 12. Fases e prioridades

| Fase | Entrega | Esforço | Custo recorrente | Depende de |
|---|---|---|---|---|
| **F0 · P0** | Corrigir `testMode` + bounce/complaint + convite (§4) | **~1 dia** | R$ 0 | nada |
| **F1 · P1** | **Captura inbound**: `/webhooks/email`, endereço por org, allowlist, threading, anexos, dedupe, conversa de e-mail no inbox, `findOrCreateContactByEmail`, fila de não resolvidos | **2–3 semanas** | R$ 0 | F0 |
| **F2 · P1** | **Envio pelo CRM**: composer de e-mail (assunto, HTML, anexos), `Reply-To` da conversa, eventos de entrega no `deliveryStatus`, BYO key do Resend | **1–2 semanas** | R$ 0 | F1 |
| **F3 · P1** | **UI e onboarding**: card "E-mail" em Canais, endereço gerado na hora, instruções de encaminhamento com aviso *redirect ≠ forward*, **botão "Testar configuração" com veredito imediato**, `ChannelHealthPanel`, `emailAck` | **1 semana** | R$ 0 | F2 |
| **F4 · P2** | **`gmail.send`**: OAuth próprio (httpAction, `state` assinado, refresh cifrado), enviar do endereço real do cliente | **1–2 semanas** + 3–5 dias de análise Google | R$ 0 | F3 |
| **F5 · P2** | **Zoho REST com polling 60s** (funciona no free, onde IMAP não existe); região no schema | **2 semanas** | R$ 0 | F3 |
| **F6 · P3** | **Leitura da caixa**: Gmail `readonly`/`modify` com CASA, **ou** Unipile, **ou** Graph para M365 | **4–8 semanas** + auditoria | US$ 540–1.800/ano ou € 50–900/mês | decisão comercial |
| **F7 · P3** | Campanha por e-mail reusando `campaigns` | 1–2 semanas | R$ 0 | F2 + F6? não |

**O corte recomendado:** F0→F3 entrega um canal de e-mail **completo nos dois sentidos**, em ~5–7
semanas, com **zero custo recorrente e zero dependência de aprovação de terceiro**. F4 é o upgrade de
menor custo/benefício a seguir (resolve a objeção "tem que sair do meu endereço" por R$ 0). F6 só com
um cliente nominal pedindo, porque é a única parte que custa dinheiro e tempo de auditoria.

**Mapeamento dos 4 clientes:**

| Cliente | Atendido em | Como |
|---|---|---|
| Gmail pessoal | **F1** | encaminhamento → captura; F4 para enviar do endereço dele |
| Google Workspace | **F1** | idem; F6 se quiser histórico/label espelhado |
| Zoho Mail | **F1** | captura (funciona **inclusive no free**); F5 para sync por API |
| Resend | **F1+F2** | nativo — é a própria infra |

---

## 13. Riscos que vão morder

1. **`testMode`** — está quebrado agora, em silêncio (§4).
2. **Gmail exige código de confirmação** no endereço de destino para ativar encaminhamento —
   automatizável porque o endereço é nosso, mas tem que estar no fluxo de F3, senão o onboarding
   emperra.
3. **MX tem que ser em subdomínio dedicado** e de menor prioridade — mexer no MX do cliente quebra o
   e-mail dele.
4. **Região do Zoho** — errar o `accounts-server` dá `invalid_code`, que parece bug de código.
5. **Zoho free sem IMAP** — descobrir depois de construir worker seria caro.
6. **CASA da Google** — teto de 100 usuários trava lançamento; decidir cedo entre esperar ou pagar.
7. **Corpo HTML > 1 MiB** — documento do Convex não aceita; D7 resolve, mas tem que ser desde o início.
8. **Jobs agendados concorrentes = 8** no Starter — qualquer worker de e-mail compete com os crons que
   já rodam.
9. **Egress de arquivo é cobrado "inside functions"** — reler anexo numa action custa.
10. **Redirect URI dev ≠ prod** (subdomínios diferentes do Convex). Registrar os dois, e considerar
    custom domain antes de uma revisão da Google.
11. **`@convex-dev/auth` não serve** para conectar contas externas — confirmado por leitura do código:
    o `callbackAction` recebe `{ profile, tokens, signature }` e **descarta `tokens`**; `authAccounts`
    não tem campo para guardá-los. O OAuth de "conectar caixa" é código novo.
12. **Se for para Graph (M365): `clientState` não é HMAC.** O segredo viaja no payload. Tratar como
    identificador, não como prova, e manter a allowlist/roteamento como a defesa real.
13. **Worker externo falha em silêncio** — se algum dia houver um, heartbeat por caixa desde o primeiro
    dia. É a classe de falha do incidente de HMAC/events do bridge, onde a lacuna não era o código, era
    o monitoramento.

---

## 14. Fora de escopo (explícito)

Restore de backup de e-mail; XLSX; sequências/drip por e-mail; calendário/convites (.ics); assinatura
rica por vendedor; rastreamento de abertura como métrica (D9); IMAP próprio (§2.5); Mail360 (webhook
sem HMAC).

---

## 15. Checklist de verificação antes de implementar

- [ ] Reconfirmar que inbound do Resend está incluído no plano contratado.
- [ ] Probe de 5 min para fechar a questão do socket TCP em Node action, **se** alguém ainda quiser o
      caminho IMAP: `convex/tcpProbe.ts` com `"use node"` + `tls.connect({host:"imap.gmail.com",port:993})`.
- [ ] Confirmar o teto real de request da `httpAction` (a doc se contradiz: "no specific limit" na
      página de limites vs "20MB" na de HTTP actions). Tratar 20 MB como teto seguro.
- [ ] Validar com jurídico o texto do `emailAck` (§9).

---

## 16. Relatórios de pesquisa (íntegra)

Os cinco relatórios que embasam este plano, com fontes por afirmação e marcação
CONFIRMADO/ESTIMATIVA, estão em `temp/email-research/` (diretório gitignored, mesmo padrão de
`temp/visao-atendente/` usado no plano de visão):

| # | Tema | Linhas |
|---|---|---|
| 01 | Auditoria do repo — e-mail e abstração de canal, com caminho:linha | 572 |
| 02 | Gmail + Google Workspace — escopos, CASA, Pub/Sub, threading, envio | 713 |
| 03 | Zoho, IMAP genérico, M365, inbound-por-webhook, agregadores | 707 |
| 04 | Restrições do runtime Convex — tabela de limites, OAuth, veredito | 448 |
| 05 | Padrões dos CRMs reais — HubSpot/Pipedrive/Salesforce/Attio/Front + LGPD BR | 413 |
