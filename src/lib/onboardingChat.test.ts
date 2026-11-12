import { describe, expect, it } from "vitest";
import { buildTimeline, currentChips, plainModelText, stageProgress, type HistoryMessage, type PendingTurn } from "./onboardingChat";

function msg(id: string, role: "user" | "assistant", text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { _id: id, role, text, blocks: [], chips: [], attachment: null, createdAt: 1, ...extra };
}

function pending(extra: Partial<PendingTurn> = {}): PendingTurn {
  return {
    userText: "Quero vender mais",
    baselineId: "m2",
    startedAt: 100,
    replyText: "",
    blocks: [],
    chips: [],
    status: null,
    streaming: true,
    ...extra,
  };
}

describe("stageProgress", () => {
  it("mapeia as etapas do servidor e a etapa de conta", () => {
    expect(stageProgress("account")).toMatchObject({ index: 1, total: 7, label: "Conta" });
    expect(stageProgress("interview").valueText).toBe("Etapa 2 de 7: Entrevista");
    expect(stageProgress("next_steps")).toMatchObject({ index: 7, ratio: 1 });
  });
  it("etapa desconhecida ou nula = entrevista", () => {
    expect(stageProgress(null).index).toBe(2);
    expect(stageProgress("xpto").index).toBe(2);
  });
});

describe("plainModelText", () => {
  it("tira HTML, imagem, link e URL; mantém quebras", () => {
    const raw = 'Oi <b>Ana</b>!\n<img src=x onerror=alert(1)>Veja ![logo](https://x.com/a.png) e [clique](https://mal.example) ou https://mal.example/p?q=1 ou www.mal.example\n\n\n\nFim';
    const out = plainModelText(raw);
    expect(out).not.toMatch(/<|>|https?:|www\.|\]\(/);
    expect(out).toContain("Oi Ana!");
    expect(out).toContain("Veja logo e clique ou [link removido] ou [link removido]");
    expect(out).toContain("\n\nFim");
    expect(out).not.toContain("\n\n\n");
  });
  it("remove invisíveis e esquemas perigosos; não-string vira vazio", () => {
    expect(plainModelText("a​b﻿c")).toBe("abc");
    expect(plainModelText("javascript:alert(1)")).toBe("[link removido]");
    expect(plainModelText("<script>alert(1)</script>Oi<style>p{}</style>")).toBe("Oi");
    expect(plainModelText(42)).toBe("");
    expect(plainModelText(null)).toBe("");
  });
});

describe("buildTimeline", () => {
  const history = [msg("m2", "assistant", "Qual o nome?", { chips: ["Loja X"] }), msg("m1", "user", "Oi")];

  it("sem turno pendente: histórico em ordem cronológica", () => {
    expect(buildTimeline(history, null).map((t) => t.key)).toEqual(["m1", "m2"]);
  });

  it("turno em andamento: bolha da pessoa e resposta parcial no fim", () => {
    const tl = buildTimeline(history, pending({ replyText: "Leg" }));
    expect(tl.map((t) => t.key)).toEqual(["m1", "m2", "pending:user", "pending:assistant"]);
    expect(tl[3]).toMatchObject({ role: "assistant", text: "Leg", pending: true });
  });

  it("sem texto nem bloco ainda: só a bolha da pessoa (os pontos vêm da tela)", () => {
    expect(buildTimeline(history, pending()).map((t) => t.key)).toEqual(["m1", "m2", "pending:user"]);
  });

  it("mensagem da pessoa já no histórico: some a pendente dela, a resposta segue", () => {
    const h = [msg("m3", "user", "Quero vender mais"), ...history];
    const keys = buildTimeline(h, pending({ replyText: "Ok" })).map((t) => t.key);
    expect(keys).toEqual(["m1", "m2", "m3", "pending:assistant"]);
  });

  it("resposta já no histórico: nada pendente duplicado; áudio do stream completa a resposta", () => {
    const h = [msg("m4", "assistant", "Ok!"), msg("m3", "user", "Quero vender mais"), ...history];
    const audio = { url: "https://x/a.wav", durationSec: 2, mimeType: "audio/wav" };
    const tl = buildTimeline(h, pending({ replyText: "Ok!", streaming: false, audio }));
    expect(tl.map((t) => t.key)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(tl[3].audio).toEqual(audio);
  });

  it("histórico vazio (baseline null): tudo o que chegar é do turno", () => {
    expect(buildTimeline([], pending({ baselineId: null })).map((t) => t.key)).toEqual(["pending:user"]);
    const h = [msg("a1", "assistant", "Oi"), msg("u1", "user", "Quero vender mais")];
    expect(buildTimeline(h, pending({ baselineId: null })).map((t) => t.key)).toEqual(["u1", "a1"]);
  });
});

describe("currentChips", () => {
  it("chips da última resposta; depois de mensagem da pessoa, nenhum; vazio usa o reserva", () => {
    const tl = buildTimeline([msg("m2", "assistant", "?", { chips: ["A", "B"] }), msg("m1", "user", "Oi")], null);
    expect(currentChips(tl)).toEqual(["A", "B"]);
    expect(currentChips([...tl, { key: "u", role: "user", text: "x", blocks: [], chips: [] }])).toEqual([]);
    expect(currentChips([], ["Saudação"])).toEqual(["Saudação"]);
  });
});
