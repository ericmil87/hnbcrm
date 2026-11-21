import { describe, expect, it } from "vitest";
import { buildDayGridModel, type DayInput, type DayResource, type GridAppointment } from "./agendaGrid";
import { buildDayList, summarizeResources } from "./agendaDayList";

const TZ = "America/Sao_Paulo";
const DATE = "2026-11-23";
const at = (h: number, m = 0) => Date.UTC(2026, 10, 23, h + 3, m);
const res = (id: string, kind: DayResource["kind"], over: Partial<DayResource> = {}): DayResource => ({
  _id: id, kind, name: id, capacity: 1, sortOrder: 0, open: [{ start: at(8), end: at(18) }], closed: false, blocks: [], ...over,
});
let n = 0;
const appt = (rooms: string[], start: number, end: number, over: Partial<GridAppointment> = {}, conflict: string[] = []): GridAppointment => ({
  _id: `a${++n}` as never,
  serviceName: "Sessão",
  startTime: start,
  endTime: end,
  status: "scheduled",
  origin: "staff",
  localDate: DATE,
  contactName: `Cli ${n}`,
  resources: [
    ...rooms.map((id) => ({ resourceId: id as never, role: "room", name: id, allocated: true })),
    ...conflict.map((id) => ({ resourceId: id as never, role: "room", name: id, allocated: false })),
  ],
  ...over,
});
const day = (appointments: GridAppointment[], over: Partial<DayInput> = {}): DayInput => ({
  timezone: TZ,
  localDate: DATE,
  resources: [res("sala1", "room"), res("sala2", "room", { capacity: 2 })],
  appointments,
  busy: [],
  exceptions: [],
  ...over,
});
const NOW = at(9);

describe("lista por horário", () => {
  it("uma lista cronológica com agendamentos, ocupado e compromissos", () => {
    const d = day([appt(["sala1"], at(14), at(15)), appt(["sala2"], at(9), at(10)), appt(["sala1"], at(11), at(12), { status: "cancelled" })], {
      busy: [{ resourceIds: ["sala1"], start: at(10, 30), end: at(11) }],
    });
    const internal = [{ id: "e1", title: "Reunião", startTime: at(12), endTime: at(13), eventType: "meeting", source: "event" as const, allDay: false, memberIds: [] }];
    const [g] = buildDayList({ day: d, internal, groupBy: "room", mode: "hora", now: NOW, withFree: true });
    expect(g.entries.map((e) => e.kind)).toEqual(["appointment", "busy", "internal", "appointment"]);
    expect(g.entries.some((e) => e.kind === "free")).toBe(false);
  });
  it("faltou aparece na lista (não na grade); cancelado não", () => {
    const d = day([appt(["sala1"], at(9), at(10), { status: "no_show" }), appt(["sala1"], at(11), at(12), { status: "cancelled" })]);
    expect(buildDayList({ day: d, internal: [], groupBy: "room", mode: "hora", now: NOW, withFree: false })[0].entries).toHaveLength(1);
  });
  it("dia sem nada: nenhum grupo", () => {
    expect(buildDayList({ day: day([]), internal: [], groupBy: "room", mode: "recurso", now: NOW, withFree: true })).toEqual([]);
  });
  it("conflito marcado e local mostra os recursos alocados", () => {
    const a = appt(["sala1"], at(9), at(10), {}, ["sala2"]);
    const [g] = buildDayList({ day: day([a]), internal: [], groupBy: "room", mode: "hora", now: NOW, withFree: false });
    expect(g.entries[0]).toMatchObject({ kind: "appointment", place: "sala1", conflict: true });
  });
});

describe("lista por recurso", () => {
  const input = (d: DayInput, over = {}) => ({ day: d, internal: [], groupBy: "room" as const, mode: "recurso" as const, now: NOW, withFree: true, ...over });

  it("um grupo por sala, com vagas e livre intercalado em ordem", () => {
    const d = day([appt(["sala1"], at(10), at(11))]);
    const groups = buildDayList(input(d));
    expect(groups.map((g) => g.key)).toEqual(["res:sala1", "res:sala2"]);
    const s1 = groups[0];
    // agora = 09:00: livre 09:00-10:00, marcado 10:00, livre 11:00-18:00
    expect(s1.entries.map((e) => e.kind)).toEqual(["free", "appointment", "free"]);
    expect(groups[1].vacancy?.label).toBe("0/2");
    expect(groups[0].vacancy?.label).toBe("0/1");
  });
  it("sem permissão de marcar não há 'livre'", () => {
    const d = day([appt(["sala1"], at(10), at(11))]);
    expect(buildDayList(input(d, { withFree: false }))[0].entries.map((e) => e.kind)).toEqual(["appointment"]);
  });
  it("'Sem lugar' vem primeiro; recurso fechado traz o motivo e nenhum livre", () => {
    const d = day([appt([], at(9), at(10), {}, ["sala1"])], {
      resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")],
      exceptions: [{ resourceId: "sala1", mode: "closed", reasonCode: "no_staff" }],
    });
    const groups = buildDayList(input(d));
    expect(groups.map((g) => g.kind)).toEqual(["noPlace", "resource", "resource"]);
    expect(groups[1]).toMatchObject({ closed: true, closedReason: "Sem equipe" });
    expect(groups[1].entries).toEqual([]);
  });
  it("agendamento com 2 salas aparece nas duas; compromissos no fim", () => {
    const d = day([appt(["sala1", "sala2"], at(10), at(11))]);
    const internal = [{ id: "t", title: "Ligar", startTime: at(10), endTime: at(10), eventType: "task", source: "task" as const, allDay: false, memberIds: [] }];
    const groups = buildDayList(input(d, { internal }));
    expect(groups[0].entries.filter((e) => e.kind === "appointment")).toHaveLength(1);
    expect(groups[1].entries.filter((e) => e.kind === "appointment")).toHaveLength(1);
    expect(groups.at(-1)?.kind).toBe("internal");
  });
  it("ocupado anônimo entra no recurso certo", () => {
    const d = day([], { busy: [{ resourceIds: ["sala2"], start: at(10), end: at(11) }] });
    const groups = buildDayList(input(d, { withFree: false }));
    expect(groups.find((g) => g.key === "res:sala2")?.entries.map((e) => e.kind)).toEqual(["busy"]);
    expect(groups.find((g) => g.key === "res:sala1")?.entries).toEqual([]);
  });
});

