# AI Agent Config — Plano de Implementação

**Criado:** 2026-07-24
**Versão do doc:** v1 (rascunho para revisão adversarial pelo Fable)
**Base de código:** `main` v0.34.0 (Convex + React), branch de trabalho `ericmil87/*`
**Status da inferência:** greenfield — **não existe nenhum código LLM/Anthropic no repositório hoje.**

> Este plano cobre **dois produtos de IA distintos** que compartilham um runtime único:
> 1. **Copiloto do CRM** — IA in-app que ajuda o usuário a configurar e operar o CRM nativamente (chat que lê e executa ações no sistema, respeitando RBAC).
> 2. **Atendente Virtual** — IA conectada a canais (WhatsApp Meta/bridge) que atende clientes de forma nativa e integrada, com handoff para humano.

---

## 0. Princípios de design

- **Reuso máximo.** A superfície de "tools" da IA são as ~28 funções `internal.*` do Convex que já existem (leads, contatos, conversas, handoffs, pipeline, tasks, calendar, activities). Não reescrever lógica de negócio — a IA é só mais um "ator" chamando as mesmas funções que o REST/MCP já usam.
- **Identidade de primeira classe.** Cada IA é uma linha em `teamMembers` (`type:"ai"`) — já existe. Isso dá atribuição de leads, handoff, audit/activity com `actorType:"ai"` de graça.
- **Convex-nativo.** Inferência roda em `internalAction` (chamada via `fetch` à Anthropic Messages API — **sem `"use node"`**, espelhando `convex/transcription.ts`). Nada de SDK Node no bundle. Loop de tool-use manual dentro da action.
- **Segurança primeiro (o atendente lê texto não-confiável de clientes).** Prompt-injection é o risco central; ver §9.
- **Modelos Claude mais capazes por padrão** (política do projeto). Default `claude-opus-4-8`; modelo é configurável por agente com tradeoffs de custo explicitados (§6).

---

## 1. Arquitetura compartilhada (o "Agent Runtime")

Ambos os produtos usam um runtime comum, novo arquivo `convex/lib/agentRuntime.ts` (puro TS) + `convex/aiAgent.ts` (actions).

```
┌──────────────────────────────────────────────────────────────┐
│  Agent Runtime (convex/lib/agentRuntime.ts + convex/aiAgent.ts)│
│                                                                │
│  1. Monta contexto (system prompt + persona + knowledge +      │
│     histórico + estado do lead/contato)                        │
│  2. Loop de tool-use com a Anthropic Messages API (fetch):     │
│       while stop_reason == "tool_use":                         │
│         - executa cada tool via ctx.runQuery/runMutation        │
│           (mesmas internal.* do REST), com PERMISSION GATE      │
│         - devolve tool_result                                  │
│  3. Persiste run em `agentRuns` (tokens, custo, tools, erro)    │
└──────────────────────────────────────────────────────────────┘
        ▲                                    ▲
        │ (copilot: user pede ação)          │ (atendente: msg inbound dispara)
   convex/copilot.ts                    hook em internalReceiveMessage
   (httpAction streaming)               → scheduler.runAfter(0, autoReply)
```

**Componentes do runtime:**

| Componente | Descrição |
|---|---|
| **Provider client** | `fetch` para `https://api.anthropic.com/v1/messages`. Header `x-api-key` (global) ou key BYO por org (§7). Model, `output_config.effort`, `thinking:{type:"adaptive"}`, prompt caching. |
| **Tool registry** | Mapa `toolName → { schema, run(ctx, args, agentIdentity) }`. Cada `run` chama a `internal.*` correspondente. Sub-conjuntos por produto (copilot vê tudo que o usuário pode; atendente vê um conjunto restrito). |
| **Permission gate** | Antes de executar QUALQUER tool de escrita, checa `requirePermission(ctx, orgId, category, level)` contra a identidade do agente (o `teamMember` IA ou o usuário logado). Fecha o gap do §9. |
| **Run logger** | Insere em `agentRuns` (novo): tokens in/out/cache, custo estimado, tools chamadas, latência, erro, produto (copilot\|atendente). |

