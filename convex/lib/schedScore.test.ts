import { describe, expect, it } from "vitest";
import { type AllocationLite, computeDayAvailability, type ResourceLite } from "./schedAvailability";
import { type Candidate, generateCandidates, type ServiceLite } from "./schedCandidates";
import {
  applySmartMode,
  DEFAULT_WEIGHTS,
  pickOffers,
  SCORE_REASON_CODES,
  type ScoredCandidate,
  scoreCandidate,
  type SmartWeights,
} from "./schedScore";
import { atLocalMinutes } from "./schedTime";

const tz = "America/Sao_Paulo";
const MIN = 60_000;
const MON = "2026-11-23";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return atLocalMinutes(date, h * 60 + m, tz);
};
const hhmm = (ms: number) => {
  const d = new Date(ms - 3 * 60 * MIN);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const room = (id: string, over: Partial<ResourceLite> = {}): ResourceLite => ({
  _id: id, kind: "room", name: `Sala ${id}`, capacity: 1,
  weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }], sortOrder: 0, active: true, ...over,
});
const row = (resourceId: string, s: string, e: string, over: Partial<AllocationLite> = {}): AllocationLite => ({
  appointmentId: `a-${resourceId}-${s}`, resourceId,
  blockStart: at(MON, s), blockEnd: at(MON, e), coreStart: at(MON, s), coreEnd: at(MON, e), units: 1, ...over,
});
const service = (over: Partial<ServiceLite> = {}): ServiceLite => ({
  _id: "s1", name: "Serviço", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
  requirements: [{ role: "Sala", kind: "room" }], ...over,
});
function setup(resources: ResourceLite[], allocations: AllocationLite[], extra: { exceptions?: Parameters<typeof computeDayAvailability>[0]["exceptions"]; internalEvents?: Parameters<typeof computeDayAvailability>[0]["internalEvents"] } = {}) {
  return computeDayAvailability({ date: MON, tz, resources, exceptions: extra.exceptions ?? [], allocations, internalEvents: extra.internalEvents ?? [] });
}
const W: SmartWeights = { ...DEFAULT_WEIGHTS, balance: 0 };
const cand = (res: string, s: string, e: string): Candidate => ({
  startTime: at(MON, s), endTime: at(MON, e), blockStart: at(MON, s), blockEnd: at(MON, e),
  plan: [{ role: "Sala", resourceId: res, units: 1 }],
});

