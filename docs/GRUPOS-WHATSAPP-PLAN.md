# Grupos de WhatsApp no CRM — plano v1 (TEMPORÁRIO, para aprovação)

Data: 2026-09-16. Base: main v0.56 (commit 965df56). Nada implementado ainda.
Insumos: levantamento do código (bridge/ingest/dispatch/campanhas/IA/UI), sondagem READ-ONLY
do gateway gerenciado (`aftvps.hnbcrm.com`, wuzapi **v1.0.8**, swagger salvo em scratchpad) e
pesquisa externa (wuzapi/whatsmeow no fonte Go, Meta Groups API, Chatwoot/Evolution).

**Status por etapa:** `docs/GRUPOS-WHATSAPP-STATUS.md` (cada agente atualiza ao fechar a fase).

**Ordem combinada com o Eric:** primeiro a API NÃO-oficial (bridge/wuzapi). A API oficial
(Meta Groups API) fica na §14 só como esboço e **só é detalhada depois do OK do Eric no caminho
do bridge** — ver lembrete no fim do arquivo.

## 0. O que o Eric pediu (tradução em requisitos)

| # | Requisito | Onde entra |
|---|---|---|
| R1 | Acompanhar grupos de WhatsApp dentro do CRM (ler o que acontece) | §3 (modelo) + §4 (ingest) + §8 (inbox) |
| R2 | Interagir com os grupos (responder, mencionar, reagir, enquete) | §5 (envio) + §8 |
| R3 | Bridge (wuzapi/whatsmeow) primeiro; Meta oficial só depois do OK | §1 + §14 |
| R4 | Ver o que o whatsmeow que já roda permite e o que vale a pena | §1 + §2 (D1–D14, "fazer / não fazer") |
| R5 | Integração com os outros módulos (leads, contatos, tarefas, campanhas, notificações, auditoria) | §3.4 + §7 + §9 |
| R6 | O que a IA pode fazer com grupos | §9 (atendente de grupo, resumo, radar de oportunidade, copiloto) |
| R7 | Mandar mensagem em massa para certos grupos usando/melhorando campanhas | §7 |
| R8 | Postagem automática periódica ("todo dia às 12h o Guardião posta no grupo XYZ"), com IA ou mensagens prontas em sequência/aleatório | §6 (publicações programadas) |
| R9 | ~~Não implementar nada ainda~~ → em 16/09 o Eric mandou implementar com agentes; status por etapa em `docs/GRUPOS-WHATSAPP-STATUS.md` | §11 + STATUS |
| R10 | Disparo em massa **1 a 1 para os membros de um grupo** sem o ciclo "exportar CSV → importar" — algo mais fácil, com UX e backend pensados | §7.1 (D15) |

## 1. O que o gateway e as libs oferecem HOJE (verificado 16/09/2026)

### 1.1 wuzapi v1.0.8 rodando em `aftvps.hnbcrm.com` (medido)
- 6 instâncias, 2 logadas (Acme Corp Test e Aos Filhos da Terra). Instância sem grupo: `GET /group/list` devolve `{"Groups": null}` — vem `null`, não `[]` (mesma pegadinha do `data:null` do histórico). **Grupo real medido em 16/09 ("Grupo-Teste-Eric", criado pelo Eric com o Cláudio dentro) — ver 1.1.1.**
- Todas assinam só `Message, ReadReceipt, LoggedOut, TemporaryBan, ClientOutdated` (`BRIDGE_WEBHOOK_EVENTS`, `convex/lib/bridgeSession.ts:118`). O runtime aceita `GroupInfo`, `JoinedGroup` e `Picture` como eventos de primeira classe (lista real em `constants.go`, 40+ tipos; o README/swagger que fala em 6 está desatualizado). Basta incluir na lista e reconectar — o connect já reescreve `users.events` (v0.56).
- **18 rotas `/group/*`** (header `token`; GET com `?groupJID=`, POST com `GroupJID`): `list`, `info`, `invitelink` (`reset` revoga), `inviteinfo {Code}`, `join {Code}`, `leave`, `create {Name, Participants[]}`, `updateparticipants {Action: add|remove|promote|demote, Phone[]}`, `requestparticipants`, `updaterequestparticipants {approve|reject}`, `joinapprovalmode`, `announce`, `locked`, `ephemeral {24h|7d|90d|off}`, `name`, `topic`, `photo` (só JPEG base64), `photo/remove`. `API.md` do repositório documenta só 12 — o resto só existe em `routes.go`/`handlers.go`.
- Shape de `/group/info` (= item de `/group/list`): ver o JSON real em 1.1.1 (o swagger está incompleto). Sem paginação de participantes (`/group/participants` → 404). JID inexistente devolve **HTTP 500 com `success:true` e sem `error`**.
- **Envio para grupo = mesmo `/chat/send/*`** com `Phone` = `1203…@g.us` (o `parseJID` aceita JID completo se tiver `@`). Vale para text/image/audio/document/video/sticker/location/contact. Menção: `ContextInfo.MentionedJID: ["55…@s.whatsapp.net"]`. Quote em grupo exige `ContextInfo.StanzaId` **e** `Participant` = JID do MEMBRO autor (hoje `whatsapp.ts:461` monta `${toPhone}@s.whatsapp.net`, errado para grupo). `markread` em grupo: `ChatPhone` = JID do grupo, `SenderPhone` = autor.
- Enquete: `POST /chat/send/poll {Group, Header, Options[]}` — campo `Group`, não `Phone`; opções ficam **só em memória do processo** (`clientManager.SetPollOptions`): reiniciou o wuzapi, o voto chega como hash sem texto. Existem `send/edit`, `chat/delete` (é revoke para todos), `chat/react` (`Id: "me:…"` para a própria), `send/buttons`/`send/list` (não funcionam de verdade no bridge em 2026).
- Participantes: `/user/info`, `/user/check`, `/user/avatar` aceitam JID de membro, mas **nenhum devolve nome**. Nome só vem do `PushName` de cada mensagem recebida ou da agenda (`GET /user/contacts` — 62 contatos, 33 chaveados por `@lid`). Telefone↔LID: `GET /user/lid/{phone}` devolve `{jid, lid}` (só no sentido telefone→LID); `POST /user/info` pelo telefone traz `LID`, mas pelo LID **não devolve o telefone**. Para LID→telefone a fonte é o `PhoneNumber` de `Participants[]` em `/group/info`.

