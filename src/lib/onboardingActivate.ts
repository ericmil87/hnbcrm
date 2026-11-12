/**
 * Regras puras do cartão "Ativar a sua IA" do onboarding: a sequência do clique
 * (aceite de IA → montar a operação → ligar Responder sozinha), com estado e
 * erro RECUPERÁVEL por etapa, o rótulo do botão que diz o que vai acontecer e o
 * texto do estado final. Nada aqui chama Convex: as chamadas entram por `deps`.
 */
import type { ApplyResult } from "../../convex/lib/onboardingApply";
import { modeToPatch } from "./attendantConfig";
import type { FinalAttendantMode } from "./onboardingApplyView";

export type ActivationMode = "autopilot" | "suggest";
export type ActivationStepId = "accept" | "apply" | "mode";
export type StepStatus = "idle" | "running" | "done" | "skipped" | "error";

export type ApplyAttempt = { ok: true; result: ApplyResult } | { ok: false; message: string };

export interface ActivationState {
  steps: Record<ActivationStepId, StepStatus>;
  errors: Partial<Record<ActivationStepId, string>>;
  result: ApplyResult | null;
  /** Modo final conhecido (só depois de a operação montar). */
  finalMode: FinalAttendantMode | null;
  /** Tudo certo: pode avisar o Copiloto (`notify activated`). */
  complete: boolean;
}

export const INITIAL_ACTIVATION: ActivationState = {
  steps: { accept: "idle", apply: "idle", mode: "idle" },
  errors: {},
  result: null,
  finalMode: null,
  complete: false,
};

export interface ActivationDeps {
  /** `aiSettings.setAiEnabled({enabled:true, lgpdAck:true})`; lança em erro. */
  enableAi: () => Promise<void>;
  /** `onboardingSessions.applyOnboardingDraft`; nunca lança (devolve `ok:false`). */
  apply: (overwrite: boolean) => Promise<ApplyAttempt>;
  /** `aiSettings.updateAgentProfile({patch:{mode:"autopilot"}, autopilotRiskAck:true})`; lança em erro. */
  enableAutopilot: (attendantId: string) => Promise<void>;
  errorMessage: (e: unknown, fallback: string) => string;
}

export interface ActivationInput {
  mode: ActivationMode;
  /** A IA já estava ativa (a etapa do aceite não existe). */
  aiActive: boolean;
  overwrite?: boolean;
}

/** O atendente foi criado/atualizado por ESTA aplicação (só então dá para ligar o modo). */
export function attendantWasBorn(r: ApplyResult): boolean {
  return r.attendant === "created" || r.attendant === "updated" || r.attendant === "overwritten";
}

/**
 * Executa (ou RETOMA) a sequência. Etapa já `done`/`skipped` não roda de novo:
 * errar no meio e clicar de novo continua de onde parou. `onChange` recebe cada
 * estado intermediário (barra de progresso por etapa).
 */
export async function runActivation(
  prev: ActivationState,
  input: ActivationInput,
  deps: ActivationDeps,
  onChange: (state: ActivationState) => void,
): Promise<ActivationState> {
  let state: ActivationState = { ...prev, steps: { ...prev.steps }, errors: {}, complete: false };
  const set = (patch: Partial<ActivationState> & { step?: [ActivationStepId, StepStatus]; error?: [ActivationStepId, string] }) => {
    const steps = patch.step ? { ...state.steps, [patch.step[0]]: patch.step[1] } : state.steps;
    const errors = patch.error ? { ...state.errors, [patch.error[0]]: patch.error[1] } : state.errors;
    const { step: _s, error: _e, ...rest } = patch;
    state = { ...state, ...rest, steps, errors };
    onChange(state);
  };

  // (1) Aceite de IA (clique da pessoa, com a caixa marcada): pula se a IA já está ativa.
  if (input.aiActive) {
    if (state.steps.accept !== "skipped") set({ step: ["accept", "skipped"] });
  } else if (state.steps.accept !== "done") {
    set({ step: ["accept", "running"] });
    try {
      await deps.enableAi();
      set({ step: ["accept", "done"] });
    } catch (e) {
      set({ step: ["accept", "error"], error: ["accept", deps.errorMessage(e, "Não foi possível ativar a IA. Tente de novo.")] });
      return state;
    }
  }

  // (2) Montar a operação (hash do rascunho VIVO, quem chama garante).
  if (state.steps.apply !== "done" || input.overwrite) {
    set({ step: ["apply", "running"] });
    const attempt = await deps.apply(input.overwrite === true);
    if (!attempt.ok) {
      set({ step: ["apply", "error"], error: ["apply", attempt.message] });
      return state;
    }
    set({ step: ["apply", "done"], result: attempt.result });
    if (input.overwrite && attempt.result.alreadyApplied) {
      set({ step: ["apply", "error"], error: ["apply", "Não foi possível sobrescrever o atendente que já existe. Ele continua como estava; tente de novo."] });
      return state;
    }
    // Resultado novo: a etapa do modo recomeça.
    set({ step: ["mode", "idle"] });
  }

  // (3) Ligar Responder sozinha (porta auditada das Configurações), só se escolhido
  // E se o atendente é desta aplicação.
  const result = state.result;
  if (input.mode === "autopilot" && result) {
    if (result.attendantId && attendantWasBorn(result)) {
      if (state.steps.mode !== "done") {
        set({ step: ["mode", "running"] });
        try {
          await deps.enableAutopilot(result.attendantId);
          set({ step: ["mode", "done"], finalMode: "autopilot" });
        } catch (e) {
          set({
            step: ["mode", "error"],
            finalMode: "autopilot_failed",
            error: ["mode", deps.errorMessage(e, "Não foi possível ligar o modo Responder sozinha.")],
          });
          return state;
        }
      }
    } else {
      // Atendente mantido (`skipped_existing`) ou ainda sem aceite: não liga o automático.
      set({ step: ["mode", "skipped"], finalMode: "suggest" });
    }
  } else if (result) {
    set({ step: ["mode", "skipped"], finalMode: "suggest" });
  }

  set({ complete: true });
  return state;
}