**Por que loop manual e não o Tool Runner do SDK:** as tools executam via `ctx.runQuery/runMutation` do Convex, dentro de uma action; um loop manual `while stop_reason === "tool_use"` mantém tudo em uma action sem dependência de SDK Node. (Ref: `shared/tool-use-concepts.md` → Manual Agentic Loop.)

---

## 2. Modelo de dados (mudanças no schema)

### 2.1 Estender `teamMembers` (config do agente vive aqui)

Novos campos opcionais (todos `v.optional`, back-compat):

```ts
// teamMembers (só relevante quando type === "ai")
aiConfig: v.optional(v.object({
  kind: v.union(v.literal("copilot"), v.literal("attendant")), // qual produto
  model: v.optional(v.string()),          // default "claude-opus-4-8"
  effort: v.optional(v.union(v.literal("low"), v.literal("medium"),
                             v.literal("high"), v.literal("xhigh"), v.literal("max"))),
  systemPrompt: v.optional(v.string()),   // persona/instruções
  temperatureNote: v.optional(v.string()),// (não usar sampling params — removidos no Opus 4.8; steer por prompt)
  // Atendente:
  channels: v.optional(v.array(v.id("channelConfigs"))), // quais canais ele atende
  boardIds: v.optional(v.array(v.id("boards"))),         // quais pipelines
  businessHours: v.optional(v.object({ tz: v.string(), windows: v.array(v.any()) })),
  handoffRules: v.optional(v.object({
    onLowConfidence: v.boolean(),
    onKeywords: v.array(v.string()),      // "falar com humano", "reclamação"...
    afterNTurns: v.optional(v.number()),
    escalateToMemberId: v.optional(v.id("teamMembers")),
  })),
  guardrails: v.optional(v.object({
    maxRepliesPerConversation: v.number(),  // anti-loop
    maxToolCallsPerRun: v.number(),
    allowedTools: v.optional(v.array(v.string())), // allowlist explícita
  })),
  knowledgeIds: v.optional(v.array(v.id("agentKnowledge"))),
})),
```

### 2.2 Consumir `org.settings.aiConfig` (hoje `handoffThreshold` é morto)

Adicionar orçamento e kill-switch:
```ts
aiConfig: { enabled, autoAssign, handoffThreshold,
            monthlyTokenBudget?: number, spentTokensThisMonth?: number,
            budgetResetAt?: number }
```
`enabled:false` = desliga toda a IA da org (kill-switch global). Estourou o budget → pausa o atendente e alerta admin.

### 2.3 Tabelas novas

| Tabela | Campos-chave | Uso |
|---|---|---|
| `agentRuns` | `organizationId`, `agentMemberId`, `kind`, `conversationId?`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, `toolCalls[]`, `stopReason`, `error?`, `latencyMs`, `createdAt`. Índices `by_organization_and_created`, `by_agent`. | Observabilidade, custo, debug, auditoria. |
| `agentKnowledge` | `organizationId`, `agentMemberId?` (null=org-wide), `title`, `content` (markdown), `enabled`, `createdAt`. Índice `by_organization`. | Base de conhecimento (FAQ/políticas) injetada no system prompt. **v1 = injeção simples; RAG/embeddings fica pra v2** (Convex tem vector search nativo se precisar). |
| `orgSecrets` | `organizationId`, `provider:"anthropic"`, `apiKeyEncrypted`, `apiKeyLast4`, `apiKeyMasked`, `createdAt`. | BYO Anthropic key por org (opcional), criptografada com o padrão de `channelConfigs` (§7). |
| `copilotThreads` / `copilotMessages` | thread por usuário; mensagens user/assistant/tool. Índices por user + created. | Histórico do chat do copiloto. (Avaliar o componente `@convex-dev/agent` — §4.4.) |

---

## 3. Superfície de tools (o que a IA pode fazer)

Reusar as `internal.*` já existentes (mapeadas pela pesquisa). Cada tool = 1 função interna.

