import { describe, expect, it } from "vitest";
import { CLOSURE_REASON_LABELS } from "./agendaClosures";
import {
  blockGeometry,
  CLOSURE_REASON_TEXT,
  buildDayGridModel,
  closedReasonOf,
  columnLoad,
  complementSpans,
  daySpan,
  freeGaps,
  gridHeight,
  hourLabels,
  isOnGrid,
  isOnList,
  layoutLanes,
  minuteFromOffset,
  nowLineTop,
  toInternalItems,
  type DayInput,
  type DayResource,
  type GridAppointment,
  type GridItem,
} from "./agendaGrid";

const TZ = "America/Sao_Paulo";
const DATE = "2026-11-23";
/** Instante de HH:MM local (UTC-3, sem horário de verão) do dia de teste. */
const at = (h: number, m = 0) => Date.UTC(2026, 10, 23, h + 3, m);

const res = (id: string, kind: DayResource["kind"], over: Partial<DayResource> = {}): DayResource => ({
  _id: id,
  kind,
  name: id,
  capacity: 1,
  sortOrder: 0,
  open: [{ start: at(8), end: at(18) }],
  closed: false,
  blocks: [],
  ...over,
});

let seq = 0;
const appt = (over: Partial<GridAppointment> & { rooms?: string[]; people?: string[]; conflict?: string[] } = {}): GridAppointment => {
  const { rooms = [], people = [], conflict = [], ...rest } = over;
  seq++;
  return {
    _id: `a${seq}` as never,
    serviceName: "Sessão",
    startTime: at(10),
    endTime: at(11),
    status: "scheduled",
    origin: "staff",
    localDate: DATE,
    contactName: `Cliente ${seq}`,
    resources: [
      ...rooms.map((id) => ({ resourceId: id as never, role: "room", name: id, allocated: true })),
      ...people.map((id) => ({ resourceId: id as never, role: "person", name: id, allocated: true })),
      ...conflict.map((id) => ({ resourceId: id as never, role: "room", name: id, allocated: false })),
    ],
    ...rest,
  };
};

const day = (over: Partial<DayInput> = {}): DayInput => ({
  timezone: TZ,
  localDate: DATE,
  resources: [res("sala1", "room"), res("sala2", "room", { capacity: 2 }), res("ana", "person"), res("beto", "person")],
  appointments: [],
  busy: [],
  exceptions: [],
  ...over,
});

const NOW = at(9, 30);
const model = (d: DayInput, groupBy: "room" | "person" = "room", internal = toInternalItems([])) =>
  buildDayGridModel({ day: d, internal, groupBy, now: NOW });

describe("daySpan (fuso da org)", () => {
  it("minutos locais, não os do navegador", () => {
    expect(daySpan(at(10), at(11, 30), DATE, TZ)).toEqual({ startMin: 600, endMin: 690 });
  });
  it("recorta o que cruza a meia-noite e ignora o que não toca o dia", () => {
    expect(daySpan(at(23), at(25), DATE, TZ)).toEqual({ startMin: 1380, endMin: 1440 });
    expect(daySpan(at(-2), at(1), DATE, TZ)).toEqual({ startMin: 0, endMin: 60 });
    expect(daySpan(at(25), at(26), DATE, TZ)).toBeNull();
  });
});

describe("colunas por agrupamento", () => {
  it("por sala: só salas; por profissional: só profissionais, na ordem do servidor", () => {
    expect(model(day()).columns.map((c) => c.label)).toEqual(["sala1", "sala2"]);
    expect(model(day(), "person").columns.map((c) => c.label)).toEqual(["ana", "beto"]);
  });

  it("agendamento com sala e profissional aparece nas duas visões", () => {
    const a = appt({ rooms: ["sala1"], people: ["ana"] });
    const d = day({ appointments: [a] });
    expect(model(d).columns[0].placed).toHaveLength(1);
    expect(model(d, "person").columns[0].placed).toHaveLength(1);
  });

  it("agendamento só com profissional vai para 'Sem sala' na visão por sala", () => {
    const d = day({ appointments: [appt({ people: ["ana"] })] });
    const m = model(d);
    expect(m.columns.map((c) => c.label)).toEqual(["sala1", "sala2", "Sem sala"]);
    expect(m.noPlace).toHaveLength(0);
  });

  it("sem agendamento sem recurso, a coluna 'Sem sala' não existe", () => {
    expect(model(day()).columns.some((c) => c.kind === "unassigned")).toBe(false);
  });

  it("cancelado e remarcado ficam de fora da grade; faltou também (só na lista)", () => {
    const d = day({
      appointments: (["cancelled", "rescheduled", "no_show", "completed", "pending_approval"] as const).map((status) => appt({ rooms: ["sala1"], status })),
    });
    expect(model(d).columns[0].placed).toHaveLength(2);
    expect(isOnGrid("no_show")).toBe(false);
    expect(isOnList("no_show")).toBe(true);
    expect(isOnList("cancelled")).toBe(false);
  });
});

