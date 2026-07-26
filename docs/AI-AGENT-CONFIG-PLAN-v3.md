# AI Agent Config — Plano de Implementação **v3** (provider-agnostic)

**Criado:** 2026-07-24
**Supersede:** v1 (rascunho) e v2 (revisão adversarial de segurança/concorrência/custo/UX). **v3 mantém integralmente a arquitetura de segurança, concorrência, identidade, evals e UX do v2** e troca a camada de provider: de Anthropic-default para **provider-agnostic, default OpenCode Go (OpenAI-compatible)**, com ZDR ligado por padrão.
**Base verificada:** `main`. Fatos de provider verificados via docs (OpenCode Go, OpenRouter) + pesquisa web (jul/2026). IDs/preços de modelo são pós-cutoff → **confirmar contra `/v1/models` na implementação** (ver [blocked]).

> **Princípio inegociável (pedido do usuário):** **toda a IA é opt-in.** Quem quiser um CRM comum nunca toca nela — `aiConfig.enabled` **default `false`**, nenhuma inferência dispara, nenhum custo. O onboarding de IA é um fluxo separado e opcional.

---

## 0. O que muda e o que permanece (do v2)

**PERMANECE sem alteração (é provider-agnostic por natureza — não re-derivar, seguir o v2):**
- **Segurança em 4 camadas** (§3.2 do v2): wrapper `assertAgentCan` server-side nas mutations agentadas; **escopo por registro**; **denylist de tools + teste de build**; **dado do CRM sempre não-confiável** (envelope delimitado).
- **Superfície de tools por INJEÇÃO de contexto** (§3.1 do v2): o atendente recebe o contexto do `conversationId` do gatilho; **não** ganha tools de listagem org-wide (`internalGetContacts`/`SearchContacts`/`GetConversations`). Isso mata a exfiltração intra-org **independente do modelo** — crítico, porque modelos baratos de chat (deepseek-v4-flash) são mais suscetíveis a prompt-injection.
- **Concorrência/idempotência** (§4.3 do v2): fila `aiReplyQueue` + pacing por-org (cursor OCC, espelhando `whatsappDispatch.ts:14-24`) + `internalCommitAiReply` transacional (re-checa elegibilidade — TOCTOU) + lock/lease OCC por conversa + debounce; mutation explícita `assumeConversation`/`pauseAi`.
- **Identidade/atribuição** (§3.5 do v2): copiloto `actorType:"human"` + `metadata.via:"copilot"`; atendente `teamMember` IA dedicado `actorType:"ai"`.
- **Evals + modo sugestão** (§4.7 do v2): `mode:"suggest"|"autopilot"`, começa em `suggest`; fila de revisão; sinais de qualidade.
- **UX** (§6 do v2): ativação em 1 toque semeada dos dados da org, personas por indústria, simulador, "assumir/pausar IA", medidor amigável, "melhorar resposta", handoff nunca frio.
- **Fases + gates de segurança** (§7 do v2), com um gate a mais em F0 (camada de provider + ZDR).
- **Limite de action = 10 min** + orçamento de wall-clock + re-scheduling p/ copiloto agêntico longo.

**MUDA (tudo que era específico da Anthropic API):**
| v2 (Anthropic) | v3 (provider-agnostic / OpenAI-compatible) |
|---|---|
| `fetch` para `api.anthropic.com/v1/messages`, blocos `tool_use`/`tool_result` | `fetch` para `/chat/completions` (OpenAI-compat), `tool_calls` + `role:"tool"` (§4). Adapter Anthropic opcional. |
| `output_config.effort`, `thinking:{adaptive}`, `budget_tokens` | Não existem. `temperature`/`top_p` VOLTAM (usar default baixo). Reasoning é do modelo (kimi/deepseek-pro têm thinking nativo), não um param universal. |
| `cache_control` explícito por prefixo | Caching **automático** por provider (DeepSeek context cache; OpenAI prefix cache). Manter prefixo estável (system+tools+knowledge) para hit. |
| Mid-conversation `role:"system"` não-spoofável (canal anti-injection) | **Não garantido** em OpenAI-compat → operador vai no `system`/`developer` inicial; dado volátil só em `user`/`tool` com delimitadores. **Downgrade real na defesa de injeção** → depender mais das tools escopadas (§0 PERMANECE). |
| `stop_reason:"refusal"` | `finish_reason:"content_filter"` (e erros de provider). |
| Custo por-token (Opus $5/$25 etc.); spend cap por tier | OpenCode Go = **assinatura + limites de uso** (não por-token). Per-token só em OpenRouter/DeepSeek-direto (DeepSeek é ~10–30× mais barato que Opus). |
| Default `claude-opus-4-8` | Default: copiloto `kimi-k2.7-code`, atendente/chat `deepseek-v4-flash` (§2). |

