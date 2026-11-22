import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  confirmLabel,
  isSituationChanged,
  lineOutcomeText,
  movesAutomatically,
  reopenNotice,
  closureRunKindLabel,
  runView,
  summarizePreview,
  validatePeriod,
  type ClosureLine,
  type ClosureResult,
  type ClosureRunLike,
} from "./agendaClosure";

const line = (over: Partial<ClosureLine> = {}): ClosureLine => ({
  appointmentId: "a1",
  resourceIds: ["r1"],
  resourceNames: ["Sala 3"],
  startTime: 0,
  localDate: "2026-11-23",
  serviceName: "Sessão",
  outcome: "reallocated",
  suggestions: [],
  ...over,
});
const result = (over: Partial<ClosureResult> = {}): ClosureResult => ({
  mode: "preview", dates: ["2026-11-23"], affected: 0, reallocated: 0, conflicts: 0, pending: 0, simulated: 0, capped: false, removed: 0, restorable: 0, items: [], ...over,
});

describe("prévia de fechar: sala move, profissional vira conflito", () => {
  it("sala: 3 mudam de sala e 2 ficam sem lugar; botão pede o aceite", () => {
    const s = summarizePreview(result({ affected: 5, reallocated: 3, conflicts: 2, simulated: 5 }), { resourceName: "Sala 3", kind: "room" });
    expect(s.sentences).toEqual([
      "5 horários marcados em Sala 3 neste período",
      "3 mudam para outra sala",
      "2 ficam sem lugar e vão para a fila de pendências",
    ]);
    expect(s.noAutoMove).toBe(false);
    expect(confirmLabel(s)).toBe("Fechar mesmo assim");
  });
  it("sala só com movidos: 'Fechar e mover N'", () => {
    const s = summarizePreview(result({ affected: 2, reallocated: 2, simulated: 2 }), { resourceName: "Sala 1", kind: "room" });
    expect(confirmLabel(s)).toBe("Fechar e mover 2");
    expect(s.sentences[1]).toBe("2 mudam para outra sala");
  });
  it("singular", () => {
    const s = summarizePreview(result({ affected: 1, reallocated: 1, simulated: 1 }), { resourceName: "Sala 1", kind: "room" });
    expect(s.sentences).toEqual(["1 horário marcado em Sala 1 neste período", "1 muda para outra sala"]);
  });
  it("equipamento também move sozinho", () => {
    const s = summarizePreview(result({ affected: 2, reallocated: 2, simulated: 2 }), { resourceName: "Laser", kind: "equipment" });
    expect(s.sentences[1]).toBe("2 mudam para outro equipamento");
  });
  it("profissional: ninguém é passado a outro; todos viram conflitos com sugestões", () => {
    const s = summarizePreview(result({ affected: 4, conflicts: 4, simulated: 4 }), { resourceName: "Ana", kind: "person" });
    expect(s.noAutoMove).toBe(true);
    expect(s.sentences).toEqual([
      "4 horários marcados em Ana neste período",
      "Ninguém passa para outro profissional sozinho: 4 viram conflitos para você resolver, com sugestões de horário.",
    ]);
    expect(s.sentences.join(" ")).not.toMatch(/mudam para/);
    expect(confirmLabel(s)).toBe("Fechar mesmo assim");
  });
  it("org inteira ou tipo (sem recurso): conflito genérico", () => {
    const s = summarizePreview(result({ affected: 3, conflicts: 3, simulated: 3 }), { resourceName: "Toda a agenda", kind: null });
    expect(s.sentences[1]).toContain("Nada é passado para outro lugar sozinho: 3 viram conflitos");
  });
  it("ninguém afetado: botão simples", () => {
    const s = summarizePreview(result(), { resourceName: "Sala 1", kind: "room" });
    expect(s.none).toBe(true);
    expect(s.sentences).toEqual([]);
    expect(confirmLabel(s)).toBe("Fechar");
  });
  it("prévia simula no máximo 40: o resto é 'a definir quando fechar'", () => {
    const items = [line(), line({ outcome: "unknown" }), line({ outcome: "unknown" })];
    const s = summarizePreview(result({ affected: 60, reallocated: 30, conflicts: 10, simulated: 40, items }), { resourceName: "Sala 1", kind: "room" });
    expect(s.unknown).toBe(20);
    expect(s.sentences.at(-1)).toBe("20 a definir quando fechar");
  });
  it("em atendimento não muda", () => {
    const s = summarizePreview(result({ affected: 2, reallocated: 1, simulated: 2, items: [line(), line({ outcome: "skipped" })] }), { resourceName: "Sala 1", kind: "room" });
    expect(s.skipped).toBe(1);
    expect(s.sentences).toContain("1 em atendimento não muda");
  });
  it("texto de cada afetado", () => {
    expect(lineOutcomeText(line({ toResourceName: "Sala 2" }))).toBe("Muda para Sala 2");
    expect(lineOutcomeText(line({ outcome: "conflict" }))).toBe("Fica sem lugar");
    expect(lineOutcomeText(line({ outcome: "conflict", suggestions: [{}, {}] }))).toBe("Fica sem lugar, com 2 sugestões");
    expect(lineOutcomeText(line({ outcome: "conflict", suggestions: [{}] }))).toBe("Fica sem lugar, com 1 sugestão");
    expect(lineOutcomeText(line({ outcome: "skipped" }))).toBe("Em atendimento, não muda");
    expect(lineOutcomeText(line({ outcome: "unknown" }))).toBe("A definir ao fechar");
  });
  it("só sala e equipamento movem", () => {
    expect([movesAutomatically("room"), movesAutomatically("equipment"), movesAutomatically("person")]).toEqual([true, true, false]);
  });
});

