# AI Agent Config — Plano v4.1 (PARA APROVAÇÃO)

**Data:** 2026-07-26 · **Status: aguardando aprovação do Eric — nada será implementado antes.**
Supersede o v4 após revisão adversarial contra o código real + 3 pesquisas
complementares (limites Meta não publicados; práticas whatsmeow/Baileys 2025-26;
concorrentes). As 4 frentes do v4 permanecem; o que muda é COMO — cada diff vs v4
está marcado com **[DIFF]** e justificado.

> Pesquisa base: `docs/AI-WHATSAPP-LIMITS.md` (12 fontes). Complementos desta
> rodada (resumidos no §Pesquisa ao final): error-codes de throttling oficiais
> completos; typing model de produção do `baileys-antiban` (mesmo protocolo do
> whatsmeow); confirmação de que wuzapi não tem pacing embutido.

---

## Invariantes INEGOCIÁVEIS (herdadas do v3 — nenhuma muda)

1. **Opt-in total**: `aiConfig.enabled` default `false` + `lgpdAck` obrigatório (`orgAiActive`).
2. **TOOL_DENYLIST + escopo por registro + envelope untrusted** (`lib/agentSecurity.ts`, `lib/promptEnvelope.ts`) + teste de build (`agentToolSecurity.test.ts`).
3. **Suggest default** + gate server-side do autopilot (≥10 revisadas, ≥60% aceitação).
4. **Commit transacional re-checando elegibilidade** (TOCTOU) — toda condição NOVA de elegibilidade entra automaticamente no re-check.
5. **Atendente sem tools org-wide** — contexto por injeção.
6. **Nunca expor `internal.*` cruas como tool.**
7. Disclosure LGPD na 1ª resposta · keyword "humano" pré-LLM · sem transcrições em `agentRuns`.

---

## P1 — Atendente IA no bridge (opt-in com aceite de risco)

### Schema (igual ao v4)
- `aiConfig.bridgeAiAck: v.optional(v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") }))`
  — aceite org-level. Texto: *"Aceito e reconheço que a API não-oficial viola os
  Termos do WhatsApp e pode causar banimento permanente do número, inclusive com
  uso de IA."*

### Backend — **[DIFF 1] o ack vira CONDIÇÃO DE ELEGIBILIDADE, não só gate de enqueue**
O v4 checava o ack só em `findAttendantForConversation` (enqueue-time). Isso é um
TOCTOU real: admin revoga o ack com item na fila ou run em voo → o commit não
re-checa → mensagem sai num canal bridge sem aceite. Correção:

- `EligibilityInput` ganha `channelProvider: "meta" | "bridge" | null` e
  `bridgeAiAckPresent: boolean`.
- **Condição nº 10 nova**: `channelProvider === "bridge" && !bridgeAiAckPresent`
  → `{ ok: false, reason: "bridge_sem_aceite" }`. Como o commit transacional
  re-executa `evaluateEligibility` (invariante 4), a revogação é honrada até o
  último instante — de graça.
- **Condição nº 9 (janela 24h)**: só se aplica quando `channelProvider !== "bridge"`.

**[DIFF 2] `serviceWindowApplies` NÃO é campo do banco** — é computado em
`conversations.ts:28-37` a partir do provider do config. O v4 sugeria lê-lo da
conversa; não existe lá. Correção: helper único
`resolveConversationChannelConfig(ctx, conversation)` (extraído da lógica já
duplicada em `attendant.ts:198-208` e `whatsapp.ts:278-287`) usado nos TRÊS
pontos — enqueue (`internalEnqueueFromInbound`), claim
(`internalClaimForProcessing`) e commit (`internalCommitAiReply`) — para derivar
`channelProvider` de forma consistente. Enqueue e commit nunca divergem.

**[DIFF 3] Fallback de config determinístico**: hoje, conversa sem
`channelConfigId` pega "o primeiro config whatsapp ativo" — com org tendo
meta+bridge, é não-determinístico. Correção no helper: preferir config **meta**
no fallback; conversa que não resolve provider é tratada como **Meta**
(conservador: exige janela de 24h e não exige ack).