describe("exemplo das 3 salas (relatório 04 §5.3)", () => {
  // Salas A, B, C abertas 08:00–18:00 (C capacidade 2, vazia). Menor serviço 30 min; grade 15; pedido de 60 min.
  // A: 09:00–10:00 e 10:00–11:00; B: 14:00–15:00. Pesos 40/50/20/10/0.
  const rooms = [room("A", { sortOrder: 1 }), room("B", { sortOrder: 2 }), room("C", { sortOrder: 3, capacity: 2 })];
  const rows = [row("A", "09:00", "10:00"), row("A", "10:00", "11:00"), row("B", "14:00", "15:00")];
  const day = setup(rooms, rows);
  const opts = { minUsefulGapMin: 30 };

  const expected: Array<[string, string, string, number, number, number, number, number]> = [
    // sala, início, fim, adjacency, deadGap, openNew, earlyFirst(feature), score
    ["A", "08:00", "09:00", 1.0, 0, 0, 1.0, 50.0],
    ["A", "11:00", "12:00", 0.5, 0, 0, 1 - 180 / 540, 26.667],
    ["B", "13:00", "14:00", 0.5, 0, 0, 1 - 300 / 540, 24.444],
    ["C", "08:00", "09:00", 0.5, 0, 1, 1.0, 10.0],
    ["A", "11:15", "12:15", 0.0, 1, 0, 1 - 195 / 540, -43.611],
  ];
  it.each(expected)("%s %s–%s tem adjacency %d, deadGap %d, openNew %d, earlyFirst %d e score %d", (r, s, e, adj, dead, openNew, early, score) => {
    const sc = scoreCandidate(cand(r, s, e), day, W, opts);
    expect(sc.features.adjacency).toBeCloseTo(adj, 6);
    expect(sc.features.deadGap).toBe(dead);
    expect(sc.features.openNewResource).toBe(openNew);
    expect(sc.features.earlyFirst).toBeCloseTo(early, 6);
    expect(sc.score).toBeCloseTo(score, 2);
  });

  it("parcelas com sinal e razões em PT-BR (A 08:00 e A 11:15)", () => {
    const a8 = scoreCandidate(cand("A", "08:00", "09:00"), day, W, opts);
    expect(a8.parts).toMatchObject({ adjacency: 40, deadGap: 0, openNewResource: 0, earlyFirst: 10, balance: 0, preference: 0 });
    expect(a8.reasons).toEqual(["no início do expediente", "logo antes de outro atendimento"]);
    const a1115 = scoreCandidate(cand("A", "11:15", "12:15"), day, W, opts);
    expect(a1115.parts.deadGap).toBe(-50);
    expect(a1115.reasons).toContain("deixa uma lacuna de 15 min");
    const c8 = scoreCandidate(cand("C", "08:00", "09:00"), day, W, opts);
    expect(c8.parts.openNewResource).toBe(-20);
    expect(c8.reasons).toContain("abre um recurso novo");
    expect(scoreCandidate(cand("A", "11:00", "12:00"), day, W, opts).reasons).toContain("logo após outro atendimento");
  });

  it("reasonCodes: estruturados, na ordem da lista fechada, coerentes com o texto", () => {
    const a8 = scoreCandidate(cand("A", "08:00", "09:00"), day, W, opts);
    expect(a8.reasonCodes).toEqual(["ADJACENT", "ADJACENT_AFTER", "EDGE_OF_DAY", "EARLY"]);
    expect(scoreCandidate(cand("A", "11:00", "12:00"), day, W, opts).reasonCodes).toEqual(expect.arrayContaining(["ADJACENT", "ADJACENT_BEFORE"]));
    expect(scoreCandidate(cand("A", "11:15", "12:15"), day, W, opts).reasonCodes).toContain("DEAD_GAP");
    const c8 = scoreCandidate(cand("C", "08:00", "09:00"), day, W, opts);
    expect(c8.reasonCodes).toContain("NEW_RESOURCE");
    expect(c8.reasonCodes).toContain("EDGE_OF_DAY");
    expect(c8.reasonCodes).not.toContain("ADJACENT");
    for (const code of [a8, c8].flatMap((x) => x.reasonCodes)) expect(SCORE_REASON_CODES).toContain(code);
    // Detalhe do lado só vem junto de ADJACENT.
    for (const [r, st, en] of expected) {
      const codes = scoreCandidate(cand(r, st, en), day, W, opts).reasonCodes;
      if (codes.includes("ADJACENT_BEFORE") || codes.includes("ADJACENT_AFTER")) expect(codes).toContain("ADJACENT");
    }
  });

  it("reasonCodes: PREFERENCE e BALANCE só com peso/preferência", () => {
    const pref = scoreCandidate(cand("A", "11:00", "12:00"), day, W, { ...opts, tz: "UTC", preference: { resourceIds: ["A"] } });
    expect(pref.reasonCodes).toContain("PREFERENCE");
    expect(scoreCandidate(cand("A", "11:00", "12:00"), day, { ...W, earlyFirst: 0 }, opts).reasonCodes).not.toContain("EARLY");
  });

  it("ranking A 08:00 > A 11:00 > B 13:00 > C 08:00 > A 11:15", () => {
    const five = expected.map(([r, s, e]) => scoreCandidate(cand(r, s, e), day, W, opts));
    const { list } = applySmartMode(five, "rank", 3, "ai", tz);
    expect(list.map((c) => `${c.plan[0].resourceId} ${hhmm(c.startTime)}`)).toEqual([
      "A 08:00", "A 11:00", "B 13:00", "C 08:00", "A 11:15",
    ]);
  });

  it("restrict oferta os quatro primeiros e esconde A 11:15; com minOffer maior cai para rank (relaxed)", () => {
    const five = expected.map(([r, s, e]) => scoreCandidate(cand(r, s, e), day, W, opts));
    const strict = applySmartMode(five, "restrict", 3, "public", tz);
    expect(strict.relaxed).toBe(false);
    expect(strict.list.map((c) => `${c.plan[0].resourceId} ${hhmm(c.startTime)}`)).toEqual(["A 08:00", "A 11:00", "B 13:00", "C 08:00"]);
    // só 3 inícios distintos (A e C às 08:00) -> pedir 4 força o fallback
    const relaxed = applySmartMode(five, "restrict", 4, "public", tz);
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.list).toHaveLength(5);
  });

  it("a grade completa de 15 min: o melhor é A 08:00 e A 11:15 nunca passa no restrict", () => {
    const all = generateCandidates({
      date: MON, tz, gridMinutes: 15, service: service(), day, earliest: 0, latest: Number.MAX_SAFE_INTEGER, maxPerStart: 3,
    }).map((c) => scoreCandidate(c, day, W, opts));
    const ranked = applySmartMode(all, "rank", 3, "ai", tz).list;
    expect(`${ranked[0].plan[0].resourceId} ${hhmm(ranked[0].startTime)}`).toBe("A 08:00");
    expect(ranked[0].score).toBeCloseTo(50, 6);
    const r = applySmartMode(all, "restrict", 3, "ai", tz);
    expect(r.relaxed).toBe(false);
    expect(r.list.some((c) => c.plan[0].resourceId === "A" && hhmm(c.startTime) === "11:15")).toBe(false);
    expect(r.list.every((c) => c.features.deadGap === 0 && c.features.adjacency > 0)).toBe(true);
    // Observação do relatório: a tabela dos 5 candidatos é uma SELEÇÃO, não a lista completa.
    // B 08:00 (sala que já tem agendamento no dia, borda do expediente) vale 20 + 10 = 30 e ficaria em 2º.
    const b8 = ranked.find((c) => c.plan[0].resourceId === "B" && hhmm(c.startTime) === "08:00")!;
    expect(b8.score).toBeCloseTo(30, 6);
    expect(ranked.indexOf(b8)).toBeLessThan(ranked.findIndex((c) => c.plan[0].resourceId === "A" && hhmm(c.startTime) === "11:00"));
  });
});

