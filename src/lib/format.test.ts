import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatDateTimeShort,
  formatDueRelative,
  formatMoney,
  formatUsd,
  formatRelative,
  formatTime,
  parseDecimal,
} from "./format";

// 2025-03-09T02:30:00Z = 08/03 23:30 em São Paulo (UTC-3) e 09/03 11:30 em Tóquio (UTC+9).
const TS = Date.UTC(2025, 2, 9, 2, 30);
const SP = { timeZone: "America/Sao_Paulo" };
const TOKYO = { timeZone: "Asia/Tokyo" };

describe("formatDate / formatTime / formatDateTime", () => {
  it("respeita o fuso informado", () => {
    expect(formatDate(TS, SP)).toBe("08/03/2025");
    expect(formatDate(TS, TOKYO)).toBe("09/03/2025");
    expect(formatTime(TS, SP)).toBe("23:30");
    expect(formatTime(TS, TOKYO)).toBe("11:30");
  });

  it("junta data e hora", () => {
    expect(formatDateTime(TS, SP)).toBe("08/03/2025 23:30");
    expect(formatDateTime(TS, TOKYO)).toBe("09/03/2025 11:30");
  });

  it("aceita Date", () => {
    expect(formatDate(new Date(TS), SP)).toBe("08/03/2025");
  });

  it("valor inválido vira traço", () => {
    expect(formatDate(NaN)).toBe("—");
    expect(formatTime(new Date("x"))).toBe("—");
    expect(formatDateTime(Infinity)).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2025, 5, 15, 12, 0);
  const ago = (ms: number) => now - ms;

  it("agora para menos de um minuto e para o futuro", () => {
    expect(formatRelative(ago(0), now)).toBe("agora");
    expect(formatRelative(ago(59_000), now)).toBe("agora");
    expect(formatRelative(now + 3_600_000, now)).toBe("agora");
  });

  it("minutos, horas e dias", () => {
    expect(formatRelative(ago(5 * 60_000), now)).toBe("há 5 min");
    expect(formatRelative(ago(59 * 60_000), now)).toBe("há 59 min");
    expect(formatRelative(ago(60 * 60_000), now)).toBe("há 1h");
    expect(formatRelative(ago(23 * 3_600_000), now)).toBe("há 23h");
    expect(formatRelative(ago(24 * 3_600_000), now)).toBe("há 1 dia");
    expect(formatRelative(ago(6 * 86_400_000), now)).toBe("há 6 dias");
  });

  it("a partir de 7 dias mostra a data, no fuso pedido", () => {
    const old = Date.UTC(2025, 2, 9, 2, 30);
    expect(formatRelative(old, now, SP)).toMatch(/^08 de mar\.? de 2025$/);
    expect(formatRelative(old, now, TOKYO)).toMatch(/^09 de mar\.? de 2025$/);
  });

  it("inválido vira traço", () => {
    expect(formatRelative(NaN, now)).toBe("—");
  });
});

describe("formatDueRelative", () => {
  const now = new Date(2025, 5, 15, 15, 0).getTime();
  const day = (offset: number, hour = 9) => new Date(2025, 5, 15 + offset, hour).getTime();

  it("hoje, ontem e amanhã por dia de calendário", () => {
    expect(formatDueRelative(day(0, 23), now)).toBe("Hoje");
    expect(formatDueRelative(day(-1), now)).toBe("Ontem");
    expect(formatDueRelative(day(1), now)).toBe("Amanhã");
  });

  it("atraso e prazo próximo em dias", () => {
    expect(formatDueRelative(day(-3), now)).toBe("3d atrás");
    expect(formatDueRelative(day(4), now)).toBe("4d");
    expect(formatDueRelative(day(7), now)).toBe("7d");
  });

  it("depois de 7 dias mostra dia e mês", () => {
    expect(formatDueRelative(day(10), now)).toMatch(/^25 de jun\.?$/);
  });
});

describe("formatMoney", () => {
  const norm = (s: string) => s.replace(/ /g, " ");

  it("BRL por padrão, com centavos", () => {
    expect(norm(formatMoney(1234.5))).toBe("R$ 1.234,50");
  });

  it("outras moedas", () => {
    expect(norm(formatMoney(10, "USD"))).toBe("US$ 10,00");
    expect(norm(formatMoney(10, "EUR"))).toBe("€ 10,00");
  });

  it("sem casas decimais", () => {
    expect(norm(formatMoney(1234.56, "BRL", { fractionDigits: 0 }))).toBe("R$ 1.235");
  });

  it("compacto", () => {
    expect(norm(formatMoney(1_500_000, "BRL", { compact: true }))).toBe("R$ 1,5 mi");
    expect(norm(formatMoney(1500, "BRL", { compact: true }))).toBe("R$ 1,5 mil");
    expect(norm(formatMoney(500, "BRL", { compact: true }))).toBe("R$ 500");
  });

  it("ausente ou não finito vira traço", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney(NaN)).toBe("—");
  });

  it("moeda inválida cai em BRL", () => {
    expect(norm(formatMoney(5, "xx"))).toBe("R$ 5,00");
    expect(norm(formatMoney(5, ""))).toBe("R$ 5,00");
  });
});

describe("formatCount", () => {
  it("separa milhares com ponto", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1.234.567");
  });
});

describe("parseDecimal", () => {
  it("aceita vírgula e ponto", () => {
    expect(parseDecimal("12,5")).toBe(12.5);
    expect(parseDecimal("12.5")).toBe(12.5);
    expect(parseDecimal(" 7 ")).toBe(7);
  });

  it("vazio ou inválido vira null", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("   ")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});

describe("formatUsd", () => {
  const norm = (s: string) => s.replace(/\u00a0/g, " ");
  it("formata dólar e abrevia valores abaixo de 1 centavo", () => {
    expect(formatUsd(0.004)).toBe("menos de US$ 0,01");
    expect(formatUsd(0)).not.toBe("menos de US$ 0,01");
    expect(norm(formatUsd(12.5))).toBe("US$ 12,50");
  });
});

describe("formatDateTimeShort", () => {
  const NOW_2025 = Date.UTC(2025, 5, 1, 12);
  it("omite o ano quando é o ano corrente", () => {
    expect(formatDateTimeShort(TS, NOW_2025, SP)).toBe("08/03 23:30");
  });
  it("mantém o ano em outro ano", () => {
    expect(formatDateTimeShort(TS, Date.UTC(2026, 0, 10), SP)).toBe("08/03/2025 23:30");
  });
  it("respeita o fuso na comparação do ano (virada de ano)", () => {
    // 01/01/2026 01:00 UTC ainda é 31/12/2025 em São Paulo.
    expect(formatDateTimeShort(Date.UTC(2026, 0, 1, 1), Date.UTC(2025, 5, 1), SP)).toBe("31/12 22:00");
  });
  it("devolve traço para data inválida", () => {
    expect(formatDateTimeShort(Number.NaN, NOW_2025)).toBe("—");
  });
});
