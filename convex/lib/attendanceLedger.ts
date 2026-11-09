/**
 * Livro de atendimentos IA (billing B2). Atendimento = CONTATO distinto no mês,
 * gravado no COMMIT da resposta ou do rascunho (nunca no claim): run com erro e
 * follow-up "nada a enviar" não contam.
 *
 * `recordAttendance` é a ÚNICA porta que insere em `aiAttendances`
 * (`entitlementsPort.test.ts`). Idempotente por (org, mês, contato).
 *  - `live`: insere a linha E incrementa `orgUsageMonthly.aiAttendances` + o bucket da
 *    classe, na mesma transação. NÃO toca `aiUsageMonthly`: `recordRunUsage` patcha esse
 *    doc a cada `finishRun`, e os commits do atendente (grandes) o disputariam no OCC.
 *  - `backfill`: só insere a linha (A1). O contador do mês já foi alimentado por outro
 *    caminho (contador antigo do claim, `aiUsageMonthly.conversations`); incrementar de
 *    novo dobraria o número e dispararia `budget_mensal` mais cedo.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { monthKeyUtc } from "./aiSpend";

export type AttendanceClass = Doc<"aiAttendances">["billing"];
export type AttendanceOrigin = NonNullable<Doc<"aiAttendances">["origin"]>;

/**
 * Mês a partir do qual `internalBackfillMonthlyUsage` não mexe mais em `conversations`
 * ("AAAA-MM", UTC). É só um teto: a regra real não depende da data do deploy (o backfill
 * também para em qualquer mês que já tenha linha no livro, e o claim sempre consulta a
 * salvaguarda `conversationServedThisMonth` para contato sem linha). Testes injetam outro
 * valor pelo parâmetro `ledgerStartMonth` do backfill.
 */
export const BILLING_LEDGER_START_MONTH = "2026-11";

/** Chave do contato: `lead.contactId ?? lead._id` (o mesmo contato em 2 canais conta 1). */
export function contactKeyOf(lead: Pick<Doc<"leads">, "_id" | "contactId">): string {
  return String(lead.contactId ?? lead._id);
}

export async function findAttendance(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  month: string,
  contactKey: string
): Promise<Doc<"aiAttendances"> | null> {
  return await ctx.db
    .query("aiAttendances")
    .withIndex("by_organization_and_month_and_contact", (q) =>
      q.eq("organizationId", organizationId).eq("month", month).eq("contactKey", contactKey)
    )
    .first();
}

/** Documento do medidor mensal da org (`orgUsageMonthly`), se já existe. */
export async function getOrgUsageMonthly(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  month: string
): Promise<Doc<"orgUsageMonthly"> | null> {
  return await ctx.db
    .query("orgUsageMonthly")
    .withIndex("by_organization_and_month", (q) => q.eq("organizationId", organizationId).eq("month", month))
    .unique();
}

/**
 * Atendimentos do mês para o teto `monthlyConversationBudget` e para o painel:
 * `aiUsageMonthly.conversations` (congelado, do código antigo) + `orgUsageMonthly.aiAttendances`.
 */
export function totalAttendances(
  usage: Pick<Doc<"aiUsageMonthly">, "conversations"> | null | undefined,
  meter: Pick<Doc<"orgUsageMonthly">, "aiAttendances"> | null | undefined
): number {
  return (usage?.conversations ?? 0) + (meter?.aiAttendances ?? 0);
}

const BUCKET: Record<
  Exclude<AttendanceClass, "legacy">,
  "attendancesIncluded" | "attendancesCredit" | "attendancesOverage" | "attendancesSuggestOnly"
> = {
  included: "attendancesIncluded",
  credit: "attendancesCredit",
  overage: "attendancesOverage",
  suggest_only: "attendancesSuggestOnly",
};

export async function recordAttendance(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    month: string;
    contactKey: string;
    conversationId: Id<"conversations">;
    firstAt: number;
    billing: AttendanceClass;
    mode: "live" | "backfill";
    origin?: AttendanceOrigin;
    creditId?: Id<"usageCredits">;
    unitPriceBrlCents?: number;
  }
): Promise<{ inserted: boolean }> {
  const existing = await findAttendance(ctx, args.organizationId, args.month, args.contactKey);
  if (existing) return { inserted: false };

  await ctx.db.insert("aiAttendances", {
    organizationId: args.organizationId,
    month: args.month,
    contactKey: args.contactKey,
    conversationId: args.conversationId,
    firstAt: args.firstAt,
    billing: args.billing,
    ...(args.origin ? { origin: args.origin } : {}),
    ...(args.creditId ? { creditId: args.creditId } : {}),
    ...(args.unitPriceBrlCents !== undefined ? { unitPriceBrlCents: args.unitPriceBrlCents } : {}),
  });
  if (args.mode === "backfill") return { inserted: true };

  const meter = await getOrgUsageMonthly(ctx, args.organizationId, args.month);
  const bucket = args.billing === "legacy" ? null : BUCKET[args.billing];
  const overageCents = args.billing === "overage" ? (args.unitPriceBrlCents ?? 0) : 0;
  if (meter) {
    await ctx.db.patch(meter._id, {
      aiAttendances: (meter.aiAttendances ?? 0) + 1,
      ...(bucket ? { [bucket]: (meter[bucket] ?? 0) + 1 } : {}),
      ...(overageCents > 0 ? { overageBrlCents: (meter.overageBrlCents ?? 0) + overageCents } : {}),
      updatedAt: args.firstAt,
    });
  } else {
    await ctx.db.insert("orgUsageMonthly", {
      organizationId: args.organizationId,
      month: args.month,
      campaignSends: 0,
      aiAttendances: 1,
      ...(bucket ? { [bucket]: 1 } : {}),
      ...(overageCents > 0 ? { overageBrlCents: overageCents } : {}),
      updatedAt: args.firstAt,
    });
  }
  return { inserted: true };
}

/**
 * Chamado pelos DOIS commits do atendente (`internalCommitAiReply` e
 * `internalCommitAiSuggestion`), só depois que algo foi persistido (mensagem ou
 * rascunho). A classe é a que o claim gravou na run (`agentRuns.billingClass`):
 * o commit não reclassifica. Conversa sem lead (grupo) nunca conta.
 * `origin` sai do item da fila: coach, devolver à IA e pedidos do Telegram são
 * `human_request`; resposta ao cliente e follow-up são `ai`.
 */
export async function recordCommittedAttendance(
  ctx: MutationCtx,
  args: {
    conversation: Pick<Doc<"conversations">, "_id" | "organizationId">;
    lead: Pick<Doc<"leads">, "_id" | "contactId"> | null;
    agentRunId: Id<"agentRuns">;
    queueItemId?: Id<"aiReplyQueue">;
    now: number;
  }
): Promise<void> {
  if (!args.lead) return;
  const run = await ctx.db.get(args.agentRunId);
  const item = args.queueItemId ? await ctx.db.get(args.queueItemId) : null;
  const humanRequest =
    item !== null && (item.origin === "coach" || item.origin === "return_to_ai" || item.requestedVia !== undefined);
  await recordAttendance(ctx, {
    organizationId: args.conversation.organizationId,
    month: monthKeyUtc(args.now),
    contactKey: contactKeyOf(args.lead),
    conversationId: args.conversation._id,
    firstAt: args.now,
    billing: run?.billingClass ?? "legacy",
    origin: humanRequest ? "human_request" : "ai",
    ...(run?.unitPriceBrlCents !== undefined ? { unitPriceBrlCents: run.unitPriceBrlCents } : {}),
    mode: "live",
  });
}