#### 1.1.1 Grupo real medido (Grupo-Teste-Eric, instância Acme, 16/09/2026)
```json
{"code":200,"data":{"Groups":[{"AddressingMode":"lid","AnnounceVersionID":"1789592106103843","CreatorCountryCode":"BR",
 "DefaultMembershipApprovalMode":"","DisappearingTimer":7776000,"GroupCreated":"2026-09-16T17:55:06-03:00",
 "IsAnnounce":false,"IsDefaultSubGroup":false,"IsEphemeral":true,"IsIncognito":false,"IsJoinApprovalRequired":false,
 "IsLocked":false,"IsParent":false,"JID":"120363431849092219@g.us","LinkedParentJID":"","MemberAddMode":"all_member_add",
 "Name":"Grupo-Teste-Eric","NameSetAt":"2026-09-16T17:55:06-03:00","NameSetBy":"180002129735765@lid",
 "NameSetByPN":"558181392929@s.whatsapp.net","OwnerJID":"180002129735765@lid","OwnerPN":"558181392929@s.whatsapp.net",
 "ParticipantCount":0,"ParticipantVersionID":"1789592106103843",
 "Participants":[
   {"AddRequest":null,"DisplayName":"","Error":0,"IsAdmin":false,"IsSuperAdmin":false,"JID":"92965187932215@lid","LID":"92965187932215@lid","PhoneNumber":"558192985729@s.whatsapp.net"},
   {"AddRequest":null,"DisplayName":"","Error":0,"IsAdmin":true,"IsSuperAdmin":true,"JID":"180002129735765@lid","LID":"180002129735765@lid","PhoneNumber":"558181392929@s.whatsapp.net"}],
 "Suspended":false,"Topic":"","TopicDeleted":false,"TopicID":"","TopicSetAt":"0001-01-01T00:00:00Z","TopicSetBy":"","TopicSetByPN":""}]},"success":true}
```
Achados que mudam o desenho:
- **`AddressingMode: "lid"` e `Participants[].JID` vem `@lid`**; o telefone já vem resolvido em `PhoneNumber` (e `OwnerPN`/`NameSetByPN`/`TopicSetByPN`). O modelo guarda os DOIS (`lid` + `phone`) por participante e casa mensagens (`Sender` `@lid`) pelo LID, não pelo telefone.
- **`ParticipantCount` vem `0` no `/group/list` e `2` no `/group/info`** — contar `Participants.length`, nunca confiar no campo da lista.
- Campos de comunidade existem (`IsParent`, `LinkedParentJID`, `IsDefaultSubGroup`) e também `IsIncognito`, `IsJoinApprovalRequired`, `MemberAddMode`, `Suspended`, `CreatorCountryCode`, `DisappearingTimer` (o grupo nasceu com temporárias de 90 dias — default do aparelho do Eric; a IA/publicação precisa saber que o conteúdo some).
- `/group/info` é byte a byte o item da lista (só o `ParticipantCount` difere). `DisplayName` vazio nos dois membros (confirma: nome só via PushName).
- O NOSSO LID (`92965187932215@lid` = Cláudio, 558192985729) é a chave para "somos admin?" e para detectar menção a nós — `/session/status` devolve `jid:""`, então o canal guarda `bridgeLid` resolvido por `GET /user/lid/{bridgePhone}`.
- `GET /chat/history?chat_jid=…@g.us` grava por `Info.Chat` sem filtrar `IsGroup` (`wmiau.go:1236`), então o histórico opt-in da v0.56 vale para grupos sem mudança no gateway. Linha: `id, user_id, chat_jid, sender_jid (LID), message_id, message_type, text_content, media_link, timestamp (gravação, UTC), data_json`.

**Mensagem de grupo REAL (evento whatsmeow cru, salvo em `convex/__fixtures__/bridgeGroupMessage.json`, sem o `messageSecret`):**
```json
{"Info":{"Chat":"120363431849092219@g.us","Sender":"180002129735765@lid","IsFromMe":false,"IsGroup":true,
 "AddressingMode":"lid","SenderAlt":"558181392929@s.whatsapp.net","RecipientAlt":"","ID":"2A38BE827E5EFDAC743C",
 "Type":"text","PushName":"Eric Milfont","Timestamp":"2026-09-16T18:04:41-03:00","MediaType":"","Edit":"", "...":"..."},
 "Message":{"extendedTextMessage":{"text":"ola tudo bem? a palavra é pernambucana",
   "contextInfo":{"expiration":7776000,"disappearingMode":{"initiator":2,"trigger":2,"initiatedByMe":false}}}},
 "IsEphemeral":false,"IsEdit":false,"RawMessage":{"...":"idêntico a Message"}}
```
- É o mesmo objeto que chega em `POST /webhooks/bridge` dentro de `event` — a fixture testa `parseBridgeEvent` direto, envolvida no envelope `{ type: "Message", event, instanceId }` que os testes já usam.
- **`Info.Sender` é o LID do membro e o telefone vem em `Info.SenderAlt`** (modo `lid`); em grupo modo `pn` é o inverso. `PushName` é do membro que falou — a única fonte de nome. Texto curto com temporárias vem como `extendedTextMessage` (não `conversation`) por causa do `contextInfo.expiration` — o parser cobre os dois.
- Ainda falta medir (F0): `fromMe` em grupo, menção (`contextInfo.mentionedJid`), quote (`stanzaId` + `participant`), mídia, reação, `Receipt.MessageSender`, `ChatPresence`, `GroupInfo`, `JoinedGroup`.
- HistorySync do connect na 1.0.8 percorre `GetJoinedGroups`; `GET /chat/history?chat_jid=…@g.us` e `GET /session/history?chat_jid=` aceitam JID de grupo — o histórico opt-in da v0.56 é reaproveitável.

### 1.2 whatsmeow (eventos)
- Mensagem de grupo é o `Message` de sempre com `Info.IsGroup: true`, `Info.Chat` = grupo, `Info.Sender` = membro (com privacidade LID: `Sender` vem `@lid` e o MSISDN em `SenderAlt` — o parser de LID que já temos em `bridgeParse.ts:330-341` serve; hoje ele só descarta em `:312-319`, "plan U2 scope").
- `GroupInfo`: mudança de nome/tópico/foto/admins + `Join[]`/`Leave[]`/`Promote[]`/`Demote[]`, `JoinReason`, `NewInviteLink`. `JoinedGroup`: nós entramos/fomos adicionados (`Reason`, `Type: "new"` se acabou de ser criado, GroupInfo embutido).
- `Receipt` em grupo: `Sender` é sempre a nossa conta; **quem leu está em `MessageSender`**. `ChatPresence` em grupo: `Chat` = grupo, `Sender` = quem digita.
- wuzapi não transforma nada: `postmap.type = "GroupInfo"` e o evento inteiro em `event`.

### 1.3 Risco de banimento (não-oficial)
- Issue #810 do whatsmeow (fechada "not planned"): contas "at risk"/banidas mesmo com baixo volume — é detecção do cliente, não só de spam. Discussão #274: ban ao `CreateGroup()` com participantes. Sinais anti-ban conhecidos (`docs/AI-WHATSAPP-LIMITS.md:425`): ~3 adds/10 min, 2 criações/10 min, contatos do mesmo grupo 10.
- Conclusão: **ler e responder em grupos onde já estamos é o menos arriscado; criar grupo e adicionar gente é o mais arriscado.** Nenhum limite é oficial — estimativa calibrável, mesma filosofia das campanhas (avisar + aceite auditado, não travar).
- Teto estrutural: 1024 membros/grupo; comunidade até 2000 pessoas.

