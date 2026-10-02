/**
 * Valores efetivos da config de follow-up (v0.60).
 *
 * O ponto destes testes é que o DEFAULT é decisão de produto (D1: ausente =
 * "Preparar rascunho") e que valor inválido gravado por uma versão antiga da
 * tela não pode virar comportamento perigoso — janela invertida não pode
 * liberar madrugada, e teto negativo não pode virar "sem teto".
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_DAILY_CAP_BRIDGE,
  DEFAULT_DAILY_CAP_META,
  DEFAULT_MAX_CHAIN,
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  parseEventEnd,
  resolveFollowUpSettings,
} from "./followUpSettings";

describe("resolveFollowUpSettings", () => {
  test("perfil sem configuração cai no default do produto (D1: rascunho)", () => {
    const meta = resolveFollowUpSettings(undefined, "meta");
    expect(meta).toEqual({
      mode: "draft",
      maxChain: DEFAULT_MAX_CHAIN,
      quietStartHour: DEFAULT_QUIET_START_HOUR,
      quietEndHour: DEFAULT_QUIET_END_HOUR,
      dailyCap: DEFAULT_DAILY_CAP_META,
    });
  });

  test("teto diário default depende do transporte (bridge é mais conservador)", () => {
    expect(resolveFollowUpSettings({}, "bridge").dailyCap).toBe(DEFAULT_DAILY_CAP_BRIDGE);
    expect(resolveFollowUpSettings({}, "meta").dailyCap).toBe(DEFAULT_DAILY_CAP_META);
    // Canal não resolvido é tratado como Meta (mesma postura da condição 11
    // da elegibilidade do atendente).
    expect(resolveFollowUpSettings({}, null).dailyCap).toBe(DEFAULT_DAILY_CAP_META);
  });

  test("valores explícitos vencem os defaults", () => {
    const s = resolveFollowUpSettings(
      {
        followUps: {
          mode: "send",
          maxChain: 4,
          quietStartHour: 9,
          quietEndHour: 18,
          dailyCap: 7,
        },
      },
      "bridge"
    );
    expect(s).toEqual({
      mode: "send",
      maxChain: 4,
      quietStartHour: 9,
      quietEndHour: 18,
      dailyCap: 7,
    });
  });

  test("dailyCap 0 é VÁLIDO e significa sem teto", () => {
    expect(resolveFollowUpSettings({ followUps: { mode: "send", dailyCap: 0 } }, "bridge").dailyCap)
      .toBe(0);
  });

  test("janela invertida ou vazia volta ao default (nunca libera madrugada)", () => {
    const invertida = resolveFollowUpSettings(
      { followUps: { mode: "send", quietStartHour: 20, quietEndHour: 8 } },
      "meta"
    );
    expect(invertida.quietStartHour).toBe(DEFAULT_QUIET_START_HOUR);
    expect(invertida.quietEndHour).toBe(DEFAULT_QUIET_END_HOUR);

    const vazia = resolveFollowUpSettings(
      { followUps: { mode: "send", quietStartHour: 10, quietEndHour: 10 } },
      "meta"
    );
    expect(vazia.quietStartHour).toBe(DEFAULT_QUIET_START_HOUR);
    expect(vazia.quietEndHour).toBe(DEFAULT_QUIET_END_HOUR);
  });

  test("números fora de faixa ou fracionários caem no default", () => {
    const s = resolveFollowUpSettings(
      {
        followUps: {
          mode: "draft",
          maxChain: 0,
          dailyCap: -5,
          quietStartHour: 2.5,
          quietEndHour: 99,
        },
      },
      "bridge"
    );
    expect(s.maxChain).toBe(DEFAULT_MAX_CHAIN);
    expect(s.dailyCap).toBe(DEFAULT_DAILY_CAP_BRIDGE);
    expect(s.quietStartHour).toBe(DEFAULT_QUIET_START_HOUR);
    expect(s.quietEndHour).toBe(DEFAULT_QUIET_END_HOUR);
  });
});

describe("eventDateField (v0.64)", () => {
  test("ausente fica undefined; presente é exposto com trim", () => {
    expect(resolveFollowUpSettings({}, "meta").eventDateField).toBeUndefined();
    expect(
      resolveFollowUpSettings({ followUps: { mode: "draft", eventDateField: " data_evento " } }, "meta")
        .eventDateField
    ).toBe("data_evento");
    expect(
      resolveFollowUpSettings({ followUps: { mode: "draft", eventDateField: "  " } }, "meta")
        .eventDateField
    ).toBeUndefined();
  });

  test("parseEventEnd: só-data vale até o fim do dia; timestamp e epoch como estão", () => {
    expect(parseEventEnd("2027-02-04")).toBe(Date.parse("2027-02-05T00:00:00Z"));
    expect(parseEventEnd("2027-02-04T10:00:00Z")).toBe(Date.parse("2027-02-04T10:00:00Z"));
    expect(parseEventEnd(1234)).toBe(1234);
    expect(parseEventEnd("lixo")).toBeNull();
    expect(parseEventEnd(undefined)).toBeNull();
    expect(parseEventEnd("")).toBeNull();
  });
});
