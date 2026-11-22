import { describe, expect, it } from "vitest";
import { appointmentTooltip, compactText, COMPACT_MAX_PX, placeText, planBlock, statusFlags, timeRangeLabel } from "./agendaBlockText";
import { appointmentTone, PALETTE_SIZE, toneAt, toneIndexOf } from "./agendaColors";
import { initialScrollMinute, scrollTopFor, visibleHours } from "./agendaScroll";
import { DENSITY_HOUR_PX, PREFS_KEY, readPrefs, writePrefs } from "./agendaPrefs";
import { buildMonthLines, cutMonthLines, monthMaxLines, unseenCount } from "./agendaMonthLines";
import { buildWeekModel, FULL_LANES, LANES_WITH_MORE, type WeekResource } from "./agendaWeekGrid";
import type { GridAppointment, InternalItem } from "./agendaGrid";

const TZ = "America/Sao_Paulo";
/** Instante de HH:MM local (UTC-3) no dia 2026-11-D. */
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h + 3, m);

const appt = (id: string, day: number, h: number, durMin = 60, over: Partial<GridAppointment> = {}): GridAppointment => ({
  _id: id as GridAppointment["_id"],
  serviceName: "Sessão",
  startTime: at(day, h),
  endTime: at(day, h) + durMin * 60_000,
  status: "scheduled",
  origin: "staff",
  localDate: `2026-11-${String(day).padStart(2, "0")}`,
  resources: [{ resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true }],
  contactName: `Cliente ${id}`,
  ...over,
});

const internalItem = (id: string, day: number, h: number, over: Partial<InternalItem> = {}): InternalItem => ({
  id,
  title: `Reunião ${id}`,
  startTime: at(day, h),
  endTime: at(day, h + 1),
  eventType: "meeting",
  source: "event",
  allDay: false,
  memberIds: [],
  ...over,
});

describe("planBlock", () => {
  it("bloco curto vira uma linha só", () => {
    expect(planBlock(28)).toEqual({ compact: true, rows: [] });
    expect(planBlock(COMPACT_MAX_PX - 1).compact).toBe(true);
  });
  it("mais altura, mais linhas, na ordem de prioridade", () => {
    expect(planBlock(40)).toEqual({ compact: false, rows: ["title", "time"] });
    expect(planBlock(54).rows).toEqual(["title", "time", "service"]);
    expect(planBlock(120).rows).toEqual(["title", "time", "service", "place"]);
  });
  it("altura inválida cai no compacto", () => {
    expect(planBlock(Number.NaN).compact).toBe(true);
  });
});

describe("texto do bloco", () => {
  it("faixa com travessão e linha compacta", () => {
    expect(timeRangeLabel(at(26, 11), at(26, 11, 50), TZ)).toBe("11:00 – 11:50");
    expect(compactText(11 * 60, "Maria", "Sessão")).toBe("11:00 Maria · Sessão");
    expect(compactText(9 * 60 + 5, "Maria")).toBe("09:05 Maria");
  });
  it("lugar sem o recurso da coluna", () => {
    const a = appt("a", 26, 11, 60, {
      resources: [
        { resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true },
        { resourceId: "p1" as never, role: "person", name: "Dra. Ana", allocated: true },
        { resourceId: "p2" as never, role: "person", name: "Dr. Beto", allocated: false },
      ],
    });
    expect(placeText(a)).toBe("Sala 1, Dra. Ana");
    expect(placeText(a, "r1")).toBe("Dra. Ana");
  });
  it("sinais de estado: situação, IA e conflito", () => {
    const now = false;
    expect(statusFlags(appt("a", 26, 11, 60, { status: "pending_approval", origin: "ai" }), now)).toEqual(["pending", "ai"]);
    expect(statusFlags(appt("b", 19, 11, 60, { status: "pending_approval" }), true)).toEqual(["expired"]);
    expect(statusFlags(appt("c", 26, 11, 60, { status: "confirmed" }), now)).toEqual(["confirmed"]);
    expect(statusFlags(appt("d", 26, 11, 60, { status: "checked_in" }), now)).toEqual(["checked_in"]);
    expect(statusFlags(appt("e", 26, 11), now)).toEqual([]);
    expect(
      statusFlags(appt("f", 26, 11, 60, { resources: [{ resourceId: "r1" as never, role: "room", name: "S", allocated: false }] }), now)
    ).toEqual(["conflict"]);
  });
  it("tooltip junta cliente, horário, serviço, lugar e situação", () => {
    const t = appointmentTooltip(appt("a", 26, 11, 50, { status: "confirmed" }), TZ, false, "Vencida");
    expect(t).toBe("Cliente a · 11:00 – 11:50 · Sessão · Sala 1 · Confirmado");
    expect(appointmentTooltip(appt("b", 19, 9, 60, { status: "pending_approval" }), TZ, true, "Vencida")).toContain("Vencida");
  });
});