describe("vizinhos: bloqueio, compromisso interno e borda", () => {
  const opts = { minUsefulGapMin: 30 };
  it("bloqueio conta como vizinho e como borda", () => {
    const day = setup([room("A")], [], { exceptions: [{ localDate: MON, mode: "block", resourceId: "A", intervals: [{ startMin: 600, endMin: 660 }] }] });
    const after = scoreCandidate(cand("A", "11:00", "12:00"), day, W, opts);
    expect(after.features.adjacency).toBe(0.5);
    expect(after.reasons).toContain("logo após outro atendimento");
    const gap = scoreCandidate(cand("A", "11:15", "12:15"), day, W, opts);
    expect(gap.features.deadGap).toBe(1); // 15 min entre o bloqueio e o candidato
    const before = scoreCandidate(cand("A", "09:00", "10:00"), day, W, opts);
    expect(before.features.adjacency).toBe(0.5); // colado no bloqueio (10:00)
  });
  it("compromisso interno do recurso-pessoa conta como vizinho", () => {
    const p = room("P", { kind: "person", teamMemberId: "tm1" });
    const day = setup([p], [], { internalEvents: [{ teamMemberId: "tm1", start: at(MON, "13:00"), end: at(MON, "14:00") }] });
    const c: Candidate = { ...cand("P", "14:00", "15:00"), plan: [{ role: "Pessoa", resourceId: "P", units: 1 }] };
    const sc = scoreCandidate(c, day, W, opts);
    expect(sc.features.adjacency).toBe(0.5);
    expect(sc.reasons).toContain("logo após outro atendimento");
  });
  it("borda de cada turno vale (almoço): colado no fim do turno da manhã", () => {
    const r = room("A", { weekly: [{ weekday: 1, startMin: 480, endMin: 720 }, { weekday: 1, startMin: 840, endMin: 1080 }] });
    const day = setup([r], []);
    expect(scoreCandidate(cand("A", "11:00", "12:00"), day, W, opts).features.adjacency).toBe(0.5);
    expect(scoreCandidate(cand("A", "14:00", "15:00"), day, W, opts).features.adjacency).toBe(0.5);
    expect(scoreCandidate(cand("A", "11:30", "12:30"), day, { ...W }, opts).features.adjacency).toBeGreaterThanOrEqual(0); // inválido (cruza o almoço) mas não quebra
  });
  it("alocação que sobrepõe (sala dupla) não é vizinho; folga entra no bloco", () => {
    const dupla = room("D", { capacity: 2 });
    const day = setup([dupla], [row("D", "10:00", "11:00")]);
    const over = scoreCandidate(cand("D", "10:00", "11:00"), day, W, opts);
    expect(over.features.adjacency).toBe(0); // sobreposto: ignorado
    expect(over.features.deadGap).toBe(0);
    // candidato com folga de 10 min antes colado no fim de outro bloco
    const day2 = setup([room("A")], [row("A", "09:00", "10:00")]);
    const buff: Candidate = { startTime: at(MON, "10:10"), endTime: at(MON, "11:10"), blockStart: at(MON, "10:00"), blockEnd: at(MON, "11:10"), plan: [{ role: "Sala", resourceId: "A", units: 1 }] };
    expect(scoreCandidate(buff, day2, W, opts).features.adjacency).toBe(0.5);
  });
});

