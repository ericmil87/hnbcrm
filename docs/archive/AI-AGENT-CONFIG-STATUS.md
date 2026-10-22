# AI Agent Config — Status da Implementação

**Data:** 2026-07-26 · **Planos:** `AI-AGENT-CONFIG-PLAN-v4.1.md` (rodada atual) + v3 (canônico da base) + v2 (segurança/concorrência)
**Fases F0→F5 (v3) + P1→P4 (v4.1) implementadas.** Lint verde (tsc convex + tsc app + convex push + vite build) · **257 testes verdes** (18 arquivos).

## Rodada v4.2 (2026-07-28) — ativação 1-fluxo + IA que preenche o CRM

Plano: `AI-AGENT-CONFIG-PLAN-v4.2.md`. **270 testes verdes (20 arquivos), lint completo.**
- **Wizard `activateOneFlow`** (mutation única: mestre+LGPD+bridge ack+atendente;
  mesma auditoria) + CTA no Painel; atendente nasce **sem horário (24h)** — aviso
  de horário migrou para o toggle de autopilot.
- **Skip com rastro**: elegibilidade reprovada grava item `skipped` na fila
  (só com org AI-ativa + atendente resolvido); `getConversationAiState` alimenta
  o chip "IA em espera: <motivo>" / "IA preparando resposta…" no inbox.
- **Captura de dados**: tools `updateThisContact` e `updateThisLeadInfo`
  (custom fields com whitelist `pipelineConfig.captureFields`, validação de
  chave/tipo/opções no executor; prompt injeta "DADOS A CAPTURAR").
- **Ações aprováveis**: `proposedActions` estruturadas `{name,argsJson,label}`;
  `acceptAiDraft(actionIndexes)` executa as marcadas via
  `executeAttendantToolCore` COMPARTILHADO com o autopilot (mesmas barreiras);
  cliente só envia índices; resultados em `aiDraft.appliedActions`.
- **Descoberta do lead**: funil→estágio + "Ver no funil" no inbox, `?board=` e
  último board lembrado no pipeline, "Leads novos caem em: X→Y" no card.
- Nota de operação: rastro de skip cresce 1 row/inbound inelegível em orgs com
  IA ativa — considerar limpeza por cron se virar volume.

## Rodada v4.1 (2026-07-26) — bridge + fila humanizada + toggles + pipeline

### P1 — Atendente no canal bridge (aceite de risco)
- `aiConfig.bridgeAiAck` org-level; mutation `aiSettings.setBridgeAiAck`
  (aceitar exige checkbox `riskAck`; revogar remove + auditLog severidade high).
- Elegibilidade reestruturada para **11 condições** (`attendant.ts`):
  nº 2 `atendente_desativado` (toggle P3), nº 10 `bridge_sem_aceite` (ack
  vigente), nº 11 janela de 24h **só para Meta** (bridge não tem janela;
  provider não-resolvível = Meta, conservador). Como toda condição, o ack é
  **re-checado no commit transacional** — revogação aborta runs em voo (testado).
- Helper único `lib/channelResolve.ts` (`resolveConversationChannelConfig`)
  usado por enqueue/claim/commit E pelo dispatch — fallback determinístico
  (prefere Meta) para conversa sem `channelConfigId`.
- UI: card "Canais não-oficiais (bridge)" com modal de risco; pill/controles de
  IA aparecem em conversas bridge quando o ack existe (`Inbox.tsx`).

### P2 — Fila de envio humanizada (anti-burst/anti-ban)
- **Cursor em dois níveis** (`lib/whatsappDispatch.ts`): por conversa (6,5s —
  pair rate Meta 131056 + margem) e por NÚMERO via tabela nova `channelPacing`
  (doc próprio de propósito: cursor quente em channelConfigs re-executaria as
  queries da UI de Canais a cada envio). Canal ocioso = envio imediato.