---

## 1. Arquitetura da camada de provider

Novo diretório `convex/lib/llm/`. Interface fina; a maioria dos providers é OpenAI-compatible, então **um adapter cobre quase tudo**.

```ts
// convex/lib/llm/types.ts
interface LlmProvider {
  chat(req: NormalizedRequest): Promise<NormalizedResponse>;      // atendente (resposta curta)
  streamChat(req: NormalizedRequest): AsyncIterable<StreamDelta>; // copiloto (streaming)
}
```

**Dois adapters:**
- **`openaiCompatible`** — cobre **OpenCode Go (default)**, OpenRouter, OpenAI, DeepSeek-direto, Moonshot-direto, Groq, Together, e **qualquer base URL custom**. Só muda `{ baseUrl, apiKeyRef, extraHeaders }`. Request/response no formato Chat Completions (§4).
- **`anthropic`** (opcional) — Messages API nativa, para orgs que preferem Claude. (O próprio OpenCode Go expõe `/messages` para minimax/qwen — anthropic-compat — mas para o v1 tratamos OpenCode Go só via `/chat/completions`.)

**Dois modos (por-org, default `platform`):**
```ts
// em org.settings.aiConfig (estende o que já existe em schema.ts:28)
providerConfig: {
  mode: "platform" | "byo",             // DEFAULT "platform" (usa as keys da plataforma)
  // BYO: a org traz o próprio provider/key (cifrada em orgSecrets)
  byo?: {
    provider: "opencode-go" | "openrouter" | "openai" | "anthropic" | "custom",
    baseUrl?: string,                   // só p/ "custom"
    apiKeyRef: { kind: "orgSecret"; id: Id<"orgSecrets"> },
  },
  zdr: boolean,                         // DEFAULT true = padrão seguro + AVISAR nas rotas não-ZDR (§3)
  models: {                             // IDs CANÔNICOS; o adapter mapeia p/ o id de cada provider
    copilot: string,    // default "kimi-k2.7-code"
    attendant: string,  // default "deepseek-v4-flash"
    classify: string,   // default "deepseek-v4-flash" (decisão de handoff/roteamento)
    complex?: string,   // p/ subir em fluxo difícil, ex. "deepseek-v4-pro"
  },
}
```
- **Modo `platform` (default) = cadeia de fallback com as keys da plataforma** (env do deployment Convex): **1º OpenCode Go** (`OPENCODE_GO_API` — já setada ✅) → **fallback OpenRouter** (`OPENROUTER_API_KEY`, ainda não setada; implementar o caminho, **inativo até a key existir**). O fallback dispara em 429/5xx/timeout **e** em **esgotamento do tier de uso** do OpenCode Go (que é assinatura+limite — §5). Precisa de um **mapa de equivalência de modelo** (id canônico → id por provider, ex.: `deepseek-v4-flash` → OpenCode Go `deepseek-v4-flash`, OpenRouter `deepseek/deepseek-v4-flash`).
- **Modo `byo`** = key da org em `orgSecrets` cifrada (reusa `secretCrypto.ts` — `encryptSecret`/`decryptSecret`/`secretLast4`; **não** existe `maskConfig` lá, escrever masker próprio). Sem fallback para as keys da plataforma (a org paga a própria conta).
- **Nunca** logar a key em `agentRuns.error`/prompt/tool_result/cache (sanitizar; §4 do v2).

**Base OpenCode Go (confirmado nas docs):** `https://opencode.ai/zen/go/v1/` · Chat Completions `POST /chat/completions` · Bearer auth · modelos chat: `grok-4.5, glm-5.2, glm-5.1, kimi-k3, kimi-k2.7-code, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash, mimo-v2.5, mimo-v2.5-pro, hy3` · residência **EUA** · **zero-retention nos modelos PAGOS** (exceções que ficam fora do ZDR: modelos *free* e rotas via-Zen de OpenAI/Anthropic — ver §3).

---

## 2. Roteamento de modelos + matriz de teste (limitada a ≤5 extras)

