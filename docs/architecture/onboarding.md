# Onboarding conversacional v2 — custo, limites e modelos (P2.4)

O Rascunho de Operação e a aplicação (P2.1) estão em [`leads-pipeline.md`](leads-pipeline.md). Aqui ficam o orçamento de custo de IA do onboarding, os limites de uso, os modelos por env e a mudança do simulador do atendente.

## Estado atual

Todo o LLM do onboarding roda com a chave da plataforma, então cada chamada passa por dois pontos em `convex/onboardingBudget.ts` (regra pura em `convex/lib/onboardingBudget.ts`):

1. `internalReserveOnboardingSpend({organizationId, sessionId, userId?, ipKey?, estimateUsdMicros?})` ANTES da chamada. Devolve `{ok, code, message, retryAfterMs}`; `ok:false` = não chamar o modelo, mostrar `message` (PT-BR).
2. `internalRecordOnboardingSpend({..., costUsdEstimate, estimateUsdMicros?, requestId?})` DEPOIS (também em erro parcial). Grava o custo real em `onboardingSessions.spentUsdMicros`, numa run `agentRuns` `kind:"onboarding"` e em `aiUsageMonthly` pela mesma porta das demais runs (`recordRunUsage`), e soma ao corte global do dia (`onboardingSpendDaily`).

Ordem das recusas: modo leitura do plano → `spendCap` da org (`org_spend_cap`) → corte global (`global_daily_cap`) → orçamento da sessão (`session_budget`) → orçamento da org (`org_budget`) → rate limit (`rate_limited`, por último para só gastar cota de quem seria atendido). O onboarding não exige `orgAiActive` na reserva (a entrevista acontece antes do aceite de IA); quem exige IA ativa é o simulador.

## Orçamento

Tudo em micro-US$ (unidade de `aiUsageMonthly.costUsdMicros`). Env vazia, não inteira, <= 0 ou acima de US$ 1.000 cai no padrão.

| Env | Padrão | O que limita |
|---|---|---|
| `ONBOARDING_SESSION_BUDGET_USD_MICROS` | 500000 (US$ 0,50) | gasto de uma sessão |
| `ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS` | 2000000 (US$ 2,00) | gasto de onboarding da org no mês (`aiUsageMonthly.byKind.onboarding`) |
| `ONBOARDING_GLOBAL_DAILY_USD_MICROS` | 20000000 (US$ 20,00) | soma de todas as orgs no dia UTC |
| `HNBCRM_INTERNAL_ORG_ID` | ausente | org interna que recebe o audit do alerta global (opcional) |

**Reserva que segura saldo.** A reserva soma `gasto + reservado + estimativa` e, se passa, segura a estimativa em `onboardingSessions.reservedUsdMicros` (`reservedAt`). O registro solta a estimativa (mesmo `estimateUsdMicros` da reserva; padrão US$ 0,02, máximo US$ 0,50) e soma o custo real. Reserva sem registro há mais de 10 min é órfã e deixa de contar (`RESERVATION_TTL_MS`). O orçamento da org soma as reservas das sessões dela (até 20 mais recentes) sem tocar em documento global. **O corte global não retém saldo**: aceita-se folga de chamadas em voo (limitada pelo rate limit) para não criar um documento quente disputado por todas as orgs.

**Quem tem o orçamento de org** (`onboardingOrgBudgetApplies`): `trial`, org sem `billing`, e `legacy` criada em/depois de `ONBOARDING_V2_LAUNCH_MS` (11/11/2026 00:00 UTC; cadastro novo sem teste ligado). NÃO tem: `legacy` anterior a essa data (cliente que já existia) e org paga `active`/`past_due`. Essas continuam sujeitas ao `spendCap` da org e ao modo leitura. Ver também `billing.md`.

**Corte global e alerta.** Estourou o teto do dia: o onboarding de IA para para todas as orgs com a mensagem amigável (`global_daily_cap`) e volta no dia UTC seguinte. O alerta é 1×/dia: `onboardingSpendDaily.alertedAt` + `alertedByOrgId` (único registro em org cliente: nenhuma linha vai para o `auditLogs` de cliente). Se `HNBCRM_INTERNAL_ORG_ID` apontar para uma org válida, grava também um audit `critical` (`metadata.action:"onboarding_global_daily_cap_reached"`) nela. Nenhum e-mail nem mensagem externa; o ponto para ligar um aviso de ops é `raiseGlobalCapAlert`.

## Rate limit

Janela fixa em `onboardingRateLimits` (chave `user|org|ip:<id>:<10m|1d>`). O projeto não usa `@convex-dev/rate-limiter` (os limites existentes são contadores próprios: `authEmailThrottle`, `apiKeys.updateLastUsed`); manteve-se o padrão. Limites por 10 min / dia: usuário 20 / 120, org 40 / 300, IP 30 / 200. Duas fases: avalia todas as janelas e só grava se todas permitirem (recusa não consome cota dos outros escopos). `internalCheckOnboardingRateLimit` faz só o rate limit, para uma rota HTTP barrar por IP antes de existir sessão. Cron diário (`crons.ts`, 08:00 UTC) chama `internalPruneOnboardingRateLimits({dryRun:false})`: apaga janelas com mais de 2 dias em lotes de 200 e se reagenda (`runAfter(0)`) enquanto houver mais.

**IP.** `normalizeIpKey` usa a entrada MAIS À DIREITA de `x-forwarded-for` (a que a borda acrescenta; as da esquerda o cliente forja) e agrupa IPv6 por /64. Não encontramos no repositório um cabeçalho de IP mais confiável (o `router.ts` só lê `x-forwarded-for`/`cf-connecting-ip`); se a plataforma expuser um, troque em um ponto só (a futura `httpAction`) e mantenha a normalização.

## Modelos por env (`lib/onboardingModels.ts`)

`getOnboardingModel("interviewer"|"reader"|"vision")` lê `ONBOARDING_MODEL_INTERVIEWER` / `_READER` / `_VISION`. Padrões = `DEFAULT_MODELS.copilot` / `.attendant` / `.vision` do `registry.ts` (sem strings duplicadas). Env vazia, com formato inválido ou fora do registry cai no padrão (`resolveOnboardingModel` informa `rejected`); para visão vale só a cadeia `VISION_MODELS_BY_PROVIDER` (fail-closed). `getOnboardingTts()` lê `ONBOARDING_TTS_MODEL`/`ONBOARDING_TTS_VOICE` (`undefined` por padrão). Trocar o modelo não muda o roteamento: retenção zero (ZDR) e a ordem de provedores continuam as de `agentRoutes`/`registry`.

## Simulador do atendente (mudança de comportamento)

`attendant.simulateAttendant` agora (a) exige `orgAiActive` (IA ligada + aceite LGPD) e recusa com "Ative a IA da organização…", sem chamar o modelo; (b) respeita modo leitura e `spendCap` (mesmas mensagens do restante); (c) é medido: run `kind:"simulator"` + `aiUsageMonthly`, marcada `error` quando não houve resposta utilizável. Orgs com IA ligada continuam simulando como antes. O simulador nunca roda antes do aceite de IA. No front, `StepTest` e `AttendantCard` mostram o estado "Ative a IA para testar o atendente" com a ação que já existe para ativar (nunca ativam sozinhos); `UsagePanel` rotula `onboarding` como "Configuração por conversa".