### 1.4 Meta Groups API (oficial) — só para situar a fase 2
- Já lançada (doc de 16/06/2026), para Official Business Account: **máx. 8 participantes por grupo**, 10.000 grupos por número, **só o negócio cria** e convida por link/template `group_invite_link`; **não existe `POST /participants`** (só remover e aprovar pedidos); sem botões/lista, sem editar/apagar; webhooks `group_lifecycle_update`, `group_participants_update`, `group_settings_update`, `group_status_update` (a Meta pode SUSPENDER o grupo por nome/foto). Envio = `POST /messages` com `recipient_type: "group"`; inbound traz `group_id` + `from` do participante; status pode vir agregado por participante ("não garantido"). Categorias `group_marketing|group_utility|group_service`. É "sala de atendimento com o cliente", não comunidade — detalhes na §14.

## 2. Decisões de produto (recomendação — confirmar)

| # | Decisão | Alternativa descartada |
|---|---|---|
| D1 | **Grupo = 1 conversa** (`conversations.kind: "group"`, `externalChatId` = JID `@g.us`), com metadados em tabela própria `groupChats`. Reaproveita inbox, mídia, busca, recibos, reações, labels, arquivamento e dispatch. | Tabela paralela `groupMessages` — duplica 100% do inbox. Grupo como contato+lead — polui o funil e o dashboard com um "lead" que é uma sala. |
| D2 | **`leadId` vira opcional em `conversations`/`messages`** (só para `kind: "group"`); eventos de grupo vão para `auditLogs` + `groupChats.timeline[]` (cap 100), como campanhas fizeram com `activities.leadId` obrigatório. | Lead sintético "Grupo X" — quebra métricas de pipeline e permite mover "o grupo" de estágio. |
| D3 | **Membros NÃO viram contato/lead automaticamente.** Ficam em `groupChats.participants[]` (JID, telefone se houver, nome via PushName, admin, entrou/saiu) com `contactId` só quando o telefone JÁ bate com um contato da org. Promoção a lead é ação explícita ("Criar lead deste membro" → contato + lead + conversa 1:1) ou sugestão da IA (§9.3). | Auto-criar contato por membro — 300 membros = 300 contatos fantasma, LGPD (dados de quem nunca falou com a empresa) e ruído no funil. |
| D4 | **Acompanhar é opt-in POR GRUPO** (`groupChats.monitored`): o CRM lista todos os grupos do número, mas só ingere mensagens dos marcados. Default OFF, inclusive para grupos novos (evento `JoinedGroup` só cadastra). Mensagem de grupo não monitorado é descartada na porta, como hoje. | Ingerir tudo — o número pessoal do cliente está em grupos de família/escola; entrar no CRM sem querer é vazamento. |
| D5 | **`fromMe` em grupo entra como `outbound` "via device"** (mesmo tratamento da v0.56), sem `senderId`, sem mexer em contadores. | — |
| D6 | **IA no grupo é um produto próprio (`groupAgent`) e default OFF por grupo**, com modo `mention` (responde só quando @mencionada ou quando respondem a uma mensagem dela) como único modo automático na v1; `suggest`/`autopilot` herdados do atendente. Tools de lead (`moveThisLead`, `qualifyThisLead`…) NÃO existem no grupo — só `replyToGroup`, `requestHandoff` e `flagOpportunity`. Tetos próprios por grupo (default 10/h, 30/dia) e persona com bloco "VOCÊ ESTÁ NUM GRUPO" (§9.1). | Reusar o atendente 1:1 — responderia a TODA mensagem de TODO membro (tetos 20/conversa estourariam em minutos) e chamaria tools de lead sem lead. |
| D7 | **Publicações programadas (`groupPosts`)**: uma publicação = destino(s) + agenda (horários/dias/fuso/início/fim) + fonte de conteúdo (`library` = lista de mensagens prontas em ordem sequencial ou aleatória, com mídia; ou `ai` = prompt + persona gera "mensagem do dia") + política de aprovação. Worker = job auto-reagendado por publicação com `tickToken`, molde do `campaignWorker.tick`. | Estender `scheduledMessages` — é one-shot, uma conversa, só texto. Cron global — pior para pausar por publicação. Reusar recorrência de tasks — ela gera "próxima ao completar", não "todo dia 12h". |
| D8 | **Aprovação humana opcional na publicação por IA**: o texto é gerado N minutos antes (default 60), vira `pendingApproval` (notificação `group_post_pending`); sem aprovação até a hora, `onMissedApproval: skip` (default) ou `send`. Biblioteca fixa não precisa de aprovação (o humano já escreveu). | Sempre autopilot — a "mensagem do dia" errada no grupo do cliente não tem undo. |
| D9 | **Disparo em massa para grupos = campanha com `audience.source: "groups"`** (recipient = grupo, 1 por JID), mesmo worker/pacing/kill switches/relatório; tetos próprios e mais baixos (bridge: 20 grupos/dia, ≥ 60 s entre grupos, sem checkNumbers). Sem Meta na v1 (§14). | Motor separado para grupos — duplica wizard, worker e relatório. |
| D10 | **Gestão de grupo no bridge é por fases de risco**: v1 = listar, entrar por link (`join`), sair, renomear/tópico/foto/anúncio/lock nos grupos em que somos admin. **Criar grupo e adicionar/remover membros ficam na F6**, atrás de aceite "ENTENDO" + `settings:manage` + tetos (2 criações/10 min, 3 adds/10 min, ≤ 10 adds/dia) auditados. | Liberar tudo na v1 — é a operação com relato direto de ban. Bloquear para sempre — somos ferramenta. |
| D11 | **RBAC sem categoria nova**: ler/responder no grupo = `inbox` (mesmos níveis); marcar "acompanhar", política de IA, entrar/sair = `settings:manage`; publicações programadas e massa = `campaigns` (`manage` cria/pausa, `full` ativa/cancela). | Categoria `groups` — mais uma coluna no editor de permissões por pouco ganho; pode vir na v2 se o uso pedir. |
| D12 | **Aceites**: ligar grupos num canal bridge exige o `bridgeAiAck`-like **`bridgeGroupsAck`** ("API não-oficial, grupos aumentam a exposição, a Meta pode banir") gravado no canal + audit `high`. Publicação por IA exige `orgAiActive` + `groupAgent.enabled`. | — |
| D13 | **Opt-out de campanha NÃO se aplica em grupo** (`applyCampaignInboundHooks` desligado para `kind: "group"`): "SAIR" escrito por um membro no grupo não pode marcar opt-out de ninguém, muito menos do grupo. Opt-out de grupo = desmarcar "acompanhar"/sair. | — |
| D15 | **Membros de um grupo são um PÚBLICO nativo de campanha** (`audience.source: "group_members"`, D3 preservado: contato/lead só nasce no envio, como qualquer campanha). Sem CSV: escolhe os grupos, filtra, vê a prévia e lança. É o padrão de spam mais vigiado ("mensagem para quem não te tem na agenda", "contatos do mesmo grupo: 10"), então tem teto próprio por grupo/dia + aceite `groupMembersDmAck` + modo seguro que espalha o envio em dias. | Export CSV de membros → import na campanha (dois passos, perde o vínculo com o grupo, sem teto por grupo). |
| D14 | **Enquete só na v2** (opções ficam em memória do wuzapi; reinício perde a correspondência do voto). Reação, quote e menção entram na v1. Botões/lista ficam fora (não funcionam no bridge). | — |

