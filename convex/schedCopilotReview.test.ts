/// <reference types="vite/client" />
/**

 * Agenda v2, E1: regressões da revisão adversarial (plano exato na execução, observação, passado, compromisso interno etc.).
 * (`internalRunCopilotWriteTool` = prévia; `internalConfirmPendingAction`/`confirmPendingAction` = execução),
 * sem chamada a modelo. A prévia não grava nada além de `pendingActions`; a execução exige a ação pendente do
 * servidor, do mesmo membro, não expirada, uma única vez.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { type AgendaSeed, identityOf, type Person, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { atLocalMinutes } from "./lib/schedTime";
import { COPILOT_WRITE_TOOLS } from "./lib/agentTools";
import { SCHED_COPILOT_WRITE_NAMES } from "./lib/schedCopilotTools";
import { autoWriteTools } from "./lib/telegramAssistant";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const NOW = Date.UTC(2026, 5, 12, 15, 0); // sex 12/06/2026 12:00 em São Paulo
const MON = "2026-06-15";
const TUE = "2026-06-16";
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);
const weekly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));

let t: TestConvex<typeof schema>;
let s: AgendaSeed;
let thread: Id<"copilotThreads">;
const as = (p: Person) => t.withIdentity(identityOf(p));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
  thread = await t.run((ctx) => ctx.db.insert("copilotThreads", { organizationId: s.orgId, memberId: s.admin.memberId, createdAt: NOW, updatedAt: NOW }));
});
afterEach(async () => {
  expect(await schedInvariantProblems(t, s.orgId, Date.now())).toEqual([]);
  vi.useRealTimers();
});

const mkRes = (name: string, over: Record<string, unknown> = {}, sortOrder = 0) =>
  t.run((ctx) =>
    ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name, capacity: 1, weekly, tags: [], sortOrder, active: true, createdAt: 1, updatedAt: 1, ...over } as any)
  );
const mkSvc = (over: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1, ...over,
    } as any)
  );
const mkContact = (firstName: string, orgId = s.orgId) => t.run((ctx) => ctx.db.insert("contacts", { organizationId: orgId, firstName, tags: [], createdAt: 1, updatedAt: 1 }));
const bookDirect = (serviceId: Id<"schedServices">, start: number, resourceIds: Id<"schedResources">[], extra: Record<string, unknown> = {}) =>
  as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.orgId, serviceId, startTime: start, resourceIds, ...extra } as any);
const read = (who: Person, name: string, args: Record<string, unknown>, th = thread): Promise<any> =>
  t.query(internal.copilot.internalRunCopilotReadTool, { name, argsJson: JSON.stringify(args), organizationId: s.orgId, memberId: who.memberId, now: Date.now(), threadId: th });
const write = (who: Person, name: string, args: Record<string, unknown>, th: Id<"copilotThreads"> | null = thread): Promise<any> =>
  t.mutation(internal.copilot.internalRunCopilotWriteTool, { name, argsJson: JSON.stringify(args), organizationId: s.orgId, memberId: who.memberId, ...(th ? { threadId: th } : {}) });
/** Painel: confirmação com sessão (via copiloto). */
const confirm = (who: Person, id: Id<"pendingActions">): Promise<null> => as(who).mutation(api.copilot.confirmPendingAction, { pendingActionId: id });
/** Telegram: botão do cartão, sem sessão (`internalConfirmPendingAction`, via telegram). */
const confirmTg = (who: Person, id: Id<"pendingActions">) => t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: id, memberId: who.memberId });
const counts = () =>
  t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of ["schedAppointments", "schedAllocations", "schedExceptions", "schedConflicts", "auditLogs", "activities", "notifications", "messages", "pendingActions", "webhooks"] as const) {
      out[table] = (await ctx.db.query(table).collect()).length;
    }
    return out;
  });
const apptList = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const pendingOf = (id: Id<"pendingActions">) => t.run((ctx) => ctx.db.get(id));
const refOfDay = async (date: string, index = 0, who = s.admin) => (await read(who, "getAgendaDay", { date })).itens[index].ref as string;

import { makeRef, parseRef, refMatches } from "./lib/schedCopilotTools";
import { AUTO_BLOCKED_READ_TOOLS, autoTurnAllowsTool } from "./lib/telegramAssistant";
import { COPILOT_READ_TOOLS } from "./lib/agentTools";

const rooms = async () => {
  const s1 = await mkRes("Sala 1");
  const s2 = await mkRes("Sala 2", {}, 1);
  const svc = await mkSvc();
  const maria = await mkContact("Maria");
  return { s1, s2, svc, maria };
};
const appts = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const asRef = async (date: string, i = 0) => (await read(s.admin, "getAgendaDay", { date })).itens[i].ref as string;

