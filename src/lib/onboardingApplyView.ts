/**
 * Resultado de "Montar minha operação" em linguagem simples (P3.3). PURO.
 * Entrada: o `ApplyResult` de `onboardingSessions.applyOnboardingDraft`.
 */
import type { ApplyResult } from "../../convex/lib/onboardingApply";

export type ApplyFeatureKey = keyof ApplyResult["features"];

export const FEATURE_LABEL: Record<ApplyFeatureKey, string> = {
  vision: "leitura de imagens",
  transcription: "transcrição de áudio",
  dateTime: "data e hora na conversa",
  translation: "tradução de mensagens",
  voice: "respostas em voz",
};

export interface ApplyResultView {
  /** O que foi criado ou atualizado. */
  created: string[];
  /** Recursos ligados agora. */
  featuresOn: string[];
  /** Recursos que esperam o aceite de IA (ou o WhatsApp). */
  waitingConsent: string[];
  waitingChannel: string[];
  /** Itens que ficaram de fora (marcados e não liberados). */
  leftOut: string[];
  /** O atendente depende do aceite de IA para existir/ligar. */
  needsConsent: boolean;
  /** Existia um atendente e ele foi mantido: dá para oferecer sobrescrever. */
  keptExistingAttendant: boolean;
  alreadyApplied: boolean;
  /** Uma frase sobre o jeito de atender (sempre "sugerir" no nascimento). */
  attendantNote: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeApplyResult(r: ApplyResult): ApplyResultView {
  const created: string[] = [];
  if (r.funnelMode === "created") created.push("Funil criado");
  if (r.funnelMode === "replaced") created.push("Funil montado no lugar do anterior");
  if (r.fieldsCreated + r.fieldsUpdated > 0) {
    created.push(plural(r.fieldsCreated + r.fieldsUpdated, "campo do lead", "campos do lead"));
  }
  if (r.quickRepliesCreated > 0) created.push(plural(r.quickRepliesCreated, "resposta rápida", "respostas rápidas"));
  switch (r.attendant) {
    case "created":
      created.push("Atendente IA criado");
      break;
    case "updated":
      created.push("Atendente IA atualizado");
      break;
    case "overwritten":
      created.push("Atendente IA que já existia foi sobrescrito");
      break;
    default:
      break;
  }

  const featuresOn: string[] = [];
  const waitingConsent: string[] = [];
  const waitingChannel: string[] = [];
  for (const key of Object.keys(FEATURE_LABEL) as ApplyFeatureKey[]) {
    const outcome = r.features[key];
    if (outcome === "applied" || outcome === "already_on") featuresOn.push(FEATURE_LABEL[key]);
    if (outcome === "pending_consent") waitingConsent.push(FEATURE_LABEL[key]);
    if (outcome === "no_channel") waitingChannel.push(FEATURE_LABEL[key]);
  }
  for (const key of r.pendingConsent) {
    if (!waitingConsent.includes(FEATURE_LABEL[key])) waitingConsent.push(FEATURE_LABEL[key]);
  }

  const s = r.skippedSuspicious;
  const leftOut: string[] = [];
  if (s.knowledge > 0) leftOut.push(plural(s.knowledge, "fato do conhecimento", "fatos do conhecimento"));
  if (s.quickReplies > 0) leftOut.push(plural(s.quickReplies, "resposta rápida", "respostas rápidas"));
  if (s.handoffRules > 0) leftOut.push(plural(s.handoffRules, "regra de pedido de ajuda", "regras de pedido de ajuda"));
  if (s.greeting) leftOut.push("a saudação");
  if (s.business) leftOut.push("a descrição do negócio");

  const needsConsent = r.attendant === "pending_consent";
  const born = r.attendant === "created" || r.attendant === "updated" || r.attendant === "overwritten";
  const attendantNote = born
    ? "Seu atendente começa em Sugerir respostas: ele escreve e a sua equipe revisa. Nada sai sozinho para um cliente."
    : null;

  return {
    created,
    featuresOn,
    waitingConsent,
    waitingChannel,
    leftOut,
    needsConsent,
    keptExistingAttendant: r.attendant === "skipped_existing",
    alreadyApplied: r.alreadyApplied,
    attendantNote,
  };
}

/** Mesma regra do servidor (`buildBlock` "simulador"): sem IA ativa ou sem operação montada, o teste fica indisponível. */
export function simulatorReason(state: { aiActive: boolean; applied: boolean }): "ai_inactive" | "not_applied" | undefined {
  if (!state.aiActive) return "ai_inactive";
  if (!state.applied) return "not_applied";
  return undefined;
}

/** Por que o botão "Montar minha operação" não pode ser clicado (null = pode). */
export function applyBlockedReason(state: { canApply: boolean; blockedCount: number; alreadyApplied: boolean }): string | null {
  if (state.blockedCount > 0) {
    return state.blockedCount === 1
      ? "Um nome do rascunho precisa ser editado antes de montar a operação."
      : `${state.blockedCount} nomes do rascunho precisam ser editados antes de montar a operação.`;
  }
  if (!state.canApply) return "O rascunho ainda não está pronto para montar a operação.";
  return null;
}
