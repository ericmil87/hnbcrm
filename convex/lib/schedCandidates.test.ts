import { describe, expect, it } from "vitest";
import { type AllocationLite, computeDayAvailability, type ResourceLite } from "./schedAvailability";
import { durationFor, generateCandidates, type ServiceLite } from "./schedCandidates";
import { evaluateRules } from "./schedRules";
import { applySmartMode, DEFAULT_WEIGHTS, pickOffers, scoreCandidate } from "./schedScore";
import { addLocalDays, atLocalMinutes, dayBounds, minutesOfDay } from "./schedTime";

const tz = "America/Sao_Paulo";
const MIN = 60_000;
const MON = "2026-11-23";
const at = (date: string, hhmm: string, zone = tz) => {
  const [h, m] = hhmm.split(":").map(Number);
  return atLocalMinutes(date, h * 60 + m, zone);
};
const hhmm = (ms: number) => {
  const d = new Date(ms - 3 * 60 * MIN); // São Paulo = UTC-3 (sem DST)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function res(over: Partial<ResourceLite> & { _id: string }): ResourceLite {
  return {
    kind: "room",
    name: over._id,
    capacity: 1,
    weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }],
    sortOrder: 0,
    active: true,
    ...over,
  };
}
function row(resourceId: string, s: string, e: string, over: Partial<AllocationLite> = {}): AllocationLite {
  const bs = at(MON, s);
  const be = at(MON, e);
  return { appointmentId: `a-${resourceId}-${s}`, resourceId, blockStart: bs, blockEnd: be, coreStart: bs, coreEnd: be, units: 1, ...over };
}
function svc(over: Partial<ServiceLite> = {}): ServiceLite {
  return {
    _id: "s1", name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
    requirements: [{ role: "Sala", kind: "room" }],
    ...over,
  };
}
function gen(opts: {
  resources: ResourceLite[]; allocations?: AllocationLite[]; exceptions?: Parameters<typeof computeDayAvailability>[0]["exceptions"];
  service?: ServiceLite; grid?: number; date?: string; earliest?: number; latest?: number;
  internalEvents?: Parameters<typeof computeDayAvailability>[0]["internalEvents"];
  ignoreAppointmentId?: string; variantKey?: string; preferred?: string[]; maxPerStart?: number; basis?: "core" | "block"; zone?: string;
}) {
  const date = opts.date ?? MON;
  const day = computeDayAvailability({
    date, tz: opts.zone ?? tz, resources: opts.resources, exceptions: opts.exceptions ?? [],
    allocations: opts.allocations ?? [], internalEvents: opts.internalEvents ?? [],
    ignoreAppointmentId: opts.ignoreAppointmentId,
  });
  return generateCandidates({
    date, tz: opts.zone ?? tz, gridMinutes: opts.grid ?? 30, service: opts.service ?? svc(), variantKey: opts.variantKey, day,
    earliest: opts.earliest ?? 0, latest: opts.latest ?? Number.MAX_SAFE_INTEGER,
    preferredResourceIds: opts.preferred, maxPerStart: opts.maxPerStart, basis: opts.basis,
  });
}

