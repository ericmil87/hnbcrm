/// <reference types="vite/client" />
/**
 * Agenda v2, PR A3b (portas de reserva): `lib/schedBookingOps.ts` + `schedulingMutations.ts`.
 * O `convex-test` roda UMA função por vez: `Promise.all` aqui prova a lógica, não o entrelaçamento
 * (a garantia concorrente vem do read set por faixa; ver o cabeçalho da porta e o relatório 08).
 * O `convex-test` também NÃO valida `returns`: `matchesValidator` compara o que sai com o validator.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";
import { peakUnits } from "./lib/schedAvailability";
import { bookAppointmentCore, bookPartyCore } from "./lib/schedBookingOps";
import * as M from "./schedulingMutations";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const NOW = new Date("2026-06-12T12:00:00Z").getTime(); // sexta, 09:00 em São Paulo
/** Instante de `h:m` (São Paulo, UTC-3) do dia `day` de junho/2026 (15 = segunda-feira). */
const at = (h: number, m = 0, day = 15) => Date.UTC(2026, 5, day, h + 3, m);

let t: TestConvex<typeof schema>;

const seededOrgs: Id<"organizations">[] = [];

beforeEach(() => {
  seededOrgs.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(async () => {
  // Todo teste de reserva termina provando que nenhum recurso passou da capacidade (pico no núcleo).
  for (const orgId of seededOrgs) await assertNoOvercapacity(orgId);
  vi.useRealTimers();
});

/** Varre as alocações de cada recurso da org e confere pico <= capacidade (linha exclusiva vale a capacidade inteira). */
async function assertNoOvercapacity(organizationId: Id<"organizations">) {
  const problems = await t.run(async (ctx) => {
    const out: string[] = [];
    const resources = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
    for (const r of resources) {
      const rows = await ctx.db.query("schedAllocations").withIndex("by_resource_and_start", (q) => q.eq("resourceId", r._id)).collect();
      const lite = rows.map((x) => ({ ...x, units: x.exclusive ? Math.max(x.units, r.capacity) : x.units }));
      if (lite.length === 0) continue;
      const from = Math.min(...lite.map((x) => x.coreStart));
      const to = Math.max(...lite.map((x) => x.coreEnd));
      const peak = peakUnits(lite, from, to, "core");
      if (peak > r.capacity) out.push(`${r.name}: pico ${peak} > capacidade ${r.capacity}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

// ---------------------------------------------------------------------------
// Semeadura (direto no banco: serviços, recursos e configuração)
// ---------------------------------------------------------------------------

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 480, endMin: 1080 }));

type Kind = "person" | "room" | "equipment";
type Req = { role: string; kind: Kind; resourceIds?: Id<"schedResources">[]; units?: number; exclusive?: boolean };

async function seedOrg(opts: { scheduling?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Teste",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { scheduling: opts.scheduling ?? true } },
      createdAt: now,
      updatedAt: now,
    });
    const member = async (name: string, role: "admin" | "agent", permissions?: Doc<"teamMembers">["permissions"]) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active",
        ...(permissions ? { permissions } : {}),
        createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await member("Admin", "admin");
    const agent = await member("Agente", "agent");
    const level = (agenda: "none" | "view_own" | "view_all") => ({ ...DEFAULT_PERMISSIONS.agent, agenda });
    const none = await member("SemAgenda", "agent", level("none"));
    const viewOwn = await member("VeProprio", "agent", level("view_own"));
    const viewAll = await member("VeTudo", "agent", level("view_all"));
    const aiMemberId = await ctx.db.insert("teamMembers", {
      organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const mkStage = (bId: Id<"boards">, name: string, order: number) =>
      ctx.db.insert("stages", { organizationId, boardId: bId, name, color: "#6366f1", order, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const stageId = await mkStage(boardId, "Novo", 0);
    const scheduledStageId = await mkStage(boardId, "Agendado", 1);
    const otherBoardId = await ctx.db.insert("boards", { organizationId, name: "Pós", color: "#22c55e", isDefault: false, order: 1, createdAt: now, updatedAt: now });
    const otherBoardStageId = await mkStage(otherBoardId, "Outra", 0);

    const mkContact = (firstName: string, relation?: "personal") =>
      ctx.db.insert("contacts", { organizationId, firstName, lastName: "Teste", tags: [], ...(relation ? { relation } : {}), createdAt: now, updatedAt: now });
    const contacts = [await mkContact("Ana"), await mkContact("Bia"), await mkContact("Caio")];
    const personalContactId = await mkContact("Pessoal", "personal");
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Lead Ana", contactId: contacts[0], boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });

    const mkResource = (name: string, kind: Kind, capacity: number, sortOrder: number, teamMemberId?: Id<"teamMembers">) =>
      ctx.db.insert("schedResources", {
        organizationId, kind, name, capacity, weekly: WEEKDAYS, tags: [], sortOrder, active: true,
        ...(teamMemberId ? { teamMemberId } : {}), createdAt: now, updatedAt: now,
      });
    const p1 = await mkResource("Profissional Um", "person", 1, 0, admin.memberId);
    const p2 = await mkResource("Profissional Dois", "person", 1, 1);
    const sala1 = await mkResource("Sala Um", "room", 1, 2);
    const sala2 = await mkResource("Sala Dois", "room", 1, 3);
    const dupla = await mkResource("Sala Dupla", "room", 2, 4);

    const mkService = (name: string, requirements: Req[], extra: Partial<Doc<"schedServices">> = {}) =>
      ctx.db.insert("schedServices", {
        organizationId, name, durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements,
        sortOrder: 0, active: true, createdAt: now, updatedAt: now, ...extra,
      });
    const services = {
      solo: await mkService("Consulta", [{ role: "Profissional", kind: "person", resourceIds: [p1] }]),
      sessao: await mkService("Sessão", [{ role: "Terapeuta", kind: "person" }, { role: "Sala", kind: "room", resourceIds: [sala1, sala2] }]),
      dupla: await mkService("Massagem casal", [{ role: "Sala", kind: "room", resourceIds: [dupla] }]),
      exclusiva: await mkService("Sala inteira", [{ role: "Sala", kind: "room", resourceIds: [dupla], exclusive: true }]),
      longo: await mkService("Longo", [{ role: "Profissional", kind: "person", resourceIds: [p1] }], { durationMin: 470, bufferBeforeMin: 10, bufferAfterMin: 10 }),
      duasSalas: await mkService("Duas salas", [{ role: "Sala A", kind: "room" }, { role: "Sala B", kind: "room" }]),
    };
    seededOrgs.push(organizationId);
    return {
      organizationId, admin, agent, none, viewOwn, viewAll, aiMemberId, boardId, stageId, scheduledStageId, otherBoardStageId,
      contacts, personalContactId, leadId, conversationId, resources: { p1, p2, sala1, sala2, dupla }, services,
    };
  });
}
type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function seedForeign() {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Outra Org", slug: `outra-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { scheduling: true } }, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    const memberId = await ctx.db.insert("teamMembers", { organizationId, userId, name: "Admin B", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "F", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "N", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Estranho", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Lead B", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "low", temperature: "cold",
      tags: [], customFields: {}, conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", { organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now });
    const resourceId = await ctx.db.insert("schedResources", { organizationId, kind: "room", name: "Sala B", capacity: 1, weekly: WEEKDAYS, sortOrder: 0, active: true, createdAt: now, updatedAt: now });
    const serviceId = await ctx.db.insert("schedServices", {
      organizationId, name: "Serviço B", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [resourceId] }], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    const appointmentId = await ctx.db.insert("schedAppointments", {
      organizationId, serviceId, serviceName: "Serviço B", kind: "normal", startTime: at(10), endTime: at(11), blockStart: at(10), blockEnd: at(11),
      localDate: "2026-06-15", status: "scheduled", origin: "staff", resources: [{ resourceId, role: "Sala", name: "Sala B", allocated: true }],
      statusChangedAt: now, createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, memberId, contactId, leadId, conversationId, resourceId, serviceId, appointmentId };
  });
}

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const asAdmin = (s: Seed) => as(s.admin.userId);

const bookArgs = (s: Seed, service: keyof Seed["services"], start: number, extra: Record<string, unknown> = {}) => ({
  organizationId: s.organizationId,
  serviceId: s.services[service],
  startTime: start,
  contactId: s.contacts[0],
  ...extra,
});
const book = (s: Seed, service: keyof Seed["services"], start: number, extra: Record<string, unknown> = {}) =>
  asAdmin(s).mutation(api.schedulingMutations.bookAppointment, bookArgs(s, service, start, extra) as never);

/** Dados de um `ConvexError` (o código `sched_rules` com violações e alternativas). */
async function rulesError(p: Promise<unknown>): Promise<{ code: string; violations: Array<{ code: string; severity: string; message: string }>; alternatives: Array<{ startTime: number; resourceIds: string[] }> }> {
  try {
    await p;
  } catch (e) {
    // O `convex-test` entrega `ConvexError.data` serializado (string JSON) e de outra instância do módulo.
    let data = (e as { data?: unknown }).data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        /* texto simples */
      }
    }
    if (typeof data === "object" && data !== null) return data as never;
    throw e;
  }
  throw new Error("esperava um erro sched_rules, mas a chamada passou");
}

const TABLES = ["schedAppointments", "schedAllocations", "schedConflicts", "schedExceptions", "schedSettings", "auditLogs", "activities", "leads", "calendarEvents", "notifications", "webhooks"] as const;
async function counts(): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of TABLES) out[table] = (await ctx.db.query(table).collect()).length;
    out._scheduled_functions = (await ctx.db.system.query("_scheduled_functions").collect()).length;
    return out;
  });
}
const allocationsOf = (appointmentId: Id<"schedAppointments">) =>
  t.run((ctx) => ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).collect());
const appointmentOf = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.get(id));
const allAppointments = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const allAllocations = () => t.run((ctx) => ctx.db.query("schedAllocations").collect());

