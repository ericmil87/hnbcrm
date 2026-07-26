# AI Agent Config — Relatório E2E

> **⚠️ SNAPSHOT HISTÓRICO (v4.0, 2026-07-24).** Na rodada **v4.1 (2026-07-26)**
> o gate "Meta-only do atendente" citado abaixo foi substituído por **aceite de
> risco org-level** (`aiConfig.bridgeAiAck`): com o aceite vigente o atendente
> ATENDE canais bridge (condição de elegibilidade re-checada no commit), e o
> Inbox passa a exibir os controles de IA em conversas bridge exatamente quando
> o aceite existe (o "cosmético" do Achado 5 virou comportamento intencional).
> NÃO é regressão — ver `AI-AGENT-CONFIG-PLAN-v4.1.md` (nota de segurança) e o
> E2E v4.1 (10✅/0❌) registrado em `AI-AGENT-CONFIG-STATUS.md`.

**Data:** 2026-07-24 · **Ambiente:** browser real (Chrome) + deployment dev `tacit-chicken-195` + LLM real (OpenCode Go) · **Org:** Acme Corp Test (`m575gcmmkm2c2brzxtg1b70q518ate72`)
**Testador:** exercício DE VERDADE dos fluxos (copiloto in-app + atendente WhatsApp), modo sugestão.

## Resumo

- **Cenários:** 20 checados → **15 ✅ · 5 ⚠️ · 0 ❌**
- **Bloqueador prático:** instabilidade upstream do **OpenCode Go** (HTTP 400 "Upstream request failed") em requests de *tool-continuation* — afeta o copiloto (intermitente) e é um risco para o atendente (determinístico com deepseek-v4-flash). Não é bug de código; é provider + fallback OpenRouter inativo.
- **Todos os gates de segurança seguraram:** two-phase do copiloto, Meta-only do atendente (bridge excluído), keyword-handoff pré-LLM, pausa/assumir, agentRuns sem PII, disclosure LGPD.
- **Nenhum código alterado** (achados são externos/design — reportados, não corrigidos).

## Tabela de resultados