**Defaults (verificar IDs contra `/v1/models` — [blocked]):**
- **Copiloto (agêntico, muitas tool-calls, mexe no CRM) → `kimi-k2.7-code`.** Perfil agêntico forte, reasoning nativo, JSON schema, ~256K contexto. É o nicho da variante "code".
- **Atendente (WhatsApp, alto volume, sensível a custo) → `deepseek-v4-flash`.** Chat rápido/barato (~$0.14/$0.28 por 1M, 1M contexto), function-calling + strict JSON. Adequado às ~1–3 tool-calls do atendimento.
  - **Ressalvas (mitigadas pelo design):** (a) degrada em cadeias de 10+ tools → fluxo longo do atendente sobe para `complex`/copiloto; (b) modelo barato é mais suscetível a prompt-injection → tools escopadas de baixo privilégio + confirmação (já no design, §0).
- **`deepseek-v4-pro`** p/ trabalho complexo de turno único — **mas** há relato de bug de tool-call multi-turn no modo thinking → **validar antes** de usar no copiloto (turno único: ok).

**Matriz de teste (o usuário pediu no máx. 5 além dos 2 já escolhidos):**
| # | Modelo | Papel | Por que testar |
|---|---|---|---|
| 1 | **Grok 4.5** | Copiloto (teto) | Frontier agêntico com foco em **baixa alucinação** — desejável quando o agente altera dados reais. |
| 2 | **GLM-5.2** | Ambos | Melhor custo-benefício geral (open-weight, rápido, multilíngue/customer-facing). Alternativa a ambos. |
| 3 | **Qwen 3.7 Plus** | Atendente | Barato + a linha **mais multilíngue** → melhor aposta PT-BR a baixo custo. Alternativa direta ao Flash. |
| 4 | **MiniMax M3** | Atendente | Tool-use mais barato com 1M contexto — menor custo/latência para volume. |
| 5 | **Kimi K3** | Copiloto (teto) | Mais inteligente da lista, mas **lento/caro** → só como teto de qualidade; 1º a cortar. |

**Mini-eval PT-BR obrigatório antes de fixar o atendente:** nenhum modelo tem benchmark PT-BR público forte. Rodar 10–20 diálogos reais de atendimento + 5 tarefas de copiloto comparando **deepseek-v4-flash vs Qwen 3.7 Plus vs GLM-5.2** (usa a infra de evals do §4.7 do v2 / `agentEvals`). Não exceder a matriz acima.

---

## 3. ZDR / residência de dados / LGPD (ligado por padrão, enforçado)

**ZDR é transparência + aviso, não bloqueio duro** (decisão do produto). `aiConfig.providerConfig.zdr` é `true` por padrão. O **caminho padrão da plataforma já é zero-retention** (OpenCode Go pago → OpenRouter ZDR), então na prática o usuário no default nunca vê aviso. O aviso aparece **só quando ele sai do padrão** (BYO com provider não-ZDR, ou escolha de um modelo com retenção). Operacionalmente:

- **Registry de rotas** `{ provider|model → { zdrCapable, dataResidency, retention } }` — a fonte da verdade para o aviso. `zdrCapable` é por **rota** (provider+modelo+tier), não por provider — há exceções (abaixo). Com `zdr:true`, ao escolher uma rota não-`zdrCapable` a UI **avisa e pede aceite** ("esta rota retém dados por até 30 dias / processa na China — confirma?"); o backend **não bloqueia por padrão** (a org é a controladora e decide). *(Opcional: um modo "estrito" por org que efetivamente recusa rotas não-ZDR no backend — oferecer como toggle avançado para quem exige compliance rígida.)* O padrão de **rotas da plataforma** é zero-retention, então o aviso é a exceção, não a regra.
- **OpenCode Go (default):** residência **EUA**; modelos **pagos** (kimi-k2.7-code, deepseek-v4-flash/pro pagos, etc.) = zero-retention → `zdrCapable:true`. **Exceções que ficam FORA do ZDR:** (a) modelos **free** do Zen (ex.: "DeepSeek V4 Flash **Free**") — usam dados para treino durante o período grátis; (b) OpenAI **via** Zen e Anthropic **via** Zen — retêm **30 dias**. Ou seja: sob ZDR, use os modelos **pagos** do Zen, não os free nem as rotas via-Zen de OpenAI/Anthropic. Nuance boa: DeepSeek servido **via Zen roda em infra US com zero-retention** — rota radicalmente diferente da API direta chinesa. (Risco residual `NÃO-CONFIRMADO`: o que o próprio OpenCode faz com os prompts — citar no DPA.)
- **OpenRouter:** ZDR por **trava dupla** — conta em *"ZDR Endpoints only"* **E**, por request, o objeto `provider`: `{"data_collection":"deny","require_parameters":true,"allow_fallbacks":false}` (params confirmados na doc). `data_collection:"deny"` = só providers que não coletam; `require_parameters` garante suporte a tools/json_schema; sem fallbacks para não cair numa rota não-ZDR. Logging de conteúdo do OpenRouter é opt-in — manter desligado.
- **DeepSeek API DIRETA (platform.deepseek.com):** residência **China (RPC)**, treina com os dados, retém ~30d, **sem opção de datacenter US/EU** → transferência internacional sensível (LGPD Art. 33). **Sob ZDR: `zdrCapable:false` — bloquear.** DeepSeek continua utilizável, mas **só via gateway US zero-retention** (Zen pago / OpenRouter ZDR).
- **Kimi/Moonshot DIRETO:** operado em Singapura, **sem opt-out de treino em nível de produto** e jurisdição final incerta → sob ZDR, **bloquear no direto**; usar via gateway zero-retention.
- **OpenAI DIRETO:** não treina com dados de API (desde 2023); retenção padrão ~30d (abuso); ZDR só **com acordo comercial** (sales) — e aí `/chat/completions` é elegível. Marcar `zdrCapable` só onde a conta tiver acordo ZDR.
- **Anthropic DIRETO (opcional):** ZDR por acordo (sales), por org; **Claude "Fable 5" NÃO roda sob ZDR** (exige 30 dias) → sob `zdr:true`, não oferecer Fable.

