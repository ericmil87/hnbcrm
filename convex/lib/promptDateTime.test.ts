/**
 * Carimbo de DATA E HORA do prompt dos agentes.
 *
 * O que estes testes protegem:
 *  - o formato exato (o prompt manda o modelo confiar SÓ neste bloco);
 *  - a virada de dia no fuso: 02:30 UTC ainda é o dia ANTERIOR em São Paulo, e
 *    errar isso faz a IA marcar "amanhã" um dia fora;
 *  - a régua dos próximos 7 dias (LLM erra aritmética de dia da semana, e é ela
 *    que permite "quinta que vem");
 *  - timezone inválida NÃO lança (é texto livre da config da org);
 *  - a semântica opt-OUT da flag (ausente = ligado).
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_TIMEZONE,
  buildCurrentDateTimeBlock,
  resolveAgentTimezone,
  safeTimezone,
  shouldIncludeCurrentDateTime,
} from "./promptDateTime";

// 18/09/2026 17:32 UTC = sexta-feira, 14:32 em São Paulo (UTC-3).
const SEXTA_1432_SP = Date.UTC(2026, 8, 18, 17, 32);

describe("buildCurrentDateTimeBlock", () => {
  test("data, dia da semana e hora no fuso pedido", () => {
    const block = buildCurrentDateTimeBlock(SEXTA_1432_SP, "America/Sao_Paulo");
    expect(block).toContain(
      "DATA E HORA ATUAIS: sexta-feira, 18/09/2026, 14:32 (fuso America/Sao_Paulo)."
    );
    expect(block).toContain("Nunca chute a data");
  });

  test("o MESMO instante em outro fuso muda hora, dia e dia da semana", () => {
    // 02:30 UTC de sábado ainda é sexta 23:30 em São Paulo — o erro clássico.
    const madrugada = Date.UTC(2026, 8, 19, 2, 30);
    expect(buildCurrentDateTimeBlock(madrugada, "America/Sao_Paulo")).toContain(
      "sexta-feira, 18/09/2026, 23:30"
    );
    expect(buildCurrentDateTimeBlock(madrugada, "UTC")).toContain(
      "sábado, 19/09/2026, 02:30 (fuso UTC)"
    );
  });

  test("meia-noite sai como 00:00, nunca 24:00", () => {
    expect(buildCurrentDateTimeBlock(Date.UTC(2026, 8, 19, 3, 0), "America/Sao_Paulo")).toContain(
      "sábado, 19/09/2026, 00:00"
    );
  });

  test("régua dos próximos 7 dias, a partir do dia seguinte", () => {
    const block = buildCurrentDateTimeBlock(SEXTA_1432_SP, "America/Sao_Paulo");
    expect(block).toContain(
      "Próximos dias: sáb 19/09, dom 20/09, seg 21/09, ter 22/09, qua 23/09, qui 24/09, sex 25/09."
    );
  });

  test("a régua atravessa a virada de mês pelo calendário", () => {
    // 28/02/2027 é domingo; 2027 não é bissexto.
    const block = buildCurrentDateTimeBlock(Date.UTC(2027, 1, 28, 15, 0), "America/Sao_Paulo");
    expect(block).toContain("Próximos dias: seg 01/03, ter 02/03,");
    expect(block).toContain("DATA E HORA ATUAIS: domingo, 28/02/2027");
  });

  test("timezone inválida não lança — cai no default do produto", () => {
    const block = buildCurrentDateTimeBlock(SEXTA_1432_SP, "America/Sao_Pualo");
    expect(block).toContain("(fuso America/Sao_Paulo)");
    expect(block).toContain("14:32");
  });

  test("timezone ausente ou vazia também cai no default", () => {
    for (const tz of [undefined, null, "", "   "]) {
      expect(buildCurrentDateTimeBlock(SEXTA_1432_SP, tz)).toContain(
        `(fuso ${DEFAULT_TIMEZONE})`
      );
    }
  });
});

describe("safeTimezone / resolveAgentTimezone", () => {
  test("fuso válido passa; inválido vira o default", () => {
    expect(safeTimezone("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(safeTimezone("Marte/Olympus")).toBe(DEFAULT_TIMEZONE);
  });

  test("o horário de atendimento vence o fuso da org", () => {
    expect(resolveAgentTimezone("Europe/Lisbon", "America/Sao_Paulo")).toBe("Europe/Lisbon");
    expect(resolveAgentTimezone(undefined, "America/Manaus")).toBe("America/Manaus");
    expect(resolveAgentTimezone("   ", "America/Manaus")).toBe("America/Manaus");
    expect(resolveAgentTimezone(undefined, undefined)).toBe(DEFAULT_TIMEZONE);
  });

  test("agenda com fuso INVÁLIDO cai para o da org, não para o default", () => {
    // Um erro de digitação no horário de atendimento não pode fazer uma org de
    // Manaus passar a ver hora de São Paulo.
    expect(resolveAgentTimezone("America/Sao_Pualo", "America/Manaus")).toBe("America/Manaus");
    // E se a org também estiver inválida, aí sim o default do produto.
    expect(resolveAgentTimezone("Marte/Olympus", "Jupiter/Io")).toBe(DEFAULT_TIMEZONE);
  });
});

describe("shouldIncludeCurrentDateTime (opt-OUT)", () => {
  test("ausente = LIGADO; só false explícito desliga", () => {
    expect(shouldIncludeCurrentDateTime(undefined)).toBe(true);
    expect(shouldIncludeCurrentDateTime(null)).toBe(true);
    expect(shouldIncludeCurrentDateTime({})).toBe(true);
    expect(shouldIncludeCurrentDateTime({ includeCurrentDateTime: true })).toBe(true);
    expect(shouldIncludeCurrentDateTime({ includeCurrentDateTime: false })).toBe(false);
  });
});
