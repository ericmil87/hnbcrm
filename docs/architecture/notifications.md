# Notificações: sino, preferências, push e PWA

> Mapa e regras da área (v0.79, 11/2026). O detalhe de cada decisão continua nos arquivos de origem, linkados abaixo; aqui fica o contrato e o que não pode ser quebrado.

## Estado atual

Um aviso nasce em `createNotification` (`convex/lib/notify.ts`), vira linha em `notifications` (o sino) e sobe uma escada de canais externos (Telegram, push, e-mail de reserva) decidida pela política `shouldDeliver`. O app é um PWA instalável com service worker que recebe o push. Módulos: `notifications.ts` (leitura/escrita do sino), `notificationPreferences.ts`, `push.ts` + `pushNode.ts`, `lib/notify.ts`, `lib/notificationResolve.ts`, `lib/notificationCopy.ts`, `lib/notificationPolicy.ts`, `lib/notificationPrefs.ts`, `lib/notificationChannels.ts`, `lib/webPush.ts`, `lib/pushStore.ts`; no front `src/components/notifications/`, `src/sw.ts`, `src/lib/push/`, `src/lib/pwa/`.

## Contrato: lida num lugar, lida em todos

Um aviso lido (sino, Telegram, push aberto, conversa aberta) está lido em todos os canais. Consequências: o push relê `readAt` antes de sair (`push.internalDeliverPush`); o e-mail de reserva só sai se o aviso ainda estiver não lido (`onlyIfUnread`); ao abrir o app o aparelho fecha as notificações já lidas. Nenhum canal lê o estado de outro: tudo passa por `readAt` da linha do sino.

## Decisões, pegadinhas medidas e histórico

### Resolução: `resolveEntityNotifications` (B1)

Quando o assunto do aviso foi resolvido em outro lugar (conversa aberta, pedido de ajuda assumido, rascunho revisado, tarefa concluída, canal reconectado), as não lidas daquela entidade viram lidas e guardam `data.resolvedBy/At/Reason`. É a **porta única**: nenhum código faz patch de `readAt` à mão (`notificationResolveCallSites.test.ts`). Alvos: conversa, repasse, tarefa, canal (`channelConfigId`) e conexão Meta. Leitura por índice com `readAt` ausente e `take`; resolver é idempotente. Transferir a conversa ou trocar o dono do lead resolve as não lidas do responsável anterior (`conversation_transferred_away`, `lead_reassigned`). Detalhes: [`ai-attendant.md`](ai-attendant.md) (dedupe do rascunho), [`tasks.md`](tasks.md) (tarefas), [`inbox.md`](inbox.md) (transferência).

### Agrupamento, destinatário e texto (B2)

- `createNotification({coalesce})` agrupa por `coalesceKey` (ex. `new_message:{conversationId}`): enquanto existir uma não lida, a nova mensagem faz patch (contador em `data.count`, `createdAt` renovado, título/prévia novos) em vez de inserir; depois de lida abre um aviso novo. Vale para `new_message`, `ai_draft_pending` e `group_mention` (janela de 10 min). Patch só chega a Telegram/push com `telegramOnPatch` (uma saída por janela do chamador). Exceção medida: `group_mention` (`telegramOnPatch` + `pushOnlyAfterRenotifyWindow`) manda CADA menção ao Telegram, mas o PUSH do patch só sai se passou a janela de renotify (5 min, `PUSH_RENOTIFY_MS`) do último toque que de fato saiu; `pushRenotifyAt` só avança quando o push é realmente agendado (pausa, silêncio, preferência desligada ou sem aparelho não contam como toque; `dispatchNotificationChannels` devolve `{pushScheduled}`).
- `new_message` é por membro: o ingest 1:1 (`lib/telegramRelay.maybeBufferInboundForRelay`) agrupa por 20 s e entrega ao destinatário de `resolveRelayRecipient`: o responsável da conversa (`assignedTo` humano) antes do dono do lead; com ou sem Telegram. Ver [`inbox.md`](inbox.md) e [`telegram.md`](telegram.md).
- **Todo título/corpo vem de `notificationCopy`** (`lib/notificationCopy.ts`): fuso da organização, corte por grafema, `<bdi>`, telefone e e-mail nunca no texto (sem nome vira "Contato"), prévia preferindo `translatedText` com "(traduzido do …)". Tipo novo exige schema + `PREFERENCE_FLAG` + `notificationCopy` + `TYPE_ICON` no front + decisão de Telegram (`notificationTypesParity.test.ts`).

### Política de entrega e preferências (C1)

