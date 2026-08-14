# Relatório — desconexão do bridge WhatsApp (Acme Corp Test) — 2026-08-14

**Org:** `m575gcmmkm2c2brzxtg1b70q518ate72` (Acme Corp Test)
**Canal:** `GuardTeste2` — provider `bridge` (wuzapi/whatsmeow), instância `org_m575gcmmkm2c2brzxtg1b70q518ate72_mrs6ks1c`, número `+55 81 9298-5729`
**Deployment:** dev `tacit-chicken-195`
**Fuso de todos os horários:** America/Recife (UTC−3)

---

## 1. Resumo executivo

Durante a janela de testes E2E desta manhã, os envios pelo canal bridge falharam com `no session` e o Eric precisou reler o QR para re-parear. **A desconexão em si não foi causada pelo nosso código** — foi perda de sessão do lado do gateway não-oficial, o risco documentado da API não-oficial. Confiança alta (não há nenhuma mutação, deploy ou chamada nossa capaz de deslogar uma sessão whatsmeow, e o canal ficou 7 dias sem tráfego nenhum antes de falhar).

Mas a investigação achou **três defeitos nossos** que transformaram um soluço rotineiro do gateway em uma pane silenciosa — e **um deles ainda está ativo agora**:

| # | Defeito | Estado |
|---|---|---|
| **A** | **Zero detecção.** Nada monitora a saúde do canal: não há cron, nem polling, nem notificação. `bridgeSessionState` só muda quando um humano clica em "Testar conexão" ou abre o modal do QR. O canal exibiu **"Conectado"** durante os 7 dias em que estava morto. | aberto |
| **B** | **Entrada quebrada desde o re-pareamento.** Depois do QR, **todos** os webhooks de entrada passaram a ser rejeitados com HTTP 401 (assinatura HMAC inválida/ausente). 40 requisições rejeitadas entre 07:06:25 e 07:13:58 = **8 eventos de entrada perdidos em definitivo** (5 tentativas cada, backoff 30/60/120/240 s, e aí o gateway desiste). | **ATIVO — mensagens recebidas não entram no CRM** |
| **C** | **Assinatura de eventos degradada.** A instância no gateway está inscrita hoje só em `events = "Message"`. No provisionamento pedimos `Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated` (`convex/lib/bridgeSession.ts:157-160`). Sem `ReadReceipt` não há mais tiques de entregue/lido; sem `LoggedOut` não chega nem o aviso de queda. | aberto |

**Veredito:** *instabilidade normal do gateway não-oficial (a queda) + bug nosso de observabilidade e de recuperação (o resto)*. A queda ia acontecer de qualquer jeito; o que não podia acontecer é a gente descobrir por acaso, no meio de um teste, 7 dias depois — e voltar do QR com a entrada ainda quebrada.

> **Ação imediata sugerida:** o canal está enviando mas **não recebendo**. Reexecutar `POST /session/hmac/config` na instância (hoje só o provisionamento faz isso, `convex/channelConfigs.ts:697-705`) e reasserir `events`. Ver §6.1.

---

## 2. Linha do tempo