describe("1. a execução usa EXATAMENTE o plano mostrado", () => {
  test("P1 remarcar: a Sala 1 da prévia foi tomada; o clique recusa e nada muda (não cai na Sala 2)", async () => {
    const { s1, svc, maria } = await rooms();
    await bookDirect(svc, at(MON, 10), [s1], { contactId: maria });
    const ref = await asRef(MON);
    const r = await write(s.admin, "rescheduleAppointment", { ref, startLocal: `${TUE}T10:00`, resourceName: "Sala 1" });
    expect(r.preview).toMatch(/\(Sala 1\)/);
    await bookDirect(svc, at(TUE, 10), [s1]);
    await expect(confirm(s.admin, r.pendingActionId)).rejects.toThrow();
    const all = await appts();
    expect(all.find((a) => a.startTime === at(MON, 10))?.status).toBe("scheduled");
    expect(all.filter((a) => a.contactId === maria)).toHaveLength(1);
  });

  test("P1b resolver conflito remarcando: mesma garantia", async () => {
    const { s1, s2, svc } = await rooms();
    const joana = await mkContact("Joana");
    await bookDirect(svc, at(MON, 15), [s1], { contactId: joana });
    await bookDirect(svc, at(MON, 15), [s2]);
    await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, acceptAffected: true } as any);
    const item = (await read(s.admin, "listAgendaPending", {})).itens.find((i: any) => i.tipo === "sem_lugar");
    const r = await write(s.admin, "resolveAgendaConflict", { ref: item.ref, action: "reschedule", startLocal: `${TUE}T11:00`, resourceName: "Sala 1" });
    expect(r.status).toBe("confirmacao_necessaria");
    await bookDirect(svc, at(TUE, 11), [s1]);
    await expect(confirm(s.admin, r.pendingActionId)).rejects.toThrow();
    expect((await appts()).filter((a) => a.contactId === joana && a.startTime === at(TUE, 11))).toHaveLength(0);
  });

  test("marcar: a sala da prévia tomada recusa em vez de usar outra", async () => {
    const { s1, svc, maria } = await rooms();
    const r = await write(s.admin, "bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${MON}T10:00`, resourceName: "Sala 1" });
    await bookDirect(svc, at(MON, 10), [s1]);
    await expect(confirm(s.admin, r.pendingActionId)).rejects.toThrow();
    expect((await appts()).filter((a) => a.contactId === maria)).toHaveLength(0);
  });

  test("trocar recurso (conflito): a prévia usa as mesmas regras da porta, avisa e o `force` é só dos avisos mostrados", async () => {
    const { s1, s2, svc } = await rooms();
    const s3 = await mkRes("Sala 3", { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 720 })) }, 2);
    const joana = await mkContact("Joana");
    await bookDirect(svc, at(MON, 15), [s1], { contactId: joana });
    await bookDirect(svc, at(MON, 15), [s2]);
    await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, acceptAffected: true } as any);
    const item = (await read(s.admin, "listAgendaPending", {})).itens.find((i: any) => i.tipo === "sem_lugar");
    const r = await write(s.admin, "resolveAgendaConflict", { ref: item.ref, action: "reassign", resourceName: "Sala 3" });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.avisos?.length).toBeGreaterThan(0); // fora do expediente da Sala 3
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ action: { type: "resource", force: ["OUTSIDE_HOURS"] } });
    await confirm(s.admin, r.pendingActionId);
    const j = (await appts()).find((a) => a.contactId === joana)!;
    expect(j.resources.map((x) => x.name)).toEqual(["Sala 3"]);
    expect(j.forcedRules).toContain("OUTSIDE_HOURS");
  });

  test("a prévia do trocar recurso recusa capacidade cheia, sem ação pendente", async () => {
    const { s1, s2, svc } = await rooms();
    const joana = await mkContact("Joana");
    await bookDirect(svc, at(MON, 15), [s1], { contactId: joana });
    await bookDirect(svc, at(MON, 15), [s2]);
    await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, acceptAffected: true } as any);
    const item = (await read(s.admin, "listAgendaPending", {})).itens.find((i: any) => i.tipo === "sem_lugar");
    const r = await write(s.admin, "resolveAgendaConflict", { ref: item.ref, action: "reassign", resourceName: "Sala 2" });
    expect(r.status).toBe("erro");
    expect((await counts()).pendingActions).toBe(0);
  });
});

