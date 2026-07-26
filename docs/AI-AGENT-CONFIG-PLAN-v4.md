# AI Agent Config — Plano v4 (PARA APROVAÇÃO)

**Data:** 2026-07-26 · **Status: aguardando aprovação do Eric — nada será implementado antes.**
Continuação do v3 (implementado, ver `AI-AGENT-CONFIG-STATUS.md`). Quatro frentes pedidas:

1. **Atendente IA no canal bridge (API não-oficial)** com aceite explícito de risco de banimento.
2. **Fila de envio humanizada** (anti-burst/anti-ban) calibrada pelos limites da Meta + práticas anti-ban.
3. **Toggles fáceis e separados**: Copiloto × Atendente.
4. **Regras de pipeline configuráveis** no atendente (estágio inicial, quando avançar, opções avançadas).

> A pesquisa sobre limites oficiais da Meta e heurísticas anti-ban da comunidade
> está concluída: **`docs/AI-WHATSAPP-LIMITS.md`** (12 fontes, doc oficial da Meta
> + threads primárias do whatsmeow). As constantes do P2 abaixo já estão
> calibradas por ela.

---

## Estado atual (o que muda e onde)

| Ponto | Hoje | Arquivo |
|---|---|---|
| Gate de canal do atendente | `configProvider(config) !== "meta"` → bridge NUNCA atende | `convex/attendant.ts:208` |
| Elegibilidade nº 9 | exige janela de 24h SEMPRE (bridge não tem janela) | `convex/attendant.ts:160` |
| Pacing de envio | só por-conversa: cursor `nextDispatchAt` + 6s fixos (pair rate da Meta) | `convex/lib/whatsappDispatch.ts` |
| Burst global | inexistente: N conversas despacham juntas (200 agendadas às 9h = 200 envios às 9h) | — |
| Mensagens agendadas | `deliver` roda no horário exato e herda só o pacing por-conversa | `convex/scheduledMessages.ts:199` |
| Toggle de IA | um único `aiConfig.enabled` (mestre) — sem separação copiloto/atendente | `convex/schema.ts:61` |
| Estágio inicial de lead inbound | fixo: board default + 1º estágio | `convex/lib/inboundRouting.ts:75-83` |
| Regras de avanço no funil | só o texto genérico do prompt; nomes dos estágios injetados | `convex/attendant.ts:1104` |
| Pill de IA no inbox | escondida em conversas bridge (`serviceWindowApplies === false`) | `src/components/Inbox.tsx` |

---

## P1 — Atendente IA no bridge (opt-in com aceite de risco)

### Schema
- `aiConfig.bridgeAiAck: v.optional(v.object({ acceptedAt, acceptedBy }))` — aceite
  org-level: *"Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e
  pode causar banimento permanente do número, inclusive com uso de IA."*

### Backend
- `findAttendantForConversation` passa a receber a org e aceita
  `provider === "bridge"` **somente se** `bridgeAiAck` existir (Meta continua sempre).
- `evaluateEligibility` nº 9 (janela 24h): só se aplica quando
  `conversation.serviceWindowApplies !== false` (bridge não tem janela — vira no-op).
- `createAttendantOneClick`/escopo de canais: canais bridge entram na lista de
  `channelConfigIds` selecionáveis quando o ack existir.
- **Nada mais muda**: modo `suggest` default, gate de autopilot, disclosure LGPD na
  1ª resposta, keyword "humano", tetos por conversa/hora — tudo igual nos dois
  transportes.

### UI (Configurações → IA)
- Card "Canais não-oficiais (bridge)": toggle com modal de aviso forte + checkbox de
  aceite (mesmo padrão do modal LGPD). Mostra o texto do risco e grava o ack.
- Inbox: a pill "IA ativa/pausada" e o `AiDraftCard` voltam a aparecer em conversas
  bridge quando o ack existir (hoje escondemos incondicionalmente).

### Nota de segurança (por que é aceitável destravar)
O invariante E ("bridge excluído até HMAC por-tenant") era conservador: o
`WA_BRIDGE_HMAC_SECRET` é segredo entre o gateway wuzapi (hospedado por nós) e o
Convex — tenants não o possuem, então um tenant NÃO consegue forjar inbound de
outro; o risco residual é comprometimento do próprio gateway. Com o aceite
explícito de risco + suggest default + tetos, destravar é decisão de produto
defensável. O texto do ack menciona o risco de banimento (não o de spoofing, que é
infra nossa). HMAC por-tenant continua no backlog de hardening.

---

## P2 — Fila de envio humanizada (anti-burst / anti-ban)