describe("situação mudou", () => {
  it("reconhece a recusa do servidor por diferença de contagem", () => {
    expect(isSituationChanged(new ConvexError("A situação mudou desde a prévia. Confira de novo antes de confirmar."))).toBe(true);
    expect(isSituationChanged(new ConvexError("3 agendamento(s) serão afetados."))).toBe(false);
    expect(isSituationChanged(new Error("A situação mudou"))).toBe(false);
  });
});

describe("período", () => {
  it("valida datas, ordem e passado", () => {
    expect(validatePeriod("2026-11-23", "2026-11-25", "2026-11-23")).toBeNull();
    expect(validatePeriod("2026-11-23", "2026-11-23", "2026-11-23")).toBeNull();
    expect(validatePeriod("", "2026-11-25", "2026-11-23")).toBe("Escolha as datas.");
    expect(validatePeriod("2026-11-25", "2026-11-24", "2026-11-23")).toBe("A data final precisa ser igual ou depois da inicial.");
    expect(validatePeriod("2026-11-22", "2026-11-25", "2026-11-23")).toBe("Escolha hoje ou uma data futura.");
  });
});

describe("andamento do fechamento em lotes", () => {
  const run = (over: Partial<ClosureRunLike> = {}): ClosureRunLike => ({
    status: "running", total: 10, totalIsPartial: false, processed: 4, reallocated: 3, conflicts: 1, failed: 0, ...over,
  });
  it("em andamento com total conhecido", () => {
    expect(runView(run())).toEqual({ state: "running", text: "Tratando os horários… 4 de 10", progress: 0.4 });
  });
  it("em andamento com total parcial: sem barra", () => {
    expect(runView(run({ totalIsPartial: true }))).toMatchObject({ text: "Tratando os horários… 4 até agora", progress: null });
  });
  it("concluído: resultado final (falhas contam como sem lugar)", () => {
    expect(runView(run({ status: "done", processed: 10, reallocated: 7, conflicts: 2, failed: 1 }))).toEqual({
      state: "done",
      text: "Fechamento concluído: 7 mudaram de lugar e 3 ficaram sem lugar.",
      progress: 1,
    });
    expect(runView(run({ status: "done", total: 0, processed: 0 })).text).toBe("Fechamento concluído. Nenhum horário foi afetado.");
  });
  it("falhou ou truncado: aviso de que não terminou por inteiro", () => {
    expect(runView(run({ status: "failed", failure: "x" })).state).toBe("incomplete");
    expect(runView(run({ status: "done", truncated: true })).text).toBe("O fechamento não terminou por inteiro. Confira a fila de pendências.");
  });
});

describe("reabrir", () => {
  it("motivos do servidor", () => {
    expect(reopenNotice("covered_by_org_closure")).toContain("agenda inteira");
    expect(reopenNotice("nothing_to_reopen")).toContain("Não há fechamento");
    expect(reopenNotice(undefined)).toBeNull();
  });
});

import { periodText } from "./agendaClosure";

