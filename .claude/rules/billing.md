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