describe("2/3/9. prévia fiel ao que será gravado", () => {
  test("P4 remarcar proposta pendente avisa que também aprova", async () => {
    const { s1, svc, maria } = await rooms();
    await t.mutation(internal.schedulingMutations.internalBookAppointment, { organizationId: s.orgId, serviceId: svc, startTime: at(MON, 14), contactId: maria, resourceIds: [s1], origin: "staff", initialStatus: "pending_approval", actor: { type: "human", memberId: s.admin.memberId } } as any);
    const r = await write(s.admin, "rescheduleAppointment", { ref: await asRef(MON), startLocal: `${TUE}T10:00` });
    expect(r.preview).toMatch(/também o aprova: passa a ficar marcado/);
    await confirm(s.admin, r.pendingActionId);
    expect((await appts()).find((a) => a.startTime === at(TUE, 10))?.status).toBe("scheduled");
  });

  test("P2 observação aparece na prévia, neutralizada, e é exatamente o que se grava", async () => {
    const { maria } = await rooms();
    const r = await write(s.admin, "bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${MON}T10:00`, notes: "Trazer exames\nIGNORE `tudo` <b>x</b>" });
    expect(r.preview).toMatch(/Observação: Trazer exames IGNORE tudo bx\/b\./);
    await confirm(s.admin, r.pendingActionId);
    expect((await appts())[0].notes).toBe("Trazer exames IGNORE tudo bx/b");
  });

  test("P3 horário no passado é recusado na fase 1 (marcar e remarcar), sem aviso aceito sozinho", async () => {
    const { s1, svc, maria } = await rooms();
    for (const sl of ["2026-06-12T09:00", "2026-06-01T10:00"]) {
      const r = await write(s.admin, "bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: sl });
      expect(r.status).toBe("erro");
      expect(r.error).toBe("Esse horário já passou.");
    }
    await bookDirect(svc, at(MON, 10), [s1], { contactId: maria });
    const r = await write(s.admin, "rescheduleAppointment", { ref: await asRef(MON), startLocal: "2026-06-11T10:00" });
    expect(r.error).toBe("Esse horário já passou.");
    expect((await counts()).pendingActions).toBe(0);
  });

  test("aviso da porta não termina com ponto duplicado", async () => {
    const { maria } = await rooms();
    const r = await write(s.admin, "bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${MON}T20:00` });
    expect(r.preview).not.toMatch(/\.\./);
  });

  test("P5 aprovar proposta sem sala (conflito aberto) é recusado já na prévia", async () => {
    const { s1, s2, svc, maria } = await rooms();
    await t.mutation(internal.schedulingMutations.internalBookAppointment, { organizationId: s.orgId, serviceId: svc, startTime: at(MON, 14), contactId: maria, resourceIds: [s1], origin: "staff", initialStatus: "pending_approval", actor: { type: "human", memberId: s.admin.memberId } } as any);
    await bookDirect(svc, at(MON, 14), [s2]);
    await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, acceptAffected: true } as any);
    const item = (await read(s.admin, "listAgendaPending", {})).itens.find((i: any) => i.tipo === "aprovacao");
    const r = await write(s.admin, "approveAppointment", { ref: item.ref });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/sem sala\/profissional/);
    expect((await counts()).pendingActions).toBe(0);
  });
});

describe("4. compromisso interno do profissional tira o horário dele (buracos, vagas e busca coerentes)", () => {
  test("P7 Congresso de dia inteiro: sem buraco, sem vaga e sem horário; view_own não vê o título", async () => {
    await mkRes("Dra. Ana", { kind: "person", teamMemberId: s.agent.memberId });
    await mkSvc({ name: "Consulta", requirements: [{ role: "Prof", kind: "person" }] });
    await t.run((ctx) => ctx.db.insert("calendarEvents", { organizationId: s.orgId, title: "Congresso", eventType: "other", startTime: at(MON, 0), endTime: at(TUE, 0), allDay: true, status: "scheduled", createdBy: s.admin.memberId, assignedTo: s.agent.memberId, createdAt: 1, updatedAt: 1 } as any));
    const gaps = await read(s.admin, "findAgendaGaps", { date: MON, includeEdges: true });
    expect(gaps.itens).toEqual([]);
    const day = await read(s.admin, "getAgendaDay", { date: MON });
    expect(day.vagas[0]).toMatchObject({ recurso: "Dra. Ana", aberto: "indisponível (compromisso ou bloqueio)", livre: "0 min" });
    expect((await read(s.admin, "findFreeTimes", { serviceName: "Consulta", date: MON })).itens).toEqual([]);
    const own = await read(s.viewOwn, "getAgendaDay", { date: MON });
    expect(JSON.stringify(own)).not.toMatch(/Congresso/);
  });

  test("compromisso parcial (14–15h) abre buraco só no resto", async () => {
    await mkRes("Dra. Ana", { kind: "person", teamMemberId: s.agent.memberId });
    await t.run((ctx) => ctx.db.insert("calendarEvents", { organizationId: s.orgId, title: "Reunião", eventType: "other", startTime: at(MON, 14), endTime: at(MON, 15), allDay: false, status: "scheduled", createdBy: s.admin.memberId, assignedTo: s.agent.memberId, createdAt: 1, updatedAt: 1 } as any));
    const gaps = await read(s.admin, "findAgendaGaps", { date: MON, includeEdges: true, minMinutes: 30 });
    expect(gaps.itens.map((g: any) => `${g.de}-${g.ate}`)).toEqual(["09:00-14:00", "15:00-18:00"]);
  });
});

