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
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ resourceIds: [room], force: [`RESOURCE_CLOSED:${room}`] });
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
    expect((await pendingOf(r.pendingActionId))!.args).toMatchObject({ action: { type: "resource", resourceIds: [s1], force: [`RESOURCE_CLOSED:${s1}`] } });
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

describe("o `force` guardado é por PAR código:recurso (E2, revisão 1)", () => {
  async function roomAndPerson() {
    const room = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const ana = await mkRes("Ana", { kind: "person" });
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person" }] });
    return { room, ana, svc };
  }

  test("remarcar: prévia só da Sala 1 fechada; a profissional entra de folga depois; confirmar RECUSA e nada é gravado", async () => {
    const { room, ana, svc } = await roomAndPerson();
    await bookDirect(svc, at(MON, 10), [room, ana], { contactId: await mkContact("João") });
    await closeDay(room, TUE);
    const ref = await refOfDay(MON);
    const r = await write("rescheduleAppointment", { ref, startLocal: `${TUE}T14:00`, resourceName: "Sala 1" });
    expect(r.preview).toMatch(/^ATENÇÃO/);
    expect(((await pendingOf(r.pendingActionId))!.args as any).force).toEqual([`RESOURCE_CLOSED:${room}`]);
    await closeDay(ana, TUE); // aviso NOVO, do mesmo código, em outro recurso
    await expect(confirm(r.pendingActionId)).rejects.toThrow(/a agenda mudou desde a prévia/);
    expect((await apptList()).filter((a) => a.status === "scheduled")).toHaveLength(1);
    expect((await pendingOf(r.pendingActionId))?.status).toBe("pending");
  });

  test("marcar: mesma garantia", async () => {
    const { room, ana } = await roomAndPerson();
    await closeDay(room, TUE);
    const r = await write("bookAppointment", { contactId: await mkContact("Maria"), serviceName: "Sessão", startLocal: `${TUE}T14:00`, resourceName: "Sala 1" });
    expect(r.preview).toMatch(/^ATENÇÃO/);
    await closeDay(ana, TUE);
    await expect(confirm(r.pendingActionId)).rejects.toThrow(/a agenda mudou desde a prévia/);
    expect(await apptList()).toHaveLength(0);
  });

  test("a porta aceita o par e o código (compatível): par cobre só aquele recurso; código cobre qualquer um", async () => {
    const { room, ana, svc } = await roomAndPerson();
    await closeDay(room, TUE);
    await closeDay(ana, TUE);
    const maria = await mkContact("Maria");
    const body = { organizationId: s.orgId, serviceId: svc, startTime: at(TUE, 14), resourceIds: [room, ana], contactId: maria };
    await expect(as(s.admin).mutation(api.schedulingMutations.bookAppointment, { ...body, force: [`RESOURCE_CLOSED:${room}`] } as any)).rejects.toThrow();
    await expect(as(s.admin).mutation(api.schedulingMutations.bookAppointment, { ...body, force: [`RESOURCE_CLOSED:${ana}`] } as any)).rejects.toThrow();
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { ...body, force: [`RESOURCE_CLOSED:${room}`, `RESOURCE_CLOSED:${ana}`] } as any);
    expect((await apptList())[0].forcedRules).toEqual(["RESOURCE_CLOSED"]);
    // código puro continua valendo (tela)
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { ...body, startTime: at(TUE, 16), force: ["RESOURCE_CLOSED"] } as any);
  });
});

describe("marcar por oferta: profissional nunca troca em silêncio (E2, revisão 2)", () => {
  async function twoPeople() {
    await mkRes("Sala 1");
    const ana = await mkRes("Ana", { kind: "person" });
    await mkRes("Bia", { kind: "person" }, 1);
    await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person" }] });
    return { ana };
  }

  test("a oferta mostrou a Ana; a Ana fecha; marcar com a oferta RECUSA ('mudou') em vez de sair com a Bia", async () => {
    const { ana } = await twoPeople();
    const maria = await mkContact("Maria");
    const found = await read("findFreeTimes", { serviceName: "Sessão", date: "terça", limit: 50 });
    const slot = found.itens[0];
    expect(slot.recursos).toContain("Ana");
    await closeDay(ana, TUE);
    const before = await pendingCount();
    const r = await write("bookAppointment", { contactId: maria, serviceName: "Sessão", offer: slot.ref });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/Oferta de horário inválida ou desatualizada: esse horário mudou desde a busca \(outro profissional\)/);
    expect(await pendingCount()).toBe(before);
    // oferta sem mudança continua valendo
    const again = await read("findFreeTimes", { serviceName: "Sessão", date: "terça", limit: 50 });
    const ok = await write("bookAppointment", { contactId: maria, serviceName: "Sessão", offer: again.itens[0].ref });
    expect(ok.status).toBe("confirmacao_necessaria");
    expect(ok.preview).toContain("Bia");
  });

  test("sem oferta e sem citar: o sistema escolhe a Bia (a Ana está fechada) e a prévia DIZ quem é, com 'Ajuste de profissional'", async () => {
    const { ana } = await twoPeople();
    await closeDay(ana, TUE);
    const r = await write("bookAppointment", { contactId: await mkContact("Maria"), serviceName: "Sessão", startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/com Sala 1, Bia/);
    expect(r.preview).toMatch(/Ajuste de profissional: Ana não serve nesse horário \(fechado nesse dia\); usei Bia\./);
  });

  test("remarcar por oferta mostrada com outra profissional: a remarcação usa a do agendamento (prova contra a busca geral)", async () => {
    const { ana } = await twoPeople();
    const svc = (await t.run((ctx) => ctx.db.query("schedServices").collect()))[0]._id;
    const room = (await t.run((ctx) => ctx.db.query("schedResources").collect())).find((r) => r.name === "Sala 1")!._id;
    const bia = (await t.run((ctx) => ctx.db.query("schedResources").collect())).find((r) => r.name === "Bia")!._id;
    await bookDirect(svc, at(MON, 10), [room, bia], { contactId: await mkContact("João") });
    const ref = await refOfDay(MON);
    const found = await read("findFreeTimes", { serviceName: "Sessão", date: "terça", limit: 50 });
    const slot = found.itens[0];
    expect(slot.recursos).toContain("Ana"); // a oferta mostrou a Ana, mas o João é da Bia
    const r = await write("rescheduleAppointment", { ref, offer: slot.ref });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toContain("Bia");
    expect(r.preview).not.toContain("Ana");
    void ana;
  });
});

