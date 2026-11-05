import { describe, expect, it } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  WIZARD_STEPS,
  aiCheckboxState,
  attendantFormsFromDraft,
  attendantGate,
  attendantRename,
  attendantStepPatch,
  businessDraftFromStatus,
  businessSavePlan,
  canAdvance,
  doneSummary,
  extrasAvailability,
  firstOpenStageId,
  firstPendingStep,
  markOnContinue,
  nextStepId,
  parseStepParam,
  readWizardData,
  savedStepFromProgress,
  skipIsPersisted,
  stepAvailability,
  visibleWizardSteps,
  wizardDataPatch,
  wizardStepHref,
  type OnboardingStatus,
} from "./onboardingWizard";

const allPending = {
  business: "pending",
  funnel: "pending",
  whatsapp: "pending",
  attendant: "pending",
  test: "pending",
  extras: "pending",
  team: "pending",
} as const;

const status = (over: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
  shouldShowWizard: true,
  accountHasEmail: true,
  capabilities: { managedBridge: true, transcription: true, llm: true, metaMessaging: false },
  steps: allPending,
  ...over,
});

const channel = "ch1" as Id<"channelConfigs">;
const board = "b1" as Id<"boards">;
const stage = "s1" as Id<"stages">;

describe("passos", () => {
  it("segue a ordem do glossário", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual([
      "Seu negócio", "Seu funil", "Conectar WhatsApp", "Atendente IA", "Teste", "Extras", "Equipe", "Pronto",
    ]);
  });

  it("pula para o primeiro passo pendente", () => {
    const s = status({ steps: { ...allPending, business: "done", funnel: "skipped" } });
    expect(firstPendingStep(s)).toBe("whatsapp");
  });

  it("vai para pronto quando nada está pendente", () => {
    const done = Object.fromEntries(Object.keys(allPending).map((k) => [k, "done"])) as OnboardingStatus["steps"];
    expect(firstPendingStep(status({ steps: done }))).toBe("done");
  });

  it("respeita o passo salvo quando está mais adiante", () => {
    const s = status({ steps: { ...allPending, business: "done" } });
    expect(firstPendingStep(s, 3)).toBe("attendant");
    expect(firstPendingStep(s, 0)).toBe("funnel");
  });

  it("só lê posição salva gravada pelo v2", () => {
    expect(savedStepFromProgress({ wizardCurrentStep: 4 })).toBeNull();
    expect(savedStepFromProgress({ wizardCurrentStep: 2, wizardData: wizardDataPatch() })).toBe(2);
    expect(savedStepFromProgress({ wizardCurrentStep: 99, wizardData: wizardDataPatch() })).toBeNull();
    // o v1 grava wizardVersion null por cima do 2 (merge raso do servidor)
    expect(savedStepFromProgress({ wizardCurrentStep: 2, wizardData: { ...wizardDataPatch(), wizardVersion: null } })).toBeNull();
  });

  it("esconde o teste sem IA no servidor e pula o passo na navegação", () => {
    const s = status({ capabilities: { managedBridge: true, transcription: false, llm: false, metaMessaging: false } });
    expect(visibleWizardSteps(s).some((x) => x.id === "test")).toBe(false);
    expect(nextStepId("attendant", s)).toBe("extras");
    expect(firstPendingStep({ ...s, steps: { ...allPending, business: "done", funnel: "done", whatsapp: "done", attendant: "done" } })).toBe("extras");
  });
});

describe("pular", () => {
  it("só grava o pulo onde o servidor aceita", () => {
    expect(skipIsPersisted("whatsapp")).toBe(true);
    expect(skipIsPersisted("attendant")).toBe(true);
    expect(skipIsPersisted("funnel")).toBe(true);
    expect(skipIsPersisted("business")).toBe(false);
  });
});

describe("passo 1", () => {
  const base = { ...businessDraftFromStatus(undefined), segment: "saas", offer: "Software de gestão" };

  it("exige segmento e o que vende", () => {
    expect(canAdvance("business", { business: base })).toBe(true);
    expect(canAdvance("business", { business: { ...base, offer: "  " } })).toBe(false);
    expect(canAdvance("business", { business: { ...base, segment: "" } })).toBe(false);
    expect(canAdvance("business", { business: { ...base, offer: "x".repeat(601) } })).toBe(false);
  });

  it("os outros passos são opcionais", () => {
    expect(canAdvance("whatsapp", {})).toBe(true);
    expect(canAdvance("funnel", { funnelOk: false })).toBe(false);
  });

  it("checkbox desmarcado nunca liga a IA", () => {
    const plan = businessSavePlan({ ...base, aiHelp: false }, status(), false);
    expect(plan.enableAi).toBe(false);
    expect(plan.profile.aiAssisted).toBe(false);
  });

  it("checkbox marcado liga a IA só uma vez", () => {
    expect(businessSavePlan({ ...base, aiHelp: true }, status(), false).enableAi).toBe(true);
    expect(businessSavePlan({ ...base, aiHelp: true }, status(), true).enableAi).toBe(false);
  });

  it("sem capacidade de LLM o checkbox some e nada liga", () => {
    const s = status({ capabilities: { managedBridge: true, transcription: false, llm: false, metaMessaging: false } });
    expect(aiCheckboxState(s).visible).toBe(false);
    expect(businessSavePlan({ ...base, aiHelp: true }, s, false).enableAi).toBe(false);
  });

  it("conta sem e-mail trava o checkbox", () => {
    expect(aiCheckboxState(status({ accountHasEmail: false }))).toMatchObject({ visible: true, disabled: true });
  });
});