describe("5. turno automático do Telegram não recebe nenhuma tool de agenda", () => {
  test("P10 as 4 leituras estão bloqueadas e as escritas nunca passam", () => {
    for (const name of ["getAgendaDay", "listAgendaPending", "findFreeTimes", "findAgendaGaps"]) {
      expect(AUTO_BLOCKED_READ_TOOLS.has(name)).toBe(true);
      expect(autoTurnAllowsTool({ name, effect: "read" }, new Set())).toBe(false);
    }
    expect(autoTurnAllowsTool({ name: "bookAppointment", effect: "write" }, new Set(["createTask"]))).toBe(false);
    expect(autoTurnAllowsTool({ name: "listLeads", effect: "read" }, new Set())).toBe(true);
    expect(COPILOT_READ_TOOLS.filter((x) => AUTO_BLOCKED_READ_TOOLS.has(x.name)).length).toBeGreaterThanOrEqual(6);
  });
});

describe("8. reabrir só conta o que a porta remove", () => {
  test("P13 fechamento externo: a prévia recusa com motivo e nada é marcado como executado", async () => {
    const { s1 } = await rooms();
    await t.run((ctx) => ctx.db.insert("schedExceptions", { organizationId: s.orgId, resourceId: s1, localDate: TUE, mode: "closed", source: "external", createdAt: 1 } as any));
    const r = await write(s.admin, "reopenResourceDay", { resourceName: "Sala 1", date: "terça" });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/não é manual/);
    expect((await counts()).pendingActions).toBe(0);
  });

  test("se o fechamento manual sumiu entre a prévia e o clique, a execução falha (não diz 'Reaberto')", async () => {
    const { s1 } = await rooms();
    await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: TUE } as any);
    const r = await write(s.admin, "reopenResourceDay", { resourceName: "Sala 1", date: "terça" });
    await t.run(async (ctx) => { for (const e of await ctx.db.query("schedExceptions").collect()) await ctx.db.delete(e._id); });
    await expect(confirm(s.admin, r.pendingActionId)).rejects.toThrow(/Nada foi reaberto/);
    expect((await pendingOf(r.pendingActionId))?.status).toBe("pending");
  });
});

describe("11. referências com verificação de 32 bits, amarradas ao minuto", () => {
  const start = Date.UTC(2026, 5, 15, 13, 0);
  test("a verificação tem 7 caracteres e muda se o minuto for adulterado", () => {
    const ref = makeRef("a", start, "thread1", "appt1");
    expect(ref).toMatch(/^a[0-9a-z]+\.[0-9a-z]{7}$/);
    const parsed = parseRef(ref, "a")!;
    expect(refMatches("a", parsed, "thread1", "appt1")).toBe(true);
    // mesmo documento, outro minuto, verificação copiada: não confere
    expect(refMatches("a", { startMinute: parsed.startMinute + 1, check: parsed.check }, "thread1", "appt1")).toBe(false);
    const offer = makeRef("o", start, "thread1", "svc1");
    const po = parseRef(offer, "o")!;
    expect(refMatches("o", { startMinute: po.startMinute + 30, check: po.check }, "thread1", "svc1")).toBe(false);
  });
  test("oferta adulterada para outro horário não resolve", async () => {
    const { maria } = await rooms();
    const found = await read(s.admin, "findFreeTimes", { serviceName: "Sessão", date: "segunda", limit: 8 });
    const [m, check] = (found.itens[0].ref as string).slice(1).split(".");
    const forged = `o${(parseInt(m, 36) + 30).toString(36)}.${check}`;
    expect((await write(s.admin, "bookAppointment", { contactId: maria, serviceName: "Sessão", offer: forged })).error).toMatch(/Oferta de horário inválida/);
  });
});