- Intervalos de canal: Meta 1s+jitter 0–2s; bridge REATIVO (inbound ≤24h)
  4s+jitter 0–6s; bridge FRIO 8s+jitter 0–7s (benchmark Letalk 8–15s). Ponto
  único (`scheduleWhatsappDispatch`) → agendadas, IA e bulk herdam sem mudança.
- **Humanização bridge** (só IA/agendadas; manual nunca): typing delay
  `clamp(1,5s+55ms/char, 8s)` computado NO claim (somado ao avanço do cursor) e
  aguardado na action com presence "composing" (`whatsapp.ts::dispatchViaBridge`).
- **Retry pacing-aware** em duas famílias: throttling benigno (131056, 130429,
  80007) → `internalRescheduleDispatch` com backoff oficial 4^X (1s/4s/16s, máx
  3), sem tocar `deliveryStatus` (idempotência preservada), 130429/80007
  empurram a fila TODA do canal; **131048 (spam-flag do número) → SEM retry**:
  failed + fila do canal congelada 30min + activity de alerta.
- `channelPacing.dailyCount`: métrica de envios/dia por canal (sem enforcement).

### P3 — Toggles separados
- `aiConfig.copilotEnabled`/`attendantEnabled` (undefined = ligado; mestre
  `enabled`+`lgpdAck` continua mandando). `setFeatureToggles` + `getAiStatus`
  expõe os dois + `bridgeAiAckDone`. Copiloto recusa sessão em
  `internalResolveSession`; atendente via condição de elegibilidade (enqueue E
  commit). Botão flutuante some com copiloto desligado.

### P4 — Regras de pipeline do atendente
- `agentProfile.pipelineConfig`: boardId, initialStageId, advanceRules,
  qualifiedStageId, qualifyThreshold (default 3), allowMoveStages.
- Roteamento inbound (`lib/inboundRouting.ts::findAttendantForChannel` — antes
  do lead existir, nos DOIS ingresses via `internalRouteInbound`): lead novo
  nasce no board/estágio do atendente do canal; config inválida → fallback +
  activity de aviso (nunca quebra o ingest).
- **Qualificação → avanço determinístico** (código, não modelo): BANT ≥
  threshold move para `qualifiedStageId` (validado contra o board ATUAL), com
  audit/activity "regra de qualificação"; roda mesmo com allowMoveStages:false;
  só em autopilot (suggest não executa tools).
- **allowMoveStages:false** com dupla barreira: filtro das tools da run +
  recusa server-side no executor (tool_call forjada testada).
- Prompt ganha seção "REGRAS DO FUNIL" (advanceRules); personas trazem
  advanceRules default (semeado no 1-toque).

### Testes novos (v4.1): 33
`whatsappDispatch.test.ts` (+12: pacing por canal com OCC, ocioso, canais
independentes, frio vs reativo, typingDelay no claim+args, manual sem delay,
métrica diária, retry 4^X sem tocar deliveryStatus, teto→failed, 130429 empurra
canal, 131048 congela+alerta), `attendantBridge.test.ts` (11: gates do ack,
TOCTOU de revogação, janela por transporte, toggles) e
`attendantPipeline.test.ts` (10: roteamento com pipelineConfig, fallbacks,
avanço determinístico, enforcement de allowMoveStages, contexto da run).

### E2E browser v4.1 (2026-07-26): 10✅/0⚠️/0❌
Login → toggles P3 (FAB do copiloto some/volta) → modal de risco do bridge
(bloqueia sem checkbox; aceite grava; revogação re-abre confirmação) → pill de
IA aparece/some em conversa bridge conforme o ack → Opções avançadas persistem
após remount (inclusive o edge-case `allowMoveStages:false` com o resto vazio)
→ simulador com LLM real respondeu com disclosure + guardrail de preço.
Estado restaurado e CONFERIDO no banco (aiConfig sem bridgeAiAck; agentProfile
sem pipelineConfig). Zero outbound; GuardTeste2 intocado.

### Revisão adversarial (achados corrigidos antes do merge)
1. Retry podia sobrescrever `sent` com `failed` em dispatch duplicado
   concorrente → `internalRescheduleDispatch` devolve "tratado" em estado
   terminal (`whatsapp.ts`).