**Leitura (ambos os produtos):** `internalGetLeads`, `internalGetLead`, `internalGetContacts`, `internalGetContact`, `internalSearchContacts`, `internalGetConversations`, `internalGetMessages`, `internalGetBoards`+`internalGetStages`, `internalGetActivities`, `internalGetDashboardStats`, `internalGetHandoffs`, `internalGetContactEnrichmentGaps`.

**Escrita (gated por RBAC):** `internalCreateLead`, `internalUpdateLead`, `internalMoveLeadToStage`, `internalAssignLead`, `internalFindOrCreateContact`/`internalCreateContact`/`internalUpdateContact`, `enrichContact`, `internalSendMessage`, `internalSendTemplate`, `internalRequestHandoff`, `internalCreateActivity`, `internal.tasks.*`, `internal.calendar.*`, `internal.scheduledMessages.schedule` (follow-up agendado).

**Sub-conjuntos por produto:**
- **Copiloto:** conjunto amplo (tudo que o usuário logado pode fazer, incluindo criar pipelines/boards, configurar canais, gerenciar equipe se admin). Age **como o usuário** → herda as permissões reais dele.
- **Atendente:** conjunto restrito — ler conversa/lead/contato, responder (`internalSendMessage`), qualificar lead, mover de estágio, agendar follow-up, e **`internalRequestHandoff`** (escalar). NÃO deleta, NÃO mexe em settings/equipe/API keys. Allowlist explícita em `guardrails.allowedTools`.

Cada tool tem `description` **prescritiva de QUANDO chamar** (não só o que faz) — o Opus 4.8 sub-utiliza tools sem isso (ver skill claude-api → "tool triggering is surface-dependent").

---

## 4. Produto 1 — Copiloto do CRM

### 4.1 Fluxo
Usuário abre um painel de chat (novo `src/components/copilot/CopilotPanel.tsx`, gaveta global). Digita "crie um pipeline de vendas B2B com 5 estágios" / "mova os leads quentes do João pra mim" / "como está meu funil?" / "conecte o WhatsApp". O copiloto planeja, chama tools, executa e responde com streaming.

### 4.2 Auth & RBAC (crítico)
O copiloto age **como o usuário logado** — NÃO como um teamMember IA separado. Toda tool passa pelo `requirePermission(ctx, orgId, category, level)` do próprio usuário. Assim ele nunca excede o RBAC de quem está usando. Ações destrutivas (deletar board, remover membro) exigem **confirmação explícita na UI** antes de executar (o runtime marca a tool como "requires confirmation" e a UI renderiza um botão — padrão "human-in-the-loop").

### 4.3 Streaming
Convex `httpAction` com resposta em streaming (SSE) OU o componente de persistent text streaming. Recomendação v1: `httpAction` que faz `stream:true` na Anthropic e repassa deltas; a UI consome via `fetch` + reader. (Reactive queries do Convex não fazem streaming token-a-token bem; por isso HTTP action.)

### 4.4 Build vs. adopt — componente `@convex-dev/agent`
**Decisão a validar:** existe o componente oficial `@convex-dev/agent` (threads, mensagens, tool calls, streaming, RAG, playground). Ele poderia entregar boa parte do copiloto de graça. Tradeoff: opinião forte + acoplamento vs. controle. **Recomendação:** avaliar num spike de 1 dia; se couber, adotar para o copiloto (threads/streaming/RAG) e manter o atendente no runtime próprio (que precisa do hook de canal e guardrails específicos). O Fable deve pressionar essa decisão.

### 4.5 Guardrails do copiloto
- Confirmação para ações destrutivas/irreversíveis.
- `maxToolCallsPerRun` (anti-loop).
- Nunca expõe segredos (tokens de canal, API keys) — tools de leitura de config retornam versões mascaradas.
- Todas as ações logadas em `activities`/`auditLogs` com `actorType:"ai"` + o `actorId` do usuário que instruiu (rastreabilidade).

---

## 5. Produto 2 — Atendente Virtual

### 5.1 Gatilho (inbound)
Hook em `internalReceiveMessage` (conversations.ts, ~linha 1354, ao lado do `autoTranscribe`):
```ts
await ctx.scheduler.runAfter(0, internal.aiAgent.autoReply, { messageId });
```
Provider-agnóstico (cobre Meta e bridge). Para áudio, encadear a partir de `internalSetTranscriptionResult` (transcription.ts) para responder só depois da transcrição.

