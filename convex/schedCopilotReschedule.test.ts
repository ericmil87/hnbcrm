/// <reference types="vite/client" />
/**
 * Agenda v2 (E2): o Copiloto não leva o cliente para sala FECHADA/cheia em silêncio. Achado da simulação: "remarca o
 * João pra sexta 14h" mantinha a sala do agendamento e, com ela fechada no dia novo, só avisava.
 *
 * Regra: sem o membro citar sala, a PRÉVIA mantém o profissional, procura sala equivalente livre e DIZ a troca (ou recusa
 * com alternativas); recurso fechado só segue quando o membro o CITOU, com ATENÇÃO em destaque, e a confirmação vale
 * como `force`. A execução grava exatamente o plano mostrado (`assertSamePlan`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { type AgendaSeed, identityOf, type Person, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { atLocalMinutes } from "./lib/schedTime";

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
const mkContact = (firstName: string) => t.run((ctx) => ctx.db.insert("contacts", { organizationId: s.orgId, firstName, tags: [], createdAt: 1, updatedAt: 1 }));
const bookDirect = (serviceId: Id<"schedServices">, start: number, resourceIds: Id<"schedResources">[], extra: Record<string, unknown> = {}) =>
  as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.orgId, serviceId, startTime: start, resourceIds, ...extra } as any);
const closeDay = (resourceId: Id<"schedResources">, date: string) =>
  as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId, fromLocalDate: date, acceptAffected: true } as any);
const read = (name: string, args: Record<string, unknown>): Promise<any> =>
  t.query(internal.copilot.internalRunCopilotReadTool, { name, argsJson: JSON.stringify(args), organizationId: s.orgId, memberId: s.admin.memberId, now: Date.now(), threadId: thread });
const write = (name: string, args: Record<string, unknown>): Promise<any> =>
  t.mutation(internal.copilot.internalRunCopilotWriteTool, { name, argsJson: JSON.stringify(args), organizationId: s.orgId, memberId: s.admin.memberId, threadId: thread });
const confirm = (id: Id<"pendingActions">) => as(s.admin).mutation(api.copilot.confirmPendingAction, { pendingActionId: id });
const pendingOf = (id: Id<"pendingActions">) => t.run((ctx) => ctx.db.get(id));
const apptList = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const pendingCount = () => t.run(async (ctx) => (await ctx.db.query("pendingActions").collect()).length);
const refOfDay = async (date: string, index = 0) => (await read("getAgendaDay", { date })).itens[index].ref as string;

/** João na Sala 1, segunda 10:00 (agendamento "de origem"). */
async function joao() {
  const room = await mkRes("Sala 1");
  const room2 = await mkRes("Sala 2", {}, 1);
  const svc = await mkSvc();
  const contact = await mkContact("João");
  await bookDirect(svc, at(MON, 10), [room], { contactId: contact });
  return { room, room2, svc, contact };
}
const nameOfResources = (a: { resources: Array<{ name: string }> }) => a.resources.map((r) => r.name);