| Cenário | Status | Evidência |
|---|---|---|
| **A.1** Botão flutuante Sparkles abre "Copiloto IA" | ✅ | Painel abre com welcome + chips de sugestão. |
| **A.2** "Como está meu funil?" — streaming + chip de tool + dados reais | ⚠️ | Na 3ª tentativa: texto em streaming, chip "consultando o funil", resposta correta (Pipeline de Saúde, 2 leads em Tratamento = R$ 500, demais estágios 0). **2 das 3 tentativas falharam com HTTP 400** do OpenCode Go (ver Achado 1). |
| **A.3** Criar "Lead E2E Copiloto" valor 5000 + auditoria | ✅ | Lead criado (`kx72fmr6…`), chip "createLead", anúncio "Vou criar…R$ 5.000". auditLog: `action:create`, `actorType:"human"`, `metadata.via:"copilot"`. |
| **A.4** Excluir lead — two-phase | ✅ | Chip "deleteLead", card VERMELHO "Excluir permanentemente… não pode ser desfeita", `pendingActions` (TTL 15min). Lead **persistiu** até Confirmar; sumiu (count 1→0) após clique. |
| **A.5** Nova conversa + persistência | ✅ | `+` reseta p/ welcome (thread criada lazy no 1º envio); mensagem persiste ao fechar/reabrir (query reativa; 13 msgs em `copilotMessages`). |
| **B** Simulador (sandbox) | ✅ | Resposta PT-BR estilo WhatsApp começa com disclosure LGPD; NÃO inventa preço ("depende da avaliação/convênio, posso agendar"). Nada escrito no CRM (0 attendant runs, sem inserts). |
| **C.1** Canal Meta E2E (creds falsas) nasce ativo | ✅ | Toast "Número conectado", card "Meta E2E · Ativo · Cloud API", `ph70p0kwk9qw…`. "Testar conexão" NÃO executado. |
| **C.2** Inbound sintético via CLI | ✅ | `internalRouteInbound` → lead `kx73pgh6…`/contact `k9728dvw…`; `internalReceiveMessage` (wamid.E2E001) OK. |
| **C.3** Fila `done` + agentRun `done`, tokens, sem transcrição | ✅ | `aiReplyQueue` status `done`; `agentRuns` kind=attendant, status=done, deepseek-v4-flash, prompt=1524/compl=371, custo=$0.00032, **sem campo de transcrição/PII**. |
| **C.4** AiDraftCard roxo + disclosure + Enviar → outbound + delivery falha | ✅ | Card roxo "Sugestão do atendente IA"; 1ª linha = disclosure LGPD. Enviar → bolha "Atendente IA" outbound; **delivery falhou** "Invalid OAuth access token" (esperado com cred falsa). |
| **C.5** Descartar (E2E002) + Editar (E2E003) | ✅ | 2º draft (sem disclosure, correto) → Descartar (toast "Sugestão descartada"). 3º draft → Editar textarea → "Enviar editado" → "Sugestão da IA enviada (editada)". |
| **C.6** Assumir conversa → IA pausada → sem fila; Reativar | ✅ | Header vira "IA pausada"; E2E004 injetado **não** criou item de fila nem run (queue ficou em 3, runs em 4); "Reativar IA" volta p/ "IA ativa". |
| **C.7** Keyword "humano" → handoff + pausa, sem inferência | ✅ | E2E005 → handoffs 31→32, fila/runs inalterados; Repasses mostra card "Cliente E2E · Pendente · De Atendente IA · Palavra-chave de repasse detectada". |
| **C.8** Métricas: 3 revisadas + ~67% aceitação | ✅ | Card mostra "Sugestões revisadas: 3 · Taxa de aceitação: 67%" (2 enviadas de 3). Autopilot travado (<10 revisadas). |
| **D** Gate do bridge (negativo) | ✅ | Todos os 3 itens de fila e 4 runs referenciam só a conversa Meta E2E (`kd75pkwt…`). Conversas bridge (`kd73vbkk…`, `kd78d0e3…`) sem fila/run. Conversa "Eric Milfont" aberta: só mensagens humanas, **nenhum AiDraftCard**. |
| **E** Medidor e custo | ⚠️ | "1 conversas atendidas pela IA · 10 execuções". Custo real dos runs = **US$ 0.000685 (>0)**, mas o medidor exibe **"US$ 0.00"** (arredonda a 2 casas); runs do copiloto não registram `costUsdEstimate` (ver Achado 4). |

## Achados / bugs

### Achado 1 — [GRANDE · reportar] OpenCode Go retorna HTTP 400 "Upstream request failed" em tool-continuation
Reproduzido direto contra o provider (`POST https://opencode.ai/zen/go/v1/chat/completions`, mesma estrutura de mensagens que o runtime: system + user + assistant(tool_calls) + tool result):

- **deepseek-v4-flash** (atendente): **400 determinístico** (4/4) na 2ª chamada.
- **kimi-k2.7-code** (copiloto): **400 intermitente** (~50% — sequência observada 400/200/400) com **bytes idênticos** → a request está bem-formada; é instabilidade/flakiness do upstream "Console Go".
- Chamadas simples e a 1ª rodada (que emite `tool_calls`) funcionam nos dois modelos.

**Por que não é bug de código:** a mesma request retorna 200 no retry (kimi) — não é formatação. É (a) instabilidade do provider (400 mal-rotulado; deveria ser 5xx), somada a (b) **fallback OpenRouter inativo** (`OPENROUTER_API_KEY` ausente) e (c) o **copiloto usa `streamChat` sem retry** (`convex/copilotHttp.ts:301-336` — uma falha mata o turno), enquanto o atendente usa `chatWithFallback→chatWithRetry` mas 400 não é retriable (`convex/lib/llm/openaiCompatible.ts:343-346`, correto para 400 genuíno) e não há 2ª rota.