## 3. Modelo de dados

### 3.1 `groupChats` (nova)
```
organizationId, channelConfigId, conversationId?          // conversa kind:"group" (criada ao marcar monitored)
jid: string                                                // "1203…@g.us" (chave)
subject, topic?, ownerJid?, pictureUrl?, createdAtWa?
isAnnounce, isLocked, isEphemeral, disappearingTimer?, isCommunityParent?, linkedParentJid?
weAreAdmin: boolean, weAreSuperAdmin: boolean
addressingMode: "lid" | "pn", participantsCount (= Participants.length), participants: [{ lid?, phone?, name?, isAdmin, isSuperAdmin, contactId?, joinedAt?, leftAt? }]   // cap 1024; chave = lid ?? phone; nome via PushName (cache oportunista)
monitored: boolean (D4), monitoredSince?, monitoredBy?
ai: { mode: "off" | "mention", replyMode: "inherit" | "suggest" | "autopilot", maxPerHour?, maxPerDay?, extraInstructions? }   // D6
summary?: { text, at, model }                              // último resumo (§9.2)
leftAt?, removedAt?, lastSyncAt, lastMessageAt?
timeline: [{ at, type, actorJid?, data? }] (cap 100)       // join/leave/promote/rename/link
índices: by_organization, by_channel_config, by_channel_config_and_jid, by_organization_and_monitored, by_conversation
```

### 3.2 `groupPosts` (publicações programadas, D7)
```
organizationId, name, status: draft | active | paused | ended
targets: [{ groupChatId }]                                  // 1..N grupos do MESMO canal (v1)
schedule: { timezone, times: ["12:00"], days: [1..7], startAt?, endAt?, jitterMinutes?: 0..30 }
content:
  kind: "library" | "ai"
  library?: { items: [{ text, attachmentFileIds?, contentType }], order: "sequential" | "random", noRepeatWindow?: number, cursor?: number }
  ai?: { prompt, persona?: "attendant" | "custom", useKnowledge: boolean, maxChars?: 600, generateMinutesBefore: 60, requiresApproval: true, onMissedApproval: "skip" | "send" }
pending?: { text, attachmentFileIds?, generatedAt, dueAt, status: "pendingApproval" | "approved" | "rejected", approvedBy?, editedText? }
stats: { sent, skipped, failed, lastSentAt?, lastError? }
schedulerFnId?, tickToken?, nextRunAt?
createdBy, createdAt, updatedAt
índices: by_organization, by_organization_and_status, by_next_run
```
Cada envio vira `messages` na conversa do grupo com `metadata.groupPost { postId, itemIndex?, generated: bool }` + `scheduled: true` (typing humanizado), e passa por `applyOutboundMessageSideEffects` → pacing/dispatch existentes.

### 3.3 Alterações em tabelas existentes
- `conversations`: `kind?: "direct" | "group"` (ausente = direct), `externalChatId?`, **`leadId` opcional** (D2), `groupChatId?`; índice `by_channel_config_and_external_chat`. `contactPresence` vira lista curta `typingParticipants?: [{ jid, name?, at }]` só para grupo.
- `messages`: **`leadId` opcional** (D2), `senderJid?`, `senderName?`, `senderContactId?`, `mentions?: [jid]`, `quotedParticipantJid?`; `metadata.group { participantJid }`. `readBy?: [{ jid, at }]` (cap 50, a partir de `Receipt.MessageSender`).
- `channelConfigs`: `bridgeGroupsEnabled?`, `bridgeGroupsAck? { acceptedAt, acceptedBy }` (D12), `bridgeGroupsLastSyncAt?`.
- `campaigns.audience.source` += `"groups"`, `campaignRecipients.groupChatId?` (+ `phone` opcional quando for grupo), `campaigns.provider` continua.
- `notifications.type` += `group_post_pending`, `group_post_failed`, `group_mention` (alguém mencionou o nosso número), `group_opportunity` (§9.3); flags em `notificationPreferences` (`lib/notify.ts` `PREFERENCE_FLAG`).
- `aiConfig.products.groupAgent { order?, model? }` + `aiConfig.groupAgentEnabled` (default OFF, como `visionEnabled`).
- Backup JSON (`exports.ts` `BACKUP_TABLES`): + `groupChats`, `groupPosts`; `exportSanitize` não precisa de regra nova (sem segredo).

### 3.4 Integração com os módulos existentes
| Módulo | Como grupo entra |
|---|---|
| Inbox | Conversa `kind:"group"` na mesma lista, filtro "Grupos", nome do remetente na bolha, @menção no composer (§8) |
| Contatos/Leads | Membro com telefone conhecido mostra chip do contato; "Criar lead deste membro" (D3); aba "Grupos" no `ContactDetailPanel` (de quais grupos monitorados o contato participa — via `participants.contactId`) |
| Tarefas | "Criar tarefa a partir desta mensagem" (já existe para lead? se não, vem junto) com `conversationId` + link deep `/app/entrada?conversation=` |
| Campanhas | `audience.source:"groups"` (D9); chip de campanha na bolha já existe |
| Repasses | `requestHandoff` do agente de grupo cria handoff com `conversationId` e SEM `leadId` (hoje `handoffs.leadId` é obrigatório — vira opcional; o card mostra o nome do grupo) |
| Notificações | tipos novos da §3.3; menção ao nosso número no grupo notifica quem tem `inbox >= reply` |
| Auditoria | monitorar/desmonitorar, aceites, entrar/sair, ativar publicação, aprovação de post por IA, override de tetos |
| Webhooks | `group.joined`, `group.left`, `group.updated` (nome/admins/membros), `group.message.received`, `group.post.sent`, `group.post.pending`; registrar em `llmsTxt.ts` + `DevelopersPage.tsx` (listas manuais) |
| Histórico do aparelho (v0.56) | a varredura passa a incluir os `groupChats.monitored` (`chat_jid` do grupo); continua importando só `fromMe` |
| Export | CSV de "membros de grupo" (nome, telefone quando houver, admin, grupo) — útil para o cliente e fácil |

## 4. Ingest (bridge)

