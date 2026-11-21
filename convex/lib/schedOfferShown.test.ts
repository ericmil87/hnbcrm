import { describe, expect, test } from "vitest";
import { issueOffers, type OffersState } from "./schedOffers";
import { offersShownInText } from "./schedOfferShown";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-06-12T12:00:00Z").getTime(); // sexta 09:00
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 5, day, h + 3, m);
const empty: OffersState = { offerSeq: 0, offers: [] };
const { state } = issueOffers(
  empty,
  [{ serviceId: "s", startTime: at(15, 8), resourceIds: [] }, { serviceId: "s", startTime: at(15, 9), resourceIds: [] }, { serviceId: "s", startTime: at(16, 14, 30), resourceIds: [] }],
  NOW
);
const shown = (text: string) => [...offersShownInText(state, text, { now: NOW, tz: TZ })].sort();

describe("offersShownInText", () => {
  test("a mensagem com dia e hora mostra a oferta (formato do servidor, com vírgulas)", () => {
    expect(shown("Tenho segunda-feira, 15/06, às 08:00 ou terça-feira, 16/06, às 14:30. Qual prefere?")).toEqual(["h1", "h3"]);
  });
  test("hora sem dia herda o dia da menção anterior na mesma frase", () => {
    expect(shown("Tenho segunda-feira, 15/06, às 08:00 ou às 09:00.")).toEqual(["h1", "h2"]);
  });
  test("só hora, sem dia nenhum antes, não mostra nada", () => {
    expect(shown("Tenho às 08:00.")).toEqual([]);
  });
  test("horário que a mensagem não cita não vira mostrado", () => {
    expect(shown("Posso ajudar com mais alguma coisa?")).toEqual([]);
    expect(shown("Tenho segunda-feira, 15/06, às 10:00.")).toEqual([]);
  });
  test("funcionamento e indisponibilidade não mostram oferta", () => {
    expect(shown("Atendemos de segunda a sexta, das 8h às 18h.")).toEqual([]);
  });
  test("estado vazio e texto vazio", () => {
    expect(offersShownInText(empty, "segunda 15/06 às 08:00", { now: NOW, tz: TZ }).size).toBe(0);
    expect(shown("")).toEqual([]);
  });
});

describe("formatos comuns de oferta (o casador não herda os bloqueios do extrator de cliente)", () => {
  const three = issueOffers(
    empty,
    [{ serviceId: "s", startTime: at(15, 8), resourceIds: [] }, { serviceId: "s", startTime: at(15, 17), resourceIds: [] }, { serviceId: "s", startTime: at(15, 9), resourceIds: [] }],
    NOW
  ).state; // h1 = 08:00, h2 = 17:00, h3 = 09:00 (segunda 15/06)
  const sh = (text: string) => [...offersShownInText(three, text, { now: NOW, tz: TZ })].sort();
  const ALL = ["h1", "h2", "h3"];
  test.each<[string, string, string[]]>([
    ["HH:MM completo", "Tenho segunda-feira, 15/06, às 08:00 ou às 17:00 ou às 09:00. Qual prefere?", ALL],
    ["Nh em lista", "Tenho segunda às 8h, 9h e 17h, qual fica melhor?", ALL],
    ["por extenso", "Tenho segunda às oito, às nove ou às cinco da tarde.", ALL],
    ["N da manhã/tarde", "Tenho segunda às 8 da manhã, 9 da manhã ou 5 da tarde.", ALL],
    ["condicional 'se quiser'", "Se quiser, tenho segunda 15/06 às 08:00 ou às 09:00.", ["h1", "h3"]],
    ["condicional 'caso prefira'", "Tenho segunda às 8h, caso prefira à tarde tenho às 17h.", ["h1", "h2"]],
    ["lista em linhas", "Segunda-feira, 15/06:\n- 08:00\n- 09:00\n- 17:00\nQual prefere?", ALL],
    ["dia com dois-pontos", "Segunda: 8h, 9h ou 17h. Qual prefere?", ALL],
    ["'Para segunda tenho'", "Para segunda tenho 8h, 9h ou 17h.", ALL],
    ["'dia 15'", "Tenho dia 15 às 8h.", ["h1"]],
    ["dia de OUTRA oferta não marca", "Tenho terça às 08:00.", []],
    ["sem dia, todas do mesmo dia", "Tenho às 08:00.", ["h1"]],
    ["duas horas na mesma frase", "Tenho segunda às 8h e às 9h.", ["h1", "h3"]],
    ["dia carregado entre frases", "Segunda tenho vaga. Às 8h, às 9h ou às 17h.", ALL],
    ["data com parênteses e emoji", "Na segunda (15/06) consigo 08:00, 09:00 ou 17:00 😊", ALL],
    ["indisponibilidade não oferece", "Não tenho mais às 10h; segunda tenho 8h, 9h e 17h.", ALL],
    ["'não tenho às 8h' não mostra a de 8h", "Não tenho às 8h. Segunda tenho 9h.", ["h3"]],
    ["hora que não é de oferta nenhuma", "Segunda às 10h está livre.", []],
    ["faixa de funcionamento não é oferta", "Atendemos segunda das 8h às 18h.", []],
    ["meio-dia por extenso numa oferta de 12:00", "Tenho segunda ao meio-dia.", []],
  ])("%s", (_label, text, expected) => {
    expect(sh(text)).toEqual(expected);
  });
  test("oferta ao meio-dia e meia", () => {
    const o = issueOffers(empty, [{ serviceId: "s", startTime: at(15, 12, 30), resourceIds: [] }, { serviceId: "s", startTime: at(15, 12), resourceIds: [] }], NOW).state;
    expect([...offersShownInText(o, "Segunda tenho ao meio-dia e meia.", { now: NOW, tz: TZ })]).toEqual(["h1"]);
    expect([...offersShownInText(o, "Segunda tenho às 12h30.", { now: NOW, tz: TZ })]).toEqual(["h1"]);
  });
});