**UI/compliance (LGPD, do v2 §4.6, reforçado):**
- **Seção "IA" em Configurações** (`Settings.tsx:23` — não existe hoje): toggle master (default OFF), gate de reconhecimento LGPD ao ativar ("confirmo que minha política divulga uso de IA + transferência internacional"), **seletor de provider/modelo com selo de residência e ZDR**, budget de uso, painel de custo.
- **Divulgação ao cliente** na 1ª mensagem ("Você fala com um assistente virtual. Digite 'humano' para uma pessoa.").
- **Opt-out por contato** (`aiOptOut` em `contacts`) = 9ª condição de elegibilidade (não responder + escalar).
- **Não persistir transcrições** em `agentRuns` (só tokens/custo/tools/`messageId`) — reduz superfície de deleção (art. 18) e mantém o registro de operações (art. 37) sem duplicar PII.
- Base legal: **legítimo interesse + execução de contrato + transparência** (não consentimento).

---

## 4. Contrato do runtime (OpenAI-compatible)

Runtime em `internalAction` com `fetch` **sem `"use node"`** (espelha `transcription.ts`). Limite de **10 min** por action → atendente cabe folgado (`maxToolCallsPerRun` 4–6, resposta curta); copiloto agêntico longo persiste `messages` no DB e re-agenda continuação (§0 PERMANECE).

**Loop de tool-use (Chat Completions):**
```
messages = [ {role:"system", content: <persona + regras + envelope de dados não-confiáveis>}, ... ]
tools    = [ {type:"function", function:{ name, description, parameters:<JSON schema> }}, ... ]
loop:
  resp = POST /chat/completions { model, messages, tools, tool_choice:"auto", temperature:0.3, stream:false }
  msg  = resp.choices[0].message
  messages.push(msg)                                  // inclui msg.tool_calls
  if resp.choices[0].finish_reason !== "tool_calls": break
  for tc of msg.tool_calls:                           // executar via internal.* GATED (assertAgentCan)
     result = runTool(tc.function.name, JSON.parse(tc.function.arguments))
     messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) })
```
- **Handoff sem 2ª chamada** (corrige v2 C11): expor `requestHandoff` como **tool** (o modelo chama) — não um passo de structured-output separado (dobraria a inferência).
- **Structured output** quando precisar (ex.: extrair `{confidence}`): `response_format:{type:"json_schema", json_schema:{name, schema, strict:true}}` (OpenAI garante adesão ao schema; o equivalente em tool é `function.strict:true` + `additionalProperties:false` + tudo em `required`). **DeepSeek/Kimi via OpenCode Go: suporte a `json_schema strict` é `NÃO-CONFIRMADO`** → estratégia por modelo: **feature-flag de capacidade** no registry; onde não houver strict, cair para `response_format:{type:"json_object"}` + **validação zod** no runtime (re-tentar/reparar em falha). No OpenRouter, casar com `require_parameters:true`.

