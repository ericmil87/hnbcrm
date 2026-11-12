import { describe, expect, it, vi } from "vitest";
import type { ApplyResult } from "../../convex/lib/onboardingApply";
import {
  INITIAL_ACTIVATION,
  activateBlockedReason,
  activateButtonLabel,
  activeLine,
  buildActivationDeps,
  runActivation,
  type ActivationDeps,
  type ActivationState,
} from "./onboardingActivate";

function result(over: Partial<ApplyResult> = {}): ApplyResult {
  return { alreadyApplied: false, attendant: "created", attendantId: "att1", ...over } as unknown as ApplyResult;
}

function deps(over: Partial<ActivationDeps> = {}): ActivationDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enableAi: vi.fn(async () => void calls.push("accept")),
    apply: vi.fn(async () => {
      calls.push("apply");
      return { ok: true as const, result: result() };
    }),
    enableAutopilot: vi.fn(async (id: string) => void calls.push(`mode:${id}`)),
    errorMessage: (e, fallback) => (e instanceof Error ? e.message : fallback),
    ...over,
  };
}

const run = (prev: ActivationState, input: Parameters<typeof runActivation>[1], d: ActivationDeps) => runActivation(prev, input, d, () => {});

describe("runActivation", () => {
  it("automático: aceita, monta e liga o modo, nesta ordem, com o id do atendente desta aplicação", async () => {
    const d = deps();
    const s = await run(INITIAL_ACTIVATION, { mode: "autopilot", aiActive: false }, d);
    expect(d.calls).toEqual(["accept", "apply", "mode:att1"]);
    expect(d.enableAutopilot).toHaveBeenCalledWith("att1");
    expect(s).toMatchObject({ complete: true, finalMode: "autopilot" });
    expect(s.steps).toEqual({ accept: "done", apply: "done", mode: "done" });
  });

  it("Sugerir respostas nunca liga o automático", async () => {
    const d = deps();
    const s = await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: false }, d);
    expect(d.enableAutopilot).not.toHaveBeenCalled();
    expect(s).toMatchObject({ complete: true, finalMode: "suggest" });
  });

  it("IA já ativa: pula o aceite", async () => {
    const d = deps();
    const s = await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: true }, d);
    expect(d.enableAi).not.toHaveBeenCalled();
    expect(s.steps.accept).toBe("skipped");
  });

  it("erro no aceite para tudo; clicar de novo retoma do aceite", async () => {
    let fail = true;
    const d = deps({
      enableAi: vi.fn(async () => {
        if (fail) throw new Error("Sem permissão");
        d.calls.push("accept");
      }),
    });
    const s1 = await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: false }, d);
    expect(s1.errors.accept).toBe("Sem permissão");
    expect(s1.steps).toMatchObject({ accept: "error", apply: "idle" });
    expect(d.apply).not.toHaveBeenCalled();
    fail = false;
    const s2 = await run(s1, { mode: "suggest", aiActive: false }, d);
    expect(s2.complete).toBe(true);
    expect(d.apply).toHaveBeenCalledTimes(1);
  });

  it("erro ao montar mantém o aceite feito e não pede de novo", async () => {
    let fail = true;
    const d = deps({
      apply: vi.fn(async () => (fail ? { ok: false as const, message: "O rascunho mudou." } : { ok: true as const, result: result() })),
    });
    const s1 = await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: false }, d);
    expect(s1.errors.apply).toBe("O rascunho mudou.");
    expect(s1.steps.accept).toBe("done");
    fail = false;
    const s2 = await run(s1, { mode: "suggest", aiActive: true }, d);
    expect(d.enableAi).toHaveBeenCalledTimes(1);
    expect(s2.complete).toBe(true);
  });

  it("falha ao ligar o automático: operação montada em Sugerir; tentar de novo roda só o modo", async () => {
    let fail = true;
    const d = deps({
      enableAutopilot: vi.fn(async () => {
        if (fail) throw new Error("falhou");
      }),
    });
    const s1 = await run(INITIAL_ACTIVATION, { mode: "autopilot", aiActive: true }, d);
    expect(s1).toMatchObject({ complete: false, finalMode: "autopilot_failed" });
    expect(s1.steps).toMatchObject({ apply: "done", mode: "error" });
    fail = false;
    const s2 = await run(s1, { mode: "autopilot", aiActive: true }, d);
    expect(d.apply).toHaveBeenCalledTimes(1);
    expect(s2).toMatchObject({ complete: true, finalMode: "autopilot" });
  });

  it("atendente mantido (skipped_existing): não liga o automático", async () => {
    const d = deps({
      apply: vi.fn(async () => ({ ok: true as const, result: result({ attendant: "skipped_existing", attendantId: "old" as never }) })),
    });
    const s = await run(INITIAL_ACTIVATION, { mode: "autopilot", aiActive: true }, d);
    expect(d.enableAutopilot).not.toHaveBeenCalled();
    expect(s).toMatchObject({ complete: true, finalMode: "suggest" });
  });

  it("sobrescrever refaz a montagem e liga o modo no atendente novo", async () => {
    const d = deps();
    const s1 = await run(INITIAL_ACTIVATION, { mode: "autopilot", aiActive: true }, d);
    const d2 = deps({
      apply: vi.fn(async () => ({ ok: true as const, result: result({ attendant: "overwritten", attendantId: "att2" as never }) })),
    });
    const s2 = await run(s1, { mode: "autopilot", aiActive: true, overwrite: true }, d2);
    expect(d2.enableAutopilot).toHaveBeenCalledWith("att2");
    expect(s2.complete).toBe(true);
  });
});

