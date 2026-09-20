/**
 * Agenda do atendente + janela de follow-up (`lib/agentSchedule.ts`).
 *
 * O que estes testes protegem:
 *  - `isWithinSchedule` continua com a MESMA semântica que tinha em
 *    `convex/attendant.ts` antes de mudar de arquivo (schedule ausente/tz
 *    inválida => dentro; `days` restringe; meia-noite não vira "24:00");
 *  - `localToEpoch` resolve os dois casos clássicos de DST (hora inexistente
 *    no salto de primavera, hora ambígua na volta do horário de verão) e
 *    recusa formato/data impossível;
 *  - `nextOpening` caminha por CALENDÁRIO local (não +24h) e respeita `days`;
 *  - `followUpWindow` intersecta a janela de silêncio com o schedule (nunca
 *    "ou um ou outro" — um schedule 0–24h não pode deixar o follow-up sair
 *    de madrugada).
 */
import { describe, expect, test } from "vitest";
import {
  followUpWindow,
  formatLocalShort,
  isWithinSchedule,
  localToEpoch,
  nextOpening,
  type AgentSchedule,
} from "./agentSchedule";

// 18/09/2026 17:32 UTC = sexta-feira, 14:32 em São Paulo (UTC-3, mesma constante de promptDateTime.test.ts).
const SEXTA_1432_SP = Date.UTC(2026, 8, 18, 17, 32);
// Sexta 18/09/2026 20:00 em São Paulo = 23:00 UTC.
const SEXTA_2000_SP = Date.UTC(2026, 8, 18, 23, 0);
// Sexta 18/09/2026 19:00 em São Paulo = 22:00 UTC.
const SEXTA_1900_SP = Date.UTC(2026, 8, 18, 22, 0);
// Sexta 18/09/2026 23:30 em São Paulo = sábado 19/09 02:30 UTC (virada de dia).
const SEXTA_2330_SP = Date.UTC(2026, 8, 19, 2, 30);
// Sábado 19/09/2026 12:00 em São Paulo = 15:00 UTC.
const SABADO_1200_SP = Date.UTC(2026, 8, 19, 15, 0);
// São Paulo é UTC-3 fixo desde 2019 — sem DST, serve de fuso "de controle".
const SP = "America/Sao_Paulo";
const NY = "America/New_York";

describe("isWithinSchedule", () => {
  const businessHours: AgentSchedule = { timezone: SP, startHour: 9, endHour: 18 };

  test("schedule ausente ou nulo => sempre dentro", () => {
    expect(isWithinSchedule(undefined, SEXTA_2000_SP)).toBe(true);
    expect(isWithinSchedule(null, SEXTA_2000_SP)).toBe(true);
  });

  test("dentro do horário => true; fora => false", () => {
    expect(isWithinSchedule(businessHours, SEXTA_1432_SP)).toBe(true); // sex 14:32
    expect(isWithinSchedule(businessHours, SEXTA_2000_SP)).toBe(false); // sex 20:00
  });

  test("days restringe o dia da semana mesmo com hora dentro da janela", () => {
    const weekdaysOnly: AgentSchedule = { ...businessHours, days: [1, 2, 3, 4, 5] };
    expect(isWithinSchedule(weekdaysOnly, SEXTA_1432_SP)).toBe(true); // sexta é dia 5, permitido
    expect(isWithinSchedule(weekdaysOnly, SABADO_1200_SP)).toBe(false); // sábado (6) fora, mesmo às 12h
  });

  test("days ausente ou vazio => todos os dias", () => {
    expect(isWithinSchedule({ ...businessHours, days: [] }, SABADO_1200_SP)).toBe(true);
  });

  test("timezone inválida não derruba — considera dentro", () => {
    expect(isWithinSchedule({ timezone: "Marte/Olympus", startHour: 9, endHour: 18 }, SEXTA_2000_SP)).toBe(
      true
    );
  });

  test("meia-noite conta como hora 0, nunca 24 (schedule de madrugada)", () => {
    const madrugada: AgentSchedule = { timezone: SP, startHour: 0, endHour: 6 };
    // Date.UTC(2026,8,19,3,0) = meia-noite em São Paulo (mesmo instante de promptDateTime.test.ts).
    expect(isWithinSchedule(madrugada, Date.UTC(2026, 8, 19, 3, 0))).toBe(true);
  });
});

describe("localToEpoch — caminho normal e formatos inválidos", () => {
  test("hora local em São Paulo (sem DST) converte exatamente", () => {
    expect(localToEpoch("2026-09-20T10:00", SP)).toBe(Date.UTC(2026, 8, 20, 13, 0));
  });

  test("fuso inválido cai no default do produto (safeTimezone)", () => {
    expect(localToEpoch("2026-09-20T10:00", "Marte/Olympus")).toBe(Date.UTC(2026, 8, 20, 13, 0));
  });

  for (const bad of [
    "amanhã",
    "2026-13-40T10:00", // mês e dia impossíveis
    "2026-09-20", // sem hora
    "2026-02-30T10:00", // fevereiro não tem dia 30
    "2026-09-20T24:00", // hora fora de faixa
    "2026-09-20T10:60", // minuto fora de faixa
    "2026-09-20T10:00:00", // segundos não fazem parte do formato aceito
    "20260920T1000", // sem separadores
    "",
  ]) {
    test(`formato/data inválidos devolvem null: ${JSON.stringify(bad)}`, () => {
      expect(localToEpoch(bad, SP)).toBeNull();
    });
  }
});