describe("faixas por capacidade", () => {
  const item = (id: string, s: number, e: number): GridItem => ({ kind: "busy", id, startMin: s, endMin: e });

  it("sala dupla com um agendamento: metade da largura (2 faixas)", () => {
    const [p] = layoutLanes([item("a", 600, 660)], 2);
    expect([p.column, p.columns]).toEqual([0, 2]);
  });
  it("sala simples sozinha: largura inteira", () => {
    expect(layoutLanes([item("a", 600, 660)], 1)[0].columns).toBe(1);
  });
  it("dois simultâneos na sala dupla: duas faixas lado a lado", () => {
    const lanes = layoutLanes([item("a", 600, 660), item("b", 600, 660)], 2);
    expect(lanes.map((l) => [l.column, l.columns]).sort()).toEqual([[0, 2], [1, 2]]);
  });
  it("acima da capacidade: faixas crescem (3 em capacidade 2) e a carga acusa 3/2", () => {
    const items = [item("a", 600, 660), item("b", 600, 660), item("c", 600, 660)];
    expect(Math.max(...layoutLanes(items, 2).map((l) => l.columns))).toBe(3);
    expect(columnLoad(items, null)).toEqual({ used: 3, basis: "peak" });
  });
  it("capacidade inválida vale 1", () => {
    expect(layoutLanes([item("a", 600, 660)], 0)[0].columns).toBe(1);
  });
  it("sem sobreposição, cada um volta a ocupar a largura mínima pela capacidade", () => {
    const lanes = layoutLanes([item("a", 600, 660), item("b", 660, 720)], 2);
    expect(lanes.every((l) => l.columns === 2)).toBe(true);
  });

  it("no modelo: 2 agendamentos simultâneos na sala dupla, carga agora 2/2", () => {
    const d = day({ appointments: [appt({ rooms: ["sala2"], startTime: at(9), endTime: at(10) }), appt({ rooms: ["sala2"], startTime: at(9), endTime: at(10) })] });
    const col = model(d).columns[1];
    expect(col.load).toEqual({ used: 2, basis: "now" });
    expect(col.placed.map((p) => p.columns)).toEqual([2, 2]);
  });
  it("em outro dia mostra o pico, não o agora", () => {
    const d = day({ appointments: [appt({ rooms: ["sala2"] })] });
    const m = buildDayGridModel({ day: d, internal: [], groupBy: "room", now: at(9) + 86_400_000 * 3 });
    expect(m.nowMin).toBeNull();
    expect(m.columns[1].load).toEqual({ used: 1, basis: "peak" });
  });
});

describe("coluna fechada", () => {
  const closedDay = (exceptions: DayInput["exceptions"]) =>
    day({ resources: [res("sala1", "room", { closed: true, open: [] }), res("sala2", "room")], exceptions });

  it("marca fechada, sem trechos esmaecidos, com o motivo do código", () => {
    const c = model(closedDay([{ resourceId: "sala1", mode: "closed", reasonCode: "maintenance" }])).columns[0];
    expect(c.closed).toBe(true);
    expect(c.closedReason).toBe("Manutenção");
    expect(c.offHours).toEqual([]);
  });
  it("texto livre vence o código; exceção da org inteira e do tipo valem; só 'closed' conta", () => {
    expect(closedReasonOf({ _id: "x", kind: "room" }, [{ mode: "closed", reasonCode: "holiday", reason: " Obra " }])).toBe("Obra");
    expect(closedReasonOf({ _id: "x", kind: "room" }, [{ mode: "closed", resourceKind: "room", reasonCode: "holiday" }])).toBe("Feriado");
    expect(closedReasonOf({ _id: "x", kind: "person" }, [{ mode: "closed", resourceKind: "room", reasonCode: "holiday" }])).toBeNull();
    expect(closedReasonOf({ _id: "x", kind: "room" }, [{ mode: "block", resourceId: "x", reasonCode: "other" }])).toBeNull();
  });
  it("view_own: sem motivo gravado vira null (a tela mostra só 'Fechada hoje')", () => {
    expect(model(closedDay([{ resourceId: "sala1", mode: "closed" }])).columns[0].closedReason).toBeNull();
  });
  it("a janela ignora colunas fechadas ao medir o expediente", () => {
    const d = day({
      resources: [res("sala1", "room", { closed: true, open: [{ start: at(5), end: at(23) }] }), res("sala2", "room", { open: [{ start: at(9), end: at(12) }] })],
    });
    expect(model(d).window).toEqual({ startHour: 9, endHour: 12 });
  });
});