2. `internalGetDispatchContext` resolvia config com fallback diferente do
   scheduler (agendar Meta / despachar bridge em conversa legada) → helper único.
3. UI: `allowMoveStages:false` com o resto vazio virava `null` (restrição
   silenciosamente descartada) → corrigido no `AiSection.tsx`.

## O que existe

### Fundação (F0)
- **Schema:** `aiConfig` estendido (lgpdAck, providerConfig com mode platform/byo + zdr/strictZdr/nonZdrAck + modelos canônicos, budget), `agentProfile` em teamMembers, `aiOptOut` em contacts, `aiTurnLock`/`aiPausedUntil` em conversations; tabelas `agentRuns` (sem PII), `aiReplyQueue`, `aiPacing`, `orgSecrets`, `pendingActions`, `copilotThreads/Messages`, `agentEvals`.
- **Camada LLM** (`convex/lib/llm/`): adapter Chat Completions (chat + streaming SSE + retry/backoff + acúmulo de tool-call deltas), registry (equivalência de modelos por provider, rotas ZDR/residência/retenção, capacidades json_schema), cadeia platform OpenCode Go → OpenRouter (**fallback implementado, INATIVO até `OPENROUTER_API_KEY`**), sanitização de credenciais em erros. IDs confirmados via `GET /v1/models` ✅ (`kimi-k2.7-code`, `deepseek-v4-flash`, `deepseek-v4-pro`; matriz de teste toda disponível — Qwen é `qwen3.7-plus`).
- **Segurança (4 camadas):** `assertAgentCan` (RBAC + org) em toda função agentável; escopo por registro; `TOOL_DENYLIST` + teste de build (`agentToolSecurity.test.ts` — barra tool com campo-segredo, params de escopo expostos, tool org-wide no atendente); envelope `<crm_data untrusted>`. Guardas de org adicionadas às `internal.*` (IDOR C9 fechado; testado em `agentOrgGuards.test.ts`). Anti-DoS: máx. 1 handoff pendente/lead.
- `createOrganization` agora nasce com `aiConfig.enabled: false`. Orgs legadas com `enabled:true` ficam desligadas até o aceite LGPD (o runtime exige `enabled && lgpdAck`).

### Copiloto (F1+F2)
- SSE autenticado (`/api/copilot/stream`, JWT Convex no Authorization), loop de tool_calls com fallback de rota, persistência incremental (fronteiras de sentença), threads por membro.
- 9 tools de leitura + 10 de escrita; escrita audita `actorType:"human"` + `via:"copilot"`; `deleteLead` → `pendingActions` (two-phase com TTL 15min, só quem pediu confirma). Onboarding conversacional via prompt + createBoard/createFieldDefinition/createQuickReply.
- UI: botão flutuante (só com IA ativa) + painel de chat com streaming, chips de tools, card de confirmações pendentes.

### Atendente (F3)
- Fila com debounce (5s) + coalescing; pacing por-org (1 inferência/s, cursor OCC); lock/lease por conversa (3min); commit transacional re-checa as 9 condições de elegibilidade + humano-respondeu (TOCTOU) + budget mensal; keyword "humano" = handoff determinístico pré-LLM; contexto POR INJEÇÃO (zero tools org-wide); só canais **Meta** (bridge excluído até HMAC por-tenant); disclosure LGPD na 1ª resposta; backoff 5s/30s/2min → escalada por handoff no teto; erro sempre sanitizado.
- Modo `suggest` (default): rascunho interno com movimentos propostos; UI no inbox (`AiDraftCard`: Enviar/Editar/Descartar) + "Assumir conversa"/"Pausar IA" no header.
- Testes de concorrência (`attendant.test.ts`): coalescing, lock defer, TOCTOU humano-respondeu, humano-assumiu, lock perdido, suggest-não-envia, opt-out, backoff+escalada, sanitização.