`lib/notificationPolicy.shouldDeliver({type, channel, prefs, orgDefaults, now})` é pura e devolve `deliver | hold_paused | hold_quiet | off` para sino/e-mail/Telegram/push. Preferências em `notificationPreferences` (`channels`, `preset`, `pausedUntil`, `quietHours`, `urgentBypass`, `showPreview`; única escrita `patchMemberPrefs`) com padrão da organização em `organizations.settings.notificationDefaults`. Sino de tipo **acionável** (`ACTIONABLE_TYPES`) nunca desliga; as preferências mandam em e-mail, Telegram e push. Pausa e silêncio seguram os canais externos (o que é segurado não é reenviado); o sino sempre registra; pedido de ajuda urgente fura (`urgentBypass`). `/pausar` do Telegram e a pausa do app gravam o mesmo `pausedUntil`, mas o alcance difere: `/pausar` pausa TODAS as organizações do chat vinculado, a pausa do app vale só para a organização atual (comportamento mantido de propósito). Toda escrita das preferências novas passa por `patchMemberPrefs` (`setPreset`, `setChannelPref`, `pauseFor`, `resume`, `setQuietHours`, `updateMyPreferences` e o PUT REST/MCP `internalUpsertPreferences`); só `markMemberNotificationsRead` (membro removido) e `expireStaleUnreadNotifications` (retenção de 30 dias) escrevem `readAt` fora da porta de resolução, de propósito (não são "assunto resolvido"). O resumo diário roda de hora em hora, seleciona orgs com hora local em [8h, 12h) (depois das 12h do dia sem envio, o dia é perdido) e carimba `lastDailyDigestDate`. Detalhe e testes: [`email.md`](email.md) (`notificationPrefsC1.test.ts`, `lib/notificationPolicy.test.ts`).

### Sino como caixa de entrada (D1)

`notifications.list` filtra `unreadOnly` e `group` (`lib/notificationGroups.ts`), `markRead`/`markUnread`/`markAllRead` (em lotes, por grupo), `unreadSummary` (badge = `unseen`, contado desde `markSeen`) e a contagem de novidades por organização para o seletor. Itens resolvidos trazem quem assumiu. Escopo `inbox:view_own` (só ele; `lib/inboxScope.seesWholeInbox`): badges do menu contam só o que é seu. Front: `NotificationBell`/`NotificationPanel`/`NotificationInboxList`, chegada em tempo real por marca d'água de `createdAt` (`detectArrivals`) e toast sem repetir nem avisar da conversa aberta. Detalhe: [`frontend.md`](frontend.md) (D1 front) e [`inbox.md`](inbox.md) (D1 back).

### Escada de canais (E1)

`createNotification` chama `dispatchNotificationChannels` (`lib/notificationChannels.ts`), único lugar dos tempos:

1. **Telegram**: imediato (ver [`telegram.md`](telegram.md)).
2. **Push**: só se o membro tem ao menos um aparelho vinculado (`pushSubscriptionMembers.by_member`, `.first()`); sem vínculo, nenhum job. Só tipos de `PUSH_TEMPLATES` (os demais em `IGNORED_FOR_PUSH`).
3. **E-mail de reserva** (`SAFETY_NET_EMAIL_CLASS`): +10 min (pedido de ajuda, menção em tarefa), +30 min (tarefa atribuída/vencendo/atrasada), só se ainda não lido. `deadlineAt` encurta a espera (metade do que falta). Nunca agendar esses e-mails direto (`pushPort.test.ts`). Fora de propósito: `new_message`, `conversation_transferred` e `group_mention` não têm e-mail de reserva.

### Web Push (E1)

Portas: `lib/webPush.ts` (pura: payload, headers, classificação de erro) e `pushNode.ts` (`"use node"`, único arquivo que importa `web-push` 3.6.7, lê VAPID e chama o serviço de push). VAPID por deployment (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; pares diferentes em DEV e PROD, nunca versionados); sem chave pública o push fica desligado. Payload no formato Declarative Web Push (iOS 18.4+) com o objeto `hnb` para o SW clássico (`url` relativa `/app/abrir?org=&to=`, `renotify`, `badge`, `actionUrls`). Segurança: `subscribe` só aceita `https` de hosts de push conhecidos (SSRF), `redirect: "manual"`, argumentos agendados só com ids (endpoint, chaves e texto nunca ficam em `_scheduled_functions`). Erros: 404/410 apagam a assinatura; falha local, VAPID inválido, 3xx e rede nunca apagam (reagendam ou contam `failed`). A assinatura é do `userId`; o opt-in é por organização (`pushSubscriptionMembers`); aparelho sem uso por 60 dias sai na retenção. Tela de bloqueio nunca leva telefone, e-mail nem link; sem prévia (`showPreview` ou ocultada pela org) só "quem e o quê". Detalhe medido: [`security.md`](security.md).

### Service worker e assinatura no app (F1)