describe("candidatas equivalentes: pré-filtro, combinações e frase honesta (E2, revisão 3)", () => {
  test("13 salas fechadas o dia todo não gastam tentativas: a 14ª, aberta, é achada", async () => {
    const room = await mkRes("Sala 1");
    const svc = await mkSvc();
    await bookDirect(svc, at(MON, 10), [room], { contactId: await mkContact("João") });
    await closeDay(room, TUE);
    for (let i = 2; i <= 14; i++) await closeDay(await mkRes(`Sala ${i}`, {}, i), TUE);
    await mkRes("Sala 15", {}, 15);
    const r = await write("rescheduleAppointment", { ref: await refOfDay(MON), startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toMatch(/ficaria em Sala 15\./);
  });

  test("candidatas além do teto (ocupadas, não fechadas): a recusa NÃO afirma que não existe sala livre", async () => {
    const room = await mkRes("Sala 1");
    const svc = await mkSvc();
    await bookDirect(svc, at(MON, 10), [room], { contactId: await mkContact("João") });
    await closeDay(room, TUE);
    for (let i = 2; i <= 14; i++) {
      const id = await mkRes(`Sala ${i}`, {}, i);
      await bookDirect(svc, at(TUE, 14), [id], { contactId: await mkContact(`C${i}`) });
    }
    await mkRes("Sala 15", {}, 15); // livre, mas fora das 12 primeiras
    const r = await write("rescheduleAppointment", { ref: await refOfDay(MON), startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("erro");
    expect(r.error).toMatch(/Não achei sala\/equipamento livre entre os \d+ arranjos que testei/);
    expect(r.error).not.toMatch(/Nenhuma sala\/equipamento equivalente está livre/);
  });

  test("tudo testado e nada serve: a frase afirma com o número testado", async () => {
    const { room, room2 } = await joao();
    await closeDay(room, TUE);
    await closeDay(room2, TUE);
    const r = await write("rescheduleAppointment", { ref: await refOfDay(MON), startLocal: `${TUE}T14:00` });
    expect(r.error).toMatch(/Nenhuma sala\/equipamento equivalente está livre nesse horário \(testei todas/);
  });

  test("duas peças indisponíveis (sala e equipamento): testa combinações, não só a diagonal", async () => {
    const r1 = await mkRes("Sala 1");
    const r2 = await mkRes("Sala 2", {}, 1);
    const r3 = await mkRes("Sala 3", {}, 2);
    const e1 = await mkRes("Equip 1", { kind: "equipment" });
    const e2 = await mkRes("Equip 2", { kind: "equipment" }, 1);
    const e3 = await mkRes("Equip 3", { kind: "equipment" }, 2);
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Equip", kind: "equipment" }] });
    await bookDirect(svc, at(MON, 10), [r1, e1], { contactId: await mkContact("João") });
    await closeDay(r1, TUE);
    await closeDay(e1, TUE);
    // Sala 2 ocupada e Equip 3 ocupado às 14:00: só (Sala 3, Equip 2) serve; a diagonal (2,2)/(3,3) não
    await bookDirect(svc, at(TUE, 14), [r2, e3], { contactId: await mkContact("Outro") });
    const r = await write("rescheduleAppointment", { ref: await refOfDay(MON), startLocal: `${TUE}T14:00` });
    expect(r.status).toBe("confirmacao_necessaria");
    const ids = ((await pendingOf(r.pendingActionId))!.args as any).resourceIds as string[];
    expect([...ids].sort()).toEqual([r3, e2].sort());
  });
});