describe("disponibilidade", () => {
  it("conta sem e-mail bloqueia WhatsApp, Atendente e Extras", () => {
    const s = status({ accountHasEmail: false });
    for (const step of ["whatsapp", "attendant", "extras"] as const) {
      expect(stepAvailability(step, s).disabled).toBe(true);
    }
    expect(stepAvailability("funnel", s).disabled).toBe(false);
  });

  it("sem gateway gerenciado o WhatsApp vira aviso", () => {
    const s = status({ capabilities: { managedBridge: false, transcription: true, llm: true, metaMessaging: false } });
    expect(stepAvailability("whatsapp", s)).toMatchObject({ unavailable: true, disabled: false });
  });
});

describe("passo 4", () => {
  const gate = (over = {}) =>
    attendantGate({ status: status(), aiActive: false, bridgeAckNeeded: false, hasAttendant: false, lgpdChecked: false, ...over });

  it("passo 4 exige aceite antes de gerar", () => {
    expect(gate().canGenerate).toBe(false);
    expect(gate().canCreate).toBe(false);
    expect(gate({ lgpdChecked: true }).canCreate).toBe(true);
    // só marcar a caixa ainda não grava o aceite: gerar continua bloqueado
    expect(gate({ lgpdChecked: true }).canGenerate).toBe(false);
    expect(gate({ aiActive: true, hasAttendant: true }).canGenerate).toBe(true);
  });

  it("sem capacidade de LLM esconde Escrever com IA", () => {
    const s = status({ capabilities: { managedBridge: true, transcription: false, llm: false, metaMessaging: false } });
    expect(attendantGate({ status: s, aiActive: true, bridgeAckNeeded: false, hasAttendant: true, lgpdChecked: false }).showWriteWithAi).toBe(false);
    expect(gate({ aiActive: true }).showWriteWithAi).toBe(true);
    expect(gate().showWriteWithAi).toBe(false);
  });

  it("mostra o aceite do QR code só quando pendente", () => {
    expect(gate({ aiActive: true, hasAttendant: true, bridgeAckNeeded: true }).showBridgeAck).toBe(true);
    expect(gate({ aiActive: true }).showBridgeAck).toBe(false);
  });

  const forms = {
    persona: { systemPrompt: "Você é a Ana", loaded: true },
    knowledge: { knowledge: "Preço: 10", loaded: true },
    handoff: { keywords: "humano, atendente" },
    schedule: { allDay: true, startHour: 8, endHour: 18 },
  };

  it("preenche o funil do passo 2 e não restringe canais quando a lista está vazia", () => {
    const patch = attendantStepPatch({ ...forms, channelId: channel, boardId: board, initialStageId: stage });
    expect("channelConfigIds" in patch).toBe(false);
    expect(patch.pipelineConfig).toEqual({ boardId: board, initialStageId: stage });
    expect(patch.systemPrompt).toBe("Você é a Ana");
    expect(patch.handoffKeywords).toEqual(["humano", "atendente"]);
    expect(patch.schedule).toBeNull();
    expect(patch.mode).toBeUndefined();
  });

  it("com lista de canais já restrita, acrescenta o número do passo 3", () => {
    const other = "ch0" as Id<"channelConfigs">;
    expect(attendantStepPatch({ ...forms, channelId: channel, current: { channelConfigIds: [other] } }).channelConfigIds).toEqual([other, channel]);
    expect("channelConfigIds" in attendantStepPatch({ ...forms, channelId: channel, current: { channelConfigIds: [] } })).toBe(false);
  });

  it("sem passos 2 e 3 não mexe em canais nem funil", () => {
    const patch = attendantStepPatch(forms);
    expect("channelConfigIds" in patch).toBe(false);
    expect("pipelineConfig" in patch).toBe(false);
  });

  it("mantém canais e regras já salvos; troca de funil descarta ids de etapa", () => {
    const other = "ch0" as Id<"channelConfigs">;
    const patch = attendantStepPatch({
      ...forms,
      channelId: channel,
      boardId: board,
      initialStageId: stage,
      current: {
        channelConfigIds: [other],
        pipelineConfig: { boardId: "old" as Id<"boards">, qualifiedStageId: "q" as Id<"stages">, advanceRules: "regras" },
      },
    });
    expect(patch.channelConfigIds).toEqual([other, channel]);
    expect(patch.pipelineConfig).toEqual({ advanceRules: "regras", boardId: board, initialStageId: stage });
  });

  it("não grava textos que não foram carregados", () => {
    const patch = attendantStepPatch({ ...forms, persona: { systemPrompt: "", loaded: false } });
    expect("systemPrompt" in patch).toBe(false);
  });

  it("converte o rascunho da IA em formulários", () => {
    const f = attendantFormsFromDraft({ name: "Ana", persona: "p", knowledge: "k", handoffKeywords: ["a", "b"] });
    expect(f.handoff.keywords).toBe("a, b");
    expect(f.persona.loaded).toBe(true);
  });

  it("escolhe a primeira etapa aberta", () => {
    const stages = [
      { _id: "w" as Id<"stages">, order: 2, isClosedWon: true },
      { _id: "b" as Id<"stages">, order: 1 },
      { _id: "a" as Id<"stages">, order: 0 },
    ];
    expect(firstOpenStageId(stages)).toBe("a");
    expect(firstOpenStageId(undefined)).toBeUndefined();
  });

  it("renomeia só quando mudou", () => {
    expect(attendantRename("  Ana  ", "Ana")).toBeUndefined();
    expect(attendantRename("Bia", "Ana")).toBe("Bia");
  });
});