describe("remarcar SEM citar sala: sala atual fechada/cheia no dia novo", () => {
  test("o caso do relatório: a Sala 1 está fechada na terça; a prévia propõe a Sala 2 e DIZ isso; a confirmação grava o plano mostrado, sem forçar regra", async () => {
    const { room, room2 } = await joao();
    await closeDay(room, TUE);
    const ref = await refOfDay(MON);

    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toContain("(Sala 2)");
    expect(r.preview).toMatch(/Troca de lugar: Sala 1 não serve nesse horário \(fechado nesse dia\); ficaria em Sala 2\./);
    expect(r.preview).not.toMatch(/ATENÇÃO/);
    expect(r.avisos).toBeUndefined();
    const pending = (await pendingOf(r.pendingActionId))!;
    expect(pending.args).toMatchObject({ resourceIds: [room2], force: [] });
    expect((await apptList()).filter((a) => a.status === "scheduled")).toHaveLength(1); // a prévia não grava

    await confirm(r.pendingActionId);
    const all = await apptList();
    const moved = all.find((a) => a.startTime === at(TUE, 14))!;
    expect(nameOfResources(moved)).toEqual(["Sala 2"]);
    expect(moved.forcedRules).toBeUndefined();
    expect(moved.status).toBe("scheduled");
    expect(all.find((a) => a.startTime === at(MON, 10))?.status).toBe("rescheduled");
  });

  test("sala atual CHEIA no horário novo: troca para a equivalente e diz o motivo", async () => {
    const { room, svc } = await joao();
    await bookDirect(svc, at(TUE, 14), [room], { contactId: await mkContact("Outra") });
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/Troca de lugar: Sala 1 não serve nesse horário \(sem vaga nesse horário\); ficaria em Sala 2\./);
    await confirm(r.pendingActionId);
    expect(nameOfResources((await apptList()).find((a) => a.startTime === at(TUE, 14) && a.contactName === "João")!)).toEqual(["Sala 2"]);
  });

  test("sem sala equivalente (as duas fechadas): a prévia RECUSA, sem ação pendente, e só aceita o recurso citado de propósito", async () => {
    const { room, room2 } = await joao();
    await closeDay(room, TUE);
    await closeDay(room2, TUE);
    const ref = await refOfDay(MON);
    const before = await pendingCount();
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/Não dá para remarcar assim: Sala 1 \(fechado nesse dia\)\. Nenhuma sala\/equipamento equivalente está livre/);
    expect(r.proximo_passo).toMatch(/EXPLICITAMENTE/);
    expect(await pendingCount()).toBe(before);
    expect((await apptList()).filter((a) => a.status === "scheduled")).toHaveLength(1);
  });

  test("recusa traz alternativas de horário quando existem", async () => {
    const { room, room2, svc } = await joao();
    // terça 14:00: Sala 1 ocupada e Sala 2 ocupada (cheio, sem fechamento): alternativas no mesmo dia
    await bookDirect(svc, at(TUE, 14), [room], { contactId: await mkContact("A") });
    await bookDirect(svc, at(TUE, 14), [room2], { contactId: await mkContact("B") });
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("erro");
    expect(r.proximo_passo ?? "").toMatch(/Horários próximos: /);
  });

  test("sala CITADA e fechada: a prévia mantém, com ATENÇÃO em destaque; confirmar vale como `force` e grava a sala fechada", async () => {
    const { room } = await joao();
    await closeDay(room, TUE);
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00`, resourceName: "Sala 1" });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/^ATENÇÃO, REGRA DA AGENDA: Sala 1 está fechado nesse dia\. Confirmar marca em Sala 1 MESMO ASSIM/);
    expect(r.atencao).toMatch(/^ATENÇÃO, REGRA DA AGENDA/);
    expect(r.avisos).toEqual(["Sala 1 está fechado nesse dia."]);
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ resourceIds: [room], force: ["RESOURCE_CLOSED"] });
    await confirm(r.pendingActionId);
    const moved = (await apptList()).find((a) => a.startTime === at(TUE, 14))!;
    expect(nameOfResources(moved)).toEqual(["Sala 1"]);
    expect(moved.forcedRules).toEqual(["RESOURCE_CLOSED"]);
  });

  test("sala CITADA e cheia: nunca é trocada em silêncio (recusa), mesmo havendo outra livre", async () => {
    const { room, svc } = await joao();
    await bookDirect(svc, at(TUE, 14), [room], { contactId: await mkContact("Outra") });
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00`, resourceName: "Sala 1" });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/capacidade cheia/);
  });

  test("sala citada que NÃO está fechada troca a sala do agendamento (a citada substitui a atual) e o plano mostrado é o gravado", async () => {
    const { room2 } = await joao();
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00`, resourceName: "Sala 2" });
    expect(r.preview).toContain("(Sala 2)");
    expect(r.preview).not.toMatch(/ATENÇÃO|Troca de lugar/);
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ resourceIds: [room2] });
    await confirm(r.pendingActionId);
    expect(nameOfResources((await apptList()).find((a) => a.startTime === at(TUE, 14))!)).toEqual(["Sala 2"]);
  });

  test("por oferta de horário (findFreeTimes): a busca nunca traz outro profissional e sala fechada não é oferecida", async () => {
    const room = await mkRes("Sala 1");
    const room2 = await mkRes("Sala 2", {}, 1);
    const ana = await mkRes("Ana", { kind: "person" });
    const bia = await mkRes("Bia", { kind: "person" }, 1);
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person" }] });
    await bookDirect(svc, at(MON, 10), [room, ana], { contactId: await mkContact("João") });
    await closeDay(room, TUE);
    // Ana está ocupada às 14:00 de terça: o horário NÃO pode sair com a Bia
    await bookDirect(svc, at(TUE, 14), [room2, ana], { contactId: await mkContact("Outro") });
    const ref = await refOfDay(MON);
    const found = await read("findFreeTimes", { serviceName: "Sessão", date: "terça", limit: 50 });
    const slot14 = found.itens.find((i: any) => /às 14:00/.test(i.horario));
    if (slot14) {
      // a oferta (do serviço) pode trazer a Bia; a remarcação usa só a Ana: tem de falhar, nunca trocar de profissional
      const r = await write("rescheduleAppointment", { ref, offer: slot14.ref });
      expect(r.status).toBe("erro");
    }
    const r2 = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r2.status).toBe("erro");
    expect(await pendingCount()).toBe(0);
    void bia;
  });
});

describe("profissional nunca é trocado sozinho", () => {
  async function withPerson() {
    const room = await mkRes("Sala 1");
    const room2 = await mkRes("Sala 2", {}, 1);
    const ana = await mkRes("Ana", { kind: "person" });
    const bia = await mkRes("Bia", { kind: "person" }, 1);
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person" }] });
    await bookDirect(svc, at(MON, 10), [room, ana], { contactId: await mkContact("João") });
    return { room, room2, ana, bia, svc };
  }

  test("sala fechada: troca só a sala, a Ana fica; profissional fechada: recusa (a Bia não entra no lugar dela)", async () => {
    const { room, ana, room2 } = await withPerson();
    await closeDay(room, TUE);
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    const ids = ((await pendingOf(r.pendingActionId))!.args as any).resourceIds as string[];
    expect([...ids].sort()).toEqual([room2, ana].sort());
    await confirm(r.pendingActionId);
    expect(nameOfResources((await apptList()).find((a) => a.startTime === at(TUE, 14))!).sort()).toEqual(["Ana", "Sala 2"]);

    // agora é a Ana que não trabalha na quarta
    const WED = "2026-06-17";
    await closeDay(ana, WED);
    const ref2 = await refOfDay(TUE);
    const r2 = await write("rescheduleAppointment", { ref: ref2, startLocal: `${WED}T14:00` });
    expect(r2.status).toBe("erro");
    expect(r2.error).toMatch(/Ana \(fechado nesse dia\)\. O profissional nunca é trocado sozinho/);
    expect(r2.proximo_passo).toMatch(/EXPLICITAMENTE/);
  });

  test("profissional citada e fechada: ATENÇÃO e a confirmação força (a sala atual fica)", async () => {
    const { ana, room } = await withPerson();
    const WED = "2026-06-17";
    await closeDay(ana, WED);
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${WED}T14:00`, resourceName: "Ana" });
    expect(r.preview).toMatch(/^ATENÇÃO, REGRA DA AGENDA: Ana está fechado nesse dia/);
    const ids = ((await pendingOf(r.pendingActionId))!.args as any).resourceIds as string[];
    expect([...ids].sort()).toEqual([room, ana].sort());
    await confirm(r.pendingActionId);
    const moved = (await apptList()).find((a) => a.startTime === at(WED, 14))!;
    expect(moved.forcedRules).toEqual(["RESOURCE_CLOSED"]);
  });
});