1. `BRIDGE_WEBHOOK_EVENTS` += `GroupInfo`, `JoinedGroup` (reconectar reescreve a assinatura — v0.56).
2. `parseBridgeEvent` ganha `kind: "group_message"` (em vez de `ignored/group`) com `{ chatJid, senderJid, senderPhone?, senderLid?, senderName, fromMe, externalId, content, media, quote{ stanzaId, participant }, mentions[] }`, e `kind: "group_info"` / `kind: "joined_group"`. Reação em grupo (`Message` com `reactionMessage`) → `group_reaction`. Presence em grupo → `group_presence`. Tudo em `lib/bridgeParse.ts`, puro, com fixtures medidas na F0.
3. `bridge.ts` `internalIngestBridgeMessage`: se `group_message`, resolve `groupChats` por `by_channel_config_and_jid`; **não existe ou `monitored:false` → no-op** (D4; grava só `lastMessageAt`/participante se existir). Se monitorado: idempotência por `externalId`; mídia pelo mesmo caminho (`internalSaveInboundAttachment`, allowlist/quota da v0.53, sem MediaKey no banco); `fromMe` → `internalReceiveGroupDeviceMessage` (D5); senão `conversations.internalReceiveGroupMessage` (nova, sem `leadId`): insere `messages` com `senderJid/senderName/senderContactId`, atualiza `lastInboundAt`, `unreadCount`, `groupChats.participants[]` (nome via PushName, `contactId` por `contacts.by_organization_and_phone` quando houver telefone), webhook `group.message.received`, transcrição/visão (mesmos gates), **não** `applyCampaignInboundHooks` (D13), e enfileira `groupAgent` só se `ai.mode === "mention"` e a mensagem menciona o nosso JID/LID ou cita mensagem nossa (§9.1).
4. `GroupInfo` → patch de `groupChats` (nome/tópico/admins/membros, timeline, `weAreAdmin`) + webhook `group.updated`; `Leave` contendo o nosso JID → `leftAt`, desmonitora, arquiva a conversa. `JoinedGroup` → upsert `groupChats` (monitored:false) + webhook `group.joined` + notificação para `settings:manage`.
5. `Receipt` em grupo: já resolve por `externalId`; acrescenta `readBy` com `MessageSender`. Status da mensagem outbound: `delivered` no 1º delivered, `read` no 1º read (o WhatsApp faz o mesmo na UI).
6. `bridge.syncGroups({ channelConfigId })` (action): `GET /group/list` → upsert `groupChats` (marca `removedAt` nos que sumiram), com `GET /admin/users` para saber o nosso JID e calcular `weAreAdmin` (o `/session/status` devolve `jid:""`). Rodar ao ligar `bridgeGroupsEnabled`, ao clicar "Atualizar" e 1x/dia por cron (só canais com grupos ligados).
7. Nosso JID/LID: guardar em `channelConfigs.bridgeLid` (`GET /user/lid/{bridgePhone}` → `data.lid`, medido) — necessário para `weAreAdmin` e para detectar menção a nós (`MentionedJID` pode vir em LID ou em telefone; comparar com os dois).

## 5. Envio para grupo

- `internalGetDispatchContext` (`whatsapp.ts:288`) passa a devolver `toPhone = conversation.externalChatId` quando `kind:"group"` (único ponto onde o destino nasce) e `dispatchViaBridge` manda `Phone: "…@g.us"` sem alteração de builders (`bridgeSend.ts` já usa `Phone`).
- Quote: `participant` vem de `messages.senderJid` da mensagem citada (não de `toPhone`). Menção: composer gera `mentions[]` (JIDs) → `ContextInfo.MentionedJID`; o texto carrega `@<número>` como o WhatsApp espera.
- Reação (`internalDispatchReaction`), markread (`ChatPhone` = grupo, `SenderPhone` = autor) e presence (`Phone` = grupo) só trocam o alvo.
- Pacing: `claimChannelSlot` continua por canal; a conversa de grupo é sempre "reativa" pelo `lastInboundAt` — ok para respostas. Publicações/massa usam `metadata.scheduled` (typing humanizado) e os tetos da §6/§7.
- Meta: `dispatchMessage` recusa `kind:"group"` em canal `meta` com erro claro até a §14.

## 6. Publicações programadas (R8)

- **Worker** `internal.groupPosts.tick` por publicação, auto-reagendado, `tickToken` anti-zumbi, `nextRunAt` calculado a partir de `schedule` no fuso (helper puro `lib/groupPostSchedule.ts` com `Intl.DateTimeFormat`, molde de `isWithinSchedule`/`nextWindowOpenAt`). Jitter opcional (0–30 min) para não postar "exatamente 12:00:00" todo dia.
- **Fonte `library`**: `order: sequential` (cursor persistido, volta ao início) ou `random` com `noRepeatWindow` (não repete os últimos N). Cada item aceita texto (spintax/`{{vars}}` de `lib/campaignRender.ts` — vars aqui são `{{grupo}}`, `{{data}}`, `{{dia_semana}}`) e mídia de `files`. Preview com `WhatsAppPreview`.
- **Fonte `ai`**: `generateMinutesBefore` antes do horário, `internal.groupPosts.generate` (action) chama a cadeia LLM do produto `groupAgent` com: prompt da publicação + persona (do atendente ou custom) + knowledge (opcional) + últimos N posts (para não repetir) + data/dia; grava `pending`. Com `requiresApproval`: notificação `group_post_pending` (in-app + e-mail) para `campaigns:manage`; a tela permite editar/aprovar/rejeitar. Na hora: aprovado → envia; pendente → `onMissedApproval`; rejeitado → `skipped`. Sem aprovação → envia direto (exige `campaigns:full` para configurar assim + aviso).
- **Tetos e segurança**: por canal bridge, ≤ 10 publicações automáticas/dia no total (calibrável, aviso ao passar), respeitar `campaignFrozenUntil` (131048-like não existe no bridge, mas `TemporaryBan` congela tudo), pausar automaticamente se o canal cair (`bridgeSessionState !== "connected"`) com notificação `group_post_failed`; canal que sair do grupo pausa a publicação. Kill switch manual e "Enviar agora" (teste) na UI.
- **Onde aparece**: página `/app/grupos` (aba "Publicações") — lista, wizard 3 passos (destinos → agenda → conteúdo/aprovação), histórico de envios (link para a mensagem no inbox). Casos: "todo dia 12h o Guardião posta a mensagem do dia (IA, aprovação)", "seg/qua/sex 09h uma dica da biblioteca em sequência", "sábado 18h a agenda da semana (texto fixo com `{{data}}`)".

## 7. Massa para grupos (R7) — campanhas

- Wizard: passo "Público" ganha "Grupos" (lista de `groupChats.monitored` do canal escolhido, com nº de membros e se somos admin); recipients = grupos. Conteúdo igual (variantes/spintax/mídia); "checar números" e "só janela aberta" não se aplicam.
- Worker: `sendToRecipient` bifurca em `recipient.groupChatId` → usa a conversa do grupo (não cria contato/lead); `replied` = qualquer mensagem de membro nos 7 dias seguintes (métrica "grupos que responderam"); sem opt-out (D13).
- Pacing próprio em `lib/campaignPacing.ts` (`groupCaps`): bridge 20 grupos/dia, 8/h, ≥ 60 s entre grupos (jitter), teto duro 50/dia; número < 3 dias exige `newNumberRiskAck` como hoje. Aviso extra no lançamento: "mensagem igual em N grupos é padrão clássico de spam; prefira variantes".
- Relatório: sent/delivered/read por grupo (delivered/read no 1º recibo), membros alcançados (soma de `participantsCount`, estimativa).