describe("janela de horas", () => {
  it("usa o expediente do dia", () => {
    expect(model(day()).window).toEqual({ startHour: 8, endHour: 18 });
  });
  it("amplia para caber item fora do expediente", () => {
    const d = day({ appointments: [appt({ rooms: ["sala1"], startTime: at(6, 30), endTime: at(7, 30) }), appt({ rooms: ["sala1"], startTime: at(19), endTime: at(20, 15) })] });
    expect(model(d).window).toEqual({ startHour: 6, endHour: 21 });
  });
  it("tudo fechado: janela padrão de 08 às 18", () => {
    const d = day({ resources: [res("sala1", "room", { closed: true, open: [] })] });
    expect(model(d).window).toEqual({ startHour: 8, endHour: 18 });
  });
  it("esmaece o que está fora do expediente (intervalo de almoço incluído)", () => {
    const d = day({ resources: [res("sala1", "room", { open: [{ start: at(8), end: at(12) }, { start: at(14), end: at(18) }] })] });
    expect(model(d).columns[0].offHours).toEqual([{ startMin: 720, endMin: 840 }]);
  });
  it("bloqueio vira trecho bloqueado e não esmaecido", () => {
    const d = day({ resources: [res("sala1", "room", { open: [{ start: at(8), end: at(10) }, { start: at(11), end: at(18) }], blocks: [{ start: at(10), end: at(11) }] })] });
    const c = model(d).columns[0];
    expect(c.blocked).toEqual([{ startMin: 600, endMin: 660 }]);
    expect(c.offHours).toEqual([]);
  });
  it("complementSpans une e recorta", () => {
    expect(complementSpans([{ startMin: 60, endMin: 120 }, { startMin: 100, endMin: 200 }], 0, 300)).toEqual([
      { startMin: 0, endMin: 60 },
      { startMin: 200, endMin: 300 },
    ]);
  });
});

describe("sem lugar", () => {
  it("agendamento com recurso em conflito vai para a faixa 'Sem lugar'", () => {
    const a = appt({ conflict: ["sala1"] });
    const m = model(day({ appointments: [a] }));
    expect(m.noPlace).toEqual([a]);
    expect(m.columns.every((c) => c.placed.length === 0)).toBe(true);
  });
  it("com a sala alocada e o profissional em conflito: fica na sala, marcado como conflito", () => {
    const a = appt({ rooms: ["sala1"], conflict: ["ana"] });
    const m = model(day({ appointments: [a] }));
    expect(m.noPlace).toEqual([]);
    const item = m.columns[0].placed[0].item;
    expect(item.kind === "appointment" && item.conflict).toBe(true);
  });
  it("sem nenhum recurso: sem lugar", () => {
    expect(model(day({ appointments: [appt()] })).noPlace).toHaveLength(1);
  });
});

describe("ocupado anônimo (view_own)", () => {
  it("vira bloco 'busy' na coluna e conta na carga, sem dado de cliente", () => {
    const d = day({ busy: [{ resourceIds: ["sala1", "sala2"], start: at(9), end: at(10) }] });
    const m = model(d);
    for (const col of m.columns) {
      expect(col.placed).toHaveLength(1);
      expect(col.placed[0].item.kind).toBe("busy");
      expect(Object.keys(col.placed[0].item).sort()).toEqual(["endMin", "id", "kind", "startMin"]);
    }
    expect(m.columns[0].load.used).toBe(1);
    expect(m.empty).toBe(false);
  });
  it("busy de recurso que não está no agrupamento não aparece", () => {
    const d = day({ busy: [{ resourceIds: ["ana"], start: at(9), end: at(10) }] });
    expect(model(d).columns.every((c) => c.placed.length === 0)).toBe(true);
  });
});