/** Compara o valor com o validator (chaves exatas de objeto, tipos básicos): o `convex-test` não valida `returns`. */
function matchesValidator(validator: unknown, value: unknown, path = "$"): string[] {
  const vd = validator as { kind: string; fields?: Record<string, unknown>; element?: unknown; members?: unknown[]; value?: unknown; isOptional?: string };
  const errs: string[] = [];
  switch (vd.kind) {
    case "any":
      return errs;
    case "null":
      return value === null ? errs : [`${path}: esperava null`];
    case "string":
    case "id":
      return typeof value === "string" ? errs : [`${path}: esperava string`];
    case "float64":
      return typeof value === "number" ? errs : [`${path}: esperava número`];
    case "boolean":
      return typeof value === "boolean" ? errs : [`${path}: esperava booleano`];
    case "literal":
      return errs;
    case "array":
      if (!Array.isArray(value)) return [`${path}: esperava array`];
      value.forEach((x, i) => errs.push(...matchesValidator(vd.element, x, `${path}[${i}]`)));
      return errs;
    case "record":
      return typeof value === "object" && value !== null ? errs : [`${path}: esperava objeto`];
    case "union": {
      const results = (vd.members ?? []).map((m) => matchesValidator(m, value, path));
      return results.some((r) => r.length === 0) ? errs : [`${path}: nenhum membro da união casa`, ...results.flat()];
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: esperava objeto`];
      const fields = vd.fields ?? {};
      const given = value as Record<string, unknown>;
      for (const key of Object.keys(given)) {
        if (given[key] !== undefined && !(key in fields)) errs.push(`${path}.${key}: campo que o validator não tem`);
      }
      for (const [key, fv] of Object.entries(fields)) {
        const optional = (fv as { isOptional: string }).isOptional === "optional";
        if (given[key] === undefined) {
          if (!optional) errs.push(`${path}.${key}: campo obrigatório ausente`);
        } else errs.push(...matchesValidator(fv, given[key], `${path}.${key}`));
      }
      return errs;
    }
    default:
      return errs;
  }
}
function expectMatches(validator: unknown, value: unknown) {
  expect(matchesValidator(validator, value)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Reservar
// ---------------------------------------------------------------------------

describe("reservar", () => {
  test("a segunda reserva no mesmo horário vê a primeira e falha com alternativas", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    expect(first.appointmentIds).toHaveLength(1);
    const err = await rulesError(book(s, "solo", at(10), { contactId: s.contacts[1] }));
    expect(err.code).toBe("sched_rules");
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect(err.alternatives.length).toBeGreaterThan(0);
    expect(err.alternatives.length).toBeLessThanOrEqual(3);
    expect(err.alternatives.every((a) => a.startTime !== at(10))).toBe(true);
    expect(err.alternatives.every((a) => a.resourceIds.length === 1)).toBe(true);
    expect(await allAppointments()).toHaveLength(1);
    expect(await allAllocations()).toHaveLength(1);
  });

  test("a alternativa devolvida é reservável", async () => {
    const s = await seedOrg();
    await book(s, "solo", at(10));
    const err = await rulesError(book(s, "solo", at(10), { contactId: s.contacts[1] }));
    const alt = err.alternatives[0];
    const ok = await book(s, "solo", alt.startTime, { contactId: s.contacts[1], resourceIds: alt.resourceIds });
    expect(ok.appointmentIds).toHaveLength(1);
  });

  test("capacidade 2 aceita 2 e recusa o 3º", async () => {
    const s = await seedOrg();
    await book(s, "dupla", at(10), { contactId: s.contacts[0] });
    await book(s, "dupla", at(10), { contactId: s.contacts[1] });
    const err = await rulesError(book(s, "dupla", at(10), { contactId: s.contacts[2] }));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect(await allAllocations()).toHaveLength(2);
  });

  test("capacidade conta o PICO: dois de 30 min em sequência cabem numa sala simples dentro de 60 min", async () => {
    const s = await seedOrg();
    const half = await t.run((ctx) =>
      ctx.db.insert("schedServices", {
        organizationId: s.organizationId, name: "Rápido", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0,
        requirements: [{ role: "Sala", kind: "room", resourceIds: [s.resources.sala1] }], sortOrder: 0, active: true, createdAt: NOW, updatedAt: NOW,
      })
    );
    const mk = (start: number, contactId: Id<"contacts">) =>
      asAdmin(s).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: half, startTime: start, contactId });
    await mk(at(10), s.contacts[0]);
    await mk(at(10, 30), s.contacts[1]);
    expect(await allAllocations()).toHaveLength(2);
    const err = await rulesError(mk(at(10, 15), s.contacts[2]));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
  });

  test("pessoa ocupada em outra sala recusa; com fallback usa outro profissional", async () => {
    const s = await seedOrg();
    const { p1, p2, sala1, sala2 } = s.resources;
    await book(s, "sessao", at(10), { resourceIds: [p1, sala1] });
    const err = await rulesError(book(s, "sessao", at(10), { contactId: s.contacts[1], resourceIds: [p1, sala2], allowResourceFallback: false }));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    const ok = await book(s, "sessao", at(10), { contactId: s.contacts[1], resourceIds: [p1, sala2] });
    const appt = (await appointmentOf(ok.appointmentIds[0]))!;
    expect(appt.resources.map((r) => r.resourceId)).toEqual([p2, sala2]);
    const rows = await allocationsOf(appt._id);
    expect(rows.map((r) => r.resourceId).sort()).toEqual([p2, sala2].sort());
  });

  test("mesmo recurso em dois papéis recusa", async () => {
    const s = await seedOrg();
    const err = await rulesError(book(s, "duasSalas", at(10), { resourceIds: [s.resources.sala1, s.resources.sala1] }));
    expect(err.violations.map((v) => v.code)).toContain("WRONG_ORG_OR_INACTIVE");
    expect(await allAllocations()).toHaveLength(0);
  });

  test("bloco acima de MAX_BLOCK_MIN recusa (e nada é gravado)", async () => {
    const s = await seedOrg();
    const err = await rulesError(book(s, "longo", at(9)));
    expect(err.violations.map((v) => v.code)).toContain("DURATION_TOO_LONG");
    expect(await allAppointments()).toHaveLength(0);
    expect(await allAllocations()).toHaveLength(0);
  });

  test("idempotencyKey repetida devolve o mesmo agendamento", async () => {
    const s = await seedOrg();
    const a = await book(s, "solo", at(10), { idempotencyKey: "k-1" });
    const b = await book(s, "solo", at(10), { idempotencyKey: "k-1" });
    expect(b.appointmentIds).toEqual(a.appointmentIds);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await allAppointments()).toHaveLength(1);
    // Mesma chave com outros dados é erro, não devolve o agendamento errado.
    await expect(book(s, "solo", at(14), { idempotencyKey: "k-1" })).rejects.toThrow(/idempotência/);
  });

  test("dedupe de negócio: mesmo contato, serviço e início com chave diferente devolve o existente", async () => {
    const s = await seedOrg();
    const a = await book(s, "solo", at(10), { idempotencyKey: "k-a" });
    const b = await book(s, "solo", at(10), { idempotencyKey: "k-b" });
    expect(b.appointmentIds).toEqual(a.appointmentIds);
    expect(b.duplicate).toBe(true);
    expect(await allAppointments()).toHaveLength(1);
    expect(await allAllocations()).toHaveLength(1);
  });

  test("mode:preview não grava nada em NENHUMA tabela tocada", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.organizationId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, funnel: { onScheduledStageId: s.scheduledStageId }, updatedAt: NOW }));
    const before = await counts();
    const ok = await asAdmin(s).mutation(api.schedulingMutations.previewBooking, bookArgs(s, "sessao", at(10), { leadId: s.leadId }) as never);
    expect(ok.ok).toBe(true);
    expect(ok.preview).toBe(true);
    expect(ok.plan.map((p) => p.role)).toEqual(["Terapeuta", "Sala"]);
    expect(ok.plan.every((p) => typeof p.resourceName === "string")).toBe(true);
    expect(await counts()).toEqual(before);
    // Prévia de reserva que falha: violações e alternativas, também sem gravar.
    await book(s, "solo", at(10));
    const mid = await counts();
    const bad = await asAdmin(s).mutation(api.schedulingMutations.previewBooking, bookArgs(s, "solo", at(10), { contactId: s.contacts[1] }) as never);
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect(bad.alternatives.length).toBeGreaterThan(0);
    expect(await counts()).toEqual(mid);
  });

  test("aviso forçável: fora do expediente exige force; vira fit_in e registra forcedRules", async () => {
    const s = await seedOrg();
    const err = await rulesError(book(s, "solo", at(19)));
    expect(err.violations.find((v) => v.code === "OUTSIDE_HOURS")?.severity).toBe("warn");
    const ok = await book(s, "solo", at(19), { force: ["OUTSIDE_HOURS"] });
    const appt = (await appointmentOf(ok.appointmentIds[0]))!;
    expect(appt.kind).toBe("fit_in");
    expect(appt.forcedRules).toEqual(["OUTSIDE_HOURS"]);
    expect(ok.warnings.map((w) => w.code)).toEqual(["OUTSIDE_HOURS"]);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", appt._id)).collect());
    expect(audit[0].metadata?.forcedRules).toEqual(["OUTSIDE_HOURS"]);
  });

  test("capacidade ninguém força, nem a equipe", async () => {
    const s = await seedOrg();
    await book(s, "solo", at(10));
    const err = await rulesError(book(s, "solo", at(10), { contactId: s.contacts[1], force: ["CAPACITY_EXCEEDED", "BUFFER_OVERLAP"] }));
    expect(err.violations.find((v) => v.code === "CAPACITY_EXCEEDED")?.severity).toBe("block");
    expect(await allAppointments()).toHaveLength(1);
  });

  test("compromisso interno do profissional é aviso forçável", async () => {
    const s = await seedOrg();
    await t.run((ctx) =>
      ctx.db.insert("calendarEvents", {
        organizationId: s.organizationId, title: "Reunião", eventType: "meeting", startTime: at(10, 15), endTime: at(10, 45),
        allDay: false, status: "scheduled", createdBy: s.admin.memberId, assignedTo: s.admin.memberId, createdAt: NOW, updatedAt: NOW,
      })
    );
    const err = await rulesError(book(s, "solo", at(10)));
    expect(err.violations.find((v) => v.code === "INTERNAL_EVENT_OVERLAP")?.severity).toBe("warn");
    const ok = await book(s, "solo", at(10), { force: ["INTERNAL_EVENT_OVERLAP"] });
    expect((await appointmentOf(ok.appointmentIds[0]))!.kind).toBe("fit_in");
  });

  test("sala exclusiva ocupa a capacidade inteira, inclusive se a capacidade subir depois", async () => {
    const s = await seedOrg();
    const ok = await book(s, "exclusiva", at(10));
    const rows = await allocationsOf(ok.appointmentIds[0]);
    expect(rows[0]).toMatchObject({ units: 2, exclusive: true });
    const err = await rulesError(book(s, "dupla", at(10), { contactId: s.contacts[1] }));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    await t.run((ctx) => ctx.db.patch(s.resources.dupla, { capacity: 3 }));
    await rulesError(book(s, "dupla", at(10), { contactId: s.contacts[1] }));
    expect(await allAppointments()).toHaveLength(1);
  });

  test("lógica de disputa: duas reservas do último horário em paralelo, só uma passa", async () => {
    const s = await seedOrg();
    const results = await Promise.allSettled([
      book(s, "solo", at(10), { contactId: s.contacts[0] }),
      book(s, "solo", at(10), { contactId: s.contacts[1] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await allAllocations()).toHaveLength(1);
  });

  test("horário passado e fora de minuto inteiro são recusados", async () => {
    const s = await seedOrg();
    const err = await rulesError(book(s, "solo", at(8, 0, 12)));
    expect(err.violations.map((v) => v.code)).toContain("PAST_START");
    await expect(book(s, "solo", at(10) + 5_000)).rejects.toThrow(/minutos inteiros/);
  });
});

// ---------------------------------------------------------------------------
// Casal na sala dupla
// ---------------------------------------------------------------------------

describe("marcação em grupo (casal na sala dupla)", () => {
  test("aceita as duas pessoas e o 3º, em outra reserva, é recusado", async () => {
    const s = await seedOrg();
    const ok = await book(s, "dupla", at(10), { companions: [{ guestName: "Acompanhante" }] });
    expect(ok.appointmentIds).toHaveLength(2);
    const [main, guest] = await Promise.all(ok.appointmentIds.map((id) => appointmentOf(id)));
    expect(main!.partyKey).toBeDefined();
    expect(guest!.partyKey).toBe(main!.partyKey);
    expect(guest!.guestName).toBe("Acompanhante");
    expect(guest!.contactId).toBeUndefined();
    expect(await allAllocations()).toHaveLength(2);
    await rulesError(book(s, "dupla", at(10), { contactId: s.contacts[1] }));
  });

  test("tudo ou nada: se a segunda pessoa não cabe, a primeira não fica (núcleo, sem depender do rollback)", async () => {
    const s = await seedOrg();
    await book(s, "dupla", at(10), { contactId: s.contacts[2] }); // 1 de 2 vagas usada
    const before = await counts();
    const member = await t.run((ctx) => ctx.db.get(s.admin.memberId));
    const result = await t.run((ctx) =>
      bookPartyCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "human", member: member! }, origin: "staff",
        serviceId: s.services.dupla, startTime: at(10), contactId: s.contacts[0], now: NOW,
        companions: [{ guestName: "Acompanhante" }],
      })
    );
    expect(result.ok).toBe(false);
    expect(await counts()).toEqual(before);
    expect(await allAppointments()).toHaveLength(1);
    expect(await allAllocations()).toHaveLength(1);
    // Pela mutation pública (que lança) o resultado é o mesmo.
    await rulesError(book(s, "dupla", at(10), { companions: [{ guestName: "Acompanhante" }] }));
    expect(await counts()).toEqual(before);
  });

  test("repetir o mesmo pedido de grupo não duplica acompanhantes", async () => {
    const s = await seedOrg();
    await book(s, "dupla", at(10), { companions: [{ guestName: "Acompanhante" }] });
    const again = await book(s, "dupla", at(10), { idempotencyKey: undefined, companions: [{ guestName: "Acompanhante" }] });
    expect(again.duplicate).toBe(true);
    expect(await allAppointments()).toHaveLength(2);
    expect(await allAllocations()).toHaveLength(2);
  });

  test("acompanhantes além do teto são recusados", async () => {
    const s = await seedOrg();
    const companions = Array.from({ length: 4 }, (_, i) => ({ guestName: `G${i}` }));
    await expect(book(s, "dupla", at(10), { companions })).rejects.toThrow(/acompanhantes/);
  });
});

// ---------------------------------------------------------------------------
// Fila de conflito (criação automática pela mensagem do humano)
// ---------------------------------------------------------------------------

describe("conflictToQueue", () => {
  const runHuman = (s: Seed, extra: Record<string, unknown> = {}) =>
    t.run((ctx) =>
      bookAppointmentCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "system", via: "human_message" }, origin: "human_message",
        serviceId: s.services.dupla, startTime: at(10), contactId: s.contacts[2], initialStatus: "scheduled",
        conflictToQueue: true, idempotencyKey: "hm:1", now: NOW, ...extra,
      } as never)
    );

  test("cria SEM alocação no recurso em conflito e abre conflito", async () => {
    const s = await seedOrg();
    await book(s, "dupla", at(10), { contactId: s.contacts[0] });
    await book(s, "dupla", at(10), { contactId: s.contacts[1] });
    const result = await runHuman(s);
    expect(result).toMatchObject({ ok: true, created: true, inConflict: true, status: "scheduled" });
    const id = (result as { appointmentId: Id<"schedAppointments"> }).appointmentId;
    const appt = (await appointmentOf(id))!;
    expect(appt.resources.every((r) => r.allocated === false)).toBe(true);
    expect(appt.needsAttention?.code).toBe("capacity_conflict");
    expect(await allocationsOf(id)).toHaveLength(0);
    expect(await allAllocations()).toHaveLength(2); // a ocupação nunca passou da capacidade
    const conflicts = await t.run((ctx) => ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "human_confirm", status: "open", resourceId: s.resources.dupla, localDate: "2026-06-15" });
    // Cancelar o agendamento em conflito encerra a linha de conflito.
    const memberDoc = (await t.run((ctx) => ctx.db.get(s.admin.memberId)))!;
    await t.run((ctx) => import("./lib/schedBookingOps").then((m) => m.cancelAppointmentCore(ctx as never, { appointment: appt, actor: { type: "human", member: memberDoc }, byClass: "staff", now: NOW })));
    const after = await t.run((ctx) => ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect());
    expect(after[0].status).toBe("resolved");
  });

  test("desfazer o cancelamento de um agendamento da fila, com a vaga livre, aloca de verdade", async () => {
    const s = await seedOrg();
    const a = (await book(s, "dupla", at(10), { contactId: s.contacts[0] })).appointmentIds[0];
    await book(s, "dupla", at(10), { contactId: s.contacts[1] });
    const queued = (await runHuman(s)) as { appointmentId: Id<"schedAppointments"> };
    const m = asAdmin(s).mutation;
    await m(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: queued.appointmentId });
    await m(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: a });
    await m(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.organizationId, appointmentId: queued.appointmentId });
    const appt = (await appointmentOf(queued.appointmentId))!;
    expect(appt.resources.every((r) => r.allocated)).toBe(true);
    expect(appt.needsAttention).toBeUndefined();
    expect(await allocationsOf(queued.appointmentId)).toHaveLength(1);
  });

  test("com vaga livre nasce alocado e sem conflito", async () => {
    const s = await seedOrg();
    const result = await runHuman(s);
    expect(result).toMatchObject({ ok: true, inConflict: false });
    expect(await allAllocations()).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("schedConflicts").collect())).toHaveLength(0);
  });

  test("só vale para a origem human_message; a IA nunca enfileira", async () => {
    const s = await seedOrg();
    await expect(runHuman(s, { origin: "staff", actor: { type: "human", member: (await t.run((ctx) => ctx.db.get(s.admin.memberId)))! } })).rejects.toThrow(/fila de conflitos/);
  });

  test("outras violações (fora do expediente) continuam barrando a criação automática", async () => {
    const s = await seedOrg();
    const result = await runHuman(s, { startTime: at(19) });
    expect(result).toMatchObject({ ok: false });
    expect(await allAppointments()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Remarcar, cancelar, status, desfazer, trocar sala
// ---------------------------------------------------------------------------

describe("remarcar", () => {
  const reschedule = (s: Seed, appointmentId: Id<"schedAppointments">, startTime: number, extra: Record<string, unknown> = {}) =>
    asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId, startTime, ...extra } as never);

  test("30 min para frente não conflita consigo mesmo; o antigo vira rescheduled e perde as alocações", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10), { leadId: s.leadId });
    const oldId = first.appointmentIds[0];
    const { appointmentId: newId } = await reschedule(s, oldId, at(10, 30));
    expect(newId).not.toBe(oldId);
    const [old, next] = [(await appointmentOf(oldId))!, (await appointmentOf(newId))!];
    expect(old.status).toBe("rescheduled");
    expect(old.rescheduledToId).toBe(newId);
    expect(next).toMatchObject({ status: "scheduled", rescheduledFromId: oldId, icalSequence: 1, startTime: at(10, 30) });
    expect(next.icalUid).toBe(`${oldId}@hnbcrm`);
    expect(await allocationsOf(oldId)).toHaveLength(0);
    expect(await allocationsOf(newId)).toHaveLength(1);
    expect(await allAllocations()).toHaveLength(1);
    const activities = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", s.leadId)).collect());
    expect(activities.some((a) => a.type === "appointment_changed" && /remarcado/i.test(a.content ?? ""))).toBe(true);
  });

  test("é atômico: horário tomado recusa e deixa o agendamento antigo intacto", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    await book(s, "solo", at(14), { contactId: s.contacts[1] });
    const before = await counts();
    const err = await rulesError(reschedule(s, first.appointmentIds[0], at(14)));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect((await appointmentOf(first.appointmentIds[0]))!.status).toBe("scheduled");
    expect(await counts()).toEqual(before);
  });

  test("não remarca para o mesmo horário nem um agendamento já cancelado", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    await expect(reschedule(s, first.appointmentIds[0], at(10))).rejects.toThrow(/igual ao atual/);
    await asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: first.appointmentIds[0] });
    await expect(reschedule(s, first.appointmentIds[0], at(11))).rejects.toThrow(/não permitida/);
  });

  test("IA não encerra o horário antigo sem aprovação (precisa de proposta)", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    await expect(
      t.mutation(internal.schedulingMutations.internalRescheduleAppointment, {
        organizationId: s.organizationId, appointmentId: first.appointmentIds[0],
        actor: { type: "ai", memberId: s.aiMemberId, conversationId: s.conversationId }, startTime: at(14),
      })
    ).rejects.toThrow(/aprovada pela equipe/);
  });
});

describe("remarcar: idempotência e proposta (rescheduleOfId)", () => {
  test("repetir o pedido de remarcação com a mesma chave devolve o novo agendamento (não erra)", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    const args = { organizationId: s.organizationId, appointmentId: old, startTime: at(11), idempotencyKey: "rs-1" };
    const first = await asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, args);
    const again = await asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, args);
    expect(again.appointmentId).toBe(first.appointmentId);
    expect(await allAppointments()).toHaveLength(2);
  });

  test("proposta da IA ignora as alocações do antigo e, ao aprovar, o antigo vira rescheduled na mesma mutation", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10), { leadId: s.leadId })).appointmentIds[0];
    const proposal = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10, 30), contactId: s.contacts[0],
      actor: { type: "ai", memberId: s.aiMemberId, conversationId: s.conversationId }, origin: "ai", rescheduleOfId: old,
    });
    expect(proposal).toMatchObject({ ok: true, status: "pending_approval" });
    const id = proposal.appointmentId!;
    expect((await appointmentOf(old))!.status).toBe("scheduled"); // o antigo segue ocupando até aprovar
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to: "scheduled" });
    const [o, n] = [(await appointmentOf(old))!, (await appointmentOf(id))!];
    expect(o).toMatchObject({ status: "rescheduled", rescheduledToId: id });
    expect(n).toMatchObject({ status: "scheduled", rescheduledFromId: old, icalSequence: 1 });
    expect(await allocationsOf(old)).toHaveLength(0);
    expect(await allocationsOf(id)).toHaveLength(1);
  });

  test("proposta de remarcação não nasce aprovada", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    await expect(
      t.mutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(14), contactId: s.contacts[0], actor: { type: "human", memberId: s.admin.memberId },
        origin: "staff", rescheduleOfId: old, initialStatus: "scheduled",
      })
    ).rejects.toThrow(/aguardando aprovação/);
  });
});

describe("cancelar", () => {
  const cancel = (s: Seed, appointmentId: Id<"schedAppointments">, extra: Record<string, unknown> = {}) =>
    asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId, ...extra } as never);

  test("libera a vaga na mesma transação e registra quem cancelou", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10), { leadId: s.leadId });
    await rulesError(book(s, "solo", at(10), { contactId: s.contacts[1] }));
    expect(await cancel(s, first.appointmentIds[0], { reason: "Cliente viajou" })).toBeNull();
    const appt = (await appointmentOf(first.appointmentIds[0]))!;
    expect(appt).toMatchObject({ status: "cancelled", cancelledByClass: "staff", cancelReason: "Cliente viajou" });
    expect(await allocationsOf(appt._id)).toHaveLength(0);
    const again = await book(s, "solo", at(10), { contactId: s.contacts[1] });
    expect(again.appointmentIds).toHaveLength(1);
  });

  test("cancelamento tardio marca lateCancel (só marca, nunca impede)", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.patch(s.services.solo, { lateCancelWindowMin: 24 * 60 * 4 }));
    const first = await book(s, "solo", at(10));
    await cancel(s, first.appointmentIds[0]);
    expect((await appointmentOf(first.appointmentIds[0]))!.lateCancel).toBe(true);
  });

  test("a equipe pode registrar que o cliente cancelou", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.patch(s.services.solo, { clientCanCancel: false }));
    const first = await book(s, "solo", at(10));
    await cancel(s, first.appointmentIds[0], { cancelledBy: "client" });
    expect((await appointmentOf(first.appointmentIds[0]))!.cancelledByClass).toBe("client");
  });

  test("o link público/cliente respeita clientCanCancel (política do serviço)", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.patch(s.services.solo, { clientCanCancel: false }));
    const first = await book(s, "solo", at(10));
    const err = await rulesError(
      t.mutation(internal.schedulingMutations.internalCancelAppointment, {
        organizationId: s.organizationId, appointmentId: first.appointmentIds[0], actor: { type: "system", via: "public_link" }, byClass: "client",
      })
    );
    expect(err.violations.map((v) => v.code)).toEqual(["CLIENT_CANNOT_CANCEL"]);
    expect(err.violations[0].message).toBe("Esse horário não está disponível.");
    expect((await appointmentOf(first.appointmentIds[0]))!.status).toBe("scheduled");
  });
});

describe("status", () => {
  const setStatus = (s: Seed, appointmentId: Id<"schedAppointments">, to: string) =>
    asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId, to } as never);

  test("fluxo: aprovar proposta da IA, confirmar, check-in e concluir", async () => {
    const s = await seedOrg();
    const created = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[0], leadId: s.leadId,
      actor: { type: "ai", memberId: s.aiMemberId, conversationId: s.conversationId }, origin: "ai",
    });
    expect(created).toMatchObject({ ok: true, status: "pending_approval", created: true });
    const id = created.appointmentId!;
    expect(await allocationsOf(id)).toHaveLength(1); // pending_approval ocupa o horário
    await setStatus(s, id, "scheduled");
    expect(await appointmentOf(id)).toMatchObject({ status: "scheduled", approvedBy: s.admin.memberId });
    await setStatus(s, id, "confirmed");
    await setStatus(s, id, "checked_in");
    await setStatus(s, id, "completed");
    const done = (await appointmentOf(id))!;
    expect(done).toMatchObject({ status: "completed" });
    expect(done.clientConfirmedAt).toBeDefined();
    expect(done.checkedInAt).toBeDefined();
    expect(done.completedAt).toBeDefined();
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", s.leadId)).collect());
    expect(acts.map((a) => a.type)).toEqual(expect.arrayContaining(["appointment_booked", "appointment_changed", "appointment_completed"]));
    await expect(setStatus(s, id, "confirmed")).rejects.toThrow(/não permitida/);
  });

  test("falta só com now >= início e libera a vaga; nunca antes", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await expect(setStatus(s, id, "no_show")).rejects.toThrow(/depois do horário/);
    vi.setSystemTime(at(10, 30));
    await setStatus(s, id, "no_show");
    expect(await appointmentOf(id)).toMatchObject({ status: "no_show" });
    expect(await allocationsOf(id)).toHaveLength(0);
  });
});

describe("desfazer (pela auditoria)", () => {
  const undo = (s: Seed, appointmentId: Id<"schedAppointments">) =>
    asAdmin(s).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.organizationId, appointmentId });
  const cancel = (s: Seed, appointmentId: Id<"schedAppointments">) =>
    asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId });

  test("desfazer cancelamento recria a vaga pela checagem de capacidade", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await cancel(s, id);
    expect(await undo(s, id)).toEqual({ restoredTo: "scheduled" });
    const restored = (await appointmentOf(id))!;
    expect(restored.status).toBe("scheduled");
    expect(restored.cancelledAt).toBeUndefined();
    expect(restored.cancelledByClass).toBeUndefined();
    expect(await allocationsOf(id)).toHaveLength(1);
  });

  test("desfazer cancelamento com o horário já tomado devolve erro com alternativas e nada muda", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await cancel(s, id);
    await book(s, "solo", at(10), { contactId: s.contacts[1] });
    const before = await counts();
    const err = await rulesError(undo(s, id));
    expect(err.violations.map((v) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect(err.alternatives.length).toBeGreaterThan(0);
    expect((await appointmentOf(id))!.status).toBe("cancelled");
    expect(await counts()).toEqual(before);
    expect(await allAllocations()).toHaveLength(1);
  });

  test("desfazer falta volta ao estado anterior e recria a alocação", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to: "confirmed" });
    vi.setSystemTime(at(10, 30));
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to: "no_show" });
    expect(await undo(s, id)).toEqual({ restoredTo: "confirmed" });
    const appt = (await appointmentOf(id))!;
    expect(appt.status).toBe("confirmed");
    expect(appt.noShowAt).toBeUndefined();
    expect(await allocationsOf(id)).toHaveLength(1);
  });

  test("desfazer concluir limpa os carimbos intermediários; o desfazer é auditado com undo:true", async () => {
    const s = await seedOrg();
    const id = (await book(s, "solo", at(10))).appointmentIds[0];
    const setStatus = (to: string) => asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to } as never);
    await setStatus("confirmed");
    await setStatus("checked_in");
    await setStatus("completed");
    expect(await undo(s, id)).toEqual({ restoredTo: "checked_in" });
    expect((await appointmentOf(id))!.completedAt).toBeUndefined();
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", id)).collect());
    expect(audits.some((a) => a.metadata?.undo === true)).toBe(true);
  });

  test("não há o que desfazer em agendamento novo nem em remarcado", async () => {
    const s = await seedOrg();
    const id = (await book(s, "solo", at(10))).appointmentIds[0];
    await expect(undo(s, id)).rejects.toThrow(/Não há o que desfazer/);
    const { appointmentId: next } = await asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId: id, startTime: at(14) });
    await expect(undo(s, id)).rejects.toThrow(/Não há o que desfazer/);
    expect(next).toBeDefined();
  });

  test("a IA não desfaz (só a equipe)", async () => {
    const s = await seedOrg();
    const id = (await book(s, "solo", at(10))).appointmentIds[0];
    await cancel(s, id);
    await expect(
      t.mutation(internal.schedulingMutations.internalUndoAppointmentStatus, {
        organizationId: s.organizationId, appointmentId: id, actor: { type: "ai", memberId: s.aiMemberId, conversationId: s.conversationId },
      })
    ).rejects.toThrow(/Não há o que desfazer/);
  });
});

describe("trocar sala", () => {
  const reassign = (s: Seed, appointmentId: Id<"schedAppointments">, resourceIds: Id<"schedResources">[], extra: Record<string, unknown> = {}) =>
    asAdmin(s).mutation(api.schedulingMutations.reassignResources, { organizationId: s.organizationId, appointmentId, resourceIds, ...extra } as never);

  test("troca de recurso na mesma transação; sala cheia recusa e mantém a alocação antiga", async () => {
    const s = await seedOrg();
    const { p1, sala1, sala2 } = s.resources;
    const a = (await book(s, "sessao", at(10), { resourceIds: [p1, sala1] })).appointmentIds[0];
    await book(s, "sessao", at(10), { contactId: s.contacts[1], resourceIds: [s.resources.p2, sala2], allowResourceFallback: false });
    const before = await counts();
    await rulesError(reassign(s, a, [p1, sala2]));
    expect(await counts()).toEqual(before);
    expect((await allocationsOf(a)).map((r) => r.resourceId).sort()).toEqual([p1, sala1].sort());
    // Sala livre: troca.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("schedAllocations").collect()) if (r.resourceId === sala2) await ctx.db.delete(r._id);
    });
    expect(await reassign(s, a, [p1, sala2])).toBeNull();
    expect((await allocationsOf(a)).map((r) => r.resourceId).sort()).toEqual([p1, sala2].sort());
    expect((await appointmentOf(a))!.resources.map((r) => r.resourceId)).toEqual([p1, sala2]);
  });

  test("recurso que não atende o requisito é recusado", async () => {
    const s = await seedOrg();
    const a = (await book(s, "sessao", at(10), { resourceIds: [s.resources.p1, s.resources.sala1] })).appointmentIds[0];
    const err = await rulesError(reassign(s, a, [s.resources.p1, s.resources.p2]));
    expect(err.violations.map((v) => v.code)).toContain("WRONG_ORG_OR_INACTIVE");
  });
});

// ---------------------------------------------------------------------------
// IA e link público: nunca forçam, mensagens sem dados de terceiros
// ---------------------------------------------------------------------------

describe("origem IA e link público", () => {
  const aiActor = (s: Seed) => ({ type: "ai" as const, memberId: s.aiMemberId, conversationId: s.conversationId });
  const aiBook = (s: Seed, extra: Record<string, unknown> = {}) =>
    t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[0], actor: aiActor(s), origin: "ai", ...extra,
    } as never);

  test("a IA nunca força: o aviso de horário bloqueia mesmo com force", async () => {
    const s = await seedOrg();
    const result = await aiBook(s, { startTime: at(19), force: ["OUTSIDE_HOURS"] });
    expect(result.ok).toBe(false);
    expect(result.violations.find((v) => v.code === "OUTSIDE_HOURS")?.severity).toBe("block");
    expect(await allAppointments()).toHaveLength(0);
  });

  test("o link público (sistema) nunca força, mesmo declarando origem de equipe", async () => {
    const s = await seedOrg();
    const result = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(19), contactId: s.contacts[0],
      actor: { type: "system", via: "public_link" }, origin: "public", force: ["OUTSIDE_HOURS"],
    });
    expect(result.ok).toBe(false);
    expect(await allAppointments()).toHaveLength(0);
  });

  test("mensagens para IA não citam nome de recurso nem de terceiro", async () => {
    const s = await seedOrg();
    await book(s, "solo", at(10), { contactId: s.contacts[1] }); // Bia ocupa o horário
    const result = await aiBook(s);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result.violations);
    expect(text).not.toMatch(/Profissional|Sala|Bia|Teste/);
    expect(result.violations.every((v) => v.detail === undefined)).toBe(true);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  test("IA nasce pending_approval; initialStatus 'scheduled' só vale com 'auto' + aceite", async () => {
    const s = await seedOrg();
    const propose = await aiBook(s, { initialStatus: "scheduled" });
    expect(propose.status).toBe("pending_approval");
    await t.run((ctx) =>
      ctx.db.insert("schedSettings", { organizationId: s.organizationId, ai: { book: "auto", autoAck: { by: s.admin.memberId, at: NOW }, firstVisitNeedsApproval: false }, updatedAt: NOW })
    );
    const auto = await aiBook(s, { serviceId: s.services.dupla, startTime: at(14), initialStatus: "scheduled" });
    expect(auto.status).toBe("scheduled");
  });

  test("firstVisitNeedsApproval é aplicado NA PORTA: primeira visita fica pending_approval mesmo em auto", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, ai: { book: "auto", autoAck: { by: s.admin.memberId, at: NOW } }, updatedAt: NOW }));
    const first = await aiBook(s, { initialStatus: "scheduled" });
    expect(first.status).toBe("pending_approval");
    // Com um atendimento concluído antes, o contato deixa de ser primeira visita.
    await t.run((ctx) =>
      ctx.db.insert("schedAppointments", {
        organizationId: s.organizationId, serviceId: s.services.solo, serviceName: "Consulta", kind: "normal", startTime: at(10, 0, 8), endTime: at(11, 0, 8),
        blockStart: at(10, 0, 8), blockEnd: at(11, 0, 8), localDate: "2026-06-08", status: "completed", origin: "staff", contactId: s.contacts[0], resources: [],
        statusChangedAt: NOW, createdAt: NOW, updatedAt: NOW,
      })
    );
    const returning = await aiBook(s, { serviceId: s.services.dupla, startTime: at(14), initialStatus: "scheduled" });
    expect(returning.status).toBe("scheduled");
  });

  test("link público nunca nasce scheduled, nem com ai.book auto; origem fora da lista do ator é recusada", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, ai: { book: "auto", autoAck: { by: s.admin.memberId, at: NOW }, firstVisitNeedsApproval: false }, updatedAt: NOW }));
    const base = { organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[1], initialStatus: "scheduled" as const };
    const pub = await t.mutation(internal.schedulingMutations.internalBookAppointment, { ...base, actor: { type: "system", via: "public_link" }, origin: "public" });
    expect(pub.status).toBe("pending_approval");
    const bad = (origin: string, actor: unknown) =>
      t.mutation(internal.schedulingMutations.internalBookAppointment, { ...base, startTime: at(15), actor, origin } as never);
    await expect(bad("waitlist", { type: "system", via: "public_link" })).rejects.toThrow(/incompatível/);
    await expect(bad("staff", { type: "system", via: "public_link" })).rejects.toThrow(/incompatível/);
    await expect(bad("staff", { type: "system", via: "human_message" })).rejects.toThrow(/incompatível/);
    await expect(bad("ai", { type: "system", via: "job" })).rejects.toThrow(/incompatível/);
    await expect(bad("waitlist", aiActor(s))).rejects.toThrow(/incompatível/);
    await expect(bad("staff", aiActor(s))).rejects.toThrow(/incompatível/);
    await expect(bad("human_message", { type: "human", memberId: s.admin.memberId })).rejects.toThrow(/incompatível/);
  });

  test("conflictToQueue só com ator de sistema via human_message", async () => {
    const s = await seedOrg();
    await expect(aiBook(s, { conflictToQueue: true })).rejects.toThrow(/fila de conflitos/);
    await expect(
      t.mutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[0],
        actor: { type: "human", memberId: s.admin.memberId }, origin: "staff", conflictToQueue: true,
      })
    ).rejects.toThrow(/fila de conflitos/);
  });

  test("IA com marcação desligada, contato fora do comercial e origem incompatível são recusados", async () => {
    const s = await seedOrg();
    const off = await aiBook(s, { contactId: s.personalContactId });
    expect(off.ok).toBe(false);
    expect(off.violations[0].code).toBe("WRONG_ORG_OR_INACTIVE");
    await expect(aiBook(s, { origin: "staff" })).rejects.toThrow(/incompatível/);
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, ai: { book: "off" }, updatedAt: NOW }));
    await expect(aiBook(s)).rejects.toThrow(/desligada/);
    // A equipe marca para o mesmo contato fora do comercial sem problema.
    const ok = await book(s, "solo", at(10), { contactId: s.personalContactId });
    expect(ok.appointmentIds).toHaveLength(1);
  });

  test("IA: o ator precisa ser membro de IA da própria org e a conversa, da mesma org", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    await expect(aiBook(s, { actor: { type: "ai", memberId: s.admin.memberId, conversationId: s.conversationId } })).rejects.toThrow(/membro de IA/);
    await expect(aiBook(s, { actor: { type: "ai", memberId: s.aiMemberId, conversationId: f.conversationId } })).rejects.toThrow(/Conversa não encontrada/);
    await expect(aiBook(s, { actor: { type: "human", memberId: f.memberId } })).rejects.toThrow(/não encontrado nesta organização/);
  });

  test("limite diário da IA por contato e teto de ativos do serviço (só IA e link)", async () => {
    const s = await seedOrg();
    const first = await aiBook(s);
    expect(first.ok).toBe(true);
    const second = await aiBook(s, { startTime: at(14) });
    expect(second.ok).toBe(false);
    expect(second.violations.map((v) => v.code)).toContain("MAX_ACTIVE_PER_CONTACT");
    // Sem teto no serviço, a equipe marca um segundo horário futuro; com teto, vira aviso forçável.
    expect((await book(s, "solo", at(14))).appointmentIds).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(s.services.solo, { maxActivePerContact: 1 }));
    const warn = await rulesError(book(s, "solo", at(16)));
    expect(warn.violations.find((v) => v.code === "MAX_ACTIVE_PER_CONTACT")?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Isolamento entre orgs, RBAC, módulo
// ---------------------------------------------------------------------------

describe("isolamento entre organizações", () => {
  test("id de serviço, recurso, contato, lead ou conversa de outra org é recusado sem revelar existência", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    const deleted = await t.run(async (ctx) => {
      const id = await ctx.db.insert("schedServices", {
        organizationId: s.organizationId, name: "Apagado", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0,
        requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: NOW, updatedAt: NOW,
      });
      await ctx.db.delete(id);
      return id;
    });
    const before = await counts();
    await expect(book(s, "solo", at(10), { serviceId: f.serviceId })).rejects.toThrow("Serviço não encontrado");
    await expect(book(s, "solo", at(10), { serviceId: deleted })).rejects.toThrow("Serviço não encontrado"); // inexistente = estrangeiro
    await expect(book(s, "solo", at(10), { contactId: f.contactId })).rejects.toThrow("Contato não encontrado");
    await expect(book(s, "solo", at(10), { leadId: f.leadId })).rejects.toThrow("Lead não encontrado");
    await expect(book(s, "solo", at(10), { conversationId: f.conversationId })).rejects.toThrow("Conversa não encontrada");
    await expect(book(s, "solo", at(10), { resourceIds: [f.resourceId] })).rejects.toThrow("Recurso não encontrado");
    await expect(book(s, "dupla", at(10), { companions: [{ guestName: "X", resourceIds: [f.resourceId] }] })).rejects.toThrow("Recurso não encontrado");
    expect(await counts()).toEqual(before);
  });

  test("agendamento de outra org nunca é lido nem alterado, nas 5 mutations por id", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    const common = { organizationId: s.organizationId, appointmentId: f.appointmentId };
    const m = asAdmin(s).mutation;
    await expect(m(api.schedulingMutations.rescheduleAppointment, { ...common, startTime: at(14) })).rejects.toThrow("Agendamento não encontrado");
    await expect(m(api.schedulingMutations.cancelAppointment, common)).rejects.toThrow("Agendamento não encontrado");
    await expect(m(api.schedulingMutations.setAppointmentStatus, { ...common, to: "confirmed" })).rejects.toThrow("Agendamento não encontrado");
    await expect(m(api.schedulingMutations.undoAppointmentStatus, common)).rejects.toThrow("Agendamento não encontrado");
    await expect(m(api.schedulingMutations.reassignResources, { ...common, resourceIds: [s.resources.sala1] })).rejects.toThrow("Agendamento não encontrado");
    expect((await appointmentOf(f.appointmentId))!.status).toBe("scheduled");
  });

  test("membro de outra org não opera a org alheia", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    const before = await counts();
    await expect(as(f.userId).mutation(api.schedulingMutations.bookAppointment, bookArgs(s, "solo", at(10)) as never)).rejects.toThrow(/Not authorized/);
    await expect(as(f.userId).mutation(api.schedulingMutations.previewBooking, bookArgs(s, "solo", at(10)) as never)).rejects.toThrow(/Not authorized/);
    expect(await counts()).toEqual(before);
  });

  test("internas: agendamento e atores de outra org também são recusados", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    await expect(
      t.mutation(internal.schedulingMutations.internalCancelAppointment, {
        organizationId: s.organizationId, appointmentId: f.appointmentId, actor: { type: "system", via: "job" }, byClass: "system",
      })
    ).rejects.toThrow("Agendamento não encontrado");
    await expect(
      t.mutation(internal.schedulingMutations.internalSetAppointmentStatus, {
        organizationId: s.organizationId, appointmentId: (await book(s, "solo", at(10))).appointmentIds[0],
        actor: { type: "human", memberId: f.memberId }, to: "confirmed",
      })
    ).rejects.toThrow(/não encontrado nesta organização/);
  });
});

describe("permissões e módulo", () => {
  test("cada nível de agenda: none, view_own e view_all recusam; edit e manage passam", async () => {
    const s = await seedOrg();
    const id = (await book(s, "solo", at(10))).appointmentIds[0];
    const calls = (userId: Id<"users">, start: number) => {
      const m = as(userId).mutation;
      const org = s.organizationId;
      return [
        () => m(api.schedulingMutations.previewBooking, bookArgs(s, "solo", start) as never),
        () => m(api.schedulingMutations.bookAppointment, bookArgs(s, "solo", start) as never),
        () => m(api.schedulingMutations.rescheduleAppointment, { organizationId: org, appointmentId: id, startTime: start }),
        () => m(api.schedulingMutations.cancelAppointment, { organizationId: org, appointmentId: id }),
        () => m(api.schedulingMutations.setAppointmentStatus, { organizationId: org, appointmentId: id, to: "confirmed" }),
        () => m(api.schedulingMutations.undoAppointmentStatus, { organizationId: org, appointmentId: id }),
        () => m(api.schedulingMutations.reassignResources, { organizationId: org, appointmentId: id, resourceIds: [s.resources.p1] }),
      ];
    };
    for (const denied of [s.none, s.viewOwn, s.viewAll]) {
      for (const call of calls(denied.userId, at(15))) await expect(call()).rejects.toThrow("Permissão insuficiente");
    }
    expect(await allAppointments()).toHaveLength(1);
    // `agent` (default edit) marca; `admin` (manage) também.
    const ok = await as(s.agent.userId).mutation(api.schedulingMutations.bookAppointment, bookArgs(s, "solo", at(15), { contactId: s.contacts[1] }) as never);
    expect(ok.appointmentIds).toHaveLength(1);
    const okAdmin = await book(s, "solo", at(16), { contactId: s.contacts[2] });
    expect(okAdmin.appointmentIds).toHaveLength(1);
  });

  test("módulo desligado recusa toda escrita (públicas e internas)", async () => {
    const s = await seedOrg({ scheduling: false });
    await expect(book(s, "solo", at(10))).rejects.toThrow(/Módulo não habilitado/);
    await expect(asAdmin(s).mutation(api.schedulingMutations.previewBooking, bookArgs(s, "solo", at(10)) as never)).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      t.mutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), actor: { type: "system", via: "human_message" }, origin: "human_message",
      })
    ).rejects.toThrow(/Módulo não habilitado/);
    expect(await allAppointments()).toHaveLength(0);
  });

  test("o núcleo também confere o módulo (não depende da mutation)", async () => {
    const s = await seedOrg({ scheduling: false });
    await expect(
      t.run((ctx) =>
        bookAppointmentCore(ctx as never, {
          organizationId: s.organizationId, actor: { type: "system", via: "job" }, origin: "import", serviceId: s.services.solo, startTime: at(10), now: NOW,
        })
      )
    ).rejects.toThrow(/Módulo não habilitado/);
  });
});

// ---------------------------------------------------------------------------
// Efeitos
// ---------------------------------------------------------------------------

describe("efeitos de cada ato", () => {
  const seedWebhook = (s: Seed) =>
    t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.organizationId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
  const scheduledEvents = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => (f.args[0] as { event?: string } | undefined)?.event).filter((e): e is string => !!e)
    );

  test("marcar grava auditoria (antes/depois, sem texto), atividade com lead e nada sem lead", async () => {
    const s = await seedOrg();
    const withLead = await book(s, "solo", at(10), { leadId: s.leadId, notes: "texto interno" });
    const noLead = await book(s, "solo", at(14), { contactId: s.contacts[1] });
    const id = withLead.appointmentIds[0];
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", id)).collect());
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "create", severity: "medium", actorType: "human", actorId: s.admin.memberId });
    expect(audits[0].metadata).toMatchObject({ via: "app", origin: "staff", forcedRules: [] });
    expect(JSON.stringify(audits[0])).not.toContain("texto interno");
    expect((audits[0].changes?.after as { id: string }).id).toBe(id);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(acts.filter((a) => a.type === "appointment_booked")).toHaveLength(1);
    expect(acts[0]).toMatchObject({ leadId: s.leadId, actorType: "human" });
    expect(acts[0].content).toMatch(/Horário marcado: seg, 15\/06\/2026 às 10:00 \(Consulta\)/);
    expect(noLead.appointmentIds).toHaveLength(1);
  });

  test("webhook só é agendado com webhook ativo semeado; cancelar e concluir emitem os seus", async () => {
    const s = await seedOrg();
    await book(s, "solo", at(9)); // sem webhook: nada agendado
    expect(await scheduledEvents()).toEqual([]);
    await seedWebhook(s);
    const a = (await book(s, "solo", at(10), { contactId: undefined, leadId: s.leadId })).appointmentIds[0];
    const b = (await book(s, "solo", at(14), { contactId: s.contacts[2] })).appointmentIds[0];
    const m = asAdmin(s).mutation;
    await m(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: a, to: "confirmed" });
    await m(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: a, to: "completed" });
    await m(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: b });
    await m(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId: (await book(s, "solo", at(16))).appointmentIds[0], startTime: at(17) });
    const events = await scheduledEvents();
    expect(events).toEqual(expect.arrayContaining(["appointment.created", "appointment.confirmed", "appointment.completed", "appointment.cancelled", "appointment.rescheduled"]));
  });

  test("payload do webhook: ISO com offset, sem telefone, e-mail nem notas", async () => {
    const s = await seedOrg();
    await seedWebhook(s);
    await book(s, "solo", at(10), { leadId: s.leadId, notes: "nota privada" });
    const fn = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())[0]);
    const payload = (fn.args[0] as { payload: Record<string, unknown>; event: string }).payload;
    expect(payload).toMatchObject({ status: "scheduled", origin: "staff", serviceName: "Consulta", startsAt: "2026-06-15T10:00:00-03:00", startsAtLocal: "2026-06-15T10:00", timezone: "America/Sao_Paulo" });
    expect(payload.resources).toEqual([{ name: "Profissional Um", role: "Profissional" }]);
    expect(JSON.stringify(payload)).not.toContain("nota privada");
  });

  test("etapa do funil: move o lead pela porta única ao marcar", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, funnel: { onScheduledStageId: s.scheduledStageId }, updatedAt: NOW }));
    await book(s, "solo", at(10), { leadId: s.leadId });
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))!.stageId).toBe(s.scheduledStageId);
    const moves = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(moves.some((a) => a.action === "move" && a.metadata?.via === "scheduling")).toBe(true);
  });

  test("etapa inválida (de outro funil, apagada ou de perda) NÃO derruba a marcação", async () => {
    for (const makeStage of [
      async (s: Seed) => s.otherBoardStageId,
      async (s: Seed) =>
        t.run(async (ctx) => {
          const id = await ctx.db.insert("stages", { organizationId: s.organizationId, boardId: s.boardId, name: "Tmp", color: "#000", order: 9, isClosedWon: false, isClosedLost: false, createdAt: NOW, updatedAt: NOW });
          await ctx.db.delete(id);
          return id;
        }),
      async (s: Seed) =>
        t.run((ctx) => ctx.db.insert("stages", { organizationId: s.organizationId, boardId: s.boardId, name: "Perdido", color: "#000", order: 8, isClosedWon: false, isClosedLost: true, createdAt: NOW, updatedAt: NOW })),
    ]) {
      t = convexTest(schema, modules);
      const s = await seedOrg();
      const stageId = await makeStage(s);
      await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, funnel: { onScheduledStageId: stageId }, updatedAt: NOW }));
      const result = await book(s, "solo", at(10), { leadId: s.leadId });
      const appt = (await appointmentOf(result.appointmentIds[0]))!;
      expect(appt.status).toBe("scheduled");
      expect(appt.needsAttention?.code).toBe("stage_move_failed");
      expect(await allocationsOf(appt._id)).toHaveLength(1);
      expect((await t.run((ctx) => ctx.db.get(s.leadId)))!.stageId).toBe(s.stageId);
    }
  });

  test("concluir move para a etapa de concluído; lead já na etapa não é movido de novo", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, funnel: { onCompletedStageId: s.scheduledStageId }, updatedAt: NOW }));
    const id = (await book(s, "solo", at(10), { leadId: s.leadId })).appointmentIds[0];
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))!.stageId).toBe(s.stageId);
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to: "completed" });
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))!.stageId).toBe(s.scheduledStageId);
    const moves = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === "move");
    expect(moves).toHaveLength(1);
  });

  test("internas gravam o ator explícito na auditoria (IA = ai; REST = api)", async () => {
    const s = await seedOrg();
    const ai = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[0],
      actor: { type: "ai", memberId: s.aiMemberId, conversationId: s.conversationId }, origin: "ai",
    });
    const rest = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(14), contactId: s.contacts[1],
      actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api",
    });
    const audit = async (id: Id<"schedAppointments">) =>
      (await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", id)).collect()))[0];
    expect(await audit(ai.appointmentId!)).toMatchObject({ actorType: "ai", actorId: s.aiMemberId });
    expect((await audit(ai.appointmentId!)).metadata).toMatchObject({ via: "attendant", origin: "ai" });
    expect(await audit(rest.appointmentId!)).toMatchObject({ actorType: "api" });
    expect((await audit(rest.appointmentId!)).metadata).toMatchObject({ via: "rest" });
  });
});

// ---------------------------------------------------------------------------
// `returns` (o convex-test não valida)
// ---------------------------------------------------------------------------

describe("o que cada mutation devolve bate com o validator de retorno", () => {
  test("públicas", async () => {
    const s = await seedOrg();
    const m = asAdmin(s).mutation;
    const org = s.organizationId;
    expectMatches(M.bookResultValidator, await m(api.schedulingMutations.previewBooking, bookArgs(s, "sessao", at(10)) as never));
    expectMatches(M.bookResultValidator, await m(api.schedulingMutations.previewBooking, bookArgs(s, "solo", at(19)) as never)); // falha de regra
    const booked = await m(api.schedulingMutations.bookAppointment, bookArgs(s, "solo", at(10), { leadId: s.leadId }) as never);
    expectMatches(M.bookReturnValidator, booked);
    expectMatches(M.bookReturnValidator, await m(api.schedulingMutations.bookAppointment, bookArgs(s, "dupla", at(10), { contactId: s.contacts[1], companions: [{ guestName: "G" }] }) as never));
    const id = booked.appointmentIds[0];
    expectMatches(M.rescheduleReturnValidator, await m(api.schedulingMutations.rescheduleAppointment, { organizationId: org, appointmentId: id, startTime: at(11) }));
    const moved = (await allAppointments()).find((a) => a.status === "scheduled" && a.startTime === at(11))!;
    expect(await m(api.schedulingMutations.setAppointmentStatus, { organizationId: org, appointmentId: moved._id, to: "confirmed" })).toBeNull();
    expect(await m(api.schedulingMutations.cancelAppointment, { organizationId: org, appointmentId: moved._id })).toBeNull();
    expectMatches(M.undoReturnValidator, await m(api.schedulingMutations.undoAppointmentStatus, { organizationId: org, appointmentId: moved._id }));
    expect(await m(api.schedulingMutations.reassignResources, { organizationId: org, appointmentId: moved._id, resourceIds: [s.resources.p1] })).toBeNull();
  });

  test("internas", async () => {
    const s = await seedOrg();
    const org = s.organizationId;
    const staff = { type: "human" as const, memberId: s.admin.memberId };
    const booked = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: org, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[0], actor: staff, origin: "staff",
    });
    expectMatches(M.bookResultValidator, booked);
    expectMatches(M.bookResultValidator, await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: org, serviceId: s.services.solo, startTime: at(10), contactId: s.contacts[1], actor: staff, origin: "staff", mode: "preview",
    }));
    const id = booked.appointmentId!;
    const rs = await t.mutation(internal.schedulingMutations.internalRescheduleAppointment, { organizationId: org, appointmentId: id, actor: staff, startTime: at(11) });
    expectMatches(M.bookResultValidator, rs);
    const next = rs.appointmentId!;
    expectMatches(M.bookResultValidator, await t.mutation(internal.schedulingMutations.internalReassignResources, { organizationId: org, appointmentId: next, actor: staff, resourceIds: [s.resources.p1] }));
    expect(await t.mutation(internal.schedulingMutations.internalSetAppointmentStatus, { organizationId: org, appointmentId: next, actor: staff, to: "confirmed" })).toBeNull();
    expectMatches(M.cancelResultValidator, await t.mutation(internal.schedulingMutations.internalCancelAppointment, { organizationId: org, appointmentId: next, actor: staff, byClass: "staff" }));
    expectMatches(M.undoResultValidator, await t.mutation(internal.schedulingMutations.internalUndoAppointmentStatus, { organizationId: org, appointmentId: next, actor: staff }));
    // Falha do desfazer também bate com o validator.
    await t.mutation(internal.schedulingMutations.internalCancelAppointment, { organizationId: org, appointmentId: next, actor: staff, byClass: "staff" });
    await book(s, "solo", at(11), { contactId: s.contacts[2] });
    const failed = await t.mutation(internal.schedulingMutations.internalUndoAppointmentStatus, { organizationId: org, appointmentId: next, actor: staff });
    expect(failed.ok).toBe(false);
    expectMatches(M.undoResultValidator, failed);
  });

  test("o auxiliar detecta campo a mais e campo obrigatório ausente (controle negativo)", () => {
    expect(matchesValidator(M.rescheduleReturnValidator, { appointmentId: "x", extra: 1 })).not.toEqual([]);
    expect(matchesValidator(M.bookReturnValidator, { appointmentIds: [] })).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Revisão adversarial (PR #177): regressões das sondagens
// ---------------------------------------------------------------------------

describe("revisão: proposta de remarcação (rescheduleOfId)", () => {
  const aiActorOf = (s: Seed) => ({ type: "ai" as const, memberId: s.aiMemberId, conversationId: s.conversationId });
  const propose = (s: Seed, oldId: Id<"schedAppointments">, startTime: number, extra: Record<string, unknown> = {}) =>
    t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime, contactId: s.contacts[0], actor: aiActorOf(s), origin: "ai", rescheduleOfId: oldId, ...extra,
    } as never);
  const setStatus = (s: Seed, id: Id<"schedAppointments">, to: string) =>
    asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to } as never);
  const p1Rows = (s: Seed) => t.run(async (ctx) => (await ctx.db.query("schedAllocations").collect()).filter((r) => r.resourceId === s.resources.p1));

  test("B1: rescheduleOfId de OUTRO contato é recusado (bloqueio duro, resposta genérica) e nada muda", async () => {
    const s = await seedOrg();
    const bia = (await book(s, "solo", at(10), { contactId: s.contacts[1] })).appointmentIds[0];
    const r = await propose(s, bia, at(10), { contactId: undefined });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual(["WRONG_ORG_OR_INACTIVE"]);
    expect(r.violations[0].severity).toBe("block");
    expect(r.violations[0].message).toBe("Esse horário não está disponível.");
    expect(await p1Rows(s)).toHaveLength(1);
    expect((await appointmentOf(bia))!.status).toBe("scheduled");
    expect(await allAppointments()).toHaveLength(1);
  });

  test("B1: a equipe também não pode apontar para agendamento de outro contato, de outro serviço, concluído ou já remarcado", async () => {
    const s = await seedOrg();
    const staff = { type: "human" as const, memberId: s.admin.memberId };
    const call = (oldId: Id<"schedAppointments">, extra: Record<string, unknown> = {}) =>
      t.mutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(15), contactId: s.contacts[0], actor: staff, origin: "staff", rescheduleOfId: oldId, ...extra,
      } as never);
    const bia = (await book(s, "solo", at(10), { contactId: s.contacts[1] })).appointmentIds[0];
    const ana = (await book(s, "solo", at(11))).appointmentIds[0];
    expect((await call(bia)).ok).toBe(false); // outro contato
    expect((await call(ana, { serviceId: s.services.dupla })).ok).toBe(false); // outro serviço
    await setStatus(s, ana, "completed");
    expect((await call(ana)).ok).toBe(false); // concluído
    const f = await seedForeign();
    await expect(call(f.appointmentId)).rejects.toThrow("Agendamento não encontrado"); // de outra org
    expect((await appointmentOf(f.appointmentId))!.status).toBe("scheduled");
  });

  test("D1: aprovar proposta com o antigo já em check-in é RECUSADO e a proposta segue pendente", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10), { leadId: s.leadId })).appointmentIds[0];
    const prop = await propose(s, old, at(10, 30));
    await setStatus(s, old, "checked_in");
    await expect(setStatus(s, prop.appointmentId!, "scheduled")).rejects.toThrow(/não vale mais: o horário original já mudou/);
    expect((await appointmentOf(prop.appointmentId!))!.status).toBe("pending_approval");
    expect((await appointmentOf(old))!.status).toBe("checked_in");
    // A equipe recusa (cancela) a proposta e a vaga dela some.
    await asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: prop.appointmentId! });
    expect(await allocationsOf(prop.appointmentId!)).toHaveLength(0);
  });

  test("D1: duas propostas para o mesmo antigo: só a primeira aprovada vale, a segunda é recusada", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    const a = await propose(s, old, at(14));
    // A IA tem teto de 1 ativo por serviço; a segunda proposta vem da equipe.
    const b = await propose(s, old, at(15), { actor: { type: "human", memberId: s.admin.memberId }, origin: "staff" });
    expect(b.appointmentId).toBeDefined();
    await setStatus(s, a.appointmentId!, "scheduled");
    await expect(setStatus(s, b.appointmentId!, "scheduled")).rejects.toThrow(/não vale mais/);
    expect((await allAppointments()).filter((x) => x.status === "scheduled")).toHaveLength(1);
  });

  test("D1b: aprovar proposta cujo horário já passou é recusado como vencida", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    const prop = await propose(s, old, at(14));
    vi.setSystemTime(at(16));
    await expect(setStatus(s, prop.appointmentId!, "scheduled")).rejects.toThrow(/proposta venceu/);
    expect((await appointmentOf(old))!.status).toBe("scheduled");
    expect((await appointmentOf(prop.appointmentId!))!.status).toBe("pending_approval");
  });

  test("D2: remarcar uma proposta é recusado (aprove ou recuse antes)", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    const prop = await propose(s, old, at(14));
    await expect(
      asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId: prop.appointmentId!, startTime: at(15) })
    ).rejects.toThrow(/Aprove ou recuse a proposta/);
    expect((await allAppointments()).filter((a) => a.contactId === s.contacts[0] && a.status !== "cancelled")).toHaveLength(2);
  });

  test("D4: aprovar proposta audita o antigo, registra atividade no lead e emite appointment.rescheduled com previousAppointmentId", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.organizationId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
    const old = (await book(s, "solo", at(10), { leadId: s.leadId })).appointmentIds[0];
    const prop = await propose(s, old, at(14));
    await setStatus(s, prop.appointmentId!, "scheduled");
    const oldAudit = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", old)).collect());
    const last = oldAudit.at(-1)!;
    expect(last.metadata).toMatchObject({ statusChange: true, rescheduledToId: prop.appointmentId });
    expect(last.changes).toMatchObject({ before: { status: "scheduled" }, after: { status: "rescheduled" } });
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", s.leadId)).collect());
    expect(acts.some((a) => a.type === "appointment_changed" && /remarcado/i.test(a.content ?? ""))).toBe(true);
    const fns = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.args[0] as { event?: string; payload?: { previousAppointmentId?: string } }));
    const resched = fns.find((f) => f.event === "appointment.rescheduled");
    expect(resched?.payload?.previousAppointmentId).toBe(old);
  });

  test("D4: remarcar direto também audita o agendamento antigo (statusChange, antes/depois)", async () => {
    const s = await seedOrg();
    const old = (await book(s, "solo", at(10))).appointmentIds[0];
    await asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId: old, startTime: at(11) });
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", old)).collect());
    const last = logs.at(-1)!;
    expect(last).toMatchObject({ action: "update", severity: "medium" });
    expect(last.metadata?.statusChange).toBe(true);
    expect(last.changes).toMatchObject({ before: { status: "scheduled" }, after: { status: "rescheduled" } });
  });

  test("D3: chave de idempotência de OUTRO agendamento não vale para remarcar nem para reservar com outros dados", async () => {
    const s = await seedOrg();
    const ana = (await book(s, "solo", at(10))).appointmentIds[0];
    const bia = (await book(s, "solo", at(14), { contactId: s.contacts[1], idempotencyKey: "rest:1" })).appointmentIds[0];
    await expect(
      asAdmin(s).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.organizationId, appointmentId: ana, startTime: at(11), idempotencyKey: "rest:1" })
    ).rejects.toThrow("Esta chave de idempotência já foi usada com outros dados.");
    expect((await appointmentOf(ana))!.status).toBe("scheduled");
    await expect(book(s, "solo", at(14), { contactId: s.contacts[2], idempotencyKey: "rest:1" })).rejects.toThrow("Esta chave de idempotência já foi usada com outros dados.");
    expect(bia).toBeDefined();
    expect(await allAppointments()).toHaveLength(2);
  });
});

describe("revisão: IA presa à conversa do ator (D7)", () => {
  const ai = (s: Seed) => ({ type: "ai" as const, memberId: s.aiMemberId, conversationId: s.conversationId });
  test("cancelar, remarcar, mudar status e trocar recurso de agendamento de OUTRO contato dão 'não encontrado'", async () => {
    const s = await seedOrg();
    const bia = (await book(s, "solo", at(10), { contactId: s.contacts[1] })).appointmentIds[0];
    const org = s.organizationId;
    const calls = [
      () => t.mutation(internal.schedulingMutations.internalCancelAppointment, { organizationId: org, appointmentId: bia, actor: ai(s), byClass: "ai" }),
      () => t.mutation(internal.schedulingMutations.internalRescheduleAppointment, { organizationId: org, appointmentId: bia, actor: ai(s), startTime: at(14) }),
      () => t.mutation(internal.schedulingMutations.internalSetAppointmentStatus, { organizationId: org, appointmentId: bia, actor: ai(s), to: "confirmed" }),
      () => t.mutation(internal.schedulingMutations.internalReassignResources, { organizationId: org, appointmentId: bia, actor: ai(s), resourceIds: [s.resources.p1] }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow("Agendamento não encontrado");
    expect((await appointmentOf(bia))!.status).toBe("scheduled");
  });

  test("o agendamento da PRÓPRIA conversa a IA cancela normalmente", async () => {
    const s = await seedOrg();
    const own = (await book(s, "solo", at(10), { leadId: s.leadId })).appointmentIds[0];
    await t.mutation(internal.schedulingMutations.internalCancelAppointment, { organizationId: s.organizationId, appointmentId: own, actor: ai(s), byClass: "ai" });
    expect(await appointmentOf(own)).toMatchObject({ status: "cancelled", cancelledByClass: "ai" });
  });
});

describe("revisão: compromissos internos (teto de leitura)", () => {
  const seedEvents = (s: Seed, n: number, startMin: number) =>
    t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("calendarEvents", {
          organizationId: s.organizationId, title: `e${i}`, eventType: "meeting", startTime: at(0, startMin + (i % 5)), endTime: at(0, startMin + (i % 5) + 5),
          allDay: false, status: "scheduled", createdBy: s.admin.memberId, assignedTo: s.admin.memberId, createdAt: NOW, updatedAt: NOW,
        });
      }
    });

  test("agenda interna acima do teto: nunca vira 'livre' (unificado com a busca: aviso 'não foi possível verificar')", async () => {
    const s = await seedOrg();
    await seedEvents(s, 305, 120); // madrugada de segunda: longe do bloco das 10h
    await t.run((ctx) =>
      ctx.db.insert("calendarEvents", {
        organizationId: s.organizationId, title: "sobrepõe", eventType: "meeting", startTime: at(10, 15), endTime: at(10, 45),
        allDay: false, status: "scheduled", createdBy: s.admin.memberId, assignedTo: s.admin.memberId, createdAt: NOW, updatedAt: NOW,
      })
    );
    const err = await rulesError(book(s, "solo", at(10)));
    const v = err.violations.find((x) => x.code === "INTERNAL_EVENT_OVERLAP");
    expect(v?.severity).toBe("warn");
    expect(v?.message).toMatch(/Não foi possível verificar os compromissos internos/);
  });

  test("agenda interna acima do teto sem sobreposição visível: vira aviso 'não foi possível verificar', nunca livre em silêncio", async () => {
    const s = await seedOrg();
    await seedEvents(s, 305, 120);
    const err = await rulesError(book(s, "solo", at(10)));
    const v = err.violations.find((x) => x.code === "INTERNAL_EVENT_OVERLAP");
    expect(v?.severity).toBe("warn");
    expect(v?.message).toMatch(/Não foi possível verificar/);
    const ok = await book(s, "solo", at(10), { force: ["INTERNAL_EVENT_OVERLAP"] });
    expect(ok.appointmentIds).toHaveLength(1);
  });
});

describe("revisão: desfazer preserva o retrato e explica o recurso inativo", () => {
  const undo = (s: Seed, id: Id<"schedAppointments">) => asAdmin(s).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.organizationId, appointmentId: id });
  const cancel = (s: Seed, id: Id<"schedAppointments">) => asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: id });

  test("recurso inativo: mensagem diz isso (não 'horário ocupado')", async () => {
    const s = await seedOrg();
    const id = (await book(s, "solo", at(10))).appointmentIds[0];
    await cancel(s, id);
    await t.run((ctx) => ctx.db.patch(s.resources.p1, { active: false }));
    const err = await rulesError(undo(s, id));
    expect(err.violations[0].code).toBe("WRONG_ORG_OR_INACTIVE");
    expect(err.violations[0].message).toMatch(/desativado ou removido/);
    expect((await appointmentOf(id))!.status).toBe("cancelled");
  });

  test("exclusividade e unidades vêm do retrato gravado ao cancelar, não do serviço atual", async () => {
    const s = await seedOrg();
    const ex = (await book(s, "exclusiva", at(10))).appointmentIds[0];
    await cancel(s, ex);
    await t.run((ctx) => ctx.db.patch(s.services.exclusiva, { requirements: [{ role: "Sala", kind: "room", resourceIds: [s.resources.dupla] }] }));
    await undo(s, ex);
    expect((await allocationsOf(ex))[0]).toMatchObject({ units: 2, exclusive: true });
    // Outro caso: unidades 1 gravadas; o serviço passa a exigir 2.
    const one = (await book(s, "dupla", at(14))).appointmentIds[0];
    await cancel(s, one);
    await t.run((ctx) => ctx.db.patch(s.services.dupla, { requirements: [{ role: "Sala", kind: "room", resourceIds: [s.resources.dupla], units: 2 }] }));
    await undo(s, one);
    expect((await allocationsOf(one))[0].units).toBe(1);
  });

  test("falta também grava o retrato para o desfazer", async () => {
    const s = await seedOrg();
    const id = (await book(s, "exclusiva", at(10))).appointmentIds[0];
    vi.setSystemTime(at(10, 30));
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to: "no_show" });
    await undo(s, id);
    expect((await allocationsOf(id))[0]).toMatchObject({ units: 2, exclusive: true });
  });
});

describe("revisão: conflictToQueue com dois recursos", () => {
  test("terapeuta livre é alocado, sala cheia fica de fora e ninguém passa da capacidade", async () => {
    const s = await seedOrg();
    const { p1, sala1, sala2 } = s.resources;
    await book(s, "duasSalas", at(10), { resourceIds: [sala1, sala2] }); // as duas salas ocupadas
    const result = await t.run((ctx) =>
      bookAppointmentCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "system", via: "human_message" }, origin: "human_message", serviceId: s.services.sessao,
        startTime: at(10), contactId: s.contacts[2], initialStatus: "scheduled", conflictToQueue: true, idempotencyKey: "hm:9", resourceIds: [p1, sala1], now: NOW,
      } as never)
    );
    expect(result).toMatchObject({ ok: true, inConflict: true });
    const id = (result as { appointmentId: Id<"schedAppointments"> }).appointmentId;
    const appt = (await appointmentOf(id))!;
    expect(appt.resources.map((r) => [r.role, r.allocated])).toEqual([["Terapeuta", true], ["Sala", false]]);
    expect((await allocationsOf(id)).map((r) => r.resourceId)).toEqual([p1]);
    const conflict = (await t.run((ctx) => ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect()))[0];
    expect(conflict).toMatchObject({ kind: "human_confirm", status: "open", resourceId: sala1 });
  });
});

describe("revisão: etapa inválida não deixa escrita parcial (premissa do catch de moveFunnelStage)", () => {
  test("etapa de outro funil: nenhum move, atividade stage_change nem webhook de etapa", async () => {
    const s = await seedOrg();
    await t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.organizationId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
    await t.run((ctx) => ctx.db.insert("schedSettings", { organizationId: s.organizationId, funnel: { onScheduledStageId: s.otherBoardStageId }, updatedAt: NOW }));
    await book(s, "solo", at(10), { leadId: s.leadId });
    const lead = (await t.run((ctx) => ctx.db.get(s.leadId)))!;
    expect(lead.stageId).toBe(s.stageId);
    expect(lead.stageEnteredAt).toBeUndefined();
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(logs.filter((l) => l.action === "move")).toHaveLength(0);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(acts.filter((a) => a.type === "stage_change")).toHaveLength(0);
    const events = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => (f.args[0] as { event?: string }).event));
    expect(events).not.toContain("lead.stage_changed");
  });
});

describe("revisão: códigos de violação onde só se conferia 'falhou'", () => {
  test("criação automática fora do expediente falha por OUTSIDE_HOURS e nada é gravado", async () => {
    const s = await seedOrg();
    const result = await t.run((ctx) =>
      bookAppointmentCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "system", via: "human_message" }, origin: "human_message", serviceId: s.services.dupla,
        startTime: at(19), contactId: s.contacts[2], initialStatus: "scheduled", conflictToQueue: true, idempotencyKey: "hm:1", now: NOW,
      } as never)
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual(["OUTSIDE_HOURS"]);
    expect(await allAppointments()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A3d: prévia de remarcação (`previewBooking` com `rescheduleAppointmentId`)
// ---------------------------------------------------------------------------

describe("A3d: simular remarcação", () => {
  const preview = (s: Seed, appointmentId: Id<"schedAppointments">, startTime: number, extra: Record<string, unknown> = {}) =>
    asAdmin(s).mutation(api.schedulingMutations.previewBooking, { organizationId: s.organizationId, serviceId: s.services.solo, startTime, rescheduleAppointmentId: appointmentId, ...extra } as never);

  test("o próprio horário não conta como ocupado e nada é gravado", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10), { leadId: s.leadId });
    const id = first.appointmentIds[0];
    // Sem rescheduleAppointmentId, 10:30 conflita com o próprio agendamento (mesma profissional, capacidade 1).
    const plain = await asAdmin(s).mutation(api.schedulingMutations.previewBooking, bookArgs(s, "solo", at(10, 30), { contactId: s.contacts[1] }) as never);
    expect(plain.ok).toBe(false);
    const before = await counts();
    const res = await preview(s, id, at(10, 30));
    expect(res.ok).toBe(true);
    expect(res.preview).toBe(true);
    expect(res.plan.length).toBeGreaterThan(0);
    assertMatchesReturns(res, M.previewBooking);
    expect(await counts()).toEqual(before);
    expect((await appointmentOf(id))!.status).toBe("scheduled");
    expect(await allocationsOf(id)).toHaveLength(1);
  });

  test("horário tomado por outro agendamento recusa com violação e alternativas", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    await book(s, "solo", at(14), { contactId: s.contacts[1] });
    const before = await counts();
    const res = await preview(s, first.appointmentIds[0], at(14));
    expect(res.ok).toBe(false);
    expect(res.violations.map((x: { code: string }) => x.code)).toContain("CAPACITY_EXCEEDED");
    assertMatchesReturns(res, M.previewBooking);
    expect(await counts()).toEqual(before);
  });

  test("aplica as regras de remarcar: mesmo horário, proposta, status terminal, serviço diferente", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await expect(preview(s, id, at(10))).rejects.toThrow(/igual ao atual/);
    await expect(preview(s, id, at(11), { serviceId: s.services.sessao })).rejects.toThrow(/serviço não é o do agendamento/i);
    const proposal = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(15), contactId: s.contacts[0],
      actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api", rescheduleOfId: id, initialStatus: "pending_approval",
    });
    expect(proposal.ok).toBe(true);
    await expect(preview(s, proposal.appointmentId!, at(16))).rejects.toThrow(/proposta/i);
    await asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: id });
    await expect(preview(s, id, at(11))).rejects.toThrow(/não permitida/);
  });

  test("RBAC e org: sem agenda:edit, outra org e id inexistente recusam do mesmo jeito", async () => {
    const s = await seedOrg();
    const f = await seedForeign();
    const first = await book(s, "solo", at(10));
    const id = first.appointmentIds[0];
    await expect(as(s.viewAll.userId).mutation(api.schedulingMutations.previewBooking, { organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(11), rescheduleAppointmentId: id } as never)).rejects.toThrow();
    await expect(as(s.none.userId).mutation(api.schedulingMutations.previewBooking, { organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(11), rescheduleAppointmentId: id } as never)).rejects.toThrow();
    // Admin da outra org com o id do agendamento desta.
    await expect(
      as(f.userId).mutation(api.schedulingMutations.previewBooking, { organizationId: f.organizationId, serviceId: f.serviceId, startTime: at(11), rescheduleAppointmentId: id } as never)
    ).rejects.toThrow("Agendamento não encontrado");
    // Admin desta org com agendamento da outra.
    await expect(preview(s, f.appointmentId, at(11))).rejects.toThrow("Agendamento não encontrado");
  });

  test("a internal aceita só em prévia e a IA só vê o agendamento da própria conversa", async () => {
    const s = await seedOrg();
    const first = await book(s, "solo", at(10), { leadId: s.leadId });
    const id = first.appointmentIds[0];
    const base = { organizationId: s.organizationId, serviceId: s.services.solo, startTime: at(11), rescheduleAppointmentId: id };
    await expect(
      t.mutation(internal.schedulingMutations.internalBookAppointment, { ...base, actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api" })
    ).rejects.toThrow(/internalRescheduleAppointment/);
    const ok = await t.mutation(internal.schedulingMutations.internalBookAppointment, { ...base, mode: "preview", actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api" });
    expect(ok.ok).toBe(true);
    assertMatchesReturns(ok, M.internalBookAppointment);
    // IA da conversa do contato 0 enxerga; o agendamento de outro contato é "não encontrado".
    const other = await book(s, "solo", at(14), { contactId: s.contacts[1] });
    const ai = { type: "ai" as const, memberId: s.aiMemberId, conversationId: s.conversationId };
    await expect(
      t.mutation(internal.schedulingMutations.internalBookAppointment, { ...base, rescheduleAppointmentId: other.appointmentIds[0], mode: "preview", actor: ai, origin: "ai" })
    ).rejects.toThrow("Agendamento não encontrado");
    expect(await schedInvariantProblems(t, s.organizationId, Date.now())).toEqual([]);
  });
});