`src/sw.ts` trata `push`, `notificationclick` e `pushsubscriptionchange` sempre dentro de `event.waitUntil`, sem rede. Todo `push` mostra uma notificação (regra do iOS); payload ilegível vira "Novidade no HNBCRM" → `/app/painel`. Ações "Assumir"/"Abrir" só onde `actions` é suportado; "Assumir" apenas abre a tela de confirmação. `/app/abrir` é a única entrada de deep link externo e valida `org` e `to`. No app: `lib/push/subscription.ts` e `actions.ts` (ativar pede a permissão como primeiro `await` do toque; `resyncPush` a cada abertura; `disablePush`), `PushActivationCard`, `MyDevicesList` e `PushLifecycle` (fecha avisos lidos, convite contextual 1×/7 dias, logout desvincula todas as orgs). `PUSH_ENABLED` (`lib/featureFlags.ts`) é o kill switch de UI. Detalhe: [`frontend.md`](frontend.md).

### PWA, atualização e kill switch (A1/A2)

Manifest com `id` `/app/` e `scope` `/` (o login `/entrar` abre dentro do app instalado; no iOS o app instalado tem armazenamento próprio), SW registrado só em `/app/` de `vite-plugin-pwa` (`injectManifest`, `registerType: "prompt"`) sem cache de runtime (Convex e storage vão sempre à rede), atualização só em momento seguro (texto digitado bloqueia), `MIN_CLIENT_BUILD`, convite de instalação e rascunho do composer. Kill switch do SW: `PWA_KILL_SWITCH=1` num build. Detalhe: [`frontend.md`](frontend.md) (A1/A2).

## Integração pós-v0.79 (fios soltos)

- Fonte única do destino por tipo: `notificationTargetPath` (`lib/notificationTargets.ts`; o push e o clique do sino usam). `NON_PERSONAL_FLAGS`, `ACTIONABLE_TYPES` e `PUSH_PREFERENCE_FLAGS` (flags com template de push) saem de `lib/notificationPolicy.ts` para o front (teste de paridade).
- Concluir/cancelar tarefa por `updateTask` (Kanban, seletor, calendário) resolve os avisos (`task_completed`/`task_cancelled`); excluir tarefa resolve também `task_comment_mention` (a conclusão não). Excluir lead resolve os avisos das conversas e repasses dentro do orçamento da cascata (`lead_deleted`).
- Responder ao cliente (app, Telegram, REST/MCP/Copiloto) resolve os `new_message` e `conversation_transferred` do próprio remetente humano (`replied`, `resolveRepliedNotifications`). `markConversationRead` resolve os avisos do próprio leitor com `inbox:view_own`; recibo e `unreadCount` seguem exigindo `view_all`.
- Índice aditivo `notifications.by_conversation_and_member_and_read`: a resolução com `memberId` lê só as não lidas dele; o dedupe do rascunho usa `.first()` em `by_member_and_coalesce_and_read` (chave `coalesceKeys.aiDraft`). Sem membro, o teto de 1000 se mantém.
- REST/MCP `GET /api/v1/notifications/preferences` também devolve `preset`, `channels`, `pausedUntil`, `quietHours`. Modelo: flags = canais externos; o sino acionável registra sempre.
- Obsoletas (mantidas para clientes em cache; remover após 15/11/2026): `notificationPreferences.getMyPreferences`, `updateMyPreferences`, `getMemberPreferences` (agora exige `team:manage`) e `notifications.unreadCount`. O template de e-mail `newMessage` foi removido (nada o usava).
- `auto-atribuir` um lead não manda e-mail `leadAssigned` (o sino já pulava). A purga de usuário apaga os aparelhos de push pela porta `deletePushSubscription`.

## Pendências conhecidas

- `triggerReminder` (lembrete disparado à mão) não gera aviso no sino.
- Follow-up da IA atribuído ao dono humano da tarefa não gera `task_assigned`.

- Canal como ícone em cada aviso: o doc da notificação não traz o canal; hoje o ícone é o do tipo.
- A conversa aberta no detalhe do lead (`?lead=`) ainda gera toast: só `?conversation=` em `/app/entrada` conta como aberta.
- `getConversations`, `getHandoffs` e `tasks.getTaskCounts` não aplicam o escopo `view_own` no backend (a lista mostra mais do que o badge conta). Se uma for apertada, as demais (inclusive buscas) vão juntas.
- E-mail de reserva desligado para `new_message`, transferência e menção em grupo (o template `newMessage` legado foi removido).
- Sessão expirada não cancela a assinatura: só o logout explícito desvincula; o aparelho segue recebendo até outra conta assinar ou o aparelho expirar (60 dias).
- Painel de métricas do push (entregues, falhas, expiradas) não foi feito.
- Validar no E2E, em aparelho real, `renotify` e o formato Declarative no iOS 18.4+.