describe("balance, preferência e vários recursos", () => {
  const opts = { minUsefulGapMin: 30 };
  it("balance só vale para pessoas e favorece a menos carregada", () => {
    const p1 = room("P1", { kind: "person" });
    const p2 = room("P2", { kind: "person" });
    const day = setup([p1, p2], [row("P1", "09:00", "11:00")]);
    const w = { ...W, balance: 10 };
    const c = (id: string): Candidate => ({ ...cand(id, "14:00", "15:00"), plan: [{ role: "Pessoa", resourceId: id, units: 1 }] });
    const s1 = scoreCandidate(c("P1"), day, w, opts);
    const s2 = scoreCandidate(c("P2"), day, w, opts);
    expect(s1.parts.balance).toBeCloseTo(0, 6); // maior carga
    expect(s2.parts.balance).toBeCloseTo(10, 6); // vazia
    expect(s2.reasons).toContain("equilibra a carga entre a equipe");
    const rooms = setup([room("R1")], [row("R1", "09:00", "11:00")]);
    expect(scoreCandidate(cand("R1", "14:00", "15:00"), rooms, w, opts).parts.balance).toBe(0);
  });
  it("preferência de período e de profissional (todas as informadas precisam casar)", () => {
    const day = setup([room("A"), room("B")], []);
    const morning = scoreCandidate(cand("A", "09:00", "10:00"), day, W, { ...opts, tz, preference: { period: "morning" } });
    const afternoon = scoreCandidate(cand("A", "14:00", "15:00"), day, W, { ...opts, tz, preference: { period: "morning" } });
    expect(morning.parts.preference).toBe(30);
    expect(afternoon.parts.preference).toBe(0);
    const both = scoreCandidate(cand("A", "09:00", "10:00"), day, W, { ...opts, tz, preference: { period: "morning", resourceIds: ["B"] } });
    expect(both.parts.preference).toBe(0);
    const byRes = scoreCandidate(cand("B", "09:00", "10:00"), day, W, { ...opts, preference: { resourceIds: ["B"] } });
    expect(byRes.parts.preference).toBe(30);
    expect(() => scoreCandidate(cand("A", "09:00", "10:00"), day, W, { ...opts, preference: { period: "evening" } })).toThrow(/tz/);
  });
  it("soma as parcelas entre os recursos do plano (sala + terapeuta)", () => {
    const day = setup([room("S"), room("T", { kind: "person" })], [row("S", "09:00", "10:00"), row("T", "09:00", "10:00")]);
    const c: Candidate = {
      ...cand("S", "10:00", "11:00"),
      plan: [{ role: "Sala", resourceId: "S", units: 1 }, { role: "Terapeuta", resourceId: "T", units: 1 }],
    };
    const sc = scoreCandidate(c, day, W, opts);
    expect(sc.parts.adjacency).toBeCloseTo(40, 6); // 20 + 20
    expect(sc.parts.earlyFirst).toBeCloseTo(2 * 10 * (1 - 120 / 540), 6);
  });
});