**Streaming (copiloto), SSE OpenAI:** linhas `data:` com `choices[0].delta.content` (texto) e `delta.tool_calls[]` parciais — **acumular por `index`** (`id`/`function.name` chegam no 1º delta do índice; `function.arguments` vem em fragmentos a concatenar); terminador `data: [DONE]`. (Isto é o dialeto **Chat Completions** — não confundir com os eventos nomeados da Responses API.) `httpAction` autenticado (token do Convex auth no header, validar antes de qualquer tool — o copiloto age como o usuário) + persistência incremental em fronteiras de sentença. **Não** adotar `@convex-dev/agent`.

**Caching (automático, sem `cache_control`) — alavanca de custo forte:** manter o prefixo estável (system + tools + knowledge) **no começo**, conteúdo variável no fim. **OpenAI:** automático, mínimo **1024 tokens**, roteia por hash dos ~256 primeiros tokens, hit em `usage.prompt_tokens_details.cached_tokens` (param opcional `prompt_cache_key`). **DeepSeek:** context cache em disco ligado por padrão, exige **match total do prefixo**, desconto de **~98%** em hit (v4-flash ~$0.0028 hit vs $0.14 miss/M) — desenhar o prefixo estável **rende muito** aqui. **OpenRouter:** passthrough do provider.

**Failure modes / backoff (do v2 §4.2/§4.4, provider-agnostic):** 429 → respeitar `retry-after`; 5xx/timeout → backoff exponencial (2s/8s/30s) re-agendado; `finish_reason:"content_filter"` → escalar via handoff. `fetch` cru não tem retry de SDK — implementar (reusar formato de `nodeActions.ts:236-253`). Idempotência de envio: guard `whatsapp.ts:549` (re-dispatch) + claim de row + commit-mutation (2 replies distintos).

**Params por papel:**
- Atendente: `temperature` baixa (0.2–0.4), `max_tokens` curto, `maxToolCallsPerRun` 4–6, não-streaming.
- Copiloto: `temperature` 0.3–0.5, streaming, `maxToolCallsPerRun` maior, wall-clock budget + re-schedule.
- (Reasoning nativo de kimi/deepseek-pro é automático; não há knob universal de "effort".)

---

## 5. Custo e budget

- **OpenCode Go = assinatura + limites de uso** ($5 1º mês, $10/mês; tiers 5h/$12, semanal/$30, mensal/$60). Não é por-token → o "spend cap" é o **tier de uso**; modelos baratos (deepseek-v4-flash) rendem mais requests. Rastrear **contagem de requests** por período contra o tier. Escolher o tier pelo volume esperado ([blocked] §8.3).
- **Per-token** (OpenRouter/DeepSeek-direto): projeção usa os preços do §2 (DeepSeek V4 Flash ~$0.14/$0.28 → **muito** mais barato que Opus). `monthlyUsageBudget` (kill-switch do app) + `agentRuns` (tokens/custo estimado por run) valem aqui.
- Medidor amigável na UI (do v2 §6): "~340 de ~500 conversas usadas este mês" — não tokens crus.

---

## 6. UX / onboarding (opt-in de ponta a ponta)

Tudo do v2 §6 vale. Reforços do pedido:
- **Copiloto como agente de onboarding/configuração** (caso de uso destacado pelo usuário): um chat "me conte seu negócio e eu monto seu CRM" que cria pipelines/estágios/campos/canais **conversando** — com **confirmação por preview** antes de aplicar (é escrita real; §3.2/§confirmação do v2). Fully opcional; quem quer CRM comum ignora.
- **Seletor de provider/modelo** na seção IA: default OpenCode Go + kimi/deepseek, com "avançado" para trocar provider, colar BYO key, e ver selo de **residência + ZDR** por modelo.
- **Ativação em 1 toque**, semeada de `quickReplies` (→ knowledge), `stages` (→ qualificação), `onboardingMeta.industry` (→ persona por indústria); horário default `America/Sao_Paulo`.
- Tudo atrás de "Personalizar"; iniciante sai de zero → "IA em modo sugestão" em 1 clique. **`enabled` default `false`**.

---

## 7. Fases revisadas (gates de segurança + provider)

