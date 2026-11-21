/// <reference types="vite/client" />
/**
 * Agenda v2, PR A1 (fundação): módulo `scheduling` (gate de plano só na transição desligado → ligado,
 * auditoria), padrões de `schedSettings`, cascata de lead/contato com agendamento, purga e backup.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { BACKUP_TABLES } from "./exports";
import { EXCLUDED_BACKUP_TABLES } from "./lib/exportSanitize";
import { resolveSchedSettings, DEFAULT_SMART_WEIGHTS } from "./lib/schedSettingsDefaults";
import * as C from "./lib/schedConstants";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

type Billing = { plan?: "essencial" | "profissional" | "escala" | "empresa"; status: "trial" | "active" | "past_due" | "read_only" | "canceled" | "legacy"; trialEndsAt?: number };

async function seed(opts: { billing?: Billing; modules?: Record<string, boolean> } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Agenda",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(opts.modules ? { modules: opts.modules } : {}) },
      ...(opts.billing ? { billing: { ...opts.billing, updatedAt: now } } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mk("Admin", "admin");
    const agent = await mk("Agente", "agent");
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    return { organizationId, admin, agent, boardId, stageId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const asAdmin = (s: Seed) => t.withIdentity({ subject: `${s.admin.userId}|s1` });
const getModules = (s: Seed) => asAdmin(s).query(api.orgModules.getOrgModules, { organizationId: s.organizationId });
const setScheduling = (s: Seed, value: boolean) =>
  asAdmin(s).mutation(api.orgModules.setOrgModules, { organizationId: s.organizationId, modules: { scheduling: value } });

describe("módulo scheduling", () => {
  test("org existente lê tudo desligado", async () => {
    const s = await seed();
    expect(await getModules(s)).toMatchObject({ scheduling: false, units: false, central: false });
  });

  test("liga e desliga com auditoria (antes/depois)", async () => {
    const s = await seed({ billing: { plan: "essencial", status: "active" } });
    expect((await setScheduling(s, true)).scheduling).toBe(true);
    expect((await getModules(s)).scheduling).toBe(true);
    expect((await setScheduling(s, false)).scheduling).toBe(false);
    const logs = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect())
        .filter((l) => l.metadata?.modules === true)
    );
    expect(logs).toHaveLength(2);
    const [on, off] = logs.sort((a, b) => a.createdAt - b.createdAt);
    expect((on.changes as any).before.scheduling).toBe(false);
    expect((on.changes as any).after.scheduling).toBe(true);
    expect((off.changes as any).after.scheduling).toBe(false);
  });

  test("todos os planos pagos ligam; legacy e sem billing ligam", async () => {
    for (const billing of [
      { plan: "essencial", status: "active" },
      { plan: "profissional", status: "active" },
      { plan: "escala", status: "past_due" },
      { plan: "empresa", status: "active" },
      { plan: "profissional", status: "trial", trialEndsAt: Date.now() + 86_400_000 },
      { status: "legacy" },
      undefined,
    ] as Array<Billing | undefined>) {
      const s = await seed({ billing });
      expect((await setScheduling(s, true)).scheduling).toBe(true);
    }
  });

  test("modo leitura, cancelado e teste vencido recusam ligar (e nada muda)", async () => {
    for (const billing of [
      { plan: "profissional", status: "read_only" },
      { plan: "empresa", status: "canceled" },
      { plan: "profissional", status: "trial", trialEndsAt: Date.now() - 1000 },
    ] as Billing[]) {
      const s = await seed({ billing });
      await expect(setScheduling(s, true)).rejects.toThrow(/modo leitura/);
      expect((await getModules(s)).scheduling).toBe(false);
    }
  });

  test("o gate vale só na transição: já ligado em conta bloqueada não recusa reenvio nem desligar", async () => {
    const s = await seed({ billing: { plan: "profissional", status: "read_only" }, modules: { scheduling: true } });
    expect((await setScheduling(s, true)).scheduling).toBe(true);
    expect((await setScheduling(s, false)).scheduling).toBe(false);
    // Mexer em OUTRO módulo nunca consulta o gate de scheduling.
    const other = await seed({ billing: { plan: "profissional", status: "read_only" } });
    const out = await asAdmin(other).mutation(api.orgModules.setOrgModules, {
      organizationId: other.organizationId,
      modules: { central: true },
    });
    expect(out).toMatchObject({ central: true, scheduling: false });
  });

  test("exige settings:manage", async () => {
    const s = await seed();
    await expect(
      t.withIdentity({ subject: `${s.agent.userId}|s1` }).mutation(api.orgModules.setOrgModules, {
        organizationId: s.organizationId,
        modules: { scheduling: true },
      })
    ).rejects.toThrow();
  });

  test("scheduling não acende a Central", async () => {
    const s = await seed();
    await setScheduling(s, true);
    await expect(
      asAdmin(s).mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Hotel A" })
    ).rejects.toThrow(/Módulo não habilitado/);
  });
});

describe("padrões de schedSettings", () => {
  test("doc ausente = padrões do plano", () => {
    const r = resolveSchedSettings(null);
    expect(r).toMatchObject({
      gridMinutes: 30, minNoticeMin: 120, maxAdvanceDays: 60,
      smart: { mode: "rank", weights: DEFAULT_SMART_WEIGHTS, minOffer: 3 },
      ai: { consult: true, book: "propose", reschedule: "propose", cancel: "handoff", firstVisitNeedsApproval: true, maxAiBookingsPerContactPerDay: 2 },
      humanConfirm: { mode: "auto" },
      reminders: { enabled: false, dayBeforeAtMin: 600, mentionService: false },
    });
    expect(r.ai.autoAck).toBeUndefined();
    expect(r.reminders.hoursBefore).toBeUndefined();
    expect(C.MAX_BLOCK_MIN).toBe(480);
    expect(C.OFFER_TTL_MS).toBe(30 * 60 * 1000);
  });

  test("doc parcial: o informado vence, o resto cai no padrão", async () => {
    const s = await seed();
    const doc = await t.run(async (ctx) => {
      const id = await ctx.db.insert("schedSettings", {
        organizationId: s.organizationId, gridMinutes: 15, ai: { book: "auto" }, updatedAt: Date.now(),
      });
      return await ctx.db.get(id);
    });
    const r = resolveSchedSettings(doc);
    expect(r.gridMinutes).toBe(15);
    expect(r.ai.book).toBe("auto");
    expect(r.ai.reschedule).toBe("propose");
    expect(r.minNoticeMin).toBe(120);
  });
});

async function insertAppointment(s: Seed, extra: Record<string, unknown>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const serviceId = await ctx.db.insert("schedServices", {
      organizationId: s.organizationId, name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("schedResources", {
      organizationId: s.organizationId, kind: "room", name: "Sala 1", capacity: 1, weekly: [], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    const appointmentId = await ctx.db.insert("schedAppointments", {
      organizationId: s.organizationId, serviceId, serviceName: "Sessão", kind: "normal",
      startTime: now + 86_400_000, endTime: now + 86_400_000 + 3_600_000,
      blockStart: now + 86_400_000, blockEnd: now + 86_400_000 + 3_600_000,
      localDate: "2026-11-22", status: "scheduled", origin: "staff",
      resources: [{ resourceId, role: "Sala", name: "Sala 1", allocated: true }],
      statusChangedAt: now, createdAt: now, updatedAt: now,
      ...extra,
    } as any);
    await ctx.db.insert("schedAllocations", {
      organizationId: s.organizationId, appointmentId, resourceId, role: "Sala",
      blockStart: now + 86_400_000, blockEnd: now + 86_400_000 + 3_600_000,
      coreStart: now + 86_400_000, coreEnd: now + 86_400_000 + 3_600_000, units: 1,
    });
    return { appointmentId, serviceId, resourceId };
  });
}

describe("cascata de lead/contato com agendamento", () => {
  async function leadAndContact(s: Seed) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Cliente", tags: [], createdAt: now, updatedAt: now });
      const leadId = await ctx.db.insert("leads", {
        organizationId: s.organizationId, title: "Lead", contactId, boardId: s.boardId, stageId: s.stageId,
        value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      } as any);
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now,
      });
      return { contactId, leadId, conversationId };
    });
  }

  test("excluir o lead mantém o agendamento (e a ocupação) sem o vínculo; apaga estado/interpretações da conversa", async () => {
    const s = await seed();
    const { contactId, leadId, conversationId } = await leadAndContact(s);
    const { appointmentId } = await insertAppointment(s, { leadId, contactId, contactName: "Cliente" });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("schedConversationState", { organizationId: s.organizationId, conversationId, offerSeq: 1, offers: [], updatedAt: now });
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId, leadId, direction: "outbound", senderType: "human", content: "oi",
        contentType: "text", isInternal: false, searchNorm: "oi", createdAt: now,
      } as any);
      await ctx.db.insert("schedInterpretations", {
        organizationId: s.organizationId, conversationId, messageId, act: "confirmou", parsed: {}, checks: { parser: true },
        decision: "ignored", status: "open", createdAt: now,
      });
    });
    await asAdmin(s).mutation(api.leads.deleteLead, { leadId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({
      lead: await ctx.db.get(leadId),
      appointment: await ctx.db.get(appointmentId),
      allocations: await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).collect(),
      state: await ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
      interp: await ctx.db.query("schedInterpretations").withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conversationId)).collect(),
    }));
    expect(after.lead).toBeNull();
    expect(after.appointment).not.toBeNull();
    expect(after.appointment!.leadId).toBeUndefined();
    expect(after.appointment!.serviceName).toBe("Sessão");
    expect(after.appointment!.contactName).toBe("Cliente");
    expect(after.allocations).toHaveLength(1);
    expect(after.state).toHaveLength(0);
    expect(after.interp).toHaveLength(0);
  });

  test("excluir o contato junto zera contactId do agendamento", async () => {
    const s = await seed();
    const { contactId, leadId } = await leadAndContact(s);
    const { appointmentId } = await insertAppointment(s, { leadId, contactId, contactName: "Cliente", guestName: "Acompanhante", notes: "nota interna", cancelReason: "motivo" });
    await asAdmin(s).mutation(api.leads.deleteLead, { leadId, deleteContact: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({ contact: await ctx.db.get(contactId), appt: await ctx.db.get(appointmentId) }));
    expect(after.contact).toBeNull();
    expect(after.appt).toMatchObject({ status: "scheduled", serviceName: "Sessão" });
    expect(after.appt!.contactName).toBeUndefined();
    expect(after.appt!.guestName).toBeUndefined();
    expect(after.appt!.notes).toBeUndefined();
    expect(after.appt!.cancelReason).toBeUndefined();
    expect(after.appt!.contactId).toBeUndefined();
    expect(after.appt!.leadId).toBeUndefined();
  });
});

describe("deleteContact (contato sem lead) passa pela cascata de referências", () => {
  test("agendamento perde vínculo e dado pessoal; tarefa e compromisso perdem o contactId", async () => {
    const s = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Solo", tags: [], createdAt: now, updatedAt: now });
      const eventId = await ctx.db.insert("calendarEvents", {
        organizationId: s.organizationId, title: "Ligar", eventType: "call", startTime: now, endTime: now + 1000, allDay: false,
        status: "scheduled", contactId, createdBy: s.admin.memberId, createdAt: now, updatedAt: now,
      });
      return { contactId, eventId };
    });
    const { appointmentId } = await insertAppointment(s, { contactId: ids.contactId, contactName: "Solo", notes: "n" });
    await asAdmin(s).mutation(api.contacts.deleteContact, { contactId: ids.contactId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({
      contact: await ctx.db.get(ids.contactId), appt: await ctx.db.get(appointmentId), event: await ctx.db.get(ids.eventId),
    }));
    expect(after.contact).toBeNull();
    expect(after.appt).not.toBeNull();
    expect(after.appt!.contactId).toBeUndefined();
    expect(after.appt!.contactName).toBeUndefined();
    expect(after.appt!.notes).toBeUndefined();
    expect(after.event).not.toBeNull();
    expect(after.event!.contactId).toBeUndefined();
  });
});

describe("registro das tabelas novas", () => {
  test("backup leva configuração e agendamentos; derivados ficam de fora e não cruzam", () => {
    for (const table of ["schedSettings", "schedResources", "schedServices", "schedExceptions", "schedAppointments"]) {
      expect(BACKUP_TABLES).toContain(table);
      expect(EXCLUDED_BACKUP_TABLES).not.toContain(table);
    }
    for (const table of ["schedAllocations", "schedConflicts", "schedConversationState", "schedInterpretations"]) {
      expect(EXCLUDED_BACKUP_TABLES).toContain(table);
      expect(BACKUP_TABLES).not.toContain(table);
    }
  });

  test("purga da org (dryRun valida os índices; real apaga agendamento e alocação)", async () => {
    const s = await seed();
    const other = await seed();
    const mine = await insertAppointment(s, {});
    const theirs = await insertAppointment(other, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("schedSettings", { organizationId: s.organizationId, updatedAt: Date.now() });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.insert("schedConversationState", { organizationId: s.organizationId, conversationId, offerSeq: 0, offers: [], updatedAt: Date.now() });
      await ctx.db.insert("schedExceptions", {
        organizationId: s.organizationId, localDate: "2026-12-25", mode: "closed", source: "manual", createdAt: Date.now(),
      });
    });
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const otherSlug = await t.run(async (ctx) => (await ctx.db.get(other.organizationId))!.slug);
    const args = { keepSlugs: [otherSlug], confirmDeployment: "example" };
    const dry = await t.mutation(internal.opsPurge.internalPurgeOrganizations, { ...args, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(await t.run(async (ctx) => await ctx.db.get(mine.appointmentId))).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      await t.mutation(internal.opsPurge.internalPurgeOrganizations, { ...args, dryRun: false });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const left = await t.run(async (ctx) => await ctx.db.get(s.organizationId));
      if (!left) break;
    }
    const after = await t.run(async (ctx) => ({
      myAppt: await ctx.db.get(mine.appointmentId),
      myAllocs: await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", mine.appointmentId)).collect(),
      mySettings: await ctx.db.query("schedSettings").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect(),
      myState: await ctx.db.query("schedConversationState").collect(),
      myExceptions: await ctx.db.query("schedExceptions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect(),
      theirAppt: await ctx.db.get(theirs.appointmentId),
      theirAllocs: await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", theirs.appointmentId)).collect(),
    }));
    expect(after.myAppt).toBeNull();
    expect(after.myAllocs).toHaveLength(0);
    expect(after.mySettings).toHaveLength(0);
    expect(after.myExceptions).toHaveLength(0);
    expect(after.myState).toHaveLength(0);
    expect(after.theirAppt).not.toBeNull();
    expect(after.theirAllocs).toHaveLength(1);
  });
});