describe("grade em minutos locais", () => {
  it("abertura 08:10 com passo 30: primeiro início às 08:30; sempre dentro do expediente", () => {
    const r = res({ _id: "r1", weekly: [{ weekday: 1, startMin: 490, endMin: 700 }] }); // 08:10-11:40
    const starts = gen({ resources: [r], service: svc({ durationMin: 30 }) }).map((c) => hhmm(c.startTime));
    expect(starts).toEqual(["08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]); // 11:30 + 30 passaria de 11:40
  });
  it("o último início respeita o fim do expediente (serviço de 60 min, fecha 18:00)", () => {
    const starts = gen({ resources: [res({ _id: "r1" })] }).map((c) => hhmm(c.startTime));
    expect(starts[0]).toBe("08:00");
    expect(starts[starts.length - 1]).toBe("17:00");
    expect(starts).toHaveLength(19);
  });
  it("slotIntervalMin do serviço sobrepõe o gridMinutes da org", () => {
    const starts = gen({ resources: [res({ _id: "r1" })], service: svc({ slotIntervalMin: 60 }), grid: 15 }).map((c) => hhmm(c.startTime));
    expect(starts.slice(0, 3)).toEqual(["08:00", "09:00", "10:00"]);
    const fine = gen({ resources: [res({ _id: "r1" })], grid: 15 }).map((c) => hhmm(c.startTime));
    expect(fine.slice(0, 3)).toEqual(["08:00", "08:15", "08:30"]);
  });
  it("grade de meia hora em Kolkata ancora na meia-noite local", () => {
    const z = "Asia/Kolkata";
    const date = "2026-11-23";
    const r = res({ _id: "r1", weekly: [{ weekday: 1, startMin: 570, endMin: 690 }] }); // 09:30-11:30
    const c = gen({ resources: [r], zone: z, date, service: svc({ durationMin: 30 }), grid: 30 });
    expect(c.map((x) => x.startTime)).toEqual([at(date, "09:30", z), at(date, "10:00", z), at(date, "10:30", z), at(date, "11:00", z)]);
  });
  it("em dia de 25 h (fim do horário de verão) não repete horário e cobre as 25 h", () => {
    const z = "America/New_York";
    const r = res({ _id: "r1", weekly: [{ weekday: 0, startMin: 0, endMin: 1440 }] });
    const c = gen({ resources: [r], zone: z, date: "2026-11-01", service: svc({ durationMin: 60 }), grid: 60 });
    const starts = c.map((x) => x.startTime);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts.length).toBe(24); // grade local: 24 inícios (a hora duplicada colapsa na 1ª ocorrência)
  });
  it("em dia de 23 h (início do horário de verão) a hora inexistente colapsa", () => {
    const z = "America/New_York";
    const r = res({ _id: "r1", weekly: [{ weekday: 0, startMin: 0, endMin: 1440 }] });
    const starts = gen({ resources: [r], zone: z, date: "2026-03-08", service: svc({ durationMin: 60 }), grid: 60 }).map((x) => x.startTime);
    expect(new Set(starts).size).toBe(starts.length);
    const b = dayBounds("2026-03-08", z);
    expect(starts.every((s) => s >= b.start && s < b.end)).toBe(true);
  });
});

describe("duração, variações e folgas", () => {
  it("variação muda a duração; chave desconhecida lança", () => {
    const s = svc({ variants: [{ key: "longa", name: "Longa", durationMin: 120 }] });
    expect(durationFor(s)).toBe(60);
    expect(durationFor(s, "longa")).toBe(120);
    expect(() => durationFor(s, "x")).toThrow();
    const c = gen({ resources: [res({ _id: "r1" })], service: s, variantKey: "longa" });
    expect(c[0].endTime - c[0].startTime).toBe(120 * MIN);
    expect(hhmm(c[c.length - 1].startTime)).toBe("16:00");
  });
  it("folgas formam o bloco e o núcleo fica dentro do expediente", () => {
    const c = gen({ resources: [res({ _id: "r1" })], service: svc({ bufferBeforeMin: 10, bufferAfterMin: 20 }) });
    expect(c[0].startTime).toBe(at(MON, "08:00"));
    expect(c[0].blockStart).toBe(at(MON, "07:50"));
    expect(c[0].blockEnd).toBe(at(MON, "09:20"));
  });
  it("bloco acima do teto não gera candidato", () => {
    expect(gen({ resources: [res({ _id: "r1", weekly: [{ weekday: 1, startMin: 0, endMin: 1440 }] })], service: svc({ durationMin: 470, bufferAfterMin: 20 }) })).toEqual([]);
  });
});

describe("capacidade, núcleo × bloco, encostar", () => {
  it("sala simples ocupada some; encostar não conflita", () => {
    const c = gen({ resources: [res({ _id: "r1" })], allocations: [row("r1", "10:00", "11:00")] });
    const starts = c.map((x) => hhmm(x.startTime));
    expect(starts).not.toContain("09:30");
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("10:30");
    expect(starts).toContain("09:00"); // 09:00-10:00 encosta
    expect(starts).toContain("11:00"); // 11:00-12:00 encosta
  });
  it("sala dupla: 1 unidade cabe ao lado de 1 ocupada; exclusive não; com 2 ocupadas nada cabe", () => {
    const dupla = res({ _id: "d1", capacity: 2 });
    const one = [row("d1", "10:00", "11:00")];
    expect(gen({ resources: [dupla], allocations: one }).map((c) => hhmm(c.startTime))).toContain("10:00");
    const excl = svc({ requirements: [{ role: "Sala", kind: "room", exclusive: true }] });
    const exclStarts = gen({ resources: [dupla], allocations: one, service: excl }).map((c) => hhmm(c.startTime));
    expect(exclStarts).not.toContain("10:00");
    expect(exclStarts).not.toContain("09:30");
    expect(exclStarts).toContain("09:00");
    const two = [row("d1", "10:00", "11:00"), row("d1", "10:00", "11:00", { appointmentId: "b" })];
    const starts = gen({ resources: [dupla], allocations: two }).map((c) => hhmm(c.startTime));
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("10:30");
    expect(starts).toContain("11:00");
    // exclusive consome as 2 unidades no plano
    expect(gen({ resources: [dupla], service: excl })[0].plan[0].units).toBe(2);
  });
  it("units > capacidade do recurso não cabe", () => {
    const s = svc({ requirements: [{ role: "Sala", kind: "room", units: 2 }] });
    expect(gen({ resources: [res({ _id: "r1" })], service: s })).toEqual([]);
    expect(gen({ resources: [res({ _id: "r2", capacity: 2 })], service: s })[0].plan[0].units).toBe(2);
  });
  it("basis block (padrão) respeita a folga; basis core só o núcleo", () => {
    // outro: bloco 10:00-11:00 com núcleo 10:10-10:50 (folga 10 antes e depois)
    const other = row("r1", "10:00", "11:00", { coreStart: at(MON, "10:10"), coreEnd: at(MON, "10:50") });
    const s = svc({ durationMin: 30, slotIntervalMin: 10 });
    const block = gen({ resources: [res({ _id: "r1" })], allocations: [other], service: s }).map((c) => hhmm(c.startTime));
    const core = gen({ resources: [res({ _id: "r1" })], allocations: [other], service: s, basis: "core" }).map((c) => hhmm(c.startTime));
    expect(block).not.toContain("10:50");
    expect(core).toContain("10:50"); // núcleo encosta no núcleo (10:50)
    expect(core).not.toContain("10:40");
    expect(block).toContain("11:00");
  });
  it("ignoreAppointmentId: remarcar 30 min para frente não conflita consigo mesmo", () => {
    const mine = row("r1", "10:00", "11:00", { appointmentId: "me" });
    const without = gen({ resources: [res({ _id: "r1" })], allocations: [mine] }).map((c) => hhmm(c.startTime));
    expect(without).not.toContain("10:30");
    const withIgnore = gen({ resources: [res({ _id: "r1" })], allocations: [mine], ignoreAppointmentId: "me" }).map((c) => hhmm(c.startTime));
    expect(withIgnore).toContain("10:30");
    expect(withIgnore).toContain("10:00");
  });
});

describe("abertura, bloqueios e compromissos internos", () => {
  it("recurso fechado ou inativo não gera candidato", () => {
    expect(gen({ resources: [res({ _id: "r1" })], exceptions: [{ localDate: MON, mode: "closed", resourceId: "r1" }] })).toEqual([]);
    expect(gen({ resources: [res({ _id: "r1", active: false })] })).toEqual([]);
  });
  it("bloqueio e compromisso interno removem horários que o atravessam", () => {
    const person = res({ _id: "p1", kind: "person", teamMemberId: "tm1" });
    const s = svc({ requirements: [{ role: "Terapeuta", kind: "person" }] });
    const starts = gen({
      resources: [person], service: s,
      exceptions: [{ localDate: MON, mode: "block", resourceId: "p1", intervals: [{ startMin: 720, endMin: 780 }] }],
      internalEvents: [{ teamMemberId: "tm1", start: at(MON, "15:00"), end: at(MON, "16:00") }],
    }).map((c) => hhmm(c.startTime));
    for (const bad of ["11:30", "12:00", "12:30", "14:30", "15:00", "15:30"]) expect(starts).not.toContain(bad);
    for (const good of ["11:00", "13:00", "14:00", "16:00"]) expect(starts).toContain(good);
  });
  it("dois turnos com almoço: nada cruza o intervalo", () => {
    const r = res({ _id: "r1", weekly: [{ weekday: 1, startMin: 480, endMin: 720 }, { weekday: 1, startMin: 840, endMin: 1080 }] });
    const starts = gen({ resources: [r] }).map((c) => hhmm(c.startTime));
    expect(starts).toContain("11:00");
    expect(starts).not.toContain("11:30");
    expect(starts).not.toContain("13:30");
    expect(starts).toContain("14:00");
  });
  it("antecedência mínima e janela máxima cortam por início", () => {
    const c = gen({ resources: [res({ _id: "r1" })], earliest: at(MON, "10:15"), latest: at(MON, "12:00") }).map((x) => hhmm(x.startTime));
    expect(c).toEqual(["10:30", "11:00", "11:30", "12:00"]);
  });
});

describe("planos com vários papéis", () => {
  const sala = (id: string, over: Partial<ResourceLite> = {}) => res({ _id: id, ...over });
  const pessoa = (id: string, over: Partial<ResourceLite> = {}) => res({ _id: id, kind: "person", ...over });
  const two = svc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person" }] });

  it("exige sala E terapeuta: sem terapeuta livre não há horário", () => {
    const rs = [sala("s1"), sala("s2"), pessoa("p1")];
    const starts = gen({ resources: rs, service: two, allocations: [row("p1", "10:00", "11:00")] }).map((c) => hhmm(c.startTime));
    expect(starts).not.toContain("10:00");
    expect(starts).toContain("09:00");
    const c = gen({ resources: rs, service: two })[0];
    expect(c.plan.map((p) => p.role)).toEqual(["Sala", "Terapeuta"]); // na ordem do serviço
  });
  it("papel mais escasso primeiro com retrocesso: pessoa A só serve numa sala específica", () => {
    // Requisito 1: qualquer sala; requisito 2: pessoa p1 apenas. Sala s1 é a preferida por sortOrder mas
    // só s2 está livre às 10:00 -> o plano usa s2.
    const rs = [sala("s1", { sortOrder: 1 }), sala("s2", { sortOrder: 2 }), pessoa("p1")];
    const s = svc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Terapeuta", kind: "person", resourceIds: ["p1"] }] });
    const c = gen({ resources: rs, service: s, allocations: [row("s1", "10:00", "11:00")], maxPerStart: 5 }).filter((x) => hhmm(x.startTime) === "10:00");
    expect(c).toHaveLength(1);
    expect(c[0].plan.find((p) => p.role === "Sala")!.resourceId).toBe("s2");
  });
  it("retrocesso: o papel mais escasso é resolvido primeiro (a pessoa genérica não toma a única pessoa válida do outro papel)", () => {
    const rs = [pessoa("p1", { sortOrder: 1 }), pessoa("p2", { sortOrder: 2 })];
    const s = svc({ requirements: [{ role: "Auxiliar", kind: "person" }, { role: "Titular", kind: "person", resourceIds: ["p1"] }] });
    const c = gen({ resources: rs, service: s, maxPerStart: 5 }).filter((x) => hhmm(x.startTime) === "09:00");
    expect(c).toHaveLength(1);
    expect(c[0].plan).toEqual([
      { role: "Auxiliar", resourceId: "p2", units: 1 },
      { role: "Titular", resourceId: "p1", units: 1 },
    ]);
    // com p2 ocupado não há plano válido naquele horário
    const busy = gen({ resources: rs, service: s, allocations: [row("p2", "09:00", "10:00")] }).map((x) => hhmm(x.startTime));
    expect(busy).not.toContain("09:00");
  });
  it("não usa o mesmo recurso em dois papéis", () => {
    const s = svc({ requirements: [{ role: "A", kind: "room" }, { role: "B", kind: "room" }] });
    expect(gen({ resources: [sala("s1")], service: s })).toEqual([]);
    const c = gen({ resources: [sala("s1"), sala("s2")], service: s, maxPerStart: 5 })[0];
    expect(new Set(c.plan.map((p) => p.resourceId)).size).toBe(2);
  });
  it("tag e resourceIds filtram o requisito", () => {
    const rs = [sala("s1", { tags: ["maca"] }), sala("s2", { tags: [] })];
    const s = svc({ requirements: [{ role: "Sala", kind: "room", tag: "maca" }] });
    expect(gen({ resources: rs, service: s, maxPerStart: 5 })[0].plan).toEqual([{ role: "Sala", resourceId: "s1", units: 1 }]);
    const only = svc({ requirements: [{ role: "Sala", kind: "room", resourceIds: ["s2"] }] });
    expect(gen({ resources: rs, service: only })[0].plan[0].resourceId).toBe("s2");
  });
  it("maxPerStart limita os planos alternativos por início (default 3), ordenados por preferência e sortOrder", () => {
    const rs = [sala("s1", { sortOrder: 3 }), sala("s2", { sortOrder: 1 }), sala("s3", { sortOrder: 2 }), sala("s4", { sortOrder: 4 })];
    const at8 = (opts: { preferred?: string[]; maxPerStart?: number }) =>
      gen({ resources: rs, ...opts }).filter((c) => hhmm(c.startTime) === "08:00").map((c) => c.plan[0].resourceId);
    expect(at8({})).toEqual(["s2", "s3", "s1"]);
    expect(at8({ maxPerStart: 1 })).toEqual(["s2"]);
    expect(at8({ preferred: ["s4"], maxPerStart: 2 })).toEqual(["s4", "s2"]);
  });
  it("é determinístico", () => {
    const rs = [sala("s1"), sala("s2"), pessoa("p1"), pessoa("p2")];
    expect(gen({ resources: rs, service: two })).toEqual(gen({ resources: [...rs].reverse(), service: two }));
  });
  it("serviço sem requisitos não gera nada", () => {
    expect(gen({ resources: [sala("s1")], service: svc({ requirements: [] }) })).toEqual([]);
  });
});

describe("regressões da revisão", () => {
  it("unidades 0, negativas ou fracionárias lançam; exclusive em capacidade inválida também", () => {
    for (const units of [0, -1, 1.5]) {
      expect(() => gen({ resources: [res({ _id: "r1" })], service: svc({ requirements: [{ role: "Sala", kind: "room", units }] }) })).toThrow(/Unidades/);
    }
    expect(() => gen({ resources: [res({ _id: "r1", capacity: 0 })], service: svc({ requirements: [{ role: "Sala", kind: "room", exclusive: true }] }) })).toThrow(/Unidades/);
  });
  it("gerador e regra OFF_GRID concordam num dia de horário de verão com passo que não divide 60 (NY 08/03/2026, 45 min)", () => {
    const z = "America/New_York";
    const date = "2026-03-08";
    const r = res({ _id: "r1", weekly: [{ weekday: 0, startMin: 0, endMin: 1440 }] });
    const c = gen({ resources: [r], zone: z, date, service: svc({ durationMin: 30, slotIntervalMin: 45 }) });
    expect(c.length).toBeGreaterThan(10);
    const minutes = c.map((x) => minutesOfDay(x.startTime, z));
    expect(minutes.every((m) => m % 45 === 0)).toBe(true);
    expect(minutes).not.toContain(195); // 03:15 era oferecido e recusado pela regra
    const day = computeDayAvailability({ date, tz: z, resources: [r], exceptions: [], allocations: [], internalEvents: [] });
    for (const cand of c) {
      const v = evaluateRules({
        origin: "ai", now: 0, tz: z, startTime: cand.startTime, endTime: cand.endTime, blockStart: cand.blockStart, blockEnd: cand.blockEnd,
        plan: cand.plan.map((p) => ({ ...p, day: day.get(p.resourceId)! })), service: { slotIntervalMin: 45 },
        settings: { gridMinutes: 30, minNoticeMin: 0, maxAdvanceDays: 36500, maxAiBookingsPerContactPerDay: 2 },
      });
      expect(v.map((x) => x.code)).not.toContain("OFF_GRID");
    }
  });
  it("desempenho: 4 pessoas × 3 salas, grade de 5 min, 7 dias (geração + pontuação + escolha) com teto folgado", () => {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const weekly = allDays.map((w) => ({ weekday: w, startMin: 480, endMin: 1080 }));
    const resources = [
      ...[1, 2, 3, 4].map((i) => res({ _id: `p${i}`, kind: "person", weekly, sortOrder: i })),
      res({ _id: "s1", weekly, sortOrder: 11 }), res({ _id: "s2", weekly, sortOrder: 12 }), res({ _id: "s3", weekly, capacity: 2, sortOrder: 13 }),
    ];
    const service = svc({ durationMin: 50, bufferAfterMin: 10, requirements: [{ role: "t", kind: "person" }, { role: "s", kind: "room" }] });
    const t0 = performance.now();
    const scored: ReturnType<typeof scoreCandidate>[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addLocalDays(MON, i);
      const day = computeDayAvailability({ date, tz, resources, exceptions: [], allocations: [], internalEvents: [] });
      for (const c of generateCandidates({ date, tz, gridMinutes: 5, service, day, earliest: 0, latest: Number.MAX_SAFE_INTEGER })) {
        scored.push(scoreCandidate(c, day, DEFAULT_WEIGHTS, { minUsefulGapMin: 30, preference: { period: "afternoon" }, tz }));
      }
    }
    const { list } = applySmartMode(scored, "rank", 3, "ai", tz);
    pickOffers(list, 3, tz);
    const ms = performance.now() - t0;
    expect(scored.length).toBeGreaterThan(2000);
    expect(ms).toBeLessThan(150);
  });
});