### 5.2 Elegibilidade (o predicado de "devo responder?")
Responder **somente se TODOS**:
1. `org.settings.aiConfig.enabled === true` e budget não estourado.
2. O lead está atribuído a um teamMember IA **ativo** (`ensureLeadForContact` já auto-atribui à IA quando `autoAssign`).
3. O canal/board da conversa está no `channels`/`boardIds` do agente.
4. `handoffState` ausente ou não `pending`/`completed` (senão humano assumiu).
5. **Sem mensagem outbound `senderType:"human"` recente** (humano assumiu manualmente → pausar IA).
6. Dentro do horário comercial (`businessHours`), se configurado.
7. `maxRepliesPerConversation` não atingido (anti-loop).
8. A mensagem é `direction:"inbound", senderType:"contact"` (não responder a si mesmo).

### 5.3 Montagem de contexto
`internalGetMessages(conversationId)` (histórico) + lead/contato + `agentKnowledge` habilitado + `systemPrompt`/persona. Prompt caching agressivo: system prompt + tool defs + knowledge são o **prefixo estável** (cacheável); histórico e a mensagem nova vêm depois (ver skill → prompt-caching). Cache read ~0.1× do custo.

### 5.4 Loop de inferência + tools
Runtime §1. Modelo default `claude-opus-4-8` (configurável). `output_config.effort` (default `medium` para atendimento; `high` para casos complexos). `thinking:{type:"adaptive"}`. **Task budget** (beta) para limitar o custo por conversa (ex.: 20k–40k tokens). Tools restritas (§3). Loop cap `maxToolCallsPerRun`.

### 5.5 Envio (outbound)
`internal.conversations.internalSendMessage({ conversationId, content, teamMemberId: <aiMemberId> })` → stamps `senderType:"ai"`, dispara webhook e o `scheduleWhatsappDispatch` (que já respeita 1msg/6s da Meta). **Nunca** chamar `internalDispatchMessage` direto.

### 5.6 Janela 24h (só Meta)
Antes de enviar texto livre: se `serviceWindowApplies && now > lastInboundAt+24h`, enviar **template aprovado** via `internalSendTemplate` (não texto livre — a Meta rejeita com erro 131026). No bridge não se aplica.

### 5.7 Handoff (escalar pro humano)
Chamar `internalRequestHandoff` quando: baixa confiança (o modelo declara via structured output — ver §6), keyword de escalação, `afterNTurns`, ou cliente pede humano. Isso já: cria `handoffs`, seta `lead.handoffState.status:"requested"`, notifica, e (ao aceitar) reatribui o lead ao humano → IA pausa automaticamente (elegibilidade §5.2.4).

### 5.8 Guardrails do atendente (defesa em profundidade)
- Anti-loop: `maxRepliesPerConversation`, dedupe por `externalId`.
- Rate/cost: budget por org (§2.2), backoff em 429.
- Prompt-injection: §9 (o cliente é fonte não-confiável).
- Loop de "IA conversando com IA": não responder se as últimas N mensagens outbound foram todas `ai` sem inbound humano novo.
- Kill-switch por conversa (label/flag "pausar IA") e global (`aiConfig.enabled`).

---

## 6. Modelos & especificidades da Claude API

**IDs (skill claude-api, cache 2026-06-24):** `claude-opus-4-8` ($5/$25, 1M ctx) · `claude-sonnet-5` ($3/$15, 1M) · `claude-haiku-4-5` ($1/$5, 200k) · `claude-fable-5` ($10/$50, 1M, o mais capaz).