### Config/UX (F4)
- Configurações → **IA**: ativação com modal LGPD, atendente 1-toque (persona por indústria + conhecimento das quickReplies), personalizar (persona/conhecimento/horário/keywords), **gate do autopilot server-side** (≥10 sugestões revisadas + ≥60% aceitação), simulador sandbox, medidor "X de Y conversas", custo estimado, budget, seletor de modelos com selo ZDR/residência, modo estrito.

### Hardening (F5)
- BYO key (`orgSecrets` cifrada + `setProviderMode`; sem fallback pra plataforma; aviso/aceite não-ZDR; strictZdr recusa no backend), golden conversations (`agentEvals` + replay), `aiDiagnostics:pingProvider` (smoke de ops).

## Validação real
- Contrato OpenCode Go validado ao vivo (tool_calls ✅ com deepseek-v4-flash).
- Smoke no deployment retornou **429 de tier 5h esgotado** — o caminho completo funciona; o fallback OpenRouter cobriria exatamente isso quando a key existir.
- **E2E completo 2026-07-24** (`AI-E2E-REPORT.md`): 15✅/5⚠️/0❌ — todos os fluxos e gates provados ao vivo (browser + LLM real).

## Correções pós-E2E (2026-07-24)
O E2E achou que o OpenCode Go retorna **HTTP 400 "Upstream request failed"** em
continuação de tool (2ª chamada com tool_calls + tool result): determinístico no
deepseek-v4-flash, ~50% intermitente no kimi (bytes idênticos → falha transitória
mal-rotulada). Mitigado sem enfraquecer nada:
1. `isUpstreamMislabeled400` — esse 400 específico agora é **retriável e
   fallover-ável** (`chatWithRetry`/`chatWithFallback`); 400 genuíno segue fatal.
2. **Retry no streaming do copiloto** (3 tentativas/rota antes do 1º delta) —
   kimi intermitente recupera; validado ao vivo.
3. **Recuperação do atendente**: se a continuação falhar após tools executadas,
   uma chamada limpa (sem histórico/sem tools) redige a resposta — provado por
   teste com a sequência real do provider (rodada → 2×400 → recovery → rascunho).
   - Prompt também instrui chamar tools + replyToCustomer no MESMO turno (evita
     a continuação no caso comum).
4. `maxTokens` do atendente 700→1200 (reasoning do deepseek estourava).
5. UI: custo sub-cent ("menos de US$ 0,01" + valor exato no tooltip); pill de IA
   oculta em conversas bridge; erro do copiloto fica visível no painel.
Diagnóstico do cenário: `npx convex run aiDiagnostics:pingProvider '{"continuation":true,"model":"kimi-k2.7-code"}'`.
**Nota:** sem `OPENROUTER_API_KEY`, o flash em continuação depende só da
recuperação; com a key, o fallover cobre também esse caso com tools reais.

## Pendências ([blocked] — dependem do usuário)
Ver `AI-AGENT-CONFIG-TODO-ERIC.md` (lista viva). Resumo:
1. **`OPENROUTER_API_KEY`** — setar via `npx convex env set` quando quiser ativar o fallback ([diferido] 5).
2. **Cláusula LGPD na política de privacidade** — necessária antes de clientes reais ([blocked] 4). O produto já exige o ack na ativação.
3. **HMAC bridge por-tenant** — segue no backlog de hardening. Desde o v4.1 o
   atendente PODE atuar em bridge, mas somente com o aceite de risco org-level
   (`bridgeAiAck`) — o racional está na nota de segurança do PLAN-v4.1 (o HMAC
   atual é segredo gateway↔Convex, tenant não forja inbound de outro tenant).
4. ~~Mini-eval PT-BR / matriz de modelos~~ — **cancelado pelo Eric (2026-07-24)**: modelos fixados nos já validados (`kimi-k2.7-code` copiloto, `deepseek-v4-flash` atendente, `deepseek-v4-pro` complexo).
5. ~~Tier OpenCode Go~~ — limite liberado em 2026-07-24; dimensionar depois pelo uso real.