describe("rótulos", () => {
  it("o botão diz o que vai acontecer", () => {
    expect(activateButtonLabel({ mode: "autopilot", aiActive: false, alreadyApplied: false })).toBe("Ativar e deixar a IA responder sozinha");
    expect(activateButtonLabel({ mode: "suggest", aiActive: false, alreadyApplied: false })).toBe("Ativar com respostas para eu aprovar");
    expect(activateButtonLabel({ mode: "suggest", aiActive: true, alreadyApplied: true })).toBe("Atualizar com respostas para eu aprovar");
  });
  it("desabilitado até marcar a caixa, com o porquê", () => {
    expect(activateBlockedReason({ aiActive: false, accepted: false, blockedReason: null })).toMatch(/caixa/);
    expect(activateBlockedReason({ aiActive: false, accepted: true, blockedReason: null })).toBeNull();
    expect(activateBlockedReason({ aiActive: true, accepted: false, blockedReason: null })).toBeNull();
    expect(activateBlockedReason({ aiActive: true, accepted: true, blockedReason: "Falta editar" })).toBe("Falta editar");
  });
  it("linha de sucesso conforme o modo final", () => {
    expect(activeLine("autopilot")).toBe("IA ativa · Responder sozinha");
    expect(activeLine("suggest")).toBe("IA ativa · Sugerir respostas");
    expect(activeLine("autopilot_failed")).toBe("IA ativa · Sugerir respostas");
    expect(activeLine(null)).toBe("IA ativa");
  });
});

describe("buildActivationDeps: as mutations de sempre, com os argumentos certos", () => {
  const mk = () => {
    const setAiEnabled = vi.fn(async () => null);
    const applyDraft = vi.fn(async () => result());
    const updateAgentProfile = vi.fn(async () => null);
    const deps = buildActivationDeps({
      organizationId: "org1",
      sessionId: "s1",
      expectedDraftHash: "hash-vivo",
      setAiEnabled,
      applyDraft,
      updateAgentProfile,
      errorMessage: (e, f) => (e instanceof Error ? e.message : f),
    });
    return { deps, setAiEnabled, applyDraft, updateAgentProfile };
  };

  it("aceite com lgpdAck, montar com o hash vivo e automático com autopilotRiskAck:true pela porta das Configurações", async () => {
    const m = mk();
    const s = await run(INITIAL_ACTIVATION, { mode: "autopilot", aiActive: false }, m.deps);
    expect(m.setAiEnabled).toHaveBeenCalledWith({ organizationId: "org1", enabled: true, lgpdAck: true });
    expect(m.applyDraft).toHaveBeenCalledWith({ organizationId: "org1", sessionId: "s1", expectedDraftHash: "hash-vivo" });
    expect(m.updateAgentProfile).toHaveBeenCalledWith({ agentMemberId: "att1", patch: { mode: "autopilot" }, autopilotRiskAck: true });
    expect(s.complete).toBe(true);
  });

  it("Sugerir respostas nunca chama updateAgentProfile", async () => {
    const m = mk();
    await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: true }, m.deps);
    expect(m.setAiEnabled).not.toHaveBeenCalled();
    expect(m.updateAgentProfile).not.toHaveBeenCalled();
  });

  it("sobrescrever manda overwriteExistingAttendant; erro da montagem vira mensagem", async () => {
    const m = mk();
    await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: true, overwrite: true }, m.deps);
    expect(m.applyDraft).toHaveBeenCalledWith(expect.objectContaining({ overwriteExistingAttendant: true }));
    m.applyDraft.mockRejectedValueOnce(new Error("O rascunho mudou."));
    const s = await run(INITIAL_ACTIVATION, { mode: "suggest", aiActive: true }, m.deps);
    expect(s.errors.apply).toBe("O rascunho mudou.");
  });
});