- **Default `claude-opus-4-8`** para ambos (política do projeto). Modelo é **configurável por agente**; para atendente de alto volume, `claude-sonnet-5` ou `claude-haiku-4-5` reduzem custo — **decisão do usuário** (o skill orienta a não fazer downgrade automático por custo). Flag na UI com o tradeoff.
- **Thinking:** `thinking:{type:"adaptive"}` explícito (no Opus 4.8, omitir = sem thinking). `output_config.effort` controla profundidade (`medium` atendimento, `high`/`xhigh` copiloto agêntico).
- **Sem `temperature`/`top_p`/`top_k`** — removidos no Opus 4.8 (400 se enviados). Steer por prompt.
- **Prompt caching** — prefixo estável (system+tools+knowledge) com `cache_control`. Verificar `usage.cache_read_input_tokens`.
- **Streaming** — obrigatório para `max_tokens` alto (copiloto). Atendente pode ser não-streaming (resposta curta).
- **Task budgets (beta `task-budgets-2026-03-13`)** — teto de tokens por run agêntico do atendente.
- **Structured outputs (`output_config.format`)** — para a decisão de handoff/confiança: pedir `{ shouldHandoff: bool, confidence: number, reason: string }` num passo estruturado, em vez de parsear texto.
- **Refusal** — tratar `stop_reason:"refusal"` (raro, mas o Opus pode recusar); logar e escalar pro humano.
- **Erros** — backoff em 429/5xx/529 (o `fetch` não tem retry automático do SDK; implementar).

---

## 7. Segredos & configuração

- **Key global** `ANTHROPIC_API_KEY` como env var do Convex (deployment) — caminho padrão.
- **BYO key por org** (opcional): tabela `orgSecrets`, criptografada AES-256-GCM reusando `convex/lib/secretCrypto.ts` (`encryptSecret`/`decryptSecret`/`maskConfig`, master key `CHANNEL_ENCRYPTION_KEY`). Decriptar só dentro da action, nunca logar/expor. UI mostra só `…<last4>`.
- Precedência: key da org (se houver) → key global.

---

## 8. Rate limits, custo e orçamento

- **Anthropic:** limites de RPM/TPM/TPD por tier da org. Picos de inbound do atendente podem estourar → fila via `ctx.scheduler` (já existe pacing de WhatsApp a 1msg/6s). Backoff exponencial em 429 lendo `retry-after`.
- **WhatsApp Meta:** 1msg/6s por destinatário (erro 131056) já tratado por `scheduleWhatsappDispatch`.
- **Budget por org:** `monthlyTokenBudget` em `aiConfig`; acumular em `spentTokensThisMonth` a cada run; ao estourar, pausar atendente + alertar admin (email já existe via `dispatchNotification`). Reset mensal via cron (`convex/crons.ts`).
- **Custo por run:** calcular de `usage` (tokens × preço do modelo) e gravar em `agentRuns.costUsd`. Painel de custo em Configurações → IA.

---

## 9. Segurança (o capítulo mais importante)

### 9.1 Prompt injection (atendente lê texto não-confiável de clientes)
- **Nunca** deixar texto do cliente agir como instrução de operador. Instruções de operador vão pelo canal seguro: system prompt (fixo) + **mid-conversation system messages** (`role:"system"` em `messages[]`, suportado no Opus 4.8) — não interpola dado volátil no system prompt.
- Tool results (dados do CRM) podem conter texto injetado por mensagens anteriores → tratar como **dados**, não instruções.
- **Confirmação para ações irreversíveis** (o atendente não deleta nada; allowlist restrita).
- Nunca expor segredos: tools de config retornam mascarado; a key nunca entra no prompt.
- Sanitizar/limitar entrada; caps de loop e de tokens.

### 9.2 RBAC — fechar o gap achado
A pesquisa achou que o scoping de permissão por API key no `router.ts` é **resolvido mas nunca aplicado** nos endpoints. O runtime da IA **deve** aplicar `requirePermission` em toda tool de escrita (§1 permission gate), tanto para o copiloto (permissões do usuário) quanto para o atendente (permissões do teamMember IA, default role `ai` = `agent`; restringir mais via allowlist). **Recomendação:** também adicionar checagem de permissão nos endpoints REST como hardening geral (item separado, fora deste escopo, mas relacionado).

### 9.3 Auditoria
Todo run em `agentRuns`; toda ação de escrita em `activities`/`auditLogs` com `actorType:"ai"`. Handoff, envio, mudança de estágio — tudo rastreável.