**Impacto real:**
- Copiloto: falha em ~2/3 das perguntas que usam ferramenta (a maioria). Só recupera com o usuário reenviando.
- Atendente: na maioria dos casos o modelo chama `replyToCustomer` na 1ª rodada (sem 2ª chamada) → funciona (validado em C.3/C.4/C.5). MAS se chamar uma tool não-reply antes, a 2ª chamada 400a determinístico → backoff → no teto vira handoff.

**Recomendação (decisão do Eric):** setar `OPENROUTER_API_KEY` (fallback já implementado, cobriria exatamente isto) e/ou reclassificar 400 "Upstream request failed" como fallover/retriable e/ou adicionar retry no streaming do copiloto. **Não apliquei** — causa externa + decisão de design (as instruções pedem só reportar).

### Achado 2 — [MÉDIO · reportar] Atendente às vezes "Modelo não produziu resposta ao cliente"
Observado 1x no inbound E2E003 (recuperou no retry por backoff). deepseek-v4-flash é modelo de *reasoning*; com `maxTokens: 700` (`convex/attendant.ts:1177`) o `reasoning_content` pode consumir o budget e devolver `content` vazio sem tool call → o loop cai em `throw new Error("Modelo não produziu resposta ao cliente")` (`convex/attendant.ts:1269-1271`). **Tuning:** aumentar `maxTokens` do atendente ou desabilitar reasoning para esse modelo.

### Achado 3 — [MENOR · UX] Falha do copiloto some da tela
Quando o LLM 400a, o erro aparece como toast fugaz e some, deixando só o chip de tool e nenhuma mensagem no thread — usuário fica sem feedback do que houve. Sugestão: persistir a mensagem de erro no thread do copiloto (hoje o evento `{type:"error"}` do SSE não vira mensagem durável).

### Achado 4 — [MENOR] Medidor de custo exibe US$ 0.00 para uso sub-cent
Custo real somado dos runs = US$ 0.000685, mas "Uso do mês" mostra "US$ 0.00" (formatação a 2 casas). Além disso, **runs do copiloto não gravam `costUsdEstimate`** (só o atendente calcula — `convex/copilotHttp.ts:446-455` não passa custo). Uso pesado do copiloto apareceria com custo $0.

### Achado 5 — [MENOR · UX] Pill "IA ativa" + "Assumir conversa" no header de conversas bridge
O atendente é gated server-side (Meta-only, `convex/attendant.ts:208`) e nunca gera draft para bridge — confirmado no teste D. Mas o header do inbox ainda exibe os controles "IA ativa"/"Assumir conversa" em conversas bridge, o que pode confundir (sugere que a IA está atuando ali). **Não é falha de segurança** — só cosmético.

## Pendências para o Eric

1. **`OPENROUTER_API_KEY`** ausente → sem fallback quando o OpenCode Go instabiliza. Já era pendência conhecida; a instabilidade observada hoje (Achado 1) reforça a urgência.
2. Decisão de design sobre retry/fallover para 400 "Upstream request failed" + retry no streaming do copiloto (Achado 1).
3. Tuning de `maxTokens`/reasoning do atendente (Achado 2).
4. **Artefatos deixados no deployment de teste** (opção "deixar" da limpeza): lead **"Cliente E2E"** (`kx73pgh6s54rtsadcwpc0bscyx8b520k`) + conversa (`kd75pkwt8jv29dstkea80cm0518b5hsh`, com `channelConfigId` órfão após deletar o Meta E2E) + **1 handoff pendente** em Repasses. Deixados como evidência; podem ser arquivados/removidos quando quiser.

## Limpeza realizada

- ✅ Horário do atendente restaurado (Início 9, Fim 18) — verificado no DB.
- ✅ Canal **Meta E2E deletado** (toast "Número desconectado"); **GuardTeste2 (bridge) intacto e não tocado**.
- ✅ Inbox continua carregando após a deleção (conversa com `channelConfigId` órfão não quebra a UI).
- ✅ Nenhum código alterado → `tsc`/testes não afetados.
- ℹ️ Canal bridge "GuardTeste2" e suas conversas reais nunca foram tocados (sem envio outbound, sem edição/QR/deleção).