/** Rótulo do botão principal: diz o que vai acontecer. */
export function activateButtonLabel(input: { mode: ActivationMode; aiActive: boolean; alreadyApplied: boolean }): string {
  const verb = input.alreadyApplied ? "Atualizar" : input.aiActive ? "Montar" : "Ativar";
  return input.mode === "autopilot"
    ? `${verb} e deixar a IA responder sozinha`
    : `${verb} com respostas para eu aprovar`;
}

/** Por que o botão principal está desabilitado (null = pode clicar). */
export function activateBlockedReason(input: { aiActive: boolean; accepted: boolean; blockedReason: string | null }): string | null {
  if (input.blockedReason) return input.blockedReason;
  if (!input.aiActive && !input.accepted) return "Marque a caixa de confirmação acima para ativar.";
  return null;
}

/** Linha de sucesso depois de ativada: "IA ativa · Responder sozinha". */
export function activeLine(mode: FinalAttendantMode | "autopilot" | "suggest" | null | undefined): string {
  if (mode === "autopilot") return "IA ativa · Responder sozinha";
  if (mode === "suggest" || mode === "autopilot_failed") return "IA ativa · Sugerir respostas";
  return "IA ativa";
}

export const ACTIVATION_STEP_LABEL: Record<ActivationStepId, string> = {
  accept: "Ativando a IA",
  apply: "Montando a sua operação",
  mode: "Ligando o modo Responder sozinha",
};

/** As três mutations de sempre, com ids como texto (quem chama converte para `Id`). */
export interface ActivationMutations {
  organizationId: string;
  sessionId: string;
  /** Hash do rascunho VIVO (o que a pessoa revisou). */
  expectedDraftHash: string;
  setAiEnabled: (args: { organizationId: string; enabled: true; lgpdAck: true }) => Promise<unknown>;
  applyDraft: (args: { organizationId: string; sessionId: string; expectedDraftHash: string; overwriteExistingAttendant?: true }) => Promise<ApplyResult>;
  updateAgentProfile: (args: { agentMemberId: string; patch: ReturnType<typeof modeToPatch>; autopilotRiskAck: true }) => Promise<unknown>;
  errorMessage: (e: unknown, fallback: string) => string;
}

/**
 * Liga `runActivation` às mutations existentes: `setAiEnabled` com o aceite
 * marcado pela pessoa, `applyOnboardingDraft` com o hash vivo e, só se o modo
 * automático foi escolhido, `updateAgentProfile` pela MESMA porta auditada das
 * Configurações, com `autopilotRiskAck: true`.
 */
export function buildActivationDeps(m: ActivationMutations): ActivationDeps {
  return {
    errorMessage: m.errorMessage,
    enableAi: async () => {
      await m.setAiEnabled({ organizationId: m.organizationId, enabled: true, lgpdAck: true });
    },
    apply: async (overwrite) => {
      try {
        const result = await m.applyDraft({
          organizationId: m.organizationId,
          sessionId: m.sessionId,
          expectedDraftHash: m.expectedDraftHash,
          ...(overwrite ? { overwriteExistingAttendant: true as const } : {}),
        });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, message: m.errorMessage(e, "Não foi possível montar a operação.") };
      }
    },
    enableAutopilot: async (attendantId) => {
      await m.updateAgentProfile({ agentMemberId: attendantId, patch: modeToPatch("autopilot"), autopilotRiskAck: true });
    },
  };
}