describe("compromissos e tarefas junto", () => {
  const items = toInternalItems([
    { _id: "e1", title: "Reunião", startTime: at(14), endTime: at(15), eventType: "meeting", canEdit: true },
    { _id: "t1", title: "Ligar", startTime: at(9), endTime: at(9), eventType: "task", _source: "task" },
    { _id: "e2", title: "Feriado", startTime: at(0), endTime: at(24), eventType: "other", allDay: true },
    { nope: true },
  ]);
  it("normaliza e descarta o inválido", () => {
    expect(items.map((i) => [i.id, i.source, i.allDay])).toEqual([
      ["e2", "event", true],
      ["t1", "task", false],
      ["e1", "event", false],
    ]);
  });
  it("coluna própria, distinta das salas, e dia inteiro à parte", () => {
    const m = model(day(), "room", items);
    const col = m.columns.at(-1)!;
    expect(col.kind).toBe("internal");
    expect(col.placed.map((p) => p.item.id)).toEqual(["task:t1", "event:e1"]);
    expect(m.allDay.map((e) => e.id)).toEqual(["e2"]);
    expect(m.empty).toBe(false);
  });
  it("dia só com compromisso não é vazio; sem nada é vazio", () => {
    expect(model(day()).empty).toBe(true);
  });
  it("tarefa sem duração vira bloco de 30 min na geometria", () => {
    expect(blockGeometry(540, 540, 8).height).toBe(30);
  });
});

describe("vagas livres", () => {
  it("expediente menos o que está marcado, respeitando a capacidade", () => {
    const d = day({ appointments: [appt({ rooms: ["sala1"], startTime: at(9), endTime: at(10) })] });
    const c = model(d).columns[0];
    expect(freeGaps(c, DATE, TZ)).toEqual([
      { startMin: 480, endMin: 540 },
      { startMin: 600, endMin: 1080 },
    ]);
  });
  it("sala dupla com 1 ocupante continua livre", () => {
    const d = day({ appointments: [appt({ rooms: ["sala2"], startTime: at(9), endTime: at(10) })] });
    expect(freeGaps(model(d).columns[1], DATE, TZ)).toEqual([{ startMin: 480, endMin: 1080 }]);
  });
  it("sala dupla cheia (2) não oferece o horário", () => {
    const two = [appt({ rooms: ["sala2"], startTime: at(9), endTime: at(10) }), appt({ rooms: ["sala2"], startTime: at(9), endTime: at(10) })];
    const gaps = freeGaps(model(day({ appointments: two })).columns[1], DATE, TZ);
    expect(gaps).toEqual([{ startMin: 480, endMin: 540 }, { startMin: 600, endMin: 1080 }]);
  });
  it("a partir de agora e sem trechos curtos; fechada = nenhum", () => {
    const c = model(day()).columns[0];
    expect(freeGaps(c, DATE, TZ, { fromMin: 17 * 60 + 45 })).toEqual([]);
    expect(freeGaps({ ...c, closed: true }, DATE, TZ)).toEqual([]);
  });
});

describe("geometria", () => {
  it("topo e altura em px a partir da janela", () => {
    expect(blockGeometry(600, 660, 8)).toEqual({ top: 120, height: 60 });
  });
  it("minuto do clique em passos de 15, dentro da janela", () => {
    expect(minuteFromOffset(0, 8, 18)).toBe(480);
    expect(minuteFromOffset(75, 8, 18)).toBe(555);
    expect(minuteFromOffset(99999, 8, 18)).toBe(1065);
    expect(minuteFromOffset(-5, 8, 18)).toBe(480);
  });
  it("linha do agora só dentro da janela", () => {
    expect(nowLineTop(570, { startHour: 8, endHour: 18 })).toBe(90);
    expect(nowLineTop(300, { startHour: 8, endHour: 18 })).toBeNull();
    expect(nowLineTop(null, { startHour: 8, endHour: 18 })).toBeNull();
  });
  it("altura e rótulos do eixo", () => {
    expect(gridHeight({ startHour: 8, endHour: 10 })).toBe(120);
    expect(hourLabels({ startHour: 8, endHour: 11 })).toEqual([8, 9, 10]);
  });
});

describe("motivos do fechamento", () => {
  it("espelham os das Configurações (cópia só para não criar chunk compartilhado)", () => {
    expect(CLOSURE_REASON_TEXT).toEqual(CLOSURE_REASON_LABELS);
  });
});