- `findAttendantForConversation` aceita `provider === "bridge"` somente com
  `bridgeAiAck` presente (Meta continua sempre) — além da condição de
  elegibilidade (defesa em profundidade nos dois pontos).
- Escopo de canais do atendente: canais bridge viram selecionáveis quando o ack existir.
- Nada mais muda: suggest default, gate de autopilot, disclosure, keyword
  "humano", tetos — idênticos nos dois transportes.

### UI (igual ao v4, com 1 ajuste)
- Card "Canais não-oficiais (bridge)" em Configurações → IA: toggle + modal de
  aviso forte + checkbox de aceite (padrão do modal LGPD). Revogável (toggle off
  apaga… **não**: revogação NÃO apaga o registro — grava `revokedAt`; o gate
  checa "ack ativo"). **[DIFF 4]** O v4 não dizia como revogar; auditoria exige
  histórico → `bridgeAiAck` vive no aiConfig e a revogação troca por
  `undefined` **com auditLog de severidade high registrando quem/quando** (o
  histórico fica no audit trail, não no doc).
- Inbox: pill "IA ativa/pausada" + `AiDraftCard` aparecem em conversas bridge
  quando o ack existir (hoje escondidos incondicionalmente via
  `serviceWindowApplies === false` — `Inbox.tsx:1021,1049`). A UI recebe o flag
  via `getAiStatus` (novo campo `bridgeAiAckDone`).

### Nota de segurança (inalterada do v4)
O invariante E ("bridge excluído até HMAC por-tenant") era conservador: o
`WA_BRIDGE_HMAC_SECRET` é segredo entre o gateway (hospedado por nós) e o Convex —
tenant não forja inbound de outro tenant. Risco residual: comprometimento do
próprio gateway. Com aceite explícito + suggest default + tetos, destravar é
decisão de produto defensável. HMAC por-tenant continua no backlog.

---

## P2 — Fila de envio humanizada (anti-burst / anti-ban)

### Desenho: cursor em dois níveis — **[DIFF 5] tabela nova `channelPacing`, NÃO campo em `channelConfigs`**
O v4 propunha `channelConfigs.nextDispatchAt`. Dois problemas reais:
(a) **reatividade** — a UI de Canais (`ChannelsSection`, health panel) assina
queries sobre `channelConfigs`; um cursor quente ali re-executaria essas queries
a CADA mensagem enviada da org; (b) **OCC** — todo `sendMessage` passaria a
conflitar com qualquer leitura/escrita de config. Correção: espelhar o padrão
`aiPacing` que já funciona:

```ts
channelPacing: defineTable({
  organizationId: v.id("organizations"),
  channelConfigId: v.id("channelConfigs"),
  nextDispatchAt: v.number(),
  // [métrica, sem enforcement] contador diário p/ calibrar futuro warm-up/cap
  dailyCount: v.optional(v.object({ day: v.string(), sent: v.number() })),
}).index("by_channel_config", ["channelConfigId"])
```

Fórmula (em `scheduleWhatsappDispatch`, ponto único — mensagens agendadas, IA e
bulk herdam sem tocar `scheduledMessages.ts`, confirmado: `deliver` já passa por
ele):

```
slot = max(now, cursorDaConversa, cursorDoCanal)
cursorDaConversa = slot + 6.5s                       (pair rate Meta + margem)
cursorDoCanal    = slot + intervalo(provider, reativa?) + jitter + typingDelay(bridge)
```

`reativa?` = a conversa teve inbound do cliente nas últimas 24h
(`conversation.lastInboundAt`) — o sinal mais forte de todas as fontes é que
risco mora em contato FRIO, não em resposta; a faixa pesada só vale para frio.

- Canal ocioso → cursor no passado → envia AGORA (pacing só morde em rajada).
- `Math.random()` para jitter é seguro em mutation Convex (seeded por execução;
  re-draw em retry OCC é aceitável).
- `scheduleWhatsappDispatch` passa a receber o provider resolvido (o helper do
  P1 já carrega o config nos chamadores); sem config resolvível → só cursor de
  conversa (comportamento atual).