| Quando | O quê | Fonte |
|---|---|---|
| 2026-07-19 16:20:33 | Canal `GuardTeste2` provisionado (instância `…_mrs6ks1c`), com `events` completo e `hmacKey` armado. | `auditLogs` (`channelConfig/create`, `createdAt=1784488833582`) |
| 2026-08-06 16:54:28 | Falha isolada de envio: `could not decode base64 encoded data`. **Não relacionada** — é erro do pipeline de mídia, não de sessão. | `messages.metadata.deliveryError` |
| **2026-08-07 19:12:39** | **Última atividade bridge saudável.** Outbound entregue e lido (`externalId 3EB0F6D98FD847EDBA7F4C`), precedido de inbound às 19:12:26. Tiques de leitura funcionando ⇒ `ReadReceipt` ainda estava inscrito. | `messages` (`deliveryStatus:"read"`) |
| 2026-08-08 → 08-13 | **Silêncio total.** Zero mensagens de entrada ou saída no canal por ~7 dias. Ninguém percebeu nada porque ninguém usou o canal. | `messages` (nenhum registro na janela) |
| ~2026-08-10 17:20 | **Provável atualização/redeploy do gateway.** O `index` estático servido por `https://aftvps.hnbcrm.com/` tem `last-modified: Mon, 10 Aug 2026 20:20:09 GMT`. O registro do usuário no gateway hoje traz campos (`s3_config`, `proxy_config`) que não existiam na versão de julho ⇒ build mais novo. | `curl -I` na raiz do gateway; `GET /admin/users` |
| **2026-08-14 06:55:09** | **Primeira falha.** Envio do atendente → `Falha no envio pelo bridge: no session`. | `messages.metadata.deliveryError` |
| 06:55:41 / 06:56:35 | Rascunhos da IA gerados normalmente (a IA nunca quebrou). | `messages` `direction:"internal"` |
| 06:57:06 | Segunda falha, mesmo erro `no session`. | idem |
| ~07:00–07:06 | Eric abre Configurações → Canais → **Mostrar QR** e re-pareia. O modal fez 48 chamadas de `getBridgeQrCode` (polling de 4 s) e 50 de `internalRecordHealthCheck`. | `convex logs` |
| **07:06:18** | Health check grava `bridgeSessionState:"connected"`, `healthDetail:"Conectado como +558192985729"`. Sessão de volta. | `channelConfigs.lastHealthCheckAt=1786701978172` |
| **07:06:25** | **Primeiro webhook rejeitado**: `Bridge webhook signature invalid for instance org_…_mrs6ks1c — rejected` → HTTP 401. 8 eventos distintos (provavelmente o backlog offline + receipts) começam a ser recusados. | `convex logs`, `POST /webhooks/bridge` |
| 07:06:32 | **Envio volta a funcionar**: mensagem "oie" com `externalId 3EB0A8D7802E9BB2503F7C`, `deliveryStatus:"sent"`. | `messages` |
| 07:06:55 / 07:07:55 / 07:09:55 / 07:13:55 | Re-tentativas do gateway: backoff 30 s → 60 s → 120 s → 240 s. Todas 401. | `convex logs` |
| **07:13:58** | Última tentativa. Total: **40 requisições = 8 eventos × 5 tentativas**. O gateway desiste (`WEBHOOK_RETRY_COUNT=5`). **Os 8 eventos foram perdidos.** | `convex logs` |
| 08:07 (fim da coleta) | Nenhum webhook novo — mas também nenhuma mensagem nova chegou, então isso não é sinal de recuperação. Sessão segue `connected:true, loggedIn:true` no gateway. | `GET /admin/users` |

Um detalhe revelador: o JID atual é `558192985729:**12**@s.whatsapp.net`. O sufixo `:12` é o índice do dispositivo vinculado — este número já foi pareado **12 vezes**. Re-pareamento recorrente não é novidade nesse número de teste.

---

## 3. Causa provável

### 3.1 A queda da sessão (`no session`)