describe("data por extenso", () => {
  it("um dia, vários dias, e 'hoje' só quando é hoje", () => {
    expect(periodText("2026-11-26", "2026-11-26")).toBe("qui, 26/11");
    expect(periodText("2026-11-26", "2026-11-26", "2026-11-26")).toBe("qui, 26/11 (hoje)");
    expect(periodText("2026-11-26", "2026-11-26", "2026-11-23")).toBe("qui, 26/11");
    expect(periodText("2026-11-26", "2026-11-27", "2026-11-26")).toBe("qui, 26/11 (hoje) a sex, 27/11");
  });
  it("botão de confirmar leva a data", () => {
    expect(confirmLabel({ total: 3, moved: 3, unplaced: 0 }, "qui, 26/11")).toBe("Fechar e mover 3 em qui, 26/11");
    expect(confirmLabel({ total: 0, moved: 0, unplaced: 0 }, "qui, 26/11")).toBe("Fechar em qui, 26/11");
  });
  it("agenda inteira: nada realocado, todos sem lugar, e prévia cortada diz 'pelo menos'", () => {
    const s = summarizePreview(
      { mode: "preview", dates: [], affected: 12, reallocated: 0, conflicts: 12, pending: 0, simulated: 12, capped: false, removed: 0, restorable: 0, items: [] },
      { resourceName: "Toda a agenda", kind: null, org: true }
    );
    expect(s.sentences[0]).toBe("12 horários marcados na agenda inteira neste período");
    expect(s.sentences[0]).not.toMatch(/em Toda/i);
    expect(s.sentences[1]).toBe("Todos os 12 horários deste período ficam sem lugar e vão para a fila de pendências.");
    const c = summarizePreview(
      { mode: "preview", dates: [], affected: 80, reallocated: 0, conflicts: 40, pending: 0, simulated: 40, capped: true, removed: 0, restorable: 0, items: [] },
      { resourceName: "Sala 1", kind: "room" }
    );
    expect(c.sentences[0]).toBe("Pelo menos 80 horários marcados em Sala 1 neste período");
  });
});

describe("lote de capacidade reduzida", () => {
  const run = (over: Partial<ClosureRunLike> = {}): ClosureRunLike => ({
    kind: "capacity", status: "running", total: 6, totalIsPartial: false, processed: 3, reallocated: 0, conflicts: 2, failed: 0, ...over,
  });
  it("andamento com rótulo próprio, sem falar em fechar", () => {
    expect(runView(run())).toEqual({ state: "running", text: "Ajustando os horários da sala… 3 de 6", progress: 0.5 });
    expect(runView(run({ totalIsPartial: true })).text).toBe("Ajustando os horários da sala… 3 até agora");
  });
  it("concluído: quantos ficaram sem lugar (singular, plural, nenhum; falhas contam)", () => {
    expect(runView(run({ status: "done", conflicts: 1 })).text).toBe("Capacidade ajustada: 1 agendamento ficou sem lugar e foi para a fila de pendências.");
    expect(runView(run({ status: "done", conflicts: 2, failed: 1 })).text).toBe("Capacidade ajustada: 3 agendamentos ficaram sem lugar e foram para a fila de pendências.");
    expect(runView(run({ status: "done", conflicts: 0 })).text).toBe("Capacidade ajustada. Nenhum agendamento ficou sem lugar.");
  });
  it("não terminou por inteiro", () => {
    expect(runView(run({ status: "failed" }))).toMatchObject({ state: "incomplete", text: "O ajuste de capacidade não terminou por inteiro. Confira a fila de pendências." });
    expect(runView(run({ status: "done", truncated: true })).state).toBe("incomplete");
  });
  it("rótulo do modo", () => {
    expect(closureRunKindLabel("capacity")).toBe("Capacidade reduzida");
    expect(closureRunKindLabel("resource_removed")).toBe("Arquivamento");
    expect(closureRunKindLabel(undefined)).toBe("Fechamento");
  });
});

import { closureDoneText } from "./agendaClosure";

describe("resultado do fechamento: concordância", () => {
  it("um, vários e nenhum", () => {
    expect(closureDoneText(1, 0)).toBe("Fechamento concluído: 1 mudou de lugar e nenhum ficou sem lugar.");
    expect(closureDoneText(0, 1)).toBe("Fechamento concluído: nenhum mudou de lugar e 1 ficou sem lugar.");
    expect(closureDoneText(7, 3)).toBe("Fechamento concluído: 7 mudaram de lugar e 3 ficaram sem lugar.");
  });
});