### Constantes (fonte ao lado; detalhes no §Pesquisa)
| Constante | Valor | Fonte |
|---|---|---|
| Par (mesma conversa), ambos transportes | **6,5s** | Meta oficial: 1 msg/6s (erro 131056) + margem [L3] |
| Cursor de canal Meta | **1s + jitter 0–2s** | Prudência de quality rating, não exigência (80 mps oficial comportaria) [L2][L3] |
| Cursor de canal bridge — conversa REATIVA (inbound do cliente nas últimas 24h) | **4s + jitter 0–6s** (faixa 4–10s) | Estimativa de engenharia calibrável — comunidade diverge 1-5s a 15-45s; atendimento reativo é a categoria de menor risco em TODAS as fontes [L10][L11][S2]. **Comentário no código dirá que NÃO é limite oficial** |
| Cursor de canal bridge — envio FRIO (sem inbound nas últimas 24h: bulk, agendadas p/ contato parado) | **8s + jitter 0–7s** (faixa 8–15s) | **[DIFF 12]** Benchmark do único concorrente que documenta pacing: Letalk usa fila sequencial global por número com intervalo aleatório 8–15s, média 12s [S3]. O risco de ban concentra em contato frio — a faixa pesada vale só para ele |
| Typing delay bridge (só IA/agendadas) | **clamp(1,5s + 55ms/char, 1,5s–8s)** | Compromisso: baileys-antiban usa ~30ms/char (modo simples) e ~267ms/char (modelo WPM 45±15 "humano real"); 55ms/char + cap 8s equilibra realismo × latência de atendimento [S2] |
| Backoff de retry de throttling | **4^X s (1, 4, 16), máx. 3 re-tentativas** | Backoff OFICIAL da doc Meta [L3] |

### **[DIFF 6] Retry pacing-aware SEM quebrar a idempotência**
O v4 mandava re-agendar "em vez de falhar", mas `internalDispatchMessage`
(`whatsapp.ts:549`) no-opa se a mensagem já tem `deliveryStatus` — marcar
`failed` antes de re-agendar mataria o retry. Correção: mutation nova
`internalRescheduleDispatch` que (a) NÃO toca `deliveryStatus`, (b) incrementa
`metadata.dispatchAttempts`, (c) reivindica NOVO slot no cursor do canal e
agenda `runAfter(4^X s + slot)`; no teto de tentativas → aí sim
`internalMarkDispatchFailed`.

**[DIFF 7] Classificação de erros em duas famílias** (achado da pesquisa de
error-codes — o v4 tratava tudo como throttling):

| Família | Códigos | Tratamento |
|---|---|---|
| Throttling benigno | **131056** (pair), **130429** (throughput), **80007** (WABA rate limit genérico) | retry 4^X; em 130429/80007 também EMPURRA o cursor do canal (senão a fila inteira bate no mesmo erro) |
| **Sinal de risco de qualidade** | **131048** ("restrições por mensagens bloqueadas/denunciadas como spam" — por número) | **SEM retry automático**: marca failed, empurra o cursor do canal +30min (congela a fila) e cria activity de alerta ao operador. Re-tentar em cima de número spam-flagged é o comportamento que agrava o quality rating |

### Humanização no bridge (só `senderType === "ai"` ou `metadata.scheduled`)
- Em `dispatchViaBridge`: presence `composing` via `POST /chat/presence` (egress
  best-effort já existe: `whatsapp.ts:842`, builder `bridgeSend.ts:142`) →
  aguarda o typingDelay → envia. Para `contentType === "audio"`:
  `Media: "audio"` (indicador "gravando áudio" — suportado pelo wuzapi).
- **[DIFF 8]** O typingDelay é computado NO CLAIM do slot (schedule-time, a
  mutation carrega a mensagem) e somado ao avanço do cursor do canal — o v4 só
  aguardava na action, o que encurtava o espaçamento real entre envios (delay de
  6s na msg A + 1,5s na msg B aproximava os envios reais).
- Envio manual do inbox NÃO ganha atraso artificial (a digitação humana já é o pacing).

### Fora desta rodada (documentado, não implementado)
- Cap diário rígido e warm-up de número bridge — mantido FORA (decisão v4). A
  pesquisa achou uma rampa de produção concreta (20→36→65→117→210→378→680/dia,
  fator 1.8×, baileys-antiban) que entra em `AI-WHATSAPP-LIMITS.md` como
  referência; o `dailyCount` do `channelPacing` (métrica-only) deixa os dados
  prontos se um dia virar produto.
