/**
 * Status da configuração inicial derivado de dados reais. Módulo puro (sem
 * `_generated`): `onboarding.ts` monta o snapshot com consultas por índice e
 * esta função decide o que está feito e qual é o próximo passo. `steps.*` em
 * `onboardingMeta` guarda só o que NÃO dá para derivar (pulou, testou).
 */

export const ONBOARDING_STEPS = [
  "business",
  "funnel",
  "whatsapp",
  "attendant",
  "test",
  "extras",
  "team",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "done" | "skipped" | "pending";
/** Estado salvo em `onboardingMeta.steps.*` (status). */
export type SavedStepStatus = "done" | "skipped";

export interface OnboardingSnapshot {
  /** `onboardingMeta.business.offer` preenchido. */
  hasBusinessOffer: boolean;
  /** `onboardingMeta.wizardCompletedAt` (org legada que já concluiu o wizard v1). */
  legacyWizardCompleted: boolean;
  /**
   * Org legada: concluiu o wizard v1 (`wizardCompletedAt` sem `wizardVersion` 2).
   * Nunca vê o wizard v2, então `business` e `test` não teriam como ser feitos.
   */
  legacyOrg?: boolean;
  /** Canal WhatsApp bridge `connected` ou Meta `active`. */
  whatsappConnected: boolean;
  /** Existe canal bridge ativo (o aceite só vale para ele). */
  hasBridgeChannel: boolean;
  bridgeAiAckDone: boolean;
  hasAttendant: boolean;
  /** Atendente ativo (só para o contexto do Copiloto; opcional). */
  attendant?: { name: string; mode: "suggest" | "autopilot" } | null;
  /** `getAiStatus.active`: IA ligada E aceite LGPD. */
  aiActive: boolean;
  /** `autoTranscribeAudio` em algum canal ou `visionEnabled`. */
  extrasEnabled: boolean;
  /** Membros humanos ativos (basta saber se passa de 1). */
  humanMemberCount: number;
  /** Existe resposta enviada pelo atendente IA. */
  firstAiReplyDone: boolean;
  /** `onboardingMeta.steps.*.status`. */
  saved: Partial<Record<OnboardingStepKey, SavedStepStatus>>;
}

export interface OnboardingStatusResult {
  steps: Record<OnboardingStepKey, OnboardingStepStatus>;
  /** Primeiro passo nem feito nem pulado; null quando não resta nenhum. */
  nextStep: OnboardingStepKey | null;
  /** Há canal bridge e o aceite de risco da IA ainda não foi dado. */
  bridgeAckPending: boolean;
  firstAiReplyDone: boolean;
}

function saved(
  s: OnboardingSnapshot,
  key: OnboardingStepKey,
): OnboardingStepStatus | null {
  return s.saved[key] ?? null;
}

export function deriveOnboardingStatus(s: OnboardingSnapshot): OnboardingStatusResult {
  const steps: Record<OnboardingStepKey, OnboardingStepStatus> = {
    // Org legada nunca passa pelo wizard v2: `business` e `test` só se completam
    // nele, então contam como feitos para o checklist não ficar preso.
    business:
      s.legacyOrg || s.hasBusinessOffer || saved(s, "business") === "done" ? "done" : "pending",
    funnel:
      saved(s, "funnel") === "done" || s.legacyWizardCompleted
        ? "done"
        : saved(s, "funnel") === "skipped"
          ? "skipped"
          : "pending",
    whatsapp: s.whatsappConnected ? "done" : saved(s, "whatsapp") === "skipped" ? "skipped" : "pending",
    attendant:
      s.aiActive && s.hasAttendant
        ? "done"
        : saved(s, "attendant") === "skipped"
          ? "skipped"
          : "pending",
    test: s.legacyOrg ? "done" : (saved(s, "test") ?? "pending"),
    extras: s.extrasEnabled ? "done" : saved(s, "extras") === "skipped" ? "skipped" : "pending",
    team: s.humanMemberCount > 1 ? "done" : saved(s, "team") === "skipped" ? "skipped" : "pending",
  };
  const nextStep = ONBOARDING_STEPS.find((k) => steps[k] === "pending") ?? null;
  return {
    steps,
    nextStep,
    bridgeAckPending: s.hasBridgeChannel && s.hasAttendant && !s.bridgeAiAckDone,
    firstAiReplyDone: s.firstAiReplyDone,
  };
}
