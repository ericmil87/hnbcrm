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