describe("dados do membro", () => {
  it("lê só strings", () => {
    expect(readWizardData({ connectedChannelId: "c", funnelBoardId: 3, setupThreadId: "t" })).toEqual({
      connectedChannelId: "c",
      funnelBoardId: undefined,
      setupThreadId: "t",
    });
    expect(readWizardData(null)).toEqual({});
  });
});

describe("?passo= (URL como fonte do passo)", () => {
  it("lê só passos conhecidos e visíveis", () => {
    expect(parseStepParam("whatsapp", status())).toBe("whatsapp");
    expect(parseStepParam("done", status())).toBe("done");
    expect(parseStepParam("inexistente", status())).toBeNull();
    expect(parseStepParam(null, status())).toBeNull();
    expect(parseStepParam("", status())).toBeNull();
  });

  it("passo 5 fica escondido sem LLM no servidor", () => {
    const noLlm = status({ capabilities: { managedBridge: true, transcription: true, llm: false, metaMessaging: false } });
    expect(parseStepParam("test", noLlm)).toBeNull();
    expect(parseStepParam("test", status())).toBe("test");
  });

  it("monta o link do passo", () => {
    expect(wizardStepHref("extras")).toBe("/app/configuracao-inicial?passo=extras");
  });
});

describe("passos 5 a 8", () => {
  it("seguir adiante só grava pulo do que ainda está pendente", () => {
    expect(markOnContinue("test", status())).toBe("skipped");
    expect(markOnContinue("extras", status({ steps: { ...allPending, extras: "done" } }))).toBeNull();
    expect(markOnContinue("team", status({ steps: { ...allPending, team: "skipped" } }))).toBeNull();
    expect(markOnContinue("attendant", status())).toBeNull();
  });

  it("extras: áudio depende do servidor e imagem da IA ligada", () => {
    expect(extrasAvailability(status(), true)).toEqual({ audio: { available: true }, vision: { available: true } });
    const noWhisper = status({ capabilities: { managedBridge: true, transcription: false, llm: true, metaMessaging: false } });
    expect(extrasAvailability(noWhisper, false)).toEqual({
      audio: { available: false, reason: "Indisponível neste servidor" },
      vision: { available: false, reason: "Ligue o Atendente IA primeiro" },
    });
  });

  it("resumo do pronto separa configurado de pendente e omite o teste sem IA", () => {
    const s = status({ steps: { ...allPending, business: "done", funnel: "done", whatsapp: "skipped" } });
    const sum = doneSummary(s);
    expect(sum.items).toHaveLength(7);
    expect(sum.configured.map((i) => i.id)).toEqual(["business", "funnel"]);
    expect(sum.missing[0]).toMatchObject({ id: "whatsapp", state: "skipped" });
    const noLlm = status({ capabilities: { managedBridge: true, transcription: true, llm: false, metaMessaging: false } });
    expect(doneSummary(noLlm).items.some((i) => i.id === "test")).toBe(false);
  });
});