| Fase | Entrega | Gate "pronto p/ produção" |
|---|---|---|
| **F0 — Fundação segura + camada de provider** | Schema (IA + `agentRuns` sem PII + `aiReplyQueue` + `aiTurnLock` + `orgSecrets` + `providerConfig`); **camada `convex/lib/llm/` (adapter openaiCompatible + registry ZDR)**; runtime (loop tool_calls, wall-clock budget); **`assertAgentCan` + escopo por registro + denylist + teste de build**; guardas de org nas `internal.*`; env `OPENCODE_GO_API` no deployment. | Teste de build barra tool que retorna segredo; toda `internal.*` agentada assevera org; `zdr:true` recusa provider não-zdrCapable; key nunca no frontend. |
| **F1 — Copiloto (leitura)** | Chat + streaming autenticado + tools de leitura. Age como usuário (`actorType:"human"`+`via:"copilot"`). | Gate server-side ativo; nenhuma escrita; segredos mascarados. |
| **F2 — Copiloto (escrita + confirmação + onboarding)** | Escrita com confirmação por reversibilidade; two-phase server-side p/ destrutivo; **fluxo de onboarding conversacional**. | Nenhuma destrutiva sem `pendingAction`+disparo humano; preview mostra o efeito. |
| **F3 — Atendente (piloto, MODO SUGESTÃO)** | Fila + `internalCommitAiReply` gated + lock/lease + debounce + janela 24h + handoff-as-tool + `deepseek-v4-flash`. **Um agente, um canal Meta, `mode:"suggest"` (não auto-envia), opt-in.** | **Gate pré-clientes:** contexto por injeção (zero tools org-wide) provado por teste de concorrência (`vitest`+`convex-test`); LGPD (toggle+ack+divulgação+opt-out); ZDR enforçado; bridge **fora** até HMAC por-tenant. |
| **F4 — Autopilot + Config UI + custo + mini-eval PT-BR** | Toggle `autopilot` (após métricas de aceitação); seção IA; medidor; personas; simulador; **mini-eval PT-BR (≤3 modelos)**. | Sinais de qualidade no limiar; budget/tier ativos; content_filter/backoff testados. |
| **F5 — Hardening & escala** | RAG (v2), tiering por tarefa, BYO key + providers extras (OpenRouter/OpenAI/Anthropic), HMAC bridge por-tenant, golden conversations, **matriz de teste ≤5 modelos**. | HMAC por-tenant antes do atendente no bridge; evals de regressão no CI. |

**Regra dura:** nenhum atendente fala com cliente real em `autopilot` antes do gate de segurança **e** de métricas de aceitação em `suggest`. IA só liga se o admin ativar (default OFF).

---

## 8. [blocked] — depende de você (consolidado)

1. **[RESOLVIDO ✅] `OPENCODE_GO_API` setada no deployment Convex.** (Lembrete p/ keys futuras: sempre `npx convex env set`, **nunca** `.env.local` nem prefixo `VITE_` — vazaria pro browser.)
2. **[blocked] Confirmar IDs de modelo do seu tier:** `GET https://opencode.ai/zen/go/v1/models` com a key. O plano assume `kimi-k2.7-code`, `deepseek-v4-flash`, `deepseek-v4-pro` — confirmar que existem/nomes exatos.
3. **[blocked] Escolher o tier/assinatura do OpenCode Go** (limites de uso: 5h/semanal/mensal) pelo volume esperado.
4. **[blocked] LGPD:** sua política de privacidade precisa divulgar uso de IA + transferência internacional (e residência, se BYO usar DeepSeek/Kimi diretos). Necessário para o gate de ativação do atendente.
5. **[diferido] `OPENROUTER_API_KEY` (fallback da plataforma).** Você optou por deixar p/ depois — o caminho de fallback é implementado mas fica **inativo** até a key existir; até lá roda só OpenCode Go. Keys de OpenAI/Anthropic idem, só se quiser esses providers.
6. **[blocked-opcional] Confirmar a matriz de teste** (≤5 extras: Grok 4.5, GLM-5.2, Qwen 3.7 Plus, MiniMax M3, Kimi K3) e o mini-eval PT-BR.
7. **[RESOLVIDO ✅] ZDR = aviso, não bloqueio.** Padrão da plataforma já é zero-retention; ao sair do padrão (BYO não-ZDR / modelo com retenção), a UI avisa e pede aceite; sem bloqueio de backend (modo estrito opcional).

---

*v3 = v2 (segurança/concorrência/identidade/evals/UX inalterados) + camada de provider agnóstica (OpenAI-compatible, default OpenCode Go) + ZDR-default + roteamento de modelos. IDs/preços de modelo são pós-cutoff e devem ser confirmados na implementação.*