### 7.1 Disparo 1 a 1 para os membros de um grupo (R10, D15)

**UX (três portas de entrada, todas caem no mesmo wizard já preenchido):**
1. Wizard de campanha → passo Público → cartão **"Membros de grupos"**: lista de grupos monitorados (nome, N membros, N com telefone, N já contatos) com seleção múltipla; filtros: excluir admins, excluir quem já é contato/lead, excluir quem recebeu campanha nos últimos N dias, só quem falou no grupo nos últimos N dias (engajados primeiro), excluir membros de outro grupo escolhido. Prévia em tempo real: **total → com telefone → sem duplicata entre grupos → sem opt-out → destinatários finais**, com amostra de 10 nomes (PushName) e telefone mascarado. Canal = o do grupo (travado).
2. Página `/app/grupos` e header do grupo no inbox → botão **"Disparar 1 a 1 para os membros"** → abre o wizard com o grupo já selecionado.
3. Painel de membros (slide-over) → seleção por checkbox → **"Disparar para selecionados"** (vira público `manual` com os telefones e `groupChatId` de origem) e **"Criar leads dos selecionados"** (ação humana explícita em lote, respeita D3).

**Backend:**
- `campaigns.audience` ganha `groupChatIds?: Id<"groupChats">[]` + `memberFilters?: { excludeAdmins?, excludeExistingContacts?, excludeCampaignedWithinDays?, activeInGroupWithinDays?, excludeGroupChatIds? }`; `campaignRecipients` ganha `sourceGroupChatId?` (de qual grupo veio — relatório "resposta por grupo de origem") e `memberName?` (PushName, usado como `{{nome}}` quando não há contato).
- `previewAudience`/snapshot: telefone = `participants[].phone` (já vem resolvido em `PhoneNumber`), `lib/phone.ts` normaliza, dedupe entre grupos (o primeiro grupo escolhido vence como `sourceGroupChatId`), `optOuts` aplicados, `activeInGroupWithinDays` lê `messages.by_conversation` do grupo (últimos N dias, `senderLid`).
- Envio = `sendToRecipient` de sempre (cria contato → lead → conversa 1:1 no board/estágio escolhido, fonte "Campanha", tag `campanha:<slug>` + tag `grupo:<slug do grupo>`), sem `checkNumbersFirst` (o membro está no WhatsApp por definição).
- **Tetos (`lib/campaignPacing.ts`, `groupMemberCaps`)**: por grupo de origem ≤ 10 membros/dia (sinal anti-ban documentado) e por canal os tetos bridge normais; modo seguro **espalha automaticamente** o público em dias (o wizard mostra "N destinatários → ~M dias"); fora do modo seguro exige "ENTENDO" + `campaigns:full`, teto duro 50/grupo/dia. Meta (F7) não tem esse limite (é a Cloud API cobrando), mas D15 só entra no bridge na v1.
- Aceite `groupMembersDmAck` no lançamento (além de `consentAck` + `bridgeRiskAck`): "estou mandando mensagem privada a pessoas que não iniciaram conversa; isso é o padrão mais bloqueado pelo WhatsApp". Audit `high` com grupos, filtros e contagem.
- `applyCampaignInboundHooks` funciona igual na DM (é conversa 1:1); `replied` por membro; o relatório agrupa por `sourceGroupChatId`.
- Copiloto/REST/MCP: `previewCampaignAudience` e `createCampaignDraft` aceitam `groupChatIds` + `memberFilters`.

## 8. UI

- **Inbox**: conversa de grupo na lista com ícone de grupo, nome = `subject`, subtítulo "N membros"; filtro "Grupos"/"Diretas"; bolha mostra `senderName` (cor estável por JID, avatar com inicial) e chip do contato se `senderContactId`; "digitando…" lista nomes; composer com `@` para mencionar membro (autocomplete de `participants`), reagir/citar já existem; header: membros (slide-over com lista, admin, "Criar lead", "Abrir contato"), "Ver no funil" some, menu ⋮ com "Parar de acompanhar", "Sair do grupo" (confirmação), "Resumo por IA" (§9.2). Rascunho de IA (`AiDraftCard`) funciona igual.
- **Configurações → Canais → card do número bridge**: painel "Grupos" (ao lado do `BridgeHistoryPanel`): interruptor "Grupos neste número" (com o aceite D12), botão "Atualizar lista", lista dos grupos (nome, membros, admin?, monitorado?), por grupo: toggle "Acompanhar", política de IA (off/mencionada + suggest/autopilot + tetos), "Entrar em grupo por link" (cole o link → `inviteinfo` → confirmar → `join`).
- **Página `/app/grupos`** (item de menu "Grupos", gate `inbox:view_own`): aba "Grupos" (visão geral: grupos monitorados, atividade 7 dias, últimas mensagens, oportunidades da IA) e aba "Publicações" (§6). Opcional v1.1: aba "Gestão" (F6).
- **Contato**: aba "Grupos". **Lead**: nada (grupo não é lead).

## 9. IA nos grupos (R6)

### 9.1 Agente de grupo (responde quando chamado)
- Gatilho: mensagem de membro que menciona o nosso JID/LID (`MentionedJID`), cita uma mensagem nossa, ou (opcional por grupo) contém palavra-chave (`ai.keywords`). Fila `aiReplyQueue` com `origin: "group_mention"`, debounce igual, lock por conversa igual, commit transacional igual (`internalCommitAiReply` re-checa elegibilidade: org ativa, `groupAgentEnabled`, `groupChats.ai.mode`, `bridgeGroupsAck`, tetos por grupo, horário do atendente, canal conectado).
- Prompt: persona do atendente + bloco "VOCÊ ESTÁ NUM GRUPO com N pessoas; responda só ao que foi perguntado a você; nunca revele dados de outro cliente; não confirme pagamento (D13 da visão); para assunto individual, convide para o privado" + histórico com `de: "membro:<nome>"` (envelopado como não-confiável) + `INFORMAÇÕES DA SUA EQUIPE` (notas). Tools: `replyToGroup` (com `mentionJids?`), `requestHandoff` (notifica humanos), `flagOpportunity` (§9.3). Sem tools de lead/contato (D6). Simulador `simulateAttendant` ganha `senderName?` por turno e um alternador "grupo".
- Modo `suggest` (default): o rascunho aparece no inbox como hoje. `autopilot` só com o gate do atendente já vencido OU `autopilotRiskAck` (v0.55).