describe("marcar (bookAppointment): sala fechada citada × não citada", () => {
  test("não citada: usa a sala aberta; todas fechadas = recusa sem ação pendente", async () => {
    const room = await mkRes("Sala 1");
    const room2 = await mkRes("Sala 2", {}, 1);
    await mkSvc();
    const maria = await mkContact("Maria");
    await closeDay(room, TUE);
    const ok = await write("bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${TUE}T14:00` });
    expect(ok.status).toBe("confirmacao_necessaria");
    expect(ok.preview).toContain("com Sala 2");
    expect(ok.preview).toMatch(/Ajuste de lugar: Sala 1 não serve nesse horário \(fechado nesse dia\); usei Sala 2\./);
    expect(ok.preview).not.toMatch(/ATENÇÃO/);
    expect((await pendingOf(ok.pendingActionId))!.args).toMatchObject({ resourceIds: [room2], force: [] });

    await closeDay(room2, TUE);
    const before = await pendingCount();
    const no = await write("bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${TUE}T15:00` });
    expect(no.status).toBe("erro");
    expect(no.error).toMatch(/Não dá para marcar assim/);
    expect(no.proximo_passo).toMatch(/EXPLICITAMENTE/);
    expect(await pendingCount()).toBe(before);
  });

  test("citada e fechada: ATENÇÃO + confirmar vale como aceite (forcedRules)", async () => {
    const room = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    await mkSvc();
    const maria = await mkContact("Maria");
    await closeDay(room, TUE);
    const r = await write("bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal: `${TUE}T14:00`, resourceName: "Sala 1" });
    expect(r.preview).toMatch(/^ATENÇÃO, REGRA DA AGENDA: Sala 1 está fechado nesse dia\./);
    expect(r.preview).toContain("Marcar Maria");
    await confirm(r.pendingActionId);
    const [a] = await apptList();
    expect(nameOfResources(a)).toEqual(["Sala 1"]);
    expect(a.forcedRules).toEqual(["RESOURCE_CLOSED"]);
  });
});

describe("resolver conflito: recurso fechado só com citação", () => {
  async function conflicted() {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const joana = await mkContact("Joana");
    await bookDirect(svc, at(MON, 15), [s1], { contactId: joana });
    await bookDirect(svc, at(MON, 15), [s2]);
    await closeDay(s1, MON);
    const item = (await read("listAgendaPending", {})).itens.find((i: any) => i.tipo === "sem_lugar");
    return { s1, s2, svc, ref: item.ref as string };
  }

  test("trocar para a sala CITADA que está fechada: ATENÇÃO; a sala fechada nunca vem de sugestão do sistema", async () => {
    const { ref, s1 } = await conflicted();
    const r = await write("resolveAgendaConflict", { ref, action: "reassign", resourceName: "Sala 1" });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/^ATENÇÃO, REGRA DA AGENDA: Sala 1 está fechado nesse dia/);
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ action: { type: "resource", resourceIds: [s1], force: ["RESOURCE_CLOSED"] } });
  });

  test("remarcar o conflito para outro dia sem citar sala: sala atual fechada nesse dia = troca para a equivalente, dita na prévia", async () => {
    const { ref, s1, s2 } = await conflicted();
    await closeDay(s1, TUE);
    const r = await write("resolveAgendaConflict", { ref, action: "reschedule", startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/Troca de lugar: Sala 1 não serve nesse horário \(fechado nesse dia\); ficaria em Sala 2\./);
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ action: { type: "reschedule", resourceIds: [s2], force: [] } });
    await confirm(r.pendingActionId);
    expect(nameOfResources((await apptList()).find((a) => a.startTime === at(TUE, 14))!)).toEqual(["Sala 2"]);
  });
});

describe("fechar sala com gente dentro: impacto dito e aceite explícito", () => {
  test("a prévia diz quantos mudam de sala/ficam sem lugar; a confirmação leva a contagem (a situação mudou = recusa)", async () => {
    const { room, svc } = await joao();
    await bookDirect(svc, at(MON, 14), [room], { contactId: await mkContact("Joana") });
    const r = await write("closeResourceDay", { resourceName: "Sala 1", date: MON });
    expect(r.preview).toMatch(/Afeta 2 agendamento\(s\): 2 mudam de sala, 0 ficam sem lugar/);
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ expectedAffected: 2 });
    // alguém marca mais um na Sala 1 depois da prévia: o impacto mudou, a confirmação recusa
    await bookDirect(svc, at(MON, 16), [room], { contactId: await mkContact("Nova") });
    await expect(confirm(r.pendingActionId)).rejects.toThrow();
  });
});