describe("resumo por recurso", () => {
  it("aberta, cheia agora (sala dupla 2/2) e fechada", () => {
    const d = day([appt(["sala2"], at(9), at(10)), appt(["sala2"], at(9), at(10))], {
      resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room", { capacity: 2 }), res("sala3", "room")],
    });
    const s = summarizeResources(buildDayGridModel({ day: d, internal: [], groupBy: "room", now: NOW }));
    expect(s.map((x) => [x.name, x.state, x.vacancy.label, x.count])).toEqual([
      ["sala1", "closed", "0/1", 0],
      ["sala2", "full", "2/2", 2],
      ["sala3", "open", "0/1", 0],
    ]);
  });
  it("acima da capacidade fica sinalizado", () => {
    const three = [1, 2, 3].map(() => appt(["sala1"], at(9), at(10)));
    const s = summarizeResources(buildDayGridModel({ day: day(three), internal: [], groupBy: "room", now: NOW }));
    expect(s[0].vacancy).toMatchObject({ label: "3/1", over: true });
  });
  it("em outro dia usa o pico e nunca marca 'cheia'", () => {
    const two = [appt(["sala1"], at(9), at(10))];
    const s = summarizeResources(buildDayGridModel({ day: day(two), internal: [], groupBy: "room", now: at(9) + 5 * 86_400_000 }));
    expect(s[0].state).toBe("open");
    expect(s[0].load.basis).toBe("peak");
  });
});

describe("agenda sem recursos (módulo recém-ligado)", () => {
  it("compromissos e tarefas continuam na lista por horário", () => {
    const d = day([], { resources: [] });
    const internal = [{ id: "e1", title: "Reunião", startTime: at(10), endTime: at(11), eventType: "meeting", source: "event" as const, allDay: false, memberIds: [] }];
    const groups = buildDayList({ day: d, internal, groupBy: "room", mode: "hora", now: NOW, withFree: true });
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.kind)).toEqual(["internal"]);
    const grid = buildDayGridModel({ day: d, internal, groupBy: "room", now: NOW });
    expect(grid.columns.some((c) => c.kind === "resource")).toBe(false);
    expect(grid.columns.map((c) => c.kind)).toEqual(["internal"]);
  });
});

describe("dia inteiro do profissional e proposta vencida", () => {
  const folga = { id: "e1", title: "Folga", startTime: at(0), endTime: at(23, 59), eventType: "other", source: "event" as const, allDay: true, memberIds: ["m1"] };
  const d = day([], { resources: [{ ...res("ana", "person"), teamMemberId: "m1" } as never, { ...res("bia", "person"), teamMemberId: "m2" } as never] });

  it("por recurso: o grupo do profissional ganha o compromisso, perde o '+ livre' e o item não repete no fim", () => {
    const groups = buildDayList({ day: d, internal: [folga], groupBy: "person", mode: "recurso", now: NOW, withFree: true });
    const ana = groups.find((g) => g.key === "res:ana")!;
    expect(ana.entries.map((e) => e.kind)).toEqual(["internal"]);
    const bia = groups.find((g) => g.key === "res:bia")!;
    expect(bia.entries.some((e) => e.kind === "free")).toBe(true);
    expect(groups.some((g) => g.kind === "internal")).toBe(false);
  });
  it("compromisso sem dono-recurso continua no grupo próprio", () => {
    const groups = buildDayList({ day: d, internal: [{ ...folga, memberIds: ["x"] }], groupBy: "person", mode: "recurso", now: NOW, withFree: true });
    expect(groups.find((g) => g.kind === "internal")?.entries).toHaveLength(1);
  });
  it("proposta vencida: marcada como vencida e sem 'sem lugar'", () => {
    const old = appt([], at(8), at(9), { status: "pending_approval" }, ["sala1"]);
    const live = appt(["sala1"], at(14), at(15), { status: "pending_approval" });
    const [g] = buildDayList({ day: day([old, live]), internal: [], groupBy: "room", mode: "hora", now: NOW, withFree: false });
    const byId = (id: string) => g.entries.find((e) => e.kind === "appointment" && e.appointment._id === id) as Extract<(typeof g.entries)[number], { kind: "appointment" }>;
    expect(byId(old._id)).toMatchObject({ expired: true, conflict: false });
    expect(byId(live._id)).toMatchObject({ expired: false });
  });
});