`no session` é literal no wuzapi: `handlers.go` responde 500 com essa string quando não existe um `*whatsmeow.Client` no mapa **em memória** para aquele token ([código](https://github.com/asternic/wuzapi/blob/919c72c9750b2a1eedf0fcf9c9592f05fe46f61c/handlers.go#L2791-L2806)). O mapa é volátil — some no restart do processo e é repovoado por `connectOnStartup()`, que tenta reconectar 3 vezes e desiste.

Hipóteses, em ordem de probabilidade:

**H1 — Restart/atualização do gateway em ~10/08 e a reconexão automática não pegou (mais provável).**
Evidências: o `last-modified` de 10/08 20:20 GMT; os campos novos (`s3_config`, `proxy_config`) no registro do usuário; e principalmente o fato de o `events` ter **regredido** de 5 eventos para só `Message` e o HMAC ter parado de assinar — duas mudanças de estado do lado do gateway que só um restart/migração explica em conjunto. O registro do usuário sobreviveu (token de julho ainda válido) ⇒ o volume persistiu; o que se perdeu foi o *device store* do whatsmeow ou a reconexão pós-boot.
*Confirmaria:* `docker logs` / uptime do container no VPS, data da imagem, e se o `users.connected` estava em `0` antes do QR.

**H2 — Remoção do dispositivo pelo lado do WhatsApp (enforcement silencioso).**
Existe um padrão real e reportado de `stream:error code="401" conflict type="device_removed"` aplicado a contas com perfil de envio suspeito, sem que o usuário tenha deslogado nada ([wuzapi #308](https://github.com/asternic/wuzapi/issues/308), [whatsmeow #877](https://github.com/tulir/whatsmeow/issues/877), [#989](https://github.com/tulir/whatsmeow/issues/989) — este último com suspensão marcada `BULK_MESSAGING`). Um número de teste que dispara respostas de IA se encaixa no perfil de risco.
*Confirmaria:* evento `LoggedOut` com `Reason: 401 device_removed` nos logs do container; ou um aviso no app do celular.

**H3 — Logout manual pelo celular** ("Dispositivos conectados" → desconectar).
*Confirmaria:* só o Eric sabe. Se ele não mexeu, descarta.

**H4 — Celular primário offline por mais de 14 dias.** O limite de 14 dias é [oficial da Meta](https://faq.whatsapp.com/378279804439436), mas aqui foram 7 dias e o celular do Eric é o dele. **Descartado.**

Não encontrei nenhuma fonte que documente uma sessão whatsmeow expirar só por **7 dias de ociosidade de tráfego** (distinto do celular offline). Ociosidade sozinha não explica; precisou de H1, H2 ou H3.

### 3.2 O 401 nos webhooks (esse eu consigo explicar com precisão)

O wuzapi assina o webhook com a `hmacKey` **por usuário**, lida de um cache em memória (`userinfocache`, `cache.NoExpiration`) — nunca do banco. E os dois caminhos que povoam esse cache são inconsistentes:

- `connectOnStartup()` (no boot, só para usuários com `connected=1`) povoa o cache **com** a chave HMAC ([wmiau.go](https://github.com/asternic/wuzapi/blob/919c72c9750b2a1eedf0fcf9c9592f05fe46f61c/wmiau.go#L328-L399)).
- `authalice` (middleware de auth, roda em **toda** requisição autenticada por token, no cache-miss) recarrega o usuário buscando só um booleano `hasHmac` e **nunca inclui a chave** ([handlers.go](https://github.com/asternic/wuzapi/blob/919c72c9750b2a1eedf0fcf9c9592f05fe46f61c/handlers.go#L138-L196)).

E o assinador só põe o header `x-hmac-signature` se conseguiu assinar — chave vazia ⇒ **header simplesmente não vai**, sem erro ([helpers.go](https://github.com/asternic/wuzapi/blob/919c72c9750b2a1eedf0fcf9c9592f05fe46f61c/helpers.go#L358-L389)). Nosso `verifyBridgeSignature` (`convex/lib/bridgeParse.ts:493-518`) retorna `false` tanto para assinatura errada quanto para header ausente, e o ingress devolve 401 (`convex/bridge.ts:100-103`) — daí a mensagem única no log.

Encadeando: o gateway reiniciou com o usuário `connected=0` (sessão caída) ⇒ `connectOnStartup` **não** rodou para ele ⇒ a primeira chamada autenticada por token repovoou o cache **sem** a chave. Ironicamente, **a nossa própria tentativa de envio das 06:55:09 e todo o polling do modal do QR** (`/session/status`, `/session/connect`, `/session/qr`) passam por `authalice` e ajudaram a fixar o cache no estado errado. Por isso o envio voltou e a entrada não.

Nosso código chama `POST /session/hmac/config` **só no provisionamento** (`convex/channelConfigs.ts:697-705`), com um comentário que já documentava esse bug do upstream desde o piloto de 19/07 — mas o remédio nunca foi aplicado no caminho de **re-pareamento**.

O padrão de retry observado bate exatamente com o upstream: `WEBHOOK_RETRY_COUNT=5`, `WEBHOOK_RETRY_DELAY_SECONDS=30`, backoff `30 × 2^(n-1)` ([helpers.go](https://github.com/asternic/wuzapi/blob/919c72c9750b2a1eedf0fcf9c9592f05fe46f61c/helpers.go#L303-L410)) — e 401 é retryado como qualquer outro não-2xx, sem parada antecipada.

### 3.3 Por que ninguém percebeu por 7 dias

Três lacunas somadas, todas nossas:

1. **`convex/crons.ts` não tem job de saúde de canal.** Os 4 crons são lembretes de tarefa, tarefas recorrentes, digest diário e formulários abandonados. `checkChannelHealth` só roda em clique de botão.
2. **O ingress descarta os eventos de sessão.** `parseBridgeEvent` (`convex/lib/bridgeParse.ts:419-454`) trata `message`, `receipt`, `reaction` e `chat_presence`; `LoggedOut`, `TemporaryBan`, `ClientOutdated`, `Disconnected` caem no `{kind:"ignored", reason:"unhandled type …"}`. Assinamos esses eventos no provisionamento e depois os jogamos fora.
3. **Falha de envio não mexe no canal.** `internalMarkDispatchFailed` (`convex/whatsapp.ts:795-826`) marca a *mensagem* como `failed` e escreve uma nota na timeline do lead. Não toca `channelConfigs.status`, não toca `bridgeSessionState`, não notifica ninguém. Dois envios podem falhar com `no session` e o card do canal continua verde escrito "Conectado".

---

## 4. Isso é normal?

**Em parte, sim — e o CLAUDE.md já avisa.** O provider `bridge` fala o protocolo do WhatsApp Web via whatsmeow, sem contrato com a Meta. Perder sessão e ter que reler o QR **faz parte do custo de usar a API não-oficial**, junto com o risco de banimento permanente.

Expectativa realista, sendo honesto sobre o que é documentado e o que é folclore:

- **Documentado e oficial:** dispositivo vinculado desloga se o celular primário ficar >14 dias sem uso.
- **Documentado no código:** restart do processo esvazia o mapa de clients; a recuperação depende de `connectOnStartup` reconectar (3 tentativas). Se o container reinicia sem volume persistente para o *device store*, o QR é obrigatório.
- **Reportado por terceiros, sem confirmação oficial:** "falsos 401 / device_removed" como enforcement silencioso contra padrão de envio suspeito.
- **Não confirmado:** que ociosidade de tráfego, sozinha, mate a sessão em ~7 dias.

O que reduz a frequência, em ordem de custo-benefício:

1. Volume persistente de verdade para o banco do wuzapi, e não colocar PgBouncer em *transaction pooling* na frente dele (causa raiz confirmada no [wuzapi #204](https://github.com/asternic/wuzapi/issues/204)).
2. Não reiniciar/atualizar o container no meio de uma janela de testes — e, quando atualizar, rodar o checklist de §6.1 logo depois.
3. Manter o pacing conservador que já existe (`convex/lib/whatsappDispatch.ts`) — rajada é o que atrai enforcement.
4. Manter o celular do número ativo e online.
5. Para qualquer coisa que precise de confiabilidade real, provider `meta`. O bridge é para teste e para quem aceitou o risco.

O que **não** é normal é o resto: ficar 7 dias cego, perder 8 eventos de entrada no re-pareamento, e voltar do QR com metade do canal quebrada.

---

## 5. RUNBOOK — é o gateway de testes ou é o código?

**Regra de ouro:** o Simulador do Atendente (Configurações → IA → botão **Testar**) exercita o LLM **sem tocar em WhatsApp nenhum** — ele nunca executa tools, nunca insere `messages`, nunca chama dispatch (`convex/attendant.ts:2550-2670`). Se o simulador responde e a mensagem real não sai, **o problema é canal, não código de IA.** Esse é o desempate mais rápido que existe; comece por ele.

### 5.1 Tabela sintoma → onde olhar → veredito

| Sintoma | Onde olhar | Veredito |
|---|---|---|
| Mensagem com **ícone vermelho** no balão do inbox e texto `Falha no envio pelo bridge: no session` embaixo (`src/components/inbox/MessageBubble.tsx:341-343` mostra `metadata.deliveryError` cru) | O próprio texto do erro | **Gateway** — sessão caída. Vá para §6.1 |
| `Falha no envio pelo bridge: <outra coisa>` (ex.: `could not decode base64 encoded data`) | Mesmo lugar | **Código nosso** — bug no payload/mídia (`convex/lib/bridgeSend.ts`, `convex/lib/bridgeMedia.ts`) |
| **Nada acontece**: mensagem sem tique, sem erro, parada | `npx convex logs` → procure `whatsapp:internalDispatchMessage`. Não apareceu? | **Código nosso** — o dispatch nem foi agendado (`convex/lib/whatsappDispatch.ts`) |
| Configurações → Canais mostra **"Conectado"** mas os envios falham | Clique em **Testar conexão** (`checkChannelHealth`) — o badge só é confiável *depois* do clique | Se virar **"Deslogado"** → **gateway**. Se seguir "Conectado" e falhar → investigar como código |
| Badge **"Deslogado"** / **"Aguardando QR"** / **"Reconectando"** | Card do canal | **Gateway** — releia o QR em **Mostrar QR** |
| **Mensagens recebidas não aparecem no inbox** | `npx convex logs` → `POST /webhooks/bridge`. Se vier `Bridge webhook signature invalid … rejected` (401) | **Gateway + nosso gap** — cache HMAC do wuzapi. §6.1 item 2. É exatamente o estado de hoje |
| Idem, mas o log diz `Bridge webhook for unknown/inactive instance … dropped` | Mesmo lugar | **Código/config** — `bridgeInstanceId` divergente ou `status != "active"` (`convex/bridge.ts:82-85`) |
| Idem, e **nenhum** `POST /webhooks/bridge` no log | `GET /admin/users` no gateway: confira `webhook` e `events` | **Gateway** — webhook desapontado ou evento não inscrito (foi o caso do `ReadReceipt` hoje) |
| Chip **"IA em espera: \<motivo\>"** no cabeçalho da conversa | `src/components/Inbox.tsx:35-50` traduz o código de `aiReplyQueue.error` | **Nem gateway nem bug**: é regra de elegibilidade (`fora_do_horario`, `ia_pausada`, `lead_de_humano`, `handoff_pendente`, `teto_hora`, `janela_24h`, `bridge_sem_aceite`…). Comportamento esperado |
| Chip **"IA em espera:"** com texto em snake_case ou em inglês | idem | **Código nosso** — código sem tradução (`lock_perdido`, `conversa_removida`, `rascunho_ja_revisado`) ou erro cru do LLM vazando |
| Chip **"IA preparando resposta…"** travado | `aiReplyQueue` da org: `status` `pending`/`processing` que não avança | **Código nosso** — lock/lease preso (`convex/attendant.ts`) |
| Simulador (Config → IA → **Testar**) **também** falha | Toast `Falha na simulação` | **LLM/provider**, não WhatsApp. Use o **Testar conexão** do card "Provider, modelos e privacidade" (`aiDiagnostics.pingProvider`) ou `npx convex run aiDiagnostics:pingChain '{}'` |
| Simulador responde **e** o envio não sai | — | **Canal.** Volte para as linhas de gateway acima |
| Painel **Saúde do canal** com banner "Taxa de falha alta (N%)" | `ChannelHealthPanel`, janela de 7 dias | **Gateway** provavelmente já degradado, ou número sob restrição |

### 5.2 Ordem de execução (2 minutos)

1. **Simulador** (Config → IA → **Testar**). Responde? A IA está sã — o problema é canal.
2. **Configurações → Canais → Testar conexão.** Este clique é o que atualiza o badge; sem ele, o estado na tela pode ter dias.
3. **`npx convex logs`** e procure, nesta ordem: `POST /webhooks/bridge` (entrada), `whatsapp:internalDispatchMessage` (saída), `signature invalid` (HMAC).
4. **Health do gateway** — `GET /session/status` com o token da instância. A URL fica em `channelConfigs.bridgeBaseUrl` (hoje o gateway gerenciado, env **`WA_BRIDGE_DEFAULT_URL`**); o token está cifrado em `bridgeTokenEncrypted` e **não deve ser extraído para uso manual** — prefira o botão "Testar conexão", que faz exatamente essa chamada pelo servidor (`convex/channelConfigs.ts:426-473`). Para visão de frota, `GET /admin/users` com **`WA_BRIDGE_ADMIN_TOKEN`** lista `connected`, `loggedIn`, `jid`, `events` e `webhook` de todas as instâncias.
5. Só depois disso suspeite do código.

---

## 6. Recomendações

### 6.1 Agora (destrava a org de teste)

1. **Rearmar a assinatura HMAC** da instância `org_…_mrs6ks1c`: `POST /session/hmac/config` com a chave de `WA_BRIDGE_HMAC_SECRET`. Hoje só o provisionamento faz isso. Sem esse passo a entrada continua 401.
2. **Reasserir `events`** para `Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated` — está só em `Message`, então não há tique de entrega nem aviso de logout. (Atenção: o upstream aceita `hmacKey` só no `AddUser`, não no `EditUser` — ver `convex/lib/bridgeSession.ts:162-165`.)
3. **Validar com uma mensagem real** de entrada e conferir no log que o `POST /webhooks/bridge` volta 200.

### 6.2 Correções de código (por impacto)

1. **Tratar os eventos de sessão no ingress.** `parseBridgeEvent` deve reconhecer `LoggedOut`, `TemporaryBan`, `ClientOutdated` e `Disconnected`, e o ingress deve gravar `bridgeSessionState` (`disconnected` / `banned` — hoje `banned` existe no schema e na UI mas **nenhum caminho do backend jamais o produz**) + `status:"error"`. É o sinal mais barato que existe: o gateway já se dá ao trabalho de mandar.
   → `convex/lib/bridgeParse.ts`, `convex/bridge.ts`
2. **Re-armar HMAC + `events` sempre que a sessão voltar.** Quando `getBridgeQrCode` ou `checkChannelHealth` observar a transição para `connected`, chamar `buildBridgeHmacConfigRequest` e reasserir a inscrição. Isso contorna o bug do `userinfocache` do upstream de forma idempotente.
   → `convex/channelConfigs.ts:512-593` e `:399-507`
3. **Notificar quando o canal cair.** Não existe hoje nenhuma notificação in-app nem e-mail ligada a `channelConfigs` — nem sino, nem template. Criar notificação (`convex/lib/notify.ts`) + e-mail (`convex/email.ts`) para admins na transição `active → error` ou `connected → disconnected`, com deduplicação para não repetir a cada probe.
4. **Cron de health check.** Um job em `convex/crons.ts` a cada 5–15 min varrendo os canais `active` e chamando o probe. É o que teria transformado "7 dias cego" em "aviso em 15 minutos".
5. **Escalar falhas de envio para o canal.** N falhas consecutivas com `no session` (ou 401 do gateway) deveriam marcar o canal como `error` e disparar o item 3, em vez de só anotar na timeline do lead.
   → `convex/whatsapp.ts:795-826`

### 6.3 Observabilidade e operação

6. **Trilha de auditoria das transições de sessão.** `internalRecordHealthCheck` sobrescreve `healthDetail`/`bridgeSessionState` sem histórico e sem `auditLogs` — por isso este relatório não consegue dizer o que o card mostrava antes das 07:06. Um `auditLog` por *mudança* de estado (não por probe) resolveria, e é barato.
7. **Card do canal no dashboard**, com semáforo e "última verificação há X".
8. **Traduzir os códigos órfãos** do chip "IA em espera" (`lock_perdido`, `conversa_removida`, `rascunho_ja_revisado`, `humano_respondeu`) e parar de imprimir erro cru do LLM para o operador.
   → `src/components/Inbox.tsx:35-50`
9. **Fixar `WUZAPI_GLOBAL_HMAC_KEY`** no VPS: se ausente, o wuzapi gera uma chave aleatória a cada restart (só afeta o webhook global, mas é armadilha).
10. **Reportar o bug do `userinfocache` upstream** (`authalice` recarregando sem `HmacKeyEncrypted`) — é irmão do [#346](https://github.com/asternic/wuzapi/issues/346), já reconhecido pelos mantenedores.

---

## Apêndice — como os dados foram obtidos

```bash
npx convex data channelConfigs --format jsonl          # estado e timestamps do canal
npx convex data auditLogs   --format jsonl --limit 800 # trilha (nenhum evento de canal hoje)
npx convex data messages    --format jsonl --limit 400 # deliveryStatus + metadata.deliveryError
npx convex data aiReplyQueue --format jsonl            # fila da IA: tudo "done", zero erro
timeout 90 npx convex logs --history 4000 --success --jsonl   # 401s do webhook + backoff
curl -I https://aftvps.hnbcrm.com/                     # last-modified do build do gateway
# GET /admin/users com WA_BRIDGE_ADMIN_TOKEN           # connected/loggedIn/jid/events
```

Janela de log disponível no deployment dev: **07:04:38 → 08:07:14** de hoje. Logs anteriores (inclusive um eventual `LoggedOut` de 10/08) já haviam expirado — outro argumento a favor de persistir as transições de sessão em `auditLogs`.

Nenhum valor de segredo foi lido, impresso ou registrado neste relatório: apenas os **nomes** das variáveis de ambiente (`WA_BRIDGE_HMAC_SECRET`, `WA_BRIDGE_DEFAULT_URL`, `WA_BRIDGE_ADMIN_TOKEN`), todas confirmadas como presentes no deployment.