---

## 10. UI (painéis de configuração)

- **Team → Membro IA → aba "Configuração de IA":** kind (copiloto/atendente), modelo, effort, system prompt/persona, canais, boards, horário, regras de handoff, guardrails, knowledge. (Estende `MemberDetailSlideOver.tsx` + `InviteMemberModal.tsx`, que hoje só coletam nome+permissões.)
- **Configurações → IA:** kill-switch global, budget mensal + gasto, painel de custo (de `agentRuns`), BYO key (mascarada).
- **Base de conhecimento:** CRUD de `agentKnowledge`.
- **Copiloto:** gaveta de chat global (`CopilotPanel.tsx`) com streaming + confirmação de ações destrutivas.
- **Inbox:** indicador "respondido por IA" (já dá pra derivar de `senderType:"ai"`), botão "pausar IA nesta conversa".

---

## 11. Rollout em fases

| Fase | Entrega | Risco |
|---|---|---|
| **F0 — Fundação** | Schema (campos + tabelas), `agentRuntime.ts`, provider client (fetch), tool registry (leitura), permission gate, `agentRuns`, env `ANTHROPIC_API_KEY`. Sem UI. | Baixo |
| **F1 — Copiloto (read-only)** | Chat + streaming + tools de **leitura** ("como está meu funil?", "liste leads quentes"). Age como o usuário. | Baixo |
| **F2 — Copiloto (write + confirmação)** | Tools de escrita com confirmação de ações destrutivas. | Médio |
| **F3 — Atendente (piloto controlado)** | Hook inbound, elegibilidade, contexto, loop, envio, handoff, janela 24h, guardrails. **Um agente, um canal, budget baixo, opt-in.** | Alto |
| **F4 — Config UI + custo/budget** | Painéis de config, knowledge, budget, BYO key, kill-switches. | Médio |
| **F5 — Hardening & escala** | RAG (v2), tiering de modelo, rate-limit tuning, structured handoff, avaliação/qualidade. | Médio |

---

## 12. Decisões em aberto (para o usuário/Fable)

1. **`@convex-dev/agent` para o copiloto?** (build vs. adopt — §4.4).
2. **Modelo default do atendente:** `opus-4-8` (qualidade) vs `sonnet-5`/`haiku-4-5` (custo). Tiering?
3. **BYO key por org** já em v1 ou só key global?
4. **Streaming do copiloto:** httpAction SSE vs. persistent-text-streaming component.
5. **Knowledge v1 injeção simples vs. RAG desde já** (Convex vector search).
6. **Copiloto age como o usuário** (herda RBAC) — confirmar que é o modelo desejado (vs. um teamMember IA dedicado).
7. **Grupos de WhatsApp** — atendente responde em grupo? (provável: não em v1.)
8. **Alcance da confirmação humana** no copiloto (só destrutivo, ou todo write?).

---

## 13. Lacunas conhecidas / o que este plano NÃO cobre ainda (para o Fable atacar)

- Estratégia de **avaliação de qualidade** do atendente (evals, golden conversations, regressão).
- **Testes** (o repo não tem framework de teste configurado além de fixtures Convex).
- Detalhes de **backoff/retry e idempotência** sob concorrência (dois inbounds quase simultâneos na mesma conversa).
- **Race conditions** de elegibilidade (humano assume no exato momento em que a IA está gerando).
- **Compliance/LGPD** — dados de conversa indo para a Anthropic; consentimento; retenção; opt-out por contato.
- **Custo em escala** — projeção real de tokens/mês por volume de conversas.
- **Failure modes** do provider (Anthropic 529/timeout) — o que a conversa "vê" (nada? mensagem de espera?).
- **i18n** — persona/knowledge/templates em PT-BR; multi-idioma?
- Detalhe fino de **rate limits** da Anthropic por tier e como a fila do Convex se comporta em pico.

---

*Este é um rascunho v1 para revisão adversarial. Ver `AI-AGENT-CONFIG-FABLE-REVIEW-PROMPT.md` para o prompt de revisão pelo Fable.*