- Monitorar `quality_score` (webhook `phone_number_quality_update`) e
  `held_for_quality_assessment`/132015 — hardening futuro do canal Meta.
- Hardening do GATEWAY (fora do CRM): atrasar presença "available" 45–120s
  pós-conexão; pool de client names (o "Chrome" fixo idêntico em milhares de
  bots é ele mesmo um fingerprint). Vai para `AI-AGENT-CONFIG-TODO-ERIC.md`.

---

## P3 — Toggles separados: Copiloto × Atendente (igual ao v4)

### Schema
- `aiConfig.copilotEnabled: v.optional(v.boolean())` — `undefined` → `true` (compat).
- `aiConfig.attendantEnabled: v.optional(v.boolean())` — idem.
- Mestre `enabled` + `lgpdAck` continuam mandando em tudo.

### Backend
- Copiloto: `internalResolveSession` (`copilot.ts:144`) recusa quando
  `copilotEnabled === false` (o SSE já resolve a sessão antes de qualquer tool).
- Atendente: razão nova `atendente_desativado` em `evaluateEligibility` —
  checada no enqueue E re-checada no commit (invariante 4, de graça).
- Mutation `aiSettings.setFeatureToggles` (settings/manage + auditLog).
- `getAiStatus` expõe `copilotEnabled`/`attendantEnabled`/`bridgeAiAckDone`
  (AppShell e Inbox já consomem `getAiStatus`).

### UI
- Dois switches grandes abaixo da ativação mestre ("Copiloto do CRM" /
  "Atendente virtual"), uma linha de descrição cada.
- Botão flutuante do copiloto some quando `copilotEnabled === false`.

---

## P4 — Regras de pipeline configuráveis no atendente

### Schema — `agentProfile.pipelineConfig` (tudo opcional = comportamento atual)
```ts
pipelineConfig: v.optional(v.object({
  boardId: v.optional(v.id("boards")),
  initialStageId: v.optional(v.id("stages")),     // deve pertencer a boardId
  advanceRules: v.optional(v.string()),           // linguagem natural → prompt
  qualifiedStageId: v.optional(v.id("stages")),   // movimento DETERMINÍSTICO
  qualifyThreshold: v.optional(v.number()),       // [DIFF 9] default 3 (de 4 BANT)
  allowMoveStages: v.optional(v.boolean()),       // default true
}))
```
**[DIFF 9]** O v4 dizia "score ≥ threshold da org", mas esse threshold não
existe (`handoffThreshold` é outra coisa). `qualifyThreshold` explícito no
próprio pipelineConfig, default **3**.

### Comportamento
- **Estágio inicial** — **[DIFF 10] resolver o atendente ANTES do lead**: o v4
  mandava "o ingest resolve o atendente do canal", mas `findAttendantForConversation`
  exige conversa+lead que ainda não existem na hora do `ensureLeadForContact`.
  Correção: helper novo `findAttendantForChannel(ctx, organizationId,
  channelConfigId)` (matching por canal, sem filtro de board) usado dentro de
  `internalRouteInbound` (`whatsapp.ts:237` — compartilhado pelos DOIS ingresses,
  meta e bridge); `ensureLeadForContact` ganha args opcionais
  `preferredBoardId`/`preferredStageId`. Sem config → comportamento atual.
- **Validação de integridade** (no `updateAgentProfile` E em runtime):
  `initialStageId` ∈ `boardId`; board/stage deletado em runtime → fallback ao
  comportamento atual + activity de aviso (nunca explode o ingest).
- **Avanço por regra (determinístico)**: quando `qualifyThisLead` (autopilot)
  atingir `score ≥ qualifyThreshold` e existir `qualifiedStageId` válido NO
  BOARD ATUAL do lead → o CÓDIGO move, com activity/audit "movido por regra de
  qualificação". Independe de `allowMoveStages` (é regra da org, não decisão do
  modelo — documentado na UI). Em modo suggest, `qualifyThisLead` não executa
  (vira proposta) → o movimento determinístico só acontece em autopilot
  (documentado na UI).
