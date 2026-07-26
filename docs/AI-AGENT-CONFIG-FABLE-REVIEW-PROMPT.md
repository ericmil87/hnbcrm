# Prompt de revisão — Fable + subagentes Opus (revisar e melhorar o plano de AI Agent Config)

> Cole o texto abaixo numa sessão do Claude Code rodando **`claude-fable-5`** (`/model claude-fable-5`), com **effort `xhigh`**, na raiz do repo `clawcrm-repo/jiaolong`. Se tiver ultracode/workflows habilitados, melhor ainda — o prompt pede fan-out com subagentes Opus.

---

Você é um arquiteto de software sênior e revisor adversarial. Sua tarefa é **verificar, pressionar e melhorar** um plano de implementação de features de IA para um CRM Convex + React multi-tenant. O plano foi escrito por um modelo menos capaz (Opus 4.8) e **precisa ser endurecido**, não elogiado. Seu viés deve ser cético: procure o que está errado, faltando, inseguro, caro demais, ou ingênuo.

## Contexto

- **Repo:** `/home/eric/orca/workspaces/clawcrm-repo/jiaolong` — CRM "HNBCRM/ClawCRM", backend **Convex**, frontend **React+Vite**, PT-BR, multi-tenant (`organizationId` em tudo). Leia `CLAUDE.md`, `convex/CLAUDE.md` e `src/CLAUDE.md` para as regras obrigatórias (Convex function syntax, `requireAuth`/`requirePermission`, side-effects checklist, `"skip"` pattern, índices `by_<field>`, nada de `.filter()` em queries, nada de `Date.now()` em queries, só agendar `internal.*`).
- **Plano a revisar:** `docs/AI-AGENT-CONFIG-PLAN.md`. Leia-o inteiro primeiro.
- **Dois produtos de IA** que compartilham runtime: (1) **Copiloto** in-app que opera o CRM respeitando RBAC; (2) **Atendente Virtual** conectado a WhatsApp (Meta Cloud API + bridge wuzapi) que atende clientes com handoff pra humano.
- **Inferência é greenfield** — não há código LLM hoje. A superfície de "tools" são as funções `internal.*` do Convex já usadas pelo REST/MCP.
- **Provider = Anthropic/Claude.** Use a skill `claude-api` (ou `/claude-api`) para QUALQUER detalhe de modelo/tool-use/caching/rate-limit/streaming — não confie na memória; a API mudou muito em 2025-2026 (thinking adaptativo, `budget_tokens` removido, sampling params removidos no Opus 4.8, `output_config.effort`, task budgets, structured outputs, prompt caching por prefixo).

## Como trabalhar (obrigatório)

1. **Leia o plano e o código real** antes de opinar. Verifique cada afirmação técnica do plano contra o código:
   - O hook de inbound existe mesmo em `convex/conversations.ts` `internalReceiveMessage` onde o plano diz? (o plano cita ~linha 1354, ao lado do `autoTranscribe`).
   - `internalSendMessage`, `internalSendTemplate`, `internalGetMessages`, `internalRequestHandoff` têm as assinaturas que o plano assume?
   - O padrão de cripto `convex/lib/secretCrypto.ts` (`encryptSecret`/`decryptSecret`/`maskConfig`) é reusável para a BYO key como descrito?
   - A janela de 24h da Meta e o `serviceWindowApplies` funcionam como o plano descreve (`convex/whatsapp.ts`, `convex/conversations.ts`)?
   - O gap de RBAC ("scoping por API key resolvido mas nunca aplicado no `router.ts`") é real? Confirme.
2. **Use subagentes Opus em paralelo** (via workflow/Agent, effort `high`) para investigar em profundidade, cada um numa dimensão — não faça tudo sequencial. Sugestão de fan-out (adapte):
   - **Subagente A — Segurança:** prompt-injection no atendente (cliente = fonte não-confiável), exfiltração de segredos, RBAC/least-privilege, confirmação de ações destrutivas, tool poisoning via dados do CRM, multi-tenancy leakage (algum caminho onde a IA de uma org vê dados de outra?).
   - **Subagente B — Rate limits & custo & confiabilidade:** limites reais da Anthropic por tier (RPM/TPM/TPD) e como a fila do Convex (`ctx.scheduler`) se comporta em pico de inbound; backoff/retry/idempotência; comportamento sob 429/529/timeout do provider; projeção de custo por volume de conversa; adequação de task budgets e tiering de modelo; interação com o pacing de 1msg/6s da Meta.
   - **Subagente C — Corretude Convex & concorrência:** race conditions de elegibilidade (humano assume enquanto a IA gera), dois inbounds quase simultâneos na mesma conversa (idempotência/dedupe por `externalId`), loops IA↔IA, o loop de tool-use rodando dentro de uma `internalAction` (limites de tempo/tamanho de action do Convex), streaming do copiloto (httpAction SSE vs `@convex-dev/agent` vs persistent-text-streaming — qual realmente funciona no Convex e quais os tradeoffs).
   - **Subagente D — Produto & UX & compliance:** modelo de "copiloto age como o usuário" vs teamMember IA dedicado; alcance da confirmação humana; avaliação de qualidade/evals do atendente; LGPD (dados indo pra Anthropic, consentimento, retenção, opt-out por contato); i18n; grupos de WhatsApp; o componente `@convex-dev/agent` vale a pena?
3. **Verifique adversarialmente** cada achado dos subagentes antes de aceitá-lo (um segundo subagente cético, ou você mesmo) — descarte falso-positivo, confirme com file:line.

## O que entregar

Produza um **`docs/AI-AGENT-CONFIG-PLAN-v2.md`** (não edite o v1 — crie o v2) contendo:

1. **Veredito executivo** — o plano é sólido? Quais as 3-5 falhas mais graves?
2. **Correções factuais** — toda afirmação do v1 que está errada sobre o código, com file:line e a correção.
3. **Lacunas críticas preenchidas** — especialmente: segurança (prompt-injection concreto, não hand-wave), rate limits reais + estratégia de fila/backoff, concorrência/idempotência, failure modes do provider, custo projetado, LGPD/retenção/opt-out, evals/qualidade.
4. **Decisões recomendadas** para cada item da §12 "Decisões em aberto" do v1 — com recomendação firme + justificativa, não só opções.
5. **Arquitetura revisada** — se você discorda da divisão (runtime compartilhado, loop manual vs SDK, copiloto como usuário, etc.), proponha melhor e justifique.
6. **Plano de fases revisado** — com critérios de "pronto para produção" e gates de segurança por fase (especialmente antes de soltar o atendente com clientes reais).
7. **Riscos residuais** — o que ainda fica em aberto após o v2, e o que precisa de validação empírica (spike/POC) antes de comprometer.

Regras: cite file:line para toda afirmação sobre o código. Não invente APIs da Anthropic — verifique via skill `claude-api`. Seja específico e acionável; um plano que diz "considere segurança" é inútil — diga *o quê*, *onde*, *como*. Escreva em **português (BR)**. Priorize correção e completude sobre brevidade — custo de tokens não é restrição aqui; use effort alto e quantos subagentes forem necessários.