**Objetivo:** nenhum burst de envios simultâneos por número, em nenhum transporte;
no bridge, comportamento que imite uso humano (intervalos irregulares, "digitando…").
Isso protege TODO envio (manual em massa, agendado, IA) — não só o atendente.

### Desenho: cursor de pacing em dois níveis
Hoje: `slot = max(now, cursorDaConversa)` (+6s). Passa a ser:

```
slot = max(now, cursorDaConversa, cursorDoCanal)
cursorDaConversa = slot + 6s                       (pair rate Meta, mantém)
cursorDoCanal    = slot + intervalo(provider) + jitter
```

- Novo campo `channelConfigs.nextDispatchAt` (cursor OCC por NÚMERO, mesmo padrão
  do por-conversa). Toda saída WhatsApp reivindica um slot no cursor do canal em
  `scheduleWhatsappDispatch` — ponto único, então **mensagens agendadas, envios da
  IA e bulk manual herdam o espalhamento automaticamente**, sem tocar em
  `scheduledMessages.ts`.
- Mensagem única com canal ocioso: cursor no passado → envia AGORA (zero latência
  percebida no uso normal; o pacing só morde em rajada).

### Intervalos calibrados pela pesquisa (`AI-WHATSAPP-LIMITS.md`)
| Transporte | Cursor por conversa (par) | Cursor por canal (número) | Racional |
|---|---|---|---|
| Meta (oficial) | 6,5 s (margem sobre os 6 s documentados — erro 131056) | 1 s + jitter 0–2 s | pair rate é documentado; espalhar rajada a destinatários distintos NÃO é exigência da Meta (80 mps de throughput comportaria), é prudência de quality rating — a própria pesquisa sugere 1–3 s [fonte 3] |
| Bridge (não-oficial) | 6,5 s (mesma analogia) | 4 s + jitter 0–6 s (faixa 4–10 s) | comunidade diverge (1–5 s a 15–45 s); 3–10 s é o ponto de partida recomendado — **estimativa de engenharia calibrável, NÃO limite oficial** (comentário no código dirá isso) |

Ponto forte da pesquisa a nosso favor: o fator decisivo de ban no protocolo
não-oficial não é o delay, é ser "broadcaster" para contatos frios. O atendente IA
é **100% reativo** (só responde conversa iniciada pelo cliente) — a categoria de
menor risco em todas as fontes. As travas acima protegem sobretudo bulk/agendadas.

### Humanização extra no bridge (só envios de IA e agendados)
- Antes de enviar: presence "composing" (já existe `sendTypingState`) + espera
  proporcional ao tamanho da resposta (ex.: `min(1,5s + 35ms/caractere, 6s)`), em
  `dispatchViaBridge` (é action, pode aguardar). Envio manual do inbox NÃO ganha
  atraso artificial — a digitação humana já é o pacing.
- **Retry pacing-aware**: erros de rate da Meta re-agendam com o backoff OFICIAL da
  doc (`4^X` segundos — 1s, 4s, 16s…): 131056 (pair rate) e 130429 (throughput);
  em vez de falhar direto (`internalMarkDispatchFailed`).

### O que fica de fora (documentado em `AI-WHATSAPP-LIMITS.md`, não implementado agora)
- Cap diário rígido por número bridge e warm-up de número novo (nenhuma fonte dá
  número garantido; se um dia entrar, é decisão de produto sem lastro documental).
- Monitorar `quality_score` via webhook `phone_number_quality_update` e cortar
  campanhas automaticamente em YELLOW/RED — hardening futuro do canal Meta.
- Tratamento de `held_for_quality_assessment`/erro 132015 (template pacing da
  Meta) — relevante quando campanhas de template forem produto.

---

## P3 — Toggles separados: Copiloto × Atendente

### Schema
- `aiConfig.copilotEnabled: v.optional(v.boolean())` — default `true` (quando mestre ligado).
- `aiConfig.attendantEnabled: v.optional(v.boolean())` — idem.
- O mestre `enabled` + `lgpdAck` continuam mandando em tudo (kill-switch geral).

### Backend
- Copiloto: `internalResolveSession` (copilotHttp) recusa quando `copilotEnabled === false`.
- Atendente: `evaluateEligibility` ganha razão `atendente_desativado` quando
  `attendantEnabled === false` (checada no enqueue E re-checada no commit, como as demais).
- Mutation nova `aiSettings.setFeatureToggles` (permissão settings/manage).

### UI
- Em Configurações → IA, logo abaixo da ativação mestre: dois switches grandes
  ("Copiloto do CRM" / "Atendente virtual") com descrição de uma linha cada.
- Botão flutuante do copiloto some quando `copilotEnabled === false`
  (o `getAiStatus` já alimenta o AppShell — só propagar o campo).

---

## P4 — Regras de pipeline configuráveis no atendente