- **Avanço por instrução (LLM)**: `advanceRules` entra no prompt em seção
  "REGRAS DO FUNIL" (system prompt, dado de admin — não passa pelo envelope
  untrusted, como `knowledge`). Modelo continua limitado ao `moveThisLead`.
- **`allowMoveStages: false`** — **[DIFF 11] enforcement server-side, não só
  filtro do registry**: o modelo pode emitir tool_call com nome arbitrário e
  `internalExecuteAttendantTool` executa por nome. Dupla barreira: (a) a run
  filtra `moveThisLead` das tools enviadas ao modelo (subtração por-run do
  registry estático — nunca adição); (b) `internalExecuteAttendantTool` recusa
  `moveThisLead` quando o profile do agente tem `allowMoveStages === false`.
- Defaults por persona: `advanceRules` default coerente em `lib/agentPersonas.ts`.

### UI
- Modal "Personalizar" → seção "Opções avançadas" (collapse fechado): select de
  board + estágio inicial, select de estágio pós-qualificação (com threshold),
  textarea "Quando avançar o lead" (placeholder da persona), switch "Atendente
  pode mover leads no funil" (com nota de que a regra de qualificação é à parte).

---

## Testes novos (vitest + convex-test)

Herdados do v4 (1-8) + os achados da revisão:
1. Bridge gate: sem ack → não atende; com ack → atende; Meta inalterado.
2. Elegibilidade: bridge ignora `janela_24h`; Meta continua exigindo; conversa
   SEM `channelConfigId` → tratada como Meta (janela exigida).
3. Toggles: `attendantEnabled:false` → `atendente_desativado` (enqueue E
   commit); `copilotEnabled:false` → sessão recusada.
4. Pacing por canal: N mensagens em M conversas do mesmo canal → slots
   estritamente espaçados ≥ intervalo mínimo; canal ocioso → imediato; canais
   DIFERENTES não se bloqueiam.
5. Agendadas em massa no mesmo `runAt` → dispatches espalhados.
6. Retry: 131056/130429 re-agenda SEM tocar `deliveryStatus` (idempotência
   preservada — o re-dispatch não no-opa); teto de tentativas → failed;
   **131048 → failed imediato + cursor do canal congelado + activity**.
7. Qualificação move determinístico p/ `qualifiedStageId` (≥ threshold, board
   atual); `allowMoveStages:false` remove a tool da run **E**
   `internalExecuteAttendantTool` recusa tool_call forjada de `moveThisLead`.
8. Build de segurança (`agentToolSecurity.test.ts`) verde — nenhuma tool nova.
9. **TOCTOU do ack**: ack revogado entre enqueue e commit → commit aborta
   (`bridge_sem_aceite`).
10. **Concorrência do channelPacing**: claims concorrentes → slots distintos
    (OCC), espelhando o teste do aiPacing.
11. Pipeline inbound: canal com atendente+pipelineConfig → lead nasce no
    board/estágio configurados; stage órfão → fallback + não explode.
12. Typing delay: computado no claim e somado ao cursor; manual não ganha delay.

---

## Sequência de execução (após OK do Eric)

1. **F-A (backend core — Fable, sequencial):** schema (bridgeAiAck, toggles,
   pipelineConfig, channelPacing) → helper `resolveConversationChannelConfig` →
   P1 elegibilidade (condições 9/10) → P3 toggles → P2 cursor de canal +
   classificação de erros + retry. Testes 1-6, 9-10 juntos. `npm run test` +
   `npm run lint` verdes antes de F-C.
2. **F-B (paralelo com F-A — subagente frontend/Sonnet):** UI — card bridge ack,
   switches P3, opções avançadas P4, pill do inbox, `getAiStatus` novo shape
   (contrato de campos definido no início para não bloquear).
3. **F-C (backend — Fable):** P4 runtime (`findAttendantForChannel`, inbound
   routing, qualificação determinística, prompt "REGRAS DO FUNIL", enforcement
   allowMoveStages) + humanização bridge (typing no claim + presence na action).
   Testes 7, 11-12.
4. **F-D:** lint + testes completos, deploy dev (`npx convex dev --once`), smoke
   `pingProvider` + simulador, E2E browser (subagente Opus), atualização de
   STATUS/TODO-ERIC/CLAUDE.md/memória.