describe("applySmartMode", () => {
  const mk = (res: string, s: string, score: number, strict = true): ScoredCandidate => ({
    ...cand(res, s, `${String(Number(s.slice(0, 2)) + 1).padStart(2, "0")}:${s.slice(3)}`),
    score,
    parts: { adjacency: 0, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 },
    features: { adjacency: strict ? 1 : 0, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 },
    reasons: [], reasonCodes: [],
  });
  const list = [mk("A", "10:00", 5), mk("A", "09:00", 20), mk("B", "09:00", 20), mk("A", "11:00", 1, false)];

  it("off = cronológico (empate por plano); rank = maior pontuação, empate mais cedo e por plano", () => {
    expect(applySmartMode(list, "off", 3, "ai", tz).list.map((c) => `${c.plan[0].resourceId}${hhmm(c.startTime)}`)).toEqual(["A09:00", "B09:00", "A10:00", "A11:00"]);
    expect(applySmartMode(list, "rank", 3, "ai", tz).list.map((c) => `${c.plan[0].resourceId}${hhmm(c.startTime)}`)).toEqual(["A09:00", "B09:00", "A10:00", "A11:00"]);
    // não muta a entrada
    expect(list[0].plan[0].resourceId).toBe("A");
    expect(hhmm(list[0].startTime)).toBe("10:00");
  });
  it("equipe nunca recebe restrict: vira rank e não esconde nada", () => {
    const staff = applySmartMode(list, "restrict", 1, "staff", tz);
    expect(staff.relaxed).toBe(false);
    expect(staff.list).toHaveLength(4);
    const ai = applySmartMode(list, "restrict", 1, "ai", tz);
    expect(ai.list).toHaveLength(3); // some o de adjacency 0
    expect(applySmartMode(list, "restrict", 1, "public", tz).list).toHaveLength(3);
  });
  it("restrict faz fallback para rank quando sobra menos que minOffer", () => {
    const r = applySmartMode(list, "restrict", 4, "ai", tz);
    expect(r.relaxed).toBe(true);
    expect(r.list).toHaveLength(4);
  });
  it("restrict usa a feature crua: peso zero não esconde tudo", () => {
    const zero = list.map((c) => ({ ...c, parts: { ...c.parts, adjacency: 0 } }));
    expect(applySmartMode(zero, "restrict", 1, "ai", tz).list).toHaveLength(3);
  });
});

describe("pickOffers", () => {
  const mk = (date: string, s: string, score: number, res = "A"): ScoredCandidate => {
    const end = `${String(Number(s.slice(0, 2)) + 1).padStart(2, "0")}:${s.slice(3)}`;
    return {
      startTime: at(date, s), endTime: at(date, end), blockStart: at(date, s), blockEnd: at(date, end),
      plan: [{ role: "Sala", resourceId: res, units: 1 }],
      score, parts: { adjacency: 0, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 },
      features: { adjacency: 0, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 }, reasons: [], reasonCodes: [],
    };
  };
  it("devolve no máximo `max`, melhor primeiro, variando período e dia", () => {
    const ranked = [
      mk(MON, "09:00", 50), mk(MON, "09:30", 45), mk(MON, "14:00", 40), mk("2026-11-24", "09:00", 35), mk(MON, "19:00", 10),
    ];
    const picks = pickOffers(ranked, 3, tz);
    expect(picks).toHaveLength(3);
    expect(picks[0]).toBe(ranked[0]); // a melhor
    expect(picks[1]).toBe(ranked[2]); // outro período (tarde)
    expect(picks[2]).toBe(ranked[3]); // outro dia
    expect(pickOffers(ranked, 2, tz)).toEqual([ranked[0], ranked[2]]);
    expect(pickOffers(ranked, 10, tz)).toHaveLength(5);
    expect(pickOffers(ranked, 0, tz)).toEqual([]);
    expect(pickOffers([], 3, tz)).toEqual([]);
  });
  it("sem variação possível cai para os melhores restantes e nunca repete o mesmo início", () => {
    const ranked = [mk(MON, "09:00", 50, "A"), mk(MON, "09:00", 49, "B"), mk(MON, "09:30", 40), mk(MON, "10:00", 30)];
    const picks = pickOffers(ranked, 3, tz);
    expect(picks.map((p) => hhmm(p.startTime))).toEqual(["09:00", "09:30", "10:00"]);
    expect(new Set(picks.map((p) => p.startTime)).size).toBe(3);
  });
  it("período e dia seguem o fuso local (22h local em UTC-3 já é o dia seguinte em UTC)", () => {
    const ranked = [mk(MON, "09:00", 50), mk(MON, "21:00", 40), mk("2026-11-24", "09:00", 30)];
    const picks = pickOffers(ranked, 3, tz);
    expect(picks[1]).toBe(ranked[1]); // noite
    expect(picks[2]).toBe(ranked[2]);
  });
  it("é determinístico", () => {
    const ranked = [mk(MON, "09:00", 50), mk(MON, "14:00", 40), mk("2026-11-24", "09:00", 35)];
    expect(pickOffers(ranked, 3, tz)).toEqual(pickOffers([...ranked], 3, tz));
  });
});