describe("cores", () => {
  const ctx = { resourceOrder: ["r1", "p1"], serviceOrder: ["s1", "s2"] };
  it("posição estável e volta ao começo", () => {
    expect(toneIndexOf(["a", "b"], "b")).toBe(1);
    expect(toneIndexOf(["a", "b"], "zzz")).toBe(0);
    expect(toneAt(PALETTE_SIZE)).toBe(toneAt(0));
    expect(toneAt(-1)).toBe(toneAt(PALETTE_SIZE - 1));
  });
  it("status usa a classe da situação; recurso e serviço usam a paleta", () => {
    const a = appt("a", 26, 11, 60, { serviceId: "s2" as never });
    expect(appointmentTone(a, { ...ctx, scheme: "status" }).block).toContain("border-semantic-info");
    expect(appointmentTone(a, { ...ctx, scheme: "servico" }).block).toBe(toneAt(1).block);
    expect(appointmentTone(a, { ...ctx, scheme: "recurso" }).block).toBe(toneAt(0).block);
  });
  it("proposta fica tracejada nos esquemas de recurso e serviço", () => {
    const a = appt("a", 26, 11, 60, { status: "pending_approval" });
    expect(appointmentTone(a, { ...ctx, scheme: "recurso" }).block).toContain("border-dashed");
  });
});

describe("rolagem inicial", () => {
  it("abre no começo do expediente, com meia hora de folga", () => {
    expect(initialScrollMinute({ nowMin: null, openStartMin: 9 * 60, openEndMin: 18 * 60 })).toBe(8 * 60 + 30);
    expect(initialScrollMinute({ nowMin: null, openStartMin: 0, openEndMin: 600 })).toBe(0);
  });
  it("hoje: 'agora' com duas horas de folga, nunca antes do expediente", () => {
    expect(initialScrollMinute({ nowMin: 15 * 60, openStartMin: 9 * 60, openEndMin: 18 * 60 })).toBe(13 * 60);
    expect(initialScrollMinute({ nowMin: 9 * 60 + 10, openStartMin: 9 * 60, openEndMin: 18 * 60 })).toBe(8 * 60 + 30);
  });
  it("agora fora do expediente volta ao começo do expediente", () => {
    expect(initialScrollMinute({ nowMin: 23 * 60, openStartMin: 9 * 60, openEndMin: 18 * 60 })).toBe(8 * 60 + 30);
  });
  it("não esconde um agendamento de madrugada", () => {
    expect(initialScrollMinute({ nowMin: null, openStartMin: 9 * 60, openEndMin: 18 * 60, firstItemMin: 6 * 60 })).toBe(5 * 60 + 30);
  });
  it("px e horas visíveis", () => {
    expect(scrollTopFor(8 * 60, 56)).toBe(448);
    expect(scrollTopFor(-5, 56)).toBe(0);
    expect(visibleHours(700, 56)).toBe(12.5);
    expect(visibleHours(700, 0)).toBe(0);
  });
});

describe("preferências", () => {
  const fake = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("grava, mescla e lê validando", () => {
    const s = fake();
    writePrefs("org1", { view: "semana", group: "profissional" }, s);
    writePrefs("org1", { density: "compacta", group: null }, s);
    expect(readPrefs("org1", s)).toMatchObject({ view: "semana", density: "compacta" });
    expect(readPrefs("org1", s).group).toBeUndefined();
    expect(readPrefs("org2", s)).toEqual({});
  });
  it("valor inválido, JSON quebrado e storage que lança viram padrão", () => {
    const s = fake();
    s.m.set(`${PREFS_KEY}:o`, JSON.stringify({ view: "ano", color: "xyz", density: 3, resource: "" }));
    expect(readPrefs("o", s)).toEqual({ view: undefined, group: undefined, color: undefined, density: undefined, resource: undefined });
    s.m.set(`${PREFS_KEY}:o`, "{quebrado");
    expect(readPrefs("o", s)).toEqual({});
    const boom = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(readPrefs("o", boom)).toEqual({});
    expect(() => writePrefs("o", { view: "dia" }, boom)).not.toThrow();
    expect(readPrefs("o", null)).toEqual({});
  });
  it("densidade em px por hora cresce", () => {
    expect(DENSITY_HOUR_PX.compacta).toBeLessThan(DENSITY_HOUR_PX.padrao);
    expect(DENSITY_HOUR_PX.padrao).toBeLessThan(DENSITY_HOUR_PX.confortavel);
  });
});