### Schema — `agentProfile.pipelineConfig` (tudo opcional = default atual)
```ts
pipelineConfig: v.optional(v.object({
  boardId: v.optional(v.id("boards")),          // board p/ novos leads dos canais do atendente
  initialStageId: v.optional(v.id("stages")),   // estágio inicial (default: 1º do board)
  advanceRules: v.optional(v.string()),         // regras em linguagem natural → prompt
  qualifiedStageId: v.optional(v.id("stages")), // p/ onde mover quando qualificar (movimento DETERMINÍSTICO)
  allowMoveStages: v.optional(v.boolean()),     // default true; false remove moveThisLead das tools da run
}))
```

### Comportamento
- **Estágio inicial**: `ensureLeadForContact` (roteamento inbound) passa a aceitar
  board/estágio preferidos; o ingest resolve o atendente do canal e usa o
  `pipelineConfig` dele quando existir. Sem config → comportamento atual.
- **Avanço por regra (determinístico)**: quando `qualifyThisLead` atingir score ≥
  threshold da org e existir `qualifiedStageId`, o CÓDIGO move o lead (não depende
  do modelo obedecer). Activity/audit registram "movido por regra de qualificação".
- **Avanço por instrução (LLM)**: `advanceRules` entra no prompt numa seção "REGRAS
  DO FUNIL" (ex.: *"mova para 'Proposta' quando o cliente pedir orçamento"*). O
  modelo continua limitado ao `moveThisLead` já existente (escopo por registro).
- **`allowMoveStages: false`**: a run filtra `moveThisLead` do registry (o registry
  estático continua sendo a fonte — só subtração por-run, nunca adição).
- Defaults por persona: cada persona de `lib/agentPersonas.ts` ganha um
  `advanceRules` default coerente (ex.: imobiliária → "visita agendada = avançar").

### UI
- No modal "Personalizar" do atendente: seção **"Opções avançadas"** (collapse
  fechado por default) com: select de board + estágio inicial, select de estágio
  pós-qualificação, textarea "Quando avançar o lead" (com placeholder da persona),
  switch "Atendente pode mover leads no funil".

---

## Testes novos (vitest + convex-test)
1. Bridge gate: sem ack → atendente não atende bridge; com ack → atende; Meta inalterado.
2. Elegibilidade: conversa bridge ignora `janela_24h`; Meta continua exigindo.
3. `attendantEnabled:false` → skip `atendente_desativado` (enqueue e commit); `copilotEnabled:false` → sessão do copiloto recusada.
4. Pacing por canal: 5 mensagens em 3 conversas do mesmo canal → slots estritamente espaçados ≥ intervalo; canal ocioso → envio imediato.
5. Mensagens agendadas em massa: N entregas no mesmo `runAt` → dispatches espalhados.
6. Retry pacing-aware: erro 131056 re-agenda em vez de falhar.
7. Qualificação move lead deterministicamente p/ `qualifiedStageId`; `allowMoveStages:false` remove a tool da run.
8. Build test de segurança (`agentToolSecurity.test.ts`) continua verde — nenhuma tool nova, nenhum campo-segredo exposto.

## Invariantes que NÃO mudam
Suggest default · gate server-side do autopilot · disclosure LGPD 1ª resposta ·
keyword "humano" pré-LLM · TOOL_DENYLIST/escopo por registro · opt-in total
(`enabled:false` default + lgpdAck) · commit transacional TOCTOU · sem transcrição
em `agentRuns`.

## Sequência de execução (após seu OK)
1. **F-A (backend core, eu):** schema + P1 gate/elegibilidade + P3 toggles + P2 cursor por canal e retry — com testes.
2. **F-B (paralelo, subagente frontend):** UI — card bridge ack, switches P3, opções avançadas P4, pill do inbox.
3. **F-C (backend, eu):** P4 runtime (inbound routing, qualificação determinística, prompt) + humanização bridge (typing/jitter) — com testes.
4. **F-D:** `npm run lint` + `npm run test` completos, deploy dev (`npx convex dev --once`), smoke com `pingProvider` + simulador, atualização de STATUS/TODO-ERIC/CLAUDE.md/memória.
5. Validação viva no seu ambiente (inclusive o teste real do bridge com seu telefone — continua sendo item seu).

## Decisões que assumi (me corrija se discordar)
- Ack do bridge é **org-level** (um aceite vale para todos os canais bridge da org), não por canal.
- Envio manual único não ganha atraso artificial em nenhum transporte (pacing só morde em rajada).
- Cap diário/warm-up de número bridge ficam FORA desta rodada (só recomendação documentada).
- Toggles P3 são org-level; o liga/desliga por atendente individual continua sendo o status do membro.