describe("restrict: minOffer e fallback por dia (regressão da revisão)", () => {
  const mk = (date: string, s: string, adj: number, score: number): ScoredCandidate => ({
    ...cand("A", s, `${String(Number(s.slice(0, 2)) + 1).padStart(2, "0")}:${s.slice(3)}`),
    startTime: at(date, s), endTime: at(date, `${String(Number(s.slice(0, 2)) + 1).padStart(2, "0")}:${s.slice(3)}`),
    blockStart: at(date, s), blockEnd: at(date, `${String(Number(s.slice(0, 2)) + 1).padStart(2, "0")}:${s.slice(3)}`),
    score, parts: { adjacency: 0, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 },
    features: { adjacency: adj, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 }, reasons: [], reasonCodes: [],
  });
  const D1 = "2026-11-23";
  const D2 = "2026-11-24";
  it("minOffer 0 ou negativo vale 1: nunca devolve lista vazia havendo horário", () => {
    const nothingStrict = [mk(D1, "09:00", 0, 5), mk(D1, "10:00", 0, 4)];
    for (const minOffer of [0, -3, NaN]) {
      const r = applySmartMode(nothingStrict, "restrict", minOffer, "ai", tz);
      expect(r.list).toHaveLength(2);
      expect(r.relaxed).toBe(true);
    }
    const some = [mk(D1, "09:00", 1, 5), mk(D1, "10:00", 0, 4)];
    expect(applySmartMode(some, "restrict", 0, "ai", tz)).toMatchObject({ relaxed: false, list: [expect.objectContaining({ score: 5 })] });
  });
  it("o fallback é por dia: o dia sem horário 'estrito' volta ao rank sem arrastar os outros", () => {
    const list = [
      mk(D1, "09:00", 1, 50), mk(D1, "10:00", 0.5, 40), mk(D1, "11:00", 1, 30), mk(D1, "14:00", 0, 1), // D1: 3 estritos
      mk(D2, "09:00", 0, 20), mk(D2, "10:00", 0, 10), // D2: nenhum estrito
    ];
    const r = applySmartMode(list, "restrict", 3, "public", tz);
    expect(r.relaxed).toBe(true);
    expect(r.relaxedDays).toEqual([D2]);
    const d1 = r.list.filter((c) => c.startTime < at(D2, "00:00"));
    const d2 = r.list.filter((c) => c.startTime >= at(D2, "00:00"));
    expect(d1).toHaveLength(3); // o de adjacency 0 some em D1
    expect(d2).toHaveLength(2); // D2 não fica com zero ofertas
    expect(r.list.map((c) => c.score)).toEqual([50, 40, 30, 20, 10]); // ordenado por pontuação no conjunto
  });
  it("a janela inteira com muitos horários estritos num dia não esconde o dia vazio de estritos (antes: 3+ estritos globais zerava D2)", () => {
    const list = [mk(D1, "09:00", 1, 9), mk(D1, "10:00", 1, 8), mk(D1, "11:00", 1, 7), mk(D2, "09:00", 0, 1)];
    expect(applySmartMode(list, "restrict", 3, "ai", tz).list.some((c) => c.startTime >= at(D2, "00:00"))).toBe(true);
  });
  it("o dia local decide o agrupamento (22:30 local em UTC-3 ainda é o dia local)", () => {
    const late = mk(D1, "22:30", 1, 1);
    const r = applySmartMode([late, mk(D2, "09:00", 0, 2)], "restrict", 1, "ai", tz);
    expect(r.list).toHaveLength(2);
    expect(r.relaxedDays).toEqual([D2]);
  });
});
