# Planos, entitlements e medição (precificação por uso)

## Estado atual

Modelo comercial: **"Traga a equipe inteira. Pague só pelo que a IA atende."** Quatro planos (Essencial, Profissional, Escala, Empresa), usuários ilimitados em todos, preço definido por **canais** e **atendimentos IA/mês** (contato distinto que a IA respondeu ou rascunhou no mês; grupos, campanhas e Copiloto não contam). Excedente opt-in com teto em R$, desligado por padrão. O catálogo com os números vive em `convex/lib/plans.ts` (o front importa o mesmo arquivo) e os cálculos em `convex/lib/billingMath.ts`.

Implementado (nov/2026): plano gravado na org, porta de entitlements e ops (B1, #85); calculadora e projeção no front, lógica pura (F1, #86); medidor por contato e de envios de campanha (B2); queries da tela "Uso e fatura" (B3). **Ainda sem gate ligado em nenhum recurso**: org sem plano ou `legacy` funciona exatamente como antes. Gates, limite/excedente, teste de 30 dias e "só leitura" (B5–B7), cobrança pelo Asaas (F3) e parceiros (F4) vêm depois.

## Modelo de dados

- `organizations.billing` (opcional, **fora de `settings`** para que `updateOrganization`/`completeWizard`, que fazem merge de `settings`, nunca o sobrescrevam): `plan?` (ausente em `legacy`), `status` (`trial · active · past_due · read_only · canceled · legacy`), `trialEndsAt`, `periodStart`, `units`, `extraChannels` (teto liberado, não cobrança), `addons.groups`, `overage {enabled, capBrl}`, `overrides`, `priceLock {kind founder|frozen, monthlyBrl, discountPct, until}`, `legacyNoticeAt`/`legacyUntil`. O cadastro grava `{status:"legacy"}` (`initialOrgBilling`). `getUserOrganizations` **não** devolve `billing`; o plano chega ao front só por `billing.getMyEntitlements`, com preço e teto apenas para quem tem `settings:view`.
- `orgSubscriptions` (1 por org, só servidor, centavos inteiros): ciclo, preço base, desconto, status de pagamento, carência, provedor e ids, e-mail e documento de cobrança (PII). Fora do backup, dentro do purge de org.
- `usageCredits`: **única** tabela de pacotes pré-pagos (1.000 atendimentos, R$ 390, 12 meses), consumidos FIFO por `expiresAt` só no commit do atendente (B6). O fechamento só lê.
- `aiAttendances`: livro de atendimentos, 1 linha por (org, mês UTC, contato), `billing` = `included|credit|overage|suggest_only|legacy`, `origin` = `ai|human_request`. É a dedupe exata de "contato distinto" e o extrato auditável da fatura.
- `orgUsageMonthly`: contadores mensais que não são custo de IA (atendimentos e buckets, `overageBrlCents`, envios de campanha, carimbos de aviso). Separado de `aiUsageMonthly` de propósito: aquele doc é patchado a cada `finishRun`, e somar o atendimento nele dentro do commit do atendente gerava conflito de OCC na maior transação do pipeline.

## Portas (únicas)

- **Leitura:** `resolveEntitlements(org, now)` (pura) e `loadEntitlements` em `convex/lib/entitlements.ts`. Sem `billing`, `legacy` ou sem plano → `gated:false`, limites infinitos. `past_due` = `active`. Checks puros nunca lançam (`checkModule`, `checkChannelSlot`, `usageCrossings`); quem decide avisar ou recusar é o chamador.
- **Escrita do plano:** `applySubscriptionChange` / `setBillingStatus` / `initialOrgBilling` em `convex/lib/entitlementsOps.ts`. Transição inválida lança `ConvexError {code:"invalid_transition"}` sem gravar. Regras: `past_due` nunca vira `read_only` sozinho (só ops); `read_only` automático só a partir de `trial`; só ops tira uma org de `legacy`; `source:"customer"` só altera `overage` (`customer_forbidden`). O backfill legacy usa `audit:"none"` para não escrever no Histórico de todas as orgs antes do aviso.
- **Medição:** `recordAttendance` (`convex/lib/attendanceLedger.ts`, modos `live|backfill`), chamado pelos dois commits do atendente (`internalCommitAiReply`, `internalCommitAiSuggestion`) via `recordCommittedAttendance`; `bumpCampaignSends` (`convex/lib/usageMeter.ts`), idempotente por destinatário (`campaignRecipients.meteredMonth`). Build guard: `convex/entitlementsPort.test.ts`.

## Decisões, pegadinhas medidas e histórico

**Contagem por contato no commit (B2).** O contador antigo (`aiUsageMonthly.conversations`) era incrementado no **claim**, por **conversa**: um contato com WhatsApp e Instagram contava 2× e uma run que falhava contava. Agora conta no commit, por `contactKey = lead.contactId ?? lead._id`, só quando a resposta ou o rascunho foi gravado. O campo antigo fica **congelado** com o que já tinha sido contado, e o teto `monthlyConversationBudget` lê `conversations + orgUsageMonthly.aiAttendances`. Mês da virada: contato sem linha cuja conversa teve run **pré-B2** (`agentRuns.billingClass === undefined`, de qualquer status, porque o claim antigo contou todas) ganha a linha em modo `backfill` sem incremento; run reivindicada pelo código antigo e commitada pelo novo também vira `backfill`. Promessa testada: para org sem plano, o `budget_mensal` só pode disparar **mais tarde, nunca mais cedo**. Efeito colateral aceito: contato cuja run nova não gerou commit (bot, silêncio, recusa, erro) não é "atendido" para o teto.

**A classe do atendimento é decidida no claim e gravada em `agentRuns.billingClass`.** O commit usa essa classe e nunca reclassifica (senão um rascunho forçado pela franquia viraria excedente se o admin ligasse o excedente enquanto o LLM roda). Turno com `forceSuggest` (franquia ou `spendCap`) nunca será `overage`/`credit` (regra do B6).

**Custo estimado quando o provedor não manda `usage`.** Antes o custo virava US$ 0 (`estimateRunCost` sem `usage`). Agora soma estimativa conservadora por caracteres (~3,5 chars/token) com a flag de estimado, em todos os produtos. Afeta o `spendCap` dessas orgs; o commit é separado para rollback e a op `opsBilling:internalCostAudit` lista quem é afetado.

**Envio de campanha = tentativa registrada.** Conta no insert da mensagem do worker; falha definitiva conta como envio.

**Mês em UTC.** Mesma régua de `aiUsageMonthly`/`spendCap`; em Brasília o ciclo vira às 21h do último dia (a tela avisa).

**Ops** (`convex/opsBilling.ts`, `dryRun` default true, cursor): `internalSetOrgPlan`, `internalGrantCredits`, `internalBackfillLegacy` (sem `noticeAt` grava só o status), `internalBillingReport`, `internalBackfillAttendances`, `internalCostAudit`. Ordem em PROD: deploy → `internalCostAudit` → `internalBackfillLegacy` (dry → real) → `internalBackfillAttendances` do mês → `internalSetOrgPlan` por cliente, um a um, depois do dry run.