5. Validação viva no seu ambiente (teste real do bridge com seu telefone — item seu).

Revisão adversarial: todo código de F-A/F-C que toca gates, elegibilidade ou
cursores passa por verificação linha a linha minha com achados citando file:line
antes de considerar a fase fechada.

---

## Decisões assumidas (herdadas do v4 + novas — me corrija se discordar)
- Ack do bridge é org-level; revogação = remover do aiConfig com auditLog high
  (histórico no audit trail).
- Envio manual único nunca ganha atraso artificial.
- Cap diário/warm-up bridge FORA desta rodada; `channelPacing.dailyCount` só métrica.
- Toggles P3 org-level; liga/desliga por atendente = status do membro.
- `qualifyThreshold` default 3/4; movimento determinístico roda mesmo com
  `allowMoveStages:false` e só em autopilot.
- 131048 congela o canal por 30min + alerta (sem auto-retry).
- Bridge diferencia reativo (4–10s) × frio (8–15s, benchmark Letalk) pelo
  `lastInboundAt` ≤ 24h da conversa — o atendente IA (sempre reativo) nunca cai
  na faixa pesada; bulk/agendada para contato parado cai.

---

## §Pesquisa — complementos desta rodada (2026-07-26)

**Limites Meta não publicados** (fonte: developers.facebook.com, error-codes,
2 jun 2026): as categorias "Test message rate limit", "Capacity rate limit" e
"Business phone rate limit" são nomeadas pela Meta **sem valor numérico em
nenhuma fonte confiável** (oficial, BSPs 360dialog/checados, comunidade) — não
inventamos caps. Códigos de throttling oficiais: 4, 80007, 130429, 131048,
131056, 133016, 131064. `80007` = rate limit genérico de WABA (sem
desambiguação de categoria); `131048` = restrição POR NÚMERO por
bloqueios/denúncias de spam (candidato a "business phone rate limit",
confiança média) — tratado como sinal de risco, não throttling.

**whatsmeow/ecossistema 2025-26**: wuzapi confirmado SEM pacing embutido
(wrapper fino — anti-ban é responsabilidade nossa); `POST /chat/presence`
`{Phone, State, Media:""|"audio"}` confirmado. Typing de produção
(baileys-antiban v4.10, mesmo protocolo): ~30ms/char (simples) a ~267ms/char
(modelo WPM 45±15 "humano real", msg de 200 chars = 30-60s) — nossa constante
55ms/char + cap 8s é o compromisso UX. Warm-up de produção: 20→36→65→117→210→
378→680/dia (fator 1.8×; >72h inativo reinicia) — referência documentada, não
implementada. Onda de detecção mai/2025 (whatsmeow#807/#810, Baileys#1392,
persiste em Baileys#2658 jun/2026) foi **comportamental + fingerprinting de
sessão** — reforça: atendente 100% reativo é a categoria de menor risco; a
heurística mais nova reportada (2026) é contador de mensagens NÃO respondidas
em 30 dias, que penaliza broadcast, não atendimento.

**Concorrentes** [S3]: o único com pacing documentado publicamente é a
**Letalk**: temporizador de envios com intervalo aleatório de **8–15s (média
12s)**, fila sequencial única por número, não configurável — base do nosso
intervalo "frio" do bridge. Concorrentes de API oficial (Kommo, Umbler,
Blip/Take, Huggy, Zenvia) NÃO publicam pacing próprio — delegam throttling à
Meta e focam em compliance (opt-in, templates, quality rating); a Kommo
recomenda "começar pequeno e crescer monitorando o quality rating" sem rampa
numérica. Chatwoot não tem WhatsApp não-oficial nativo (comunidade usa Evolution
API/Baileys) e não tem pacing anti-ban no código; o consenso de guias de
terceiros do ecossistema Evolution é delay 10–45s e caps 20–50/dia (número
novo) a 80–200/dia (aquecido) — fontes com viés comercial, tratadas como
contexto, não como autoridade. Relato anedótico relevante para expectativa de
risco: ~30% de chance de ban em 6 meses mesmo com número aquecido
(Evolution/Baileys, mesmo protocolo do nosso bridge) — reforça que o texto do
ack do P1 não é teatro.