### 9.2 Resumo e monitoramento (leitura, baixo risco, alto valor)
- "Resumo por IA" sob demanda no header do grupo (últimas 24h/7 dias: temas, perguntas sem resposta, decisões, quem falou mais) → grava `groupChats.summary`.
- Digest diário opcional por grupo (`ai.dailyDigestAt`): resumo + "perguntas sem resposta" enviados como notificação in-app/e-mail para quem tem `inbox >= reply` — o gerente lê 5 linhas em vez de 200 mensagens.
- Alertas: menção ao nosso número (`group_mention`, sem LLM), palavra-chave configurável (ex. "reclamação", "cancelar"), link/spam (heurística).

### 9.3 Radar de oportunidade (IA → lead)
- Passe barato por mensagem (ou por lote de 15 min) só nos grupos com `ai.opportunityRadar: true`: classifica "intenção de compra/pedido de orçamento/dúvida sobre produto" → notificação `group_opportunity` com o membro, a mensagem e o botão "Criar lead + puxar para o privado" (cria contato/lead/conversa 1:1 e abre um rascunho de DM). A IA **nunca** manda DM sozinha (ban + LGPD) — D3.
- Runs em `agentRuns` com `kind: "group_radar"`, custo visível na tela de IA.

### 9.4 Copiloto
- Tools de leitura: `listGroups`, `getGroupDetail` (membros/atividade), `getGroupSummary` (usa 9.2), `listGroupPosts`, `getGroupPostHistory`. Escrita: `createGroupPostDraft`, `pauseGroupPost` (direto), `activateGroupPost` e `sendGroupMessage` via `pendingActions` (confirmação humana), `createLeadFromGroupMember`. `TOOL_DENYLIST` += `internalSyncGroups` e tudo que devolve `channelConfigs` (o retorno de `listGroups` não pode carregar o doc do canal; `SECRET_FIELD_PATTERN` já barra token).

## 10. RBAC, REST, MCP, webhooks
- App: D11. REST (`router.ts`, rotas FLAT + entrada em `ROUTE_PERMISSIONS`, `routerPermissions.test.ts` cobra): `GET /groups`, `GET /groups/get?groupChatId=`, `POST /groups/monitor`, `POST /groups/send` (texto/mídia/menção), `GET /groups/messages`, `POST /groups/sync`, `GET/POST /group-posts/*` (list/get/create/update/activate/pause/approve). MCP: `crm_list_groups`, `crm_get_group`, `crm_send_group_message`, `crm_list_group_posts`, `crm_create_group_post`, `crm_approve_group_post` (wrappers sobre REST). Sem `join/leave/create` em REST/MCP na v1.
- Webhooks: lista da §3.4; `message.received` continua só para diretas (payload atual tem `leadId` obrigatório — não quebrar consumidores).

## 11. Fases e entregáveis

| Fase | Conteúdo | Arquivos principais | Testes |
|---|---|---|---|
| **F0 — Medição (1 dia, sem código de produto)** | Grupo já existe (Grupo-Teste-Eric, JID `120363431849092219@g.us`, Cláudio + Eric); `/group/list`, `/group/info`, `/user/lid`, `/user/info` JÁ medidos (1.1.1). `Message` de grupo em texto JÁ capturada (`convex/__fixtures__/bridgeGroupMessage.json`). Falta: assinar `GroupInfo`/`JoinedGroup` na instância Acme e capturar as demais fixtures REAIS de webhook: `Message` de grupo (Sender `@lid` + `SenderAlt`), `fromMe` em grupo, menção, quote, reação, `Receipt` com `MessageSender`, `ChatPresence`, `GroupInfo` (rename/add/remove), `JoinedGroup`, `/group/list` + `/group/info` (com/sem comunidade), `/chat/history` de grupo, `/user/lid`. Registrar pegadinhas (`Groups:null`, 500 com `success:true`). | `docs/GRUPOS-F0-FIXTURES.md`, `convex/__fixtures__/bridgeGroup*.json` | — |
| **F1 — Núcleo backend** | Schema §3 (`groupChats`, `leadId` opcional em conversations/messages/handoffs, campos novos), parser (§4.2), ingest de grupo (§4.3–4.5), `syncGroups`, nosso JID/LID no canal, dispatch para `@g.us` + quote/menção/reação/markread/presence (§5), aceite D12, audit, webhooks, backup. Tocar as 3 cópias do núcleo de side effects (`internalReceiveMessage`, `sendMessage`, `scheduledMessages.deliver`) para aceitar conversa sem lead. | `schema.ts`, `lib/bridgeParse.ts`, `bridge.ts`, `conversations.ts`, `whatsapp.ts`, `lib/bridgeSend.ts`, `lib/bridgeSession.ts`, `groupChats.ts` (novo), `channelConfigs.ts`, `exports.ts` | `bridgeGroupIngress.test.ts`, `bridgeGroupDispatch.test.ts`, `groupChats.test.ts`, regressão das suítes de bridge |
| **F2 — UI base** | Inbox com grupos (§8), painel "Grupos" no card do canal, página `/app/grupos` (aba Grupos), aba no contato, "Criar lead deste membro", rota/menu/permissões. | `src/components/Inbox.tsx`, `inbox/MessageBubble.tsx`, `inbox/GroupMembersPanel.tsx`, `settings/ChannelsSection.tsx` (`BridgeGroupsPanel`), `src/components/groups/*`, `main.tsx`, `Sidebar.tsx` | — (E2E vivo) |
| **F3 — Publicações programadas** | `groupPosts` + worker + schedule puro + biblioteca (sequencial/aleatório) + IA com aprovação + notificações + UI (aba Publicações + wizard) + audit/webhooks. | `convex/groupPosts.ts`, `convex/groupPostWorker.ts`, `lib/groupPostSchedule.ts`, `lib/notify.ts`, `src/components/groups/posts/*` | `lib/groupPostSchedule.test.ts`, `groupPosts.test.ts` (fake timers, aprovação, missed, canal caído) |
| **F4 — IA** | Agente de grupo (`groupAgent`, menção/cita, tools restritas, tetos, prompt), resumo/digest, radar de oportunidade, simulador com grupo, copiloto tools + pendingActions, `TOOL_DENYLIST`, config por produto (`products.groupAgent`) + UI em Configurações → IA. | `attendant.ts` (ou `groupAgent.ts` novo reaproveitando o núcleo), `lib/agentTools.ts`, `copilot.ts`, `aiSettings.ts`, `AiSection.tsx` | `groupAgent.test.ts`, `agentToolSecurity.test.ts`, `copilotGroups.test.ts` |
| **F5 — Campanhas: grupos e membros** | (a) `audience.source:"groups"` (§7), recipients por grupo, `groupCaps`; (b) **`audience.source:"group_members"` (§7.1, D15)**: filtros, prévia com funil de contagem, dedupe, `sourceGroupChatId`, `groupMemberCaps` com espalhamento em dias, `groupMembersDmAck`; wizard (cartões de público novos, 3 portas de entrada), relatório por grupo de origem, REST/MCP/copiloto. | `campaigns.ts`, `campaignWorker.ts`, `lib/campaignPacing.ts`, `lib/campaignAudience.ts` (novo, puro), `CampaignWizard.tsx`, `CampaignDetail.tsx`, `groups/*` | `campaignsGroups.test.ts`, `lib/campaignAudience.test.ts`, `lib/campaignPacing.test.ts` |
| **F6 — Gestão avançada (opcional, risco)** | Criar grupo, add/remove/promote/demote, link de convite (mostrar/resetar), aprovação de pedidos, com "ENTENDO" + tetos + audit `high`. | `groupChats.ts`, `lib/bridgeGroups.ts`, UI aba "Gestão" | `groupManagement.test.ts` |
| **F7 — Meta Groups API** | **BLOQUEADA até o OK do Eric no caminho bridge.** Esboço na §14. | — | — |
| **F8 — E2E vivo + docs** | Acme Corp Test (bridge real) com grupo de teste: ingest, menção, IA em suggest, publicação 12h (biblioteca e IA com aprovação), campanha para 2 grupos; ajustar tetos; CLAUDE.md, landing, `llmsTxt`, Termos (cláusula de grupos). | `docs/GRUPOS-E2E-REPORT.md` | — |