describe("linhas do mês", () => {
  const dates = ["2026-11-26", "2026-11-27"];
  it("ordena por horário, dia inteiro primeiro, e ignora cancelado", () => {
    const lines = buildMonthLines({
      dates,
      tz: TZ,
      appointments: [appt("b", 26, 14), appt("a", 26, 9), appt("c", 26, 10, 60, { status: "cancelled" }), appt("d", 27, 8)],
      internal: [internalItem("e1", 26, 11), internalItem("e2", 26, 0, { allDay: true, startTime: at(26, 0), endTime: at(27, 0) })],
    });
    expect(lines["2026-11-26"].map((l) => l.label)).toEqual(["Reunião e2", "Cliente a", "Reunião e1", "Cliente b"]);
    expect(lines["2026-11-27"].map((l) => l.label)).toEqual(["Cliente d"]);
  });
  it("altura da célula vira número de linhas", () => {
    expect(monthMaxLines(60)).toBe(1);
    expect(monthMaxLines(120)).toBe(5);
    expect(monthMaxLines(Number.NaN)).toBe(2);
  });
  it("corte: cabendo mostra tudo; senão a última linha vira +N mais", () => {
    expect(cutMonthLines([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(cutMonthLines([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2], hidden: 3 });
    expect(cutMonthLines([1, 2], 1)).toEqual({ shown: [], hidden: 2 });
  });
  it("leitura cortada: a contagem do servidor completa o +N", () => {
    expect(cutMonthLines([1, 2], 5, 4)).toEqual({ shown: [1, 2], hidden: 4 });
    expect(unseenCount(9, 5)).toBe(4);
    expect(unseenCount(3, 5)).toBe(0);
  });
});

describe("Semana", () => {
  const dates = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
  const resources: WeekResource[] = [
    { _id: "r1", kind: "room", name: "Sala 1", active: true, weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) },
    { _id: "p1", kind: "person", name: "Dra. Ana", active: true, teamMemberId: "m1", weekly: [4].map((weekday) => ({ weekday, startMin: 480, endMin: 720 })) },
  ];
  const base = { dates, tz: TZ, now: at(26, 10), resources, filterResourceId: null as string | null };

  it("junta agendamento com cliente e compromisso da equipe na mesma coluna, lado a lado", () => {
    const m = buildWeekModel({ ...base, appointments: [appt("a", 26, 11)], internal: [internalItem("e1", 26, 11)] });
    const day = m.days[3];
    expect(day.placed).toHaveLength(2);
    expect(day.placed.map((p) => p.columns)).toEqual([2, 2]);
    expect(new Set(day.placed.map((p) => p.column))).toEqual(new Set([0, 1]));
    expect(day.count).toBe(2);
    expect(m.todayIndex).toBe(3);
    expect(m.nowMin).toBe(10 * 60);
    expect(day.isToday).toBe(true);
    expect(m.empty).toBe(false);
  });
  it("agendamento com duas salas aparece uma vez", () => {
    const a = appt("a", 26, 11, 60, {
      resources: [
        { resourceId: "r1" as never, role: "room", name: "Sala 1", allocated: true },
        { resourceId: "p1" as never, role: "person", name: "Dra. Ana", allocated: true },
      ],
    });
    expect(buildWeekModel({ ...base, appointments: [a], internal: [] }).days[3].placed).toHaveLength(1);
  });
  it("até 3 sobrepostos aparecem todos; acima disso 2 faixas e a ficha +N", () => {
    const three = Array.from({ length: FULL_LANES }, (_, i) => appt(`t${i}`, 25, 10));
    const d3 = buildWeekModel({ ...base, appointments: three, internal: [] }).days[2];
    expect(d3.placed.map((p) => p.columns)).toEqual([3, 3, 3]);
    expect(d3.overflow).toHaveLength(0);
    const many = Array.from({ length: 6 }, (_, i) => appt(`m${i}`, 25, 10));
    const day = buildWeekModel({ ...base, appointments: many, internal: [] }).days[2];
    expect(day.placed).toHaveLength(LANES_WITH_MORE);
    expect(day.placed.every((p) => p.columns === LANES_WITH_MORE + 1)).toBe(true);
    expect(day.overflow).toHaveLength(1);
    expect(day.overflow[0]).toMatchObject({ hidden: many.length - LANES_WITH_MORE, column: LANES_WITH_MORE, columns: LANES_WITH_MORE + 1 });
    expect(day.count).toBe(6);
  });
  it("filtro por recurso: só o que é dele; compromisso só do profissional dono; sala não mostra compromisso", () => {
    const appts = [appt("a", 26, 9), appt("b", 26, 12, 60, { resources: [{ resourceId: "p1" as never, role: "person", name: "Ana", allocated: true }] })];
    const evs = [internalItem("e1", 26, 15, { memberIds: ["m1"] }), internalItem("e2", 26, 16, { memberIds: ["m2"] })];
    const room = buildWeekModel({ ...base, filterResourceId: "r1", appointments: appts, internal: evs }).days[3];
    expect(room.placed.map((p) => p.item.id)).toEqual(["appt:a"]);
    const person = buildWeekModel({ ...base, filterResourceId: "p1", appointments: appts, internal: evs }).days[3];
    expect(person.placed.map((p) => p.item.id).sort()).toEqual(["appt:b", "event:e1"]);
    expect(buildWeekModel({ ...base, appointments: appts, internal: evs }).days[3].placed).toHaveLength(4);
  });
  it("compromisso de dia inteiro vai para a faixa do topo", () => {
    const e = internalItem("f", 26, 0, { allDay: true, startTime: at(26, 0), endTime: at(27, 0) });
    const day = buildWeekModel({ ...base, appointments: [], internal: [e] }).days[3];
    expect(day.allDay).toHaveLength(1);
    expect(day.placed).toHaveLength(0);
  });
  it("expediente esmaecido por dia; dia sem escala é todo esmaecido; sem recursos nada esmaece", () => {
    const m = buildWeekModel({ ...base, filterResourceId: "r1", appointments: [], internal: [] });
    expect(m.days[0].offHours).toEqual([{ startMin: 0, endMin: 540 }, { startMin: 1080, endMin: 1440 }]);
    expect(m.days[5].offHours).toEqual([{ startMin: 0, endMin: 1440 }]);
    expect(m.openStartMin).toBe(540);
    expect(m.openEndMin).toBe(1080);
    const none = buildWeekModel({ ...base, resources: [], appointments: [], internal: [] });
    expect(none.days[0].offHours).toEqual([]);
    expect(none.openStartMin).toBe(480);
    expect(none.empty).toBe(true);
  });
  it("hoje fora da semana: sem linha de agora", () => {
    const m = buildWeekModel({ ...base, now: at(10, 10), appointments: [], internal: [] });
    expect(m.todayIndex).toBe(-1);
    expect(m.nowMin).toBeNull();
  });
  it("primeiro item da semana serve à rolagem", () => {
    expect(buildWeekModel({ ...base, appointments: [appt("a", 26, 11), appt("b", 24, 7)], internal: [] }).firstItemMin).toBe(7 * 60);
  });
});

import { buildMonthGrid, monthGridDates } from "./agendaMonthLines";
import { buildMonthCells } from "./agendaMonth";

describe("grade do mês", () => {
  it("semanas inteiras: do começo da semana do dia 1 ao fim da semana do último dia", () => {
    const d = monthGridDates("2026-11-26");
    expect(d[0]).toBe("2026-10-26");
    expect(d[d.length - 1]).toBe("2026-12-06");
    expect(d.length % 7).toBe(0);
    expect(monthGridDates("2027-02-10")).toHaveLength(28);
  });
  it("dias vizinhos ficam fora do mês; contagem do servidor só completa quando a leitura foi cortada", () => {
    const cells = buildMonthCells("2026-11-01", "2026-11-30", { days: [{ localDate: "2026-11-26", active: 9, pending: 2, closedResources: 1, occupancy: [] }], capped: false, completeThrough: null }, 3);
    const lines = buildMonthLines({ dates: monthGridDates("2026-11-26"), tz: TZ, appointments: [appt("a", 26, 9), appt("b", 26, 10)], internal: [internalItem("e", 26, 12)] });
    const weeks = buildMonthGrid({ date: "2026-11-26", cells, lines, truncated: false });
    const all = weeks.flat();
    expect(weeks).toHaveLength(6);
    expect(all.find((x) => x.localDate === "2026-10-30")!.inMonth).toBe(false);
    const d26 = all.find((x) => x.localDate === "2026-11-26")!;
    expect(d26).toMatchObject({ inMonth: true, unseen: 0, total: 3, pending: 2, someClosed: true, allClosed: false });
    const cut = buildMonthGrid({ date: "2026-11-26", cells, lines, truncated: true }).flat().find((x) => x.localDate === "2026-11-26")!;
    expect(cut).toMatchObject({ unseen: 7, total: 10 });
  });
});