describe("localToEpoch — DST em America/New_York", () => {
  test("hora INEXISTENTE (salto de primavera, 08/03/2026 02h->03h) avança para o próximo instante válido", () => {
    // 2026-03-08 é quando New York entra no horário de verão: 02:00 EST vira
    // 03:00 EDT direto — 02:30 nunca existe. O avanço soma o tamanho do salto
    // (1h): 02:30 -> 03:30 EDT, que É um instante real.
    const result = localToEpoch("2026-03-08T02:30", NY);
    expect(result).toBe(Date.UTC(2026, 2, 8, 7, 30)); // 03:30 EDT (UTC-4) = 07:30 UTC
    expect(formatLocalShort(result as number, NY)).toBe("dom 08/03 03:30");
  });

  test("hora AMBÍGUA (volta do horário de verão, 01/11/2026 2h->1h) resolve para a PRIMEIRA ocorrência", () => {
    // 01:00-01:59 acontece duas vezes: primeiro em EDT (-4h), depois em EST
    // (-5h). A primeira ocorrência é o instante UTC MENOR das duas.
    const result = localToEpoch("2026-11-01T01:30", NY);
    expect(result).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT (UTC-4) = 05:30 UTC — a mais cedo
    expect(formatLocalShort(result as number, NY)).toBe("dom 01/11 01:30");
  });

  test("hora comum no mesmo dia da virada, mas fora da janela ambígua/inexistente, resolve sem ambiguidade", () => {
    expect(localToEpoch("2026-03-08T10:00", NY)).toBe(Date.UTC(2026, 2, 8, 14, 0)); // já em EDT
  });
});

describe("nextOpening", () => {
  const businessHours: AgentSchedule = { timezone: SP, startHour: 9, endHour: 18 };

  test("já dentro do schedule => devolve o próprio `from`", () => {
    expect(nextOpening(businessHours, SEXTA_1432_SP)).toBe(SEXTA_1432_SP);
  });

  test("schedule ausente => devolve `from`", () => {
    expect(nextOpening(undefined, SEXTA_2000_SP)).toBe(SEXTA_2000_SP);
  });

  test("virada de dia: sexta 23:30 fora do horário -> sábado 09:00 (mesmo fuso, sem `days`)", () => {
    const opening = nextOpening(businessHours, SEXTA_2330_SP);
    expect(opening).toBe(Date.UTC(2026, 8, 19, 12, 0)); // sábado 09:00 SP
    expect(formatLocalShort(opening, SP)).toBe("sáb 19/09 09:00");
  });

  test("days restrito: sexta 19h (fora do expediente) pula fim de semana -> segunda 09:00", () => {
    const weekdaysOnly: AgentSchedule = { ...businessHours, days: [1, 2, 3, 4, 5] };
    const opening = nextOpening(weekdaysOnly, SEXTA_1900_SP);
    expect(opening).toBe(Date.UTC(2026, 8, 21, 12, 0)); // segunda 21/09 09:00 SP
    expect(formatLocalShort(opening, SP)).toBe("seg 21/09 09:00");
  });

  test("startHour >= endHour (janela inválida) => devolve `from`", () => {
    const neverOpens: AgentSchedule = { timezone: SP, startHour: 10, endHour: 10 };
    expect(nextOpening(neverOpens, SEXTA_2000_SP)).toBe(SEXTA_2000_SP);
  });
});

describe("followUpWindow — silêncio SEMPRE intersectado com o schedule", () => {
  test("sem schedule: janela padrão = silêncio, todos os dias", () => {
    expect(followUpWindow(undefined, SP, 8, 20)).toEqual({ timezone: SP, startHour: 8, endHour: 20 });
  });

  test("schedule 0–24h + silêncio 8–20h => 8–20 (o schedule cobrindo o dia todo não pode liberar madrugada)", () => {
    const schedule: AgentSchedule = { timezone: SP, startHour: 0, endHour: 24 };
    expect(followUpWindow(schedule, SP, 8, 20)).toEqual({
      timezone: SP,
      startHour: 8,
      endHour: 20,
      days: undefined,
    });
  });

  test("schedule 9–18h + silêncio 8–20h => 9–18 (o schedule mais estreito vence)", () => {
    const schedule: AgentSchedule = { timezone: SP, startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] };
    expect(followUpWindow(schedule, SP, 8, 20)).toEqual({
      timezone: SP,
      startHour: 9,
      endHour: 18,
      days: [1, 2, 3, 4, 5],
    });
  });

  test("schedule 22–24h + silêncio 8–20h => interseção vazia, usa só o silêncio (mas preserva `days`)", () => {
    const schedule: AgentSchedule = { timezone: SP, startHour: 22, endHour: 24, days: [2, 4] };
    expect(followUpWindow(schedule, SP, 8, 20)).toEqual({
      timezone: SP,
      startHour: 8,
      endHour: 20,
      days: [2, 4],
    });
  });

  test("fuso do schedule inválido cai para o fuso passado (não direto pro default do produto)", () => {
    const schedule: AgentSchedule = { timezone: "Marte/Olympus", startHour: 0, endHour: 24 };
    expect(followUpWindow(schedule, "America/Manaus", 8, 20)).toEqual({
      timezone: "America/Manaus",
      startHour: 8,
      endHour: 20,
      days: undefined,
    });
  });
});

describe("formatLocalShort", () => {
  test('formato "abrev dd/mm HH:mm" em pt-BR, h23', () => {
    expect(formatLocalShort(SEXTA_1432_SP, SP)).toBe("sex 18/09 14:32");
  });

  test("meia-noite sai como 00:00", () => {
    expect(formatLocalShort(Date.UTC(2026, 8, 19, 3, 0), SP)).toBe("sáb 19/09 00:00");
  });

  test("timezone inválida cai no default do produto", () => {
    expect(formatLocalShort(SEXTA_1432_SP, "Marte/Olympus")).toBe("sex 18/09 14:32");
  });
});