Ordem sugerida: F0 → F1 → F2 (valida R1/R2 cedo) → F3 (R8, o pedido mais concreto) → F4 → F5 → review (code-review + security-review) → F8. F6 e F7 só com aprovação explícita.

## 12. O que fazer primeiro e o que NÃO fazer (resumo de prioridade)

**Fazer (v1):** ler grupos monitorados no inbox; responder/mencionar/citar/reagir; nome do remetente; sincronizar lista de grupos; entrar por link e sair; publicações programadas (biblioteca + IA com aprovação); resumo/digest por IA; agente de grupo só quando mencionado; radar de oportunidade → lead manual; campanha para grupos com tetos baixos.

**Não fazer na v1:** criar grupos e adicionar membros pelo CRM (F6, risco de ban direto); auto-criar contato/lead por membro (D3); IA respondendo a tudo no grupo; DM automática da IA para membro; enquetes (D14); botões/lista; comunidades (só ler `linkedParentJid` se vier); Meta oficial (F7).

## 13. Segurança, LGPD e lacunas do código que a v1 fecha
- Multi-tenant: `groupChats` por `organizationId` + `channelConfigId`; o mesmo grupo em dois números da MESMA org gera dois `groupChats` (um por canal — e duas conversas; aceitável na v1, documentar). Exclusividade do número (v0.56) já impede o mesmo número em duas orgs.
- LGPD: membros de grupo são terceiros que não falaram com a empresa — por isso D3/D4 (opt-in por grupo, sem contato automático, radar só com o interruptor). Cláusula nova nos Termos e no `lgpdAck` (grupos monitorados guardam nome/telefone dos membros e conteúdo). Export/backup incluem `groupChats`; a cascata de exclusão de canal apaga `groupChats` + conversas de grupo (+ blobs via `lib/fileRefs.ts`).
- Anti-ban: D10/D12, tetos da §6/§7, `TemporaryBan` congela publicações e campanhas, aviso genérico ao ligar grupos num número com < 7 dias.
- Segredos: nada novo sai do servidor; `listGroups` nunca devolve o doc de `channelConfigs`.
- Lacunas que a v1 toca: (a) `leadId` obrigatório em `conversations`/`messages`/`handoffs`/`activities` (63 usos) — a F1 relaxa só onde grupo passa e usa `auditLogs`/timeline para o resto; (b) `whatsapp.ts:461` monta o `participant` do quote a partir do `toPhone` (errado para grupo); (c) `BRIDGE_WEBHOOK_EVENTS` sem eventos de grupo; (d) `jidToPhone` aplicado a `@g.us` devolveria o id do grupo como se fosse MSISDN — o parser precisa bifurcar ANTES; (e) `/group/list` devolve `null` para vazio, `ParticipantCount` da lista vem 0 e `/group/info` 500 com `success:true` — `parseBridge*Response` precisa tratar os três; (f) `contactPresence` é um único estado por conversa; (g) webhooks sem registry (`llmsTxt.ts` + `DevelopersPage.tsx`).

## 14. Fase 2 — API oficial (Meta Groups API) — ESBOÇO, aguardando OK do Eric

Só para o desenho da v1 não fechar portas. **Não detalhar nem implementar antes da aprovação do caminho bridge.**
- O que a Meta permite: grupo criado PELO NEGÓCIO (máx. 8 pessoas), convite por link enviado num template `group_invite_link` (utility), aprovação de entrada, remover membro, mensagens texto/mídia/template, pin. Não permite entrar em grupo de cliente, adicionar membro por API, botões/lista, editar/apagar.
- Encaixe no modelo: `groupChats.provider: "meta"`, `jid` = `group_id` da Meta, `participants` vindos de `GET /<GROUP_ID>?fields=participants`; ingest pelo `POST /webhooks/whatsapp` lendo `messages[].group_id` (+ `from` do participante); webhooks `group_lifecycle_update`/`group_participants_update`/`group_settings_update`/`group_status_update` (suspensão → pausar publicações/campanhas do grupo); status agregado por participante (`recipient_participant_id`) → `readBy`; dispatch `recipient_type: "group"`; categorias `group_*` no custo.
- Casos de uso reais com 8 pessoas: "sala do cliente" (cliente + família + vendedor + Guardião), grupo de projeto/obra, suporte VIP. Publicações programadas e agente de grupo funcionam igual; campanhas em massa para grupos Meta fazem pouco sentido (8 pessoas) — provavelmente fora.
- O que preciso do Eric antes de detalhar: se a org piloto tem OBA (Official Business Account) e o número está na Cloud API (não no app Business); se o caso "sala do cliente" interessa.

## 15. Perguntas abertas para o Eric
1. Aprova D3 (membro não vira contato/lead automaticamente) e D4 (acompanhar é opt-in por grupo)?
2. Agente de grupo só por menção (D6) basta na v1, ou quer o modo "palavra-chave" já na v1?
3. Publicações por IA com aprovação obrigatória por default (D8) — ok? Quem aprova: `campaigns:manage`?
4. Criar grupo/adicionar membro fica mesmo para a F6 (atrás de aceite) ou prefere fora do produto?
5. Ordem F3 (publicações) antes de F4 (IA) — ok? É o pedido mais concreto ("todo dia às 12h").
6. Nome da página: "Grupos" no menu principal, ou dentro de "Campanhas"?

---
**LEMBRETE (para o Claude e para o Eric):** quando o Eric aprovar o caminho da API NÃO-oficial
(este plano, F0–F6), o próximo passo pendente é **detalhar e concluir a F7 (Meta Groups API, §14)**
neste mesmo arquivo — não deixar a fase oficial esquecida.
