import { describe, expect, test } from "vitest";
import {
  validateGroupPostSchedule,
  nextRun,
  nextRunAt,
  slotKey,
  smallestTimeGapMinutes,
  describeSchedule,
  localParts,
  type GroupPostSchedule,
} from "./groupPostSchedule";

const HOUR = 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const keyOf = (ms: number, tz: string) => {
  const p = localParts(ms, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}`;
};

describe("localParts", () => {
  test("mapeia dia da semana 1..7 (1=Seg…7=Dom) e é estável em fuso fixo", () => {
    // 2026-09-16T12:00:00Z é quarta-feira (weekday 3) em São Paulo (UTC-3 fixo desde 2019)
    const p = localParts(Date.UTC(2026, 8, 16, 12, 0, 0), "America/Sao_Paulo");
    expect(p).toEqual({ y: 2026, m: 9, d: 16, hh: 9, mm: 0, weekday: 3 });
  });

  test("fuso inválido não derruba o cálculo (cai em São Paulo)", () => {
    expect(() => localParts(Date.UTC(2026, 8, 16, 12, 0, 0), "Not/AZone")).not.toThrow();
  });
});

describe("nextRunAt — América/São_Paulo (sem DST desde 2019)", () => {
  const schedule: GroupPostSchedule = {
    timezone: "America/Sao_Paulo",
    times: ["09:00", "18:00"],
    days: [1, 2, 3, 4, 5, 6, 7],
  };

  test("próximo slot no MESMO dia", () => {
    // 2026-09-16 08:00 local (11:00Z) -> próximo é 09:00 local do mesmo dia (12:00Z)
    const after = Date.UTC(2026, 8, 16, 11, 0, 0);
    expect(nextRunAt(schedule, after)).toBe(Date.UTC(2026, 8, 16, 12, 0, 0));
  });

  test("depois do último horário do dia -> dia SEGUINTE", () => {
    // 2026-09-16 18:30 local (21:30Z), depois do 18:00 -> próximo é 09:00 do dia 17 (12:00Z)
    const after = Date.UTC(2026, 8, 16, 21, 30, 0);
    expect(nextRunAt(schedule, after)).toBe(Date.UTC(2026, 8, 17, 12, 0, 0));
  });

  test("days pulando fim de semana -> SEMANA seguinte", () => {
    const scheduleWeekdays: GroupPostSchedule = { ...schedule, days: [1, 2, 3, 4, 5] };
    // 2026-09-18 é sexta-feira; 19:00 local (22:00Z) é depois do último horário
    const after = Date.UTC(2026, 8, 18, 22, 0, 0);
    // Pula sáb (19) e dom (20); próximo é segunda 2026-09-21 09:00 local (12:00Z)
    expect(nextRunAt(scheduleWeekdays, after)).toBe(Date.UTC(2026, 8, 21, 12, 0, 0));
  });

  test("startAt no futuro pula ocorrências anteriores", () => {
    const after = Date.UTC(2026, 8, 16, 11, 0, 0); // veria 09:00 do dia 16 sem startAt
    const startAt = Date.UTC(2026, 8, 18, 0, 0, 0); // só a partir do dia 18
    const withStart: GroupPostSchedule = { ...schedule, startAt };
    const result = nextRunAt(withStart, after);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(startAt);
    expect(result).toBe(Date.UTC(2026, 8, 18, 12, 0, 0)); // 09:00 local do dia 18
  });

  test("endAt no passado -> null", () => {
    const after = Date.UTC(2026, 8, 16, 11, 0, 0);
    const withEnd: GroupPostSchedule = { ...schedule, endAt: Date.UTC(2026, 8, 1, 0, 0, 0) };
    expect(nextRunAt(withEnd, after)).toBeNull();
  });

  test("endAt corta exatamente após o último slot elegível", () => {
    const after = Date.UTC(2026, 8, 16, 11, 0, 0);
    // Só o slot de 09:00 do dia 16 (12:00Z) cabe antes do endAt
    const withEnd: GroupPostSchedule = { ...schedule, endAt: Date.UTC(2026, 8, 16, 12, 30, 0) };
    expect(nextRunAt(withEnd, after)).toBe(Date.UTC(2026, 8, 16, 12, 0, 0));
    // Pedir o PRÓXIMO depois desse já estoura o endAt -> null
    expect(nextRunAt(withEnd, Date.UTC(2026, 8, 16, 12, 0, 0))).toBeNull();
  });
});

describe("nextRunAt — America/New_York (com DST em 2026)", () => {
  const schedule: GroupPostSchedule = {
    timezone: "America/New_York",
    times: ["09:00"],
    days: [1, 2, 3, 4, 5, 6, 7],
  };

  test("início do horário de verão (2026-03-08): salto de 23h, não 24h", () => {
    // 1 min antes do 09:00 local de 7/mar (EST, UTC-5 => 14:00Z)
    const beforeMar7 = Date.UTC(2026, 2, 7, 13, 59, 0);
    const mar7 = nextRunAt(schedule, beforeMar7);
    expect(mar7).toBe(Date.UTC(2026, 2, 7, 14, 0, 0)); // EST: 09:00-5=14:00Z

    const mar8 = nextRunAt(schedule, mar7!);
    expect(mar8).toBe(Date.UTC(2026, 2, 8, 13, 0, 0)); // EDT já em vigor: 09:00-4=13:00Z

    expect(mar8! - mar7!).toBe(23 * HOUR);
  });

  test("fim do horário de verão (2026-11-01): salto de 25h, não 24h", () => {
    // 1 min antes do 09:00 local de 31/out (EDT, UTC-4 => 13:00Z)
    const beforeOct31 = Date.UTC(2026, 9, 31, 12, 59, 0);
    const oct31 = nextRunAt(schedule, beforeOct31);
    expect(oct31).toBe(Date.UTC(2026, 9, 31, 13, 0, 0)); // EDT: 09:00-4=13:00Z

    const nov1 = nextRunAt(schedule, oct31!);
    expect(nov1).toBe(Date.UTC(2026, 10, 1, 14, 0, 0)); // EST já em vigor: 09:00-5=14:00Z

    expect(nov1! - oct31!).toBe(25 * HOUR);
  });
});

describe("jitter determinístico", () => {
  const schedule: GroupPostSchedule = {
    timezone: "America/Sao_Paulo",
    times: ["09:00"],
    days: [1, 2, 3, 4, 5, 6, 7],
    jitterMinutes: 15,
  };
  const scheduleNoJitter: GroupPostSchedule = { ...schedule, jitterMinutes: 0 };
  const after = Date.UTC(2026, 8, 16, 11, 0, 0);

  test("mesma seed -> mesmo instante; dentro de [0, jitterMinutes] do horário base", () => {
    const base = nextRunAt(scheduleNoJitter, after)!;
    const a = nextRunAt(schedule, after, { seed: "grupo-familia" });
    const b = nextRunAt(schedule, after, { seed: "grupo-familia" });
    expect(a).toBe(b);
    expect(a!).toBeGreaterThanOrEqual(base);
    expect(a!).toBeLessThanOrEqual(base + 15 * 60_000);
  });

  test("seed ausente também é determinístico (default estável)", () => {
    const a = nextRunAt(schedule, after);
    const b = nextRunAt(schedule, after);
    expect(a).toBe(b);
  });

  test("seeds diferentes podem produzir deslocamentos diferentes (não é sempre 0)", () => {
    const offsets = new Set<number>();
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const r = nextRunAt(schedule, after, { seed })!;
      offsets.add(r);
    }
    expect(offsets.size).toBeGreaterThan(1);
  });
});

describe("slotKey", () => {
  const timezone = "America/Sao_Paulo";
  const schedule: GroupPostSchedule = {
    timezone,
    times: ["09:00"],
    days: [1, 2, 3, 4, 5, 6, 7],
    jitterMinutes: 15,
  };
  const scheduleNoJitter: GroupPostSchedule = { ...schedule, jitterMinutes: 0 };
  const after = Date.UTC(2026, 8, 16, 11, 0, 0);

  test("estável com e sem jitter (mesmo slot lógico)", () => {
    const base = nextRunAt(scheduleNoJitter, after)!;
    const jittered = nextRunAt(schedule, after, { seed: "grupo-x" })!;

    const expectedKey = keyOf(base, timezone);
    expect(slotKey(scheduleNoJitter, base)).toBe(expectedKey);
    expect(slotKey(schedule, jittered)).toBe(expectedKey);
  });

  test("slots diferentes geram chaves diferentes", () => {
    const day1 = nextRunAt(scheduleNoJitter, after)!;
    const day2 = nextRunAt(scheduleNoJitter, day1)!;
    expect(slotKey(scheduleNoJitter, day1)).not.toBe(slotKey(scheduleNoJitter, day2));
  });
});

describe("nextRun devolve a chave do slot-BASE junto do instante", () => {
  const timezone = "America/Sao_Paulo";

  test("dois horários próximos com jitter NÃO colidem na mesma chave", () => {
    // Agenda que o validador recusa hoje (jitter >= intervalo), mas que já pode
    // existir num documento antigo: a chave tem de sair do cálculo, não de um
    // walk-back a partir do instante jitterado.
    const schedule: GroupPostSchedule = {
      timezone,
      times: ["12:00", "12:20"],
      days: [1, 2, 3, 4, 5, 6, 7],
      jitterMinutes: 30,
    };
    const after = Date.UTC(2026, 8, 18, 13, 0, 0); // 10:00 local de 18/09
    const first = nextRun(schedule, after, { seed: "p1" })!;
    const second = nextRun(schedule, first.at, { seed: "p1" })!;

    expect(first.slotKey).toBe("2026-09-18T12:00");
    expect(second.slotKey).toBe("2026-09-18T12:20");
    expect(first.slotKey).not.toBe(second.slotKey);

    // E o motivo de a chave vir do cálculo: o walk-back é AMBÍGUO aqui. Um
    // disparo às 12:21 local pode ser "12:00 + 21 min de jitter" ou
    // "12:20 + 1 min", e ele sempre responde o horário mais próximo — o que
    // fazia o tique das 12:21 gravar o slot das 12:20 e engolir o disparo
    // seguinte na idempotência.
    expect(slotKey(schedule, Date.UTC(2026, 8, 18, 15, 21))).toBe("2026-09-18T12:20");
  });

  test("sem jitter a chave bate com o walk-back", () => {
    const schedule: GroupPostSchedule = {
      timezone,
      times: ["09:00", "18:00"],
      days: [1, 2, 3, 4, 5, 6, 7],
    };
    const after = Date.UTC(2026, 8, 16, 11, 0, 0);
    const run = nextRun(schedule, after)!;
    expect(run.slotKey).toBe(slotKey(schedule, run.at));
    expect(nextRunAt(schedule, after)).toBe(run.at);
  });
});

describe("smallestTimeGapMinutes", () => {
  test("um horário só não tem distância", () => {
    expect(smallestTimeGapMinutes(["09:00"])).toBeNull();
  });
  test("menor intervalo entre horários consecutivos", () => {
    expect(smallestTimeGapMinutes(["12:00", "12:20", "18:00"])).toBe(20);
  });
  test("conta a volta pela meia-noite", () => {
    expect(smallestTimeGapMinutes(["00:05", "23:50"])).toBe(15);
  });
});

describe("describeSchedule (PT-BR)", () => {
  test("dias e horários múltiplos", () => {
    const schedule: GroupPostSchedule = {
      timezone: "America/Sao_Paulo",
      times: ["18:00", "09:00"],
      days: [5, 1, 3],
    };
    expect(describeSchedule(schedule)).toBe("Seg, Qua e Sex às 09:00 e 18:00 (America/Sao_Paulo)");
  });

  test("um dia e um horário só (sem 'e' sobrando)", () => {
    const schedule: GroupPostSchedule = {
      timezone: "America/Sao_Paulo",
      times: ["12:00"],
      days: [6],
    };
    expect(describeSchedule(schedule)).toBe("Sáb às 12:00 (America/Sao_Paulo)");
  });
});

describe("validateGroupPostSchedule", () => {
  test("aceita agenda válida e normaliza (ordena times, dedupe + ordena days)", () => {
    // times duplicados são INVÁLIDOS (verificado no teste abaixo) — aqui só
    // fora de ordem; days repetidos são tolerados e deduplicados.
    const result = validateGroupPostSchedule({
      timezone: "America/Sao_Paulo",
      times: ["18:00", "09:00"],
      days: [5, 1, 1, 3],
      jitterMinutes: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.times).toEqual(["09:00", "18:00"]);
      expect(result.value.days).toEqual([1, 3, 5]);
      expect(result.value.jitterMinutes).toBe(10);
    }
  });

  test("recusa fuso horário inválido", () => {
    const result = validateGroupPostSchedule({
      timezone: "Nao/Existe",
      times: ["09:00"],
      days: [1],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fuso/i);
  });

  test("recusa horário mal formatado", () => {
    for (const bad of ["9:00", "09:60", "24:00", "12:5", "abc"]) {
      const result = validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: [bad],
        days: [1],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/horário/i);
    }
  });

  test("recusa times duplicados, vazio, ou mais de 10", () => {
    expect(validateGroupPostSchedule({ timezone: "America/Sao_Paulo", times: [], days: [1] }).ok).toBe(false);
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: Array.from({ length: 11 }, (_, i) => `0${i % 10}:00`),
        days: [1],
      }).ok
    ).toBe(false);
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["09:00", "09:00"],
        days: [1],
      }).ok
    ).toBe(false);
  });

  test("recusa dias fora de 1..7 ou vazio", () => {
    expect(
      validateGroupPostSchedule({ timezone: "America/Sao_Paulo", times: ["09:00"], days: [0] }).ok
    ).toBe(false);
    expect(
      validateGroupPostSchedule({ timezone: "America/Sao_Paulo", times: ["09:00"], days: [8] }).ok
    ).toBe(false);
    expect(
      validateGroupPostSchedule({ timezone: "America/Sao_Paulo", times: ["09:00"], days: [] }).ok
    ).toBe(false);
  });

  test("recusa jitter maior ou igual ao intervalo entre dois horários", () => {
    const bad = validateGroupPostSchedule({
      timezone: "America/Sao_Paulo",
      times: ["12:00", "12:20"],
      days: [1],
      jitterMinutes: 30,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/intervalo entre dois horários/);

    // Igual ao intervalo também é recusado (o disparo encostaria no seguinte).
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["12:00", "12:20"],
        days: [1],
        jitterMinutes: 20,
      }).ok
    ).toBe(false);
    // Menor que o intervalo passa.
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["12:00", "12:20"],
        days: [1],
        jitterMinutes: 19,
      }).ok
    ).toBe(true);
    // Um horário só: jitter livre até 30.
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["12:00"],
        days: [1],
        jitterMinutes: 30,
      }).ok
    ).toBe(true);
  });

  test("recusa jitterMinutes > 30 ou negativo", () => {
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["09:00"],
        days: [1],
        jitterMinutes: 31,
      }).ok
    ).toBe(false);
    expect(
      validateGroupPostSchedule({
        timezone: "America/Sao_Paulo",
        times: ["09:00"],
        days: [1],
        jitterMinutes: -1,
      }).ok
    ).toBe(false);
  });

  test("recusa endAt <= startAt", () => {
    const result = validateGroupPostSchedule({
      timezone: "America/Sao_Paulo",
      times: ["09:00"],
      days: [1],
      startAt: 1000,
      endAt: 500,
    });
    expect(result.ok).toBe(false);
  });

  test("recusa payload que não é objeto", () => {
    expect(validateGroupPostSchedule(null).ok).toBe(false);
    expect(validateGroupPostSchedule("agenda").ok).toBe(false);
    expect(validateGroupPostSchedule(42).ok).toBe(false);
  });
});
