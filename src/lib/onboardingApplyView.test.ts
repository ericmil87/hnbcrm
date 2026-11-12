import { describe, expect, it } from "vitest";
import type { ApplyResult } from "../../convex/lib/onboardingApply";
import { applyBlockedReason, describeApplyResult, simulatorReason } from "./onboardingApplyView";

function result(over: Partial<ApplyResult> = {}): ApplyResult {
  return {
    alreadyApplied: false,
    draftHash: "h",
    boardId: null,
    funnelMode: "created",
    fieldsCreated: 2,
    fieldsUpdated: 0,
    quickRepliesCreated: 3,
    quickRepliesSkipped: 0,
    attendant: "created",
    attendantId: null,
    attendantModeReset: false,
    skippedSuspicious: { knowledge: 0, quickReplies: 0, handoffRules: 0, greeting: false, business: false },
    aiActive: true,
    features: { vision: "applied", transcription: "already_on", dateTime: "not_requested", translation: "applied", voice: "no_channel" },
    pendingConsent: [],
    ...over,
  } as ApplyResult;
}

describe("describeApplyResult", () => {
  it("conta o que foi criado, o que foi ligado e que o atendente nasce em sugerir", () => {
    const v = describeApplyResult(result());
    expect(v.created).toEqual(["Funil criado", "2 campos do lead", "3 respostas rápidas", "Atendente IA criado"]);
    expect(v.featuresOn).toEqual(["leitura de imagens", "transcrição de áudio", "tradução de mensagens"]);
    expect(v.waitingChannel).toEqual(["respostas em voz"]);
    expect(v.attendantNote).toMatch(/Sugerir respostas/);
    expect(v.needsConsent).toBe(false);
  });

  it("a nota do atendente diz a verdade conforme o modo final", () => {
    expect(describeApplyResult(result(), "autopilot").attendantNote).toMatch(/responde sozinha, 24h/);
    expect(describeApplyResult(result(), "autopilot").attendantNote).not.toMatch(/Nada sai sozinho/);
    expect(describeApplyResult(result(), "autopilot_failed").attendantNote).toMatch(/ficou montada em Sugerir respostas/);
    expect(describeApplyResult(result(), "suggest").attendantNote).toMatch(/Nada sai sozinho/);
  });

  it("aceite pendente: atendente e recursos esperam o aceite de IA", () => {
    const v = describeApplyResult(
      result({
        attendant: "pending_consent",
        features: { vision: "pending_consent", transcription: "pending_consent", dateTime: "not_requested", translation: "pending_consent", voice: "not_requested" },
        pendingConsent: ["vision", "transcription", "translation"],
      })
    );
    expect(v.needsConsent).toBe(true);
    expect(v.waitingConsent).toEqual(["leitura de imagens", "transcrição de áudio", "tradução de mensagens"]);
    expect(v.attendantNote).toBeNull();
    expect(v.created).not.toContain("Atendente IA criado");
  });

  it("atendente existente mantido (skipped_existing) e itens que ficaram de fora", () => {
    const v = describeApplyResult(
      result({
        attendant: "skipped_existing",
        skippedSuspicious: { knowledge: 2, quickReplies: 1, handoffRules: 0, greeting: true, business: false },
      })
    );
    expect(v.keptExistingAttendant).toBe(true);
    expect(v.leftOut).toEqual(["2 fatos do conhecimento", "1 resposta rápida", "a saudação"]);
  });

  it("não usa o termo proibido 'Repasse'", () => {
    const text = JSON.stringify(
      describeApplyResult(result({ skippedSuspicious: { knowledge: 0, quickReplies: 0, handoffRules: 3, greeting: false, business: false } }))
    );
    expect(text).not.toMatch(/Repasse/i);
    expect(text).toMatch(/pedido de ajuda/);
  });
});

describe("applyBlockedReason / simulatorReason", () => {
  it("nome bloqueado impede montar, com explicação", () => {
    expect(applyBlockedReason({ canApply: false, blockedCount: 2, alreadyApplied: false })).toMatch(/2 nomes/);
    expect(applyBlockedReason({ canApply: true, blockedCount: 0, alreadyApplied: false })).toBeNull();
  });
  it("simulador: sem IA ativa pesa antes de 'não montou'", () => {
    expect(simulatorReason({ aiActive: false, applied: false })).toBe("ai_inactive");
    expect(simulatorReason({ aiActive: true, applied: false })).toBe("not_applied");
    expect(simulatorReason({ aiActive: true, applied: true })).toBeUndefined();
  });
});
