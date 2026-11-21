/**
 * Helper de teste (Agenda v2, A3c): invariantes GLOBAIS da agenda. Chame no fim de todo teste que mexe em alocação,
 * exceção ou conflito:
 *  - nenhum recurso passa da capacidade (pico no núcleo; linha `exclusive` vale a capacidade inteira);
 *  - todo agendamento ativo, ainda por acontecer, tem para CADA recurso: alocação com linha em recurso ativo e não
 *    fechado (salvo aviso forçado `RESOURCE_CLOSED` ou em andamento), OU linha aberta em `schedConflicts`, OU a marca
 *    `no_resource` (resolução manual do operador).
 */
import type { TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";
import { peakUnits } from "./schedAvailability";
import { ACTIVE_STATUSES } from "./schedStatus";

export async function schedInvariantProblems(t: TestConvex<typeof schema>, orgId: Id<"organizations">, now: number): Promise<string[]> {
  return await t.run(async (ctx) => {
    const out: string[] = [];
    const resources = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect();
    const rmap = new Map(resources.map((r) => [r._id as string, r]));
    for (const r of resources) {
      const rows = await ctx.db.query("schedAllocations").withIndex("by_resource_and_start", (q) => q.eq("resourceId", r._id)).collect();
      if (rows.length === 0) continue;
      const lite = rows.map((x) => ({ ...x, units: x.exclusive ? Math.max(x.units, r.capacity) : x.units }));
      for (const x of lite) {
        const pk = peakUnits(lite, x.coreStart, x.coreEnd, "core");
        if (pk > r.capacity) {
          out.push(`CAPACIDADE ${r.name}: ${pk} > ${r.capacity}`);
          break;
        }
      }
    }
    // Um fechamento que falhou/estourou o limite SINALIZA o erro (run `failed` + aviso): não é "gente esquecida em silêncio".
    const runSignalsError = (await ctx.db.query("schedClosureRuns").withIndex("by_organization_and_created", (q) => q.eq("organizationId", orgId)).collect()).some((r) => r.status === "failed");
    const appts = (await ctx.db.query("schedAppointments").collect()).filter((a) => a.organizationId === orgId && (ACTIVE_STATUSES as readonly string[]).includes(a.status));
    const closed = (await ctx.db.query("schedExceptions").collect()).filter((e) => e.organizationId === orgId && e.mode === "closed");
    for (const a of appts) {
      if (a.endTime <= now) continue;
      const hasOpenConflict = (await ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", a._id)).collect()).some((c) => c.status === "open");
      const allocs = await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", a._id)).collect();
      for (const e of a.resources) {
        const r = rmap.get(e.resourceId);
        if (!e.allocated) {
          if (!hasOpenConflict && a.needsAttention?.code !== "no_resource") out.push(`SEM-ALOCACAO-SEM-CONFLITO ${a._id} (${a.status})`);
          continue;
        }
        if (!allocs.some((x) => x.resourceId === e.resourceId)) out.push(`MARCADO-ALOCADO-SEM-LINHA ${a._id}`);
        if (r && !r.active && !hasOpenConflict) out.push(`EM-RECURSO-INATIVO ${a._id} ${r.name}`);
        const isClosed = closed.some(
          (x) => x.localDate === a.localDate && (x.resourceId === e.resourceId || (x.resourceId === undefined && (x.resourceKind === undefined || x.resourceKind === r?.kind)))
        );
        const forced = (a.forcedRules ?? []).includes("RESOURCE_CLOSED");
        if (isClosed && !hasOpenConflict && !runSignalsError && !forced && a.status !== "checked_in") out.push(`EM-RECURSO-FECHADO-SEM-CONFLITO ${a._id} ${r?.name} (${a.status})`);
      }
    }
    return out;
  });
}
