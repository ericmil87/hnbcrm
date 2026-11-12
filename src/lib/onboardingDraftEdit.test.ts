import { describe, expect, it, vi } from "vitest";
import { draftFixture } from "../test/onboardingDraftFixture";
import {
  DRAFT_CONFLICT_NOTICE,
  addKnowledge,
  checkReleaseReason,
  isDraftConflictMessage,
  moveStage,
  releaseKnowledge,
  releaseQuickReply,
  removeKnowledge,
  removeQuickReply,
  renameStage,
  saveDraftEdit,
  setBusiness,
  setFunnelName,
  setKnowledgeText,
  setPersona,
  setQuickReply,
  setTranslation,
} from "./onboardingDraftEdit";

describe("edição do rascunho (funções puras)", () => {
  it("não muda o rascunho recebido", () => {
    const d = draftFixture();
    const snapshot = JSON.stringify(d);
    setPersona({ attendantName: "Zé" })(d);
    removeKnowledge(0)(d);
    moveStage(0, 1)(d);
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("persona: só os campos fechados mudam", () => {
    const d = setPersona({ attendantName: "Zé", tone: "formal", addressAs: "senhor" })(draftFixture());
    expect(d.persona).toMatchObject({ attendantName: "Zé", tone: "formal", addressAs: "senhor", presentsAsAi: true });
  });

  it("tradução liga e desliga em features.translation", () => {
    expect(setTranslation(false)(draftFixture()).features.translation).toBe(false);
    expect(setTranslation(true)(setTranslation(false)(draftFixture())).features.translation).toBe(true);
  });

  it("conhecimento: liberar manda release.reason sem by/at; editar o texto tira a liberação", () => {
    const released = releaseKnowledge(1, "é o telefone da loja")(draftFixture());
    expect(released.knowledge[1].release).toEqual({ reason: "é o telefone da loja" });
    expect(released.knowledge[0].release).toBeUndefined();
    const edited = setKnowledgeText(1, "Ligue para a loja")(released);
    expect(edited.knowledge[1].release).toBeUndefined();
    expect(edited.knowledge[1].text).toBe("Ligue para a loja");
    expect(setKnowledgeText(1, "Ligue para 1199999")(released).knowledge[1].release).toBeDefined();
  });

  it("conhecimento: remover e adicionar (origem 'você')", () => {
    expect(removeKnowledge(0)(draftFixture()).knowledge).toHaveLength(1);
    const added = addKnowledge("Entregamos em Olinda")(draftFixture());
    expect(added.knowledge.at(-1)).toMatchObject({ text: "Entregamos em Olinda", origin: { kind: "usuario" }, suspicious: false });
  });

  it("respostas rápidas: editar, remover e liberar", () => {
    const d = draftFixture();
    expect(setQuickReply(0, { shortcut: "ola", text: "Olá, tudo bem?" })(d).quickReplies[0]).toMatchObject({ shortcut: "ola" });
    expect(removeQuickReply(0)(d).quickReplies).toHaveLength(1);
    expect(releaseQuickReply(1, "chave da loja")(d).quickReplies[1].release).toEqual({ reason: "chave da loja" });
  });

  it("negócio: editar tira a liberação; igual mantém", () => {
    const d = draftFixture();
    d.business.release = { reason: "ok, é meu" };
    expect(setBusiness({ name: d.business.name })(d).business.release).toEqual({ reason: "ok, é meu" });
    expect(setBusiness({ name: "Outra" })(d).business.release).toBeUndefined();
    expect(setBusiness({ city: "" })(draftFixture()).business.city).toBeUndefined();
  });

  it("funil: renomear e reordenar renumera 0..n-1", () => {
    let d = renameStage(1, "Atendimento")(setFunnelName("Funil novo")(draftFixture()));
    expect(d.funnel.name).toBe("Funil novo");
    expect(d.funnel.stages.map((s) => s.name)).toEqual(["Novo", "Atendimento", "Ganho"]);
    d = moveStage(1, 1)(d);
    expect(d.funnel.stages.map((s) => [s.name, s.order])).toEqual([
      ["Novo", 0],
      ["Ganho", 1],
      ["Atendimento", 2],
    ]);
    expect(moveStage(0, -1)(d)).toEqual(d);
  });
});

describe("motivo da liberação", () => {
  it("pede um motivo de verdade", () => {
    expect(checkReleaseReason("   ").ok).toBe(false);
    expect(checkReleaseReason("ok").ok).toBe(false);
    expect(checkReleaseReason("x".repeat(201)).ok).toBe(false);
    expect(checkReleaseReason("  é o   telefone da loja ")).toEqual({ ok: true, reason: "é o telefone da loja" });
  });
});

describe("saveDraftEdit (saveDraft com versão)", () => {
  const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "erro");

  it("grava o rascunho editado com expectedVersion = versão do formulário", async () => {
    const mutate = vi.fn().mockResolvedValue({});
    const out = await saveDraftEdit({
      current: { draft: draftFixture(), version: 4 },
      baseVersion: 4,
      update: setPersona({ attendantName: "Zé" }),
      mutate,
      errorMessage,
    });
    expect(out).toEqual({ ok: true });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].expectedVersion).toBe(4);
    expect(mutate.mock.calls[0][0].draft.persona.attendantName).toBe("Zé");
  });

  it("rascunho mais novo que o formulário: não grava e avisa", async () => {
    const mutate = vi.fn();
    const out = await saveDraftEdit({
      current: { draft: draftFixture(), version: 5 },
      baseVersion: 4,
      update: setTranslation(false),
      mutate,
      errorMessage,
    });
    expect(out).toEqual({ ok: false, reason: "stale", message: DRAFT_CONFLICT_NOTICE });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("conflito do servidor vira o aviso de recarregar", async () => {
    const out = await saveDraftEdit({
      current: { draft: draftFixture(), version: 4 },
      baseVersion: 4,
      update: setTranslation(false),
      mutate: vi.fn().mockRejectedValue(new Error("O rascunho foi alterado em outro lugar. Recarregue e tente de novo.")),
      errorMessage,
    });
    expect(out).toMatchObject({ ok: false, reason: "conflict", message: DRAFT_CONFLICT_NOTICE });
    expect(isDraftConflictMessage("O rascunho foi alterado em outro lugar.")).toBe(true);
  });

  it("outro erro do servidor mostra a mensagem dele; sem rascunho não grava", async () => {
    const err = await saveDraftEdit({
      current: { draft: draftFixture(), version: 1 },
      baseVersion: 1,
      update: (d) => d,
      mutate: vi.fn().mockRejectedValue(new Error("Etapas do funil: no mínimo 2")),
      errorMessage,
    });
    expect(err).toEqual({ ok: false, reason: "error", message: "Etapas do funil: no mínimo 2" });
    const none = await saveDraftEdit({ current: null, baseVersion: 0, update: (d) => d, mutate: vi.fn(), errorMessage });
    expect(none).toMatchObject({ ok: false, reason: "no_draft" });
  });
});
