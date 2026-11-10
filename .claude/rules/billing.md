---
paths:
  - "convex/**"
  - "src/**"
---

# Planos, entitlements e medição

Contexto e histórico: `docs/architecture/billing.md`. Números: `convex/lib/plans.ts` (fonte única; o front importa, nunca copia).

- Ler o plano só por `resolveEntitlements`/`loadEntitlements` (`convex/lib/entitlements.ts`). Org sem `billing`, `legacy` ou sem plano = `gated:false`: todo gate novo precisa passar nesse caso sem mudar nada.
- Escrever `organizations.billing` ou `orgSubscriptions` só por `applySubscriptionChange`/`setBillingStatus` (`convex/lib/entitlementsOps.ts`); o cadastro usa `initialOrgBilling`. `source:"customer"` só mexe em `overage`. Guard: `convex/entitlementsPort.test.ts`.
- "Avisar, não travar": gate de plano recusa só ação **nova** (ligar módulo, criar canal, criar API key); nunca desliga o que já está ligado numa org pagante. `past_due` funciona como `active`. Convites (usuários ilimitados) e exportação nunca têm gate.
- Atendimento IA = contato distinto no mês, gravado por `recordAttendance` nos dois commits do atendente; nunca incrementar contador no claim. A classe (`agentRuns.billingClass`) é decidida no claim e o commit não reclassifica. Turno com `forceSuggest` nunca é `overage`/`credit`.
- Contadores de uso moram em `orgUsageMonthly` (não em `aiUsageMonthly`, que é patchado a cada run e daria OCC no commit). `aiUsageMonthly.conversations` está congelado: o teto do cliente soma os dois.
- Envio de campanha conta só por `bumpCampaignSends` (idempotente por destinatário via `meteredMonth`).
- `getMyEntitlements` é assinada em várias telas: lê só o doc da org e devolve `null` para não-membro. Contagens (canais, grupos) e uso detalhado ficam em queries que só o painel "Uso e fatura" assina.
- Nunca expor `billing` em queries que devolvem o doc da org (`getUserOrganizations` o omite). Preço/teto só para `settings:view`; nome de contato no extrato só com `contacts:view` e sem telefone/e-mail.
- Modo leitura (`read_only`/`canceled`/teste vencido): IA e envio param, inbound e exportação nunca. Gate novo de envio/IA reusa `lib/readOnly.ts` (`assertOutboundAllowed`, `assertPlanWritable`) e `internalSpendGate`; mensagem agendada fica `pending` (nunca `failed`) e campanha pausa com `pauseCode:"plan_read_only"`. O cron `internalBillingTick` só age em `trial`, mais o ciclo de vida self-service (`cancelAt` e `scheduledChange` vencidos de org `active`/`past_due`).
- Termos: `termsAcceptances` é append-only e `TERMS_VERSION` muda quando preço/franquia/licença/reembolso mudam. Cadastro em teste só com env `BILLING_TRIAL_ON_SIGNUP="true"`; 1 teste por usuário (`trialGrants`).
- Asaas: só `convex/lib/asaasApi.ts` fala com a API e lê `ASAAS_API_KEY`/`ASAAS_ENV` (guard `asaasApiPort.test.ts`, padrão `$aact_` no `secretScan`); nunca logar chave, CPF/CNPJ, e-mail nem corpo de resposta. Sem a chave a integração está desligada (manual).
- Checkout: preço sempre calculado no servidor (`checkoutPricing`); o cliente não manda valor. `source:"checkout"` da porta só escreve campos de cobrança (nunca status/plano). Quem libera o plano é o pagamento CONFIRMADO relido na API (webhook), nunca o retorno do checkout.
- Webhook do Asaas: token em tempo constante, dedupe por `eventId`, releitura na API antes de mudar estado, org resolvida pela assinatura gravada (nunca pelo corpo). Nenhum evento coloca a org em `read_only`; legacy sem assinatura nunca é tocada.
- Ciclo de vida (`docs/architecture/billing.md`): sem pró-rata. Upgrade = assinatura NOVA e o plano só troca quando o pagamento dela confirma (webhook, `pendingUpgrade`); downgrade = `scheduledChange` aplicado pelo cron em `effectiveAt`; cancelamento = DELETE no Asaas + `cancelAt` (status `active` até lá). `classifyPlanChange`/`evaluatePlanChange` (`lib/planChange.ts`) decidem para a ação e para `previewCheckout({mode:"change"})`; `checkRefund` (`lib/refund.ts`) para o reembolso (1ª fatura paga, ≤ 168 h, uma vez por org). Avisos só a admins e respeitando `billing.quiet`. A única mudança de `billing` que `source:"checkout"` faz é `active/past_due -> canceled` do reembolso (`isRefundCancel`).
