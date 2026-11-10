/**
 * Leitura do uso de atendimentos IA no periodo (B6/B4). Sem escrita.
 *
 * "Usado" = linhas do livro com `firstAt >= inicio do periodo` e classe diferente de
 * `legacy` (A2). Caminho rapido: os baldes de `orgUsageMonthly` (so `recordAttendance`
 * live os incrementa, e `legacy` nao tem balde). O livro so e varrido no mes em que o
 * periodo COMECA no meio.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { monthKeyUtc, monthStartUtcMs } from "./aiSpend";

export function bucketsTotal(meter: Doc<"orgUsageMonthly"> | null | undefined): number {
  return (
    (meter?.attendancesIncluded ?? 0) +
    (meter?.attendancesCredit ?? 0) +
    (meter?.attendancesOverage ?? 0) +
    (meter?.attendancesSuggestOnly ?? 0)
  );
}

/** Chaves "AAAA-MM" de `fromMonth` ate `toMonth` (max. 3: o teste dura 30 dias). */
function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let cursor = monthStartUtcMs(fromMonth);
  for (let i = 0; i < 3; i++) {
    const key = monthKeyUtc(cursor);
    out.push(key);
    if (key >= toMonth) break;
    const d = new Date(cursor);
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

export async function attendancesUsedInPeriod(
  ctx: { db: QueryCtx["db"] },
  args: {
    organizationId: Id<"organizations">;
    now: number;
    /** `attendancePeriodStart`; `undefined` = so o mes corrente. */
    periodStart: number | undefined;
    /** Teste: a franquia atravessa a virada do mes. Plano pago: so o mes corrente. */
    acrossMonths: boolean;
    /** Interrompe a varredura do livro acima disto (basta saber que estourou). */
    scanCap: number;
  }
): Promise<number> {
  const month = monthKeyUtc(args.now);
  const monthStart = monthStartUtcMs(month);
  const from =
    args.acrossMonths && args.periodStart !== undefined
      ? args.periodStart
      : Math.max(args.periodStart ?? 0, monthStart);
  let total = 0;
  for (const m of monthsBetween(monthKeyUtc(from), month)) {
    if (from <= monthStartUtcMs(m)) {
      const meter = await ctx.db
        .query("orgUsageMonthly")
        .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId).eq("month", m))
        .unique();
      total += bucketsTotal(meter);
      continue;
    }
    // O periodo comeca no meio deste mes: conta as linhas do livro a partir dele.
    const rows = ctx.db
      .query("aiAttendances")
      .withIndex("by_organization_and_month_and_firstAt", (q) =>
        q.eq("organizationId", args.organizationId).eq("month", m).gte("firstAt", from)
      );
    for await (const row of rows) {
      if (row.billing !== "legacy") total += 1;
      if (total > args.scanCap) return total;
    }
  }
  return total;
}

/** Primeiro pacote com saldo e dentro da validade (FIFO por `expiresAt`). */
export async function firstValidCredit(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  now: number
): Promise<Doc<"usageCredits"> | null> {
  const credits = ctx.db
    .query("usageCredits")
    .withIndex("by_organization_and_expires", (q) => q.eq("organizationId", organizationId).gt("expiresAt", now));
  for await (const c of credits) {
    if (c.consumed < c.granted) return c;
  }
  return null;
}
